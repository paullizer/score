import type {
  FrozenGradeTargetSnapshot, FrozenRealAnalysisTargetSnapshot, FrozenRealResumeSnapshot,
  RealAnalysisComparisonRecord, RealAnalysisInitializationManifest, RealAnalysisResult, RealAnalysisRunRecord,
} from '../../src/domain/real-analyses'
import type { ReferenceDocument } from '../../src/domain/real-grades'
import type { ImmutableBlobReference, ImmutableJsonBlobReference } from '../../src/domain/real-resumes'
import { ANALYSIS_LIMITS } from '../../src/domain/real-analyses'
import { invalidRequest } from '../errors'
import { validateGradeApproval, validateReferenceDocument } from '../grades/validation'
import { preservesProcessingSettings } from '../jobs/policy'
import type { AnalysisBlob, AnalysisBlobStore } from './store'
import {
  analysisBlobInRun, analysisBytesHash, analysisHash, assertAnalysis, assertAnalysisResultBinding,
  MAX_ANALYSIS_JSON_BYTES, parseAnalysisEntity, parseAnalysisInitializationManifest, parseAnalysisResult,
  parseFrozenResumeSnapshot, parseFrozenTargetSnapshot,
} from './validation'

export interface AnalysisSnapshots {
  resumeSnapshot: FrozenRealResumeSnapshot
  targetSnapshot: FrozenRealAnalysisTargetSnapshot
}

type AnalysisBlobReader = Pick<AnalysisBlobStore, 'read'>

export function parseAnalysisJson(blob: AnalysisBlob): unknown {
  assertAnalysis(blob.contentType === 'application/json' && blob.bytes.byteLength <= MAX_ANALYSIS_JSON_BYTES &&
    blob.sha256 === analysisBytesHash(blob.bytes), 'Invalid JSON blob metadata or digest.')
  try { return JSON.parse(Buffer.from(blob.bytes).toString('utf8')) } catch {
    throw new Error('Invalid analysis data: Captured JSON could not be read.')
  }
}

export function analysisBlobReference(name: string, blob: AnalysisBlob): ImmutableJsonBlobReference {
  assertAnalysis(blob.contentType === 'application/json', 'A JSON blob is required.')
  return { blobName: name, contentType: 'application/json', sha256: blob.sha256, bytes: blob.bytes.byteLength }
}

export async function readAnalysisBlob(
  blobs: AnalysisBlobReader, reference: ImmutableBlobReference, workspaceId: string, runId: string,
): Promise<AnalysisBlob> {
  assertAnalysis(analysisBlobInRun(reference.blobName, workspaceId, runId), 'Blob is outside the analysis run.')
  const blob = await blobs.read(reference.blobName)
  assertAnalysis(blob && blob.contentType === reference.contentType && blob.bytes.byteLength === reference.bytes &&
    blob.sha256 === reference.sha256 && analysisBytesHash(blob.bytes) === reference.sha256, 'Captured blob is missing or its digest changed.')
  return blob
}

export async function putAnalysisJson(
  blobs: AnalysisBlobStore, name: string, value: unknown,
): Promise<ImmutableJsonBlobReference> {
  const bytes = Buffer.from(JSON.stringify(value))
  assertAnalysis(bytes.byteLength <= MAX_ANALYSIS_JSON_BYTES, 'Snapshot exceeds the blob budget.')
  const saved = await blobs.putImmutable(name, bytes, 'application/json')
  assertAnalysis(saved.blob.contentType === 'application/json' && saved.blob.sha256 === analysisBytesHash(bytes) &&
    analysisBytesHash(saved.blob.bytes) === saved.blob.sha256 && saved.blob.bytes.byteLength === bytes.byteLength,
  'Immutable snapshot already contains different evidence.')
  return analysisBlobReference(name, saved.blob)
}

export async function readAnalysisManifest(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord,
): Promise<RealAnalysisInitializationManifest> {
  parseAnalysisEntity(run)
  const manifest = parseAnalysisInitializationManifest(parseAnalysisJson(await readAnalysisBlob(blobs, run.manifest, run.workspaceId, run.id)))
  assertAnalysis(manifest.workspaceId === run.workspaceId && manifest.runId === run.id &&
    manifest.createdAt === run.createdAt && manifest.createdBy === run.createdBy &&
    manifest.inputFingerprint === run.inputFingerprint && manifest.request.name === run.name &&
    manifest.comparisons.length === run.progress.total &&
    preservesProcessingSettings(manifest.processingSettings, run.processingSettings),
  'Manifest does not belong to this run.')
  return manifest
}

export function assertComparisonManifestBinding(
  manifest: RealAnalysisInitializationManifest, comparison: RealAnalysisComparisonRecord,
): void {
  const pair = manifest.comparisons[comparison.index]
  const resume = manifest.resumes.find(item => item.snapshotId === pair?.resumeSnapshotId)
  const target = manifest.targets.find(item => item.snapshotId === pair?.targetSnapshotId)
  assertAnalysis(comparison.runId === manifest.runId && comparison.workspaceId === manifest.workspaceId &&
    pair?.id === comparison.id && analysisHash(resume ?? null) === analysisHash(comparison.resume) &&
    analysisHash(target ?? null) === analysisHash(comparison.target) &&
    preservesProcessingSettings(manifest.processingSettings, comparison.processingSettings),
  'Comparison does not match its immutable plan.')
}

async function validatedReferenceDocument(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord, reference: ImmutableJsonBlobReference,
): Promise<ReferenceDocument> {
  const document = parseAnalysisJson(await readAnalysisBlob(blobs, reference, run.workspaceId, run.id)) as ReferenceDocument
  assertAnalysis(validateReferenceDocument(document).length === 0, 'Invalid frozen reference document.')
  return document
}

async function bindReferenceDocuments(
  target: FrozenGradeTargetSnapshot, read: (reference: ImmutableJsonBlobReference) => Promise<ReferenceDocument>,
): Promise<ReferenceDocument[]> {
  const documents: ReferenceDocument[] = []
  for (const reference of target.references) {
    const document = await read(reference.document)
    assertAnalysis(document.id === reference.source.documentId && document.version === reference.source.documentVersion &&
      document.pageCount === reference.source.pageCount && document.completeness === reference.source.completeness &&
      analysisHash([...document.selectedPages].sort((a, b) => a - b)) ===
        analysisHash([...reference.source.selectedPages].sort((a, b) => a - b)), 'Frozen reference document binding mismatch.')
    documents.push(document)
  }
  const seedDocument = documents.find(document => document.id === target.seed.document.id)
  assertAnalysis(seedDocument && seedDocument.version === target.seed.document.version &&
    analysisHash(seedDocument.paragraphs) === analysisHash(target.seed.document.paragraphs), 'Reference seed and saved job document disagree.')
  assertAnalysis(validateGradeApproval(target.version, target.sourceSet, documents).length === 0,
    'Saved grade is not supported by these exact approved reference captures.')
  return documents
}

export async function readAnalysisReferenceDocuments(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord, target: FrozenGradeTargetSnapshot,
): Promise<ReferenceDocument[]> {
  return bindReferenceDocuments(target, reference => validatedReferenceDocument(blobs, run, reference))
}

function assertSnapshotSummaryBinding(
  manifest: RealAnalysisInitializationManifest, comparison: RealAnalysisComparisonRecord,
  { resumeSnapshot, targetSnapshot }: AnalysisSnapshots,
): void {
  assertAnalysis(resumeSnapshot.workspaceId === manifest.workspaceId && resumeSnapshot.snapshotId === comparison.resume.snapshotId &&
    targetSnapshot.workspaceId === manifest.workspaceId && targetSnapshot.snapshotId === comparison.target.snapshotId &&
    resumeSnapshot.frozenAt === manifest.createdAt && targetSnapshot.frozenAt === manifest.createdAt &&
    analysisHash(resumeSnapshot.selection) === analysisHash(comparison.resume.summary.selection) &&
    analysisHash(targetSnapshot.summary) === analysisHash(comparison.target.summary) &&
    resumeSnapshot.resume.name === comparison.resume.summary.name && resumeSnapshot.resume.role === comparison.resume.summary.role &&
    resumeSnapshot.displayName === comparison.resume.summary.displayName &&
    resumeSnapshot.resume.sourceLabel === comparison.resume.summary.sourceLabel &&
    resumeSnapshot.capture.capturedAt === comparison.resume.summary.capturedAt, 'Snapshot does not match its manifest summary.')
}

export async function readAnalysisSnapshots(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord,
): Promise<AnalysisSnapshots> {
  parseAnalysisEntity(comparison)
  const manifest = await readAnalysisManifest(blobs, run)
  assertComparisonManifestBinding(manifest, comparison)
  const [resumeBlob, targetBlob] = await Promise.all([
    readAnalysisBlob(blobs, comparison.resume.blob, run.workspaceId, run.id),
    readAnalysisBlob(blobs, comparison.target.blob, run.workspaceId, run.id),
  ])
  const resumeSnapshot = parseFrozenResumeSnapshot(parseAnalysisJson(resumeBlob))
  const targetSnapshot = parseFrozenTargetSnapshot(parseAnalysisJson(targetBlob))
  assertSnapshotSummaryBinding(manifest, comparison, { resumeSnapshot, targetSnapshot })
  if (targetSnapshot.kind === 'grade') {
    await readAnalysisReferenceDocuments(blobs, run, targetSnapshot)
  } else {
    await readAnalysisBlob(blobs, targetSnapshot.original, run.workspaceId, run.id)
  }
  return { resumeSnapshot, targetSnapshot }
}

export async function readAnalysisResult(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord, snapshots?: AnalysisSnapshots,
): Promise<RealAnalysisResult | null> {
  parseAnalysisEntity(comparison)
  if (!comparison.result) return null
  const captured = snapshots ?? await readAnalysisSnapshots(blobs, run, comparison)
  const result = parseAnalysisResult(parseAnalysisJson(await readAnalysisBlob(blobs, comparison.result, run.workspaceId, run.id)))
  assertAnalysisResultBinding(result, run, comparison, captured.resumeSnapshot, captured.targetSnapshot)
  assertAnalysis(analysisHash({ completion: result.completion, overall: result.overall, coverage: result.coverage }) ===
    analysisHash(comparison.resultSummary), 'Comparison summary differs from its immutable result.')
  return result
}

export interface AnalysisSnapshotReader {
  snapshots(comparison: RealAnalysisComparisonRecord): Promise<AnalysisSnapshots>
  result(comparison: RealAnalysisComparisonRecord, snapshots: AnalysisSnapshots): Promise<RealAnalysisResult | null>
}

/** Only the caller's bounded read operation owns these caches; nothing survives the request. */
export function createAnalysisSnapshotReader(
  blobs: AnalysisBlobReader, run: RealAnalysisRunRecord,
  options: { maxComparisons: number; maxBytes: number; signal?: AbortSignal },
): AnalysisSnapshotReader {
  assertAnalysis(Number.isInteger(options.maxComparisons) && options.maxComparisons > 0 &&
    options.maxComparisons <= ANALYSIS_LIMITS.maxComparisons && Number.isSafeInteger(options.maxBytes) &&
    options.maxBytes > 0, 'A bounded snapshot read budget is required.')
  let bytesRead = 0
  const boundedBlobs: AnalysisBlobReader = {
    async read(name) {
      options.signal?.throwIfAborted()
      const blob = await blobs.read(name)
      options.signal?.throwIfAborted()
      bytesRead += blob?.bytes.byteLength ?? 0
      if (bytesRead > options.maxBytes) {
        throw invalidRequest('The frozen report sources exceed the read budget. Narrow the export to one exact job/grade target; no evidence was omitted.')
      }
      return blob
    },
  }
  const comparisons = new Set<string>()
  const resumes = new Map<string, Promise<FrozenRealResumeSnapshot>>()
  const targets = new Map<string, Promise<FrozenRealAnalysisTargetSnapshot>>()
  const references = new Map<string, Promise<ReferenceDocument>>()
  const originals = new Map<string, Promise<void>>()
  let manifest: Promise<RealAnalysisInitializationManifest> | undefined
  const read = (reference: ImmutableBlobReference) => readAnalysisBlob(boundedBlobs, reference, run.workspaceId, run.id)
  const referenceDocument = (reference: ImmutableJsonBlobReference) => {
    const key = analysisHash(reference)
    let document = references.get(key)
    if (!document) {
      document = validatedReferenceDocument(boundedBlobs, run, reference)
      references.set(key, document)
    }
    return document
  }
  const snapshots = async (comparison: RealAnalysisComparisonRecord): Promise<AnalysisSnapshots> => {
    options.signal?.throwIfAborted()
    parseAnalysisEntity(comparison)
    comparisons.add(comparison.id)
    assertAnalysis(comparisons.size <= options.maxComparisons, 'Snapshot reader comparison budget exceeded.')
    const plan = await (manifest ??= readAnalysisManifest(boundedBlobs, run))
    assertComparisonManifestBinding(plan, comparison)
    let resume = resumes.get(comparison.resume.snapshotId)
    if (!resume) {
      resume = read(comparison.resume.blob).then(blob => parseFrozenResumeSnapshot(parseAnalysisJson(blob)))
      resumes.set(comparison.resume.snapshotId, resume)
    }
    let target = targets.get(comparison.target.snapshotId)
    if (!target) {
      target = (async () => {
        const saved = parseFrozenTargetSnapshot(parseAnalysisJson(await read(comparison.target.blob)))
        if (saved.kind === 'grade') {
          await bindReferenceDocuments(saved, referenceDocument)
        } else {
          const key = analysisHash(saved.original)
          let verified = originals.get(key)
          if (!verified) {
            verified = read(saved.original).then(() => undefined)
            originals.set(key, verified)
          }
          await verified
        }
        return saved
      })()
      targets.set(comparison.target.snapshotId, target)
    }
    const [resumeSnapshot, targetSnapshot] = await Promise.all([resume, target])
    options.signal?.throwIfAborted()
    const saved = { resumeSnapshot, targetSnapshot }
    assertSnapshotSummaryBinding(plan, comparison, saved)
    return saved
  }
  return {
    snapshots,
    async result(comparison, saved) {
      options.signal?.throwIfAborted()
      assertAnalysis(comparisons.has(comparison.id), 'Read the bound snapshots before reading a report result.')
      return readAnalysisResult(boundedBlobs, run, comparison, saved)
    },
  }
}
