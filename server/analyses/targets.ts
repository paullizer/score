import type {
  FrozenJobTargetSnapshot, FrozenGradeTargetSnapshot, FrozenRealResumeSnapshot,
  RealAnalysisResumeSelection, RealAnalysisTargetSelection, RealAnalysisTargetSummary,
  RealAnalysisTargetsPage, RealGradeTargetSelection, RealGradeTargetSummary, RealJobTargetSelection, RealJobTargetSummary,
} from '../../src/domain/real-analyses'
import {
  gradeHeadId, type GradeEntity, type GradeHeadRecord, type ReferenceDocument,
} from '../../src/domain/real-grades'
import type { RealResumeProfile, RealResumeRecord } from '../../src/domain/real-resumes'
import type { RealJobRecord } from '../../src/domain/real-jobs'
import { WORD_DOCUMENT_LIMITS, isOriginalContentType, isWordContentType, originalExtension } from '../../src/domain/document-formats'
import { MAX_MARKDOWN_BYTES } from '../../src/domain/source-files'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { RealResumesDeps } from '../resumes/store'
import {
  blobInGrade, parseGradeEntity, parseGradeSeedSnapshot, validateGradeApproval, validateReferenceDocument,
} from '../grades/validation'
import { validateRealJobRecord, validateRealRubric, validateRealSourceDocument } from '../jobs/validation'
import { parseResumeEntity, parseRealResumeProfile, parseResumeCaptureManifest } from '../resumes/validation'
import { conflict, invalidRequest, notFound, unavailable } from '../errors'
import type { AnalysisBlob, AnalysisBlobStore } from './store'
import {
  analysisBytesHash, analysisHash, analysisTargetSummaryId, assertAnalysis, parseFrozenResumeSnapshot,
  parseFrozenTargetSnapshot, analysisRequirementEvidence, parseAnalysisTargetSummary, MAX_ANALYSIS_JSON_BYTES, MAX_ANALYSIS_ORIGINAL_BYTES,
} from './validation'
import { analysisPageCursor, analysisPageToken, validateAnalysisPage } from './paging'
import { parseAnalysisJson } from './snapshots'
import { analysisIsLocked } from './guards'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'

export interface AnalysisSourceDeps {
  resumes?: RealResumesDeps
  jobs?: RealJobsDeps
  grades?: RealGradesDeps
}
type ResolvedJob = Omit<FrozenJobTargetSnapshot, 'schemaVersion' | 'snapshotId' | 'workspaceId' | 'dataKind' | 'frozenAt' | 'original'> & {
  original: AnalysisBlob
}
type ResolvedGrade = Omit<FrozenGradeTargetSnapshot, 'schemaVersion' | 'snapshotId' | 'workspaceId' | 'dataKind' | 'frozenAt' | 'references'> & {
  references: { source: FrozenGradeTargetSnapshot['references'][number]['source']; document: ReferenceDocument; blob: AnalysisBlob }[]
}
export type ResolvedAnalysisTarget = ResolvedJob | ResolvedGrade

function checkedBlob(blob: AnalysisBlob | undefined, contentType: string, hash?: string, bytes?: number): AnalysisBlob {
  const maximum = isWordContentType(contentType) ? WORD_DOCUMENT_LIMITS.maxFileBytes
    : contentType === 'text/markdown' ? MAX_MARKDOWN_BYTES
    : contentType === 'application/json' ? MAX_ANALYSIS_JSON_BYTES : MAX_ANALYSIS_ORIGINAL_BYTES
  if (!blob || blob.contentType !== contentType || !blob.bytes.byteLength || blob.bytes.byteLength > maximum ||
    blob.sha256 !== analysisBytesHash(blob.bytes) || (hash !== undefined && blob.sha256 !== hash) ||
    (bytes !== undefined && blob.bytes.byteLength !== bytes)) throw unavailable('An exact captured analysis input is unavailable or has changed.')
  return blob
}
function validateJob(value: unknown, workspaceId: string, id?: string): RealJobRecord {
  if (!validateRealJobRecord(value) || value.workspaceId !== workspaceId || (id !== undefined && value.id !== id)) {
    throw notFound('The requested real job was not found in this workspace.')
  }
  return value
}

export class RealAnalysisTargets {
  constructor(private readonly deps: AnalysisSourceDeps) {}

  private async grade<K extends GradeEntity['recordType']>(
    workspaceId: string, id: string, kind: K, ladderId?: string,
  ): Promise<Extract<GradeEntity, { recordType: K }>> {
    if (!this.deps.grades) throw unavailable('Real grade targets are unavailable.')
    const value = await this.deps.grades.store.get(workspaceId, id)
    if (!value) throw notFound('The selected approved grade input was not found.')
    const record = parseGradeEntity(value.record)
    if (record.workspaceId !== workspaceId || record.id !== id || record.recordType !== kind ||
      (ladderId !== undefined && (!('ladderId' in record) || record.ladderId !== ladderId))) {
      throw notFound('The selected approved grade input was not found in this workspace.')
    }
    return record as Extract<GradeEntity, { recordType: K }>
  }

  private async jobTarget(workspaceId: string, job: RealJobRecord, selection?: RealJobTargetSelection): Promise<ResolvedJob[]> {
    if (!this.deps.jobs) throw unavailable('Real job targets are unavailable.')
    if ((await this.deps.jobs.store.getWorkspaceLifecycle(workspaceId)).state !== 'active') {
      throw conflict('The selected job workspace is archived or removed.')
    }
    if (analysisIsLocked(job.lifecycle) || analysisIsLocked(job.rubricLifecycle) || job.job.rubricDeletedAt) {
      throw conflict('Archived or removed jobs and job rubrics cannot be selected for new analysis work.')
    }
    if (job.job.status !== 'ready') throw conflict('Analysis requires a ready real job.')
    const source = job.source
    if (!job.extractedBlobName || !source.originalBlobName || !source.originalContentType || !source.sha256 || !source.bytes) {
      throw conflict('The selected job does not have complete captured evidence.')
    }
    const [documentValue, originalValue, savedRubrics] = await Promise.all([
      this.deps.jobs.blobs.read(job.extractedBlobName), this.deps.jobs.blobs.read(source.originalBlobName),
      this.deps.jobs.store.listRubrics(workspaceId, job.id),
    ])
    const documentBlob = checkedBlob(documentValue, 'application/json')
    const original = checkedBlob(originalValue, source.originalContentType, source.sha256, source.bytes)
    const document = parseAnalysisJson(documentBlob) as FrozenJobTargetSnapshot['document']
    if (validateRealSourceDocument(document, source.originalContentType).length || document.id !== job.job.documentId) {
      throw unavailable('The selected job document has invalid captured evidence.')
    }
    const rubrics = selection ? savedRubrics.filter(item => item.id === selection.rubricId && item.version === selection.rubricVersion) : savedRubrics
    if (!rubrics.length || (selection && rubrics.length !== 1)) throw conflict('The exact selected saved job rubric version is unavailable.')
    if (new Set(rubrics.map(item => `${item.id}:${item.version}`)).size !== rubrics.length) throw unavailable('Saved job rubric versions are duplicated.')
    return rubrics.map(rubric => {
      if (rubric.jobId !== job.id || validateRealRubric(rubric, document, source.originalContentType).length) {
        throw unavailable('The saved real job rubric has invalid source evidence.')
      }
      const exact: RealJobTargetSelection = {
        kind: 'job', jobId: job.id, rubricId: rubric.id, rubricVersion: rubric.version,
        rubricHash: analysisHash(rubric), documentId: document.id, documentVersion: document.version, documentSha256: documentBlob.sha256,
      }
      if (selection && analysisHash(selection) !== analysisHash(exact)) throw conflict('The selected job rubric or source hash is stale. Refresh targets and choose an exact version.')
      const summary: RealJobTargetSummary = {
        kind: 'job', id: analysisTargetSummaryId(exact), workspaceId, dataKind: 'real', selection: exact,
        ...(job.displayName !== undefined ? { displayName: job.displayName } : {}),
        label: job.job.title, sublabel: `${job.job.organization}${job.job.organization ? ' · ' : ''}${rubric.name} · v${rubric.version}`,
        rubricId: rubric.id, rubricVersion: rubric.version, criterionCount: rubric.criteria.length,
      }
      parseAnalysisTargetSummary(summary)
      const frozenRubric = rubric as FrozenJobTargetSnapshot['rubric']
      return {
        kind: 'job', selection: exact, summary, job: { ...job.job, rubricId: rubric.id, status: 'ready' },
        rubric: frozenRubric, document, source, original,
        requirementEvidence: analysisRequirementEvidence({ kind: 'job', rubric: frozenRubric }),
      }
    })
  }

  private async gradeEligible(workspaceId: string, head: GradeHeadRecord): Promise<boolean> {
    if (!this.deps.grades) throw unavailable('Real grade targets are unavailable.')
    const [ladder, workspace, family] = await Promise.all([
      this.grade(workspaceId, head.ladderId, 'grade-ladder'),
      this.deps.grades.store.getControl(workspaceId),
      this.deps.grades.store.getControl(workspaceId, head.ladderId),
    ])
    if (analysisIsLocked(head.lifecycle) || analysisIsLocked(ladder.lifecycle) ||
      (workspace && workspace.record.state !== 'active') || (family && family.record.state !== 'active')) return false
    if (!this.deps.jobs) throw unavailable('The approved grade seed eligibility is unavailable.')
    if ((await this.deps.jobs.store.getWorkspaceLifecycle(workspaceId)).state !== 'active') return false
    const seed = await this.deps.jobs.store.get(workspaceId, ladder.seedJobId)
    if (!seed) throw notFound('The approved grade seed job is no longer available for a new analysis.')
    const job = validateJob(seed.record, workspaceId, ladder.seedJobId)
    return !analysisIsLocked(job.lifecycle) && !analysisIsLocked(job.rubricLifecycle) && !job.job.rubricDeletedAt
  }

  private async gradeTarget(workspaceId: string, head: GradeHeadRecord, requested?: RealGradeTargetSelection): Promise<ResolvedGrade> {
    if (!this.deps.grades) throw unavailable('Real grade targets are unavailable.')
    if (!await this.gradeEligible(workspaceId, head)) throw conflict('Archived or removed ladders, grades, and seed rubrics cannot start new analysis work.')
    if (!head.approvedVersionId || !head.approvalId) throw conflict('This grade has no approved version.')
    // Current draft context, generation and review pointers are deliberately not used here.
    const [version, approval] = await Promise.all([
      this.grade(workspaceId, head.approvedVersionId, 'grade-version', head.ladderId),
      this.grade(workspaceId, head.approvalId, 'grade-approval', head.ladderId),
    ])
    const [review, sourceSet] = await Promise.all([
      this.grade(workspaceId, approval.reviewId, 'grade-review', head.ladderId),
      this.grade(workspaceId, version.sourceSetId, 'grade-source-set', head.ladderId),
    ])
    const selection: RealGradeTargetSelection = {
      kind: 'grade', ladderId: head.ladderId, grade: head.grade, versionId: version.id, version: version.version,
      versionHash: version.contentHash, approvalId: approval.id, reviewId: review.id,
      sourceSetId: sourceSet.id, sourceSetHash: sourceSet.contentHash,
    }
    if (requested && analysisHash(requested) !== analysisHash(selection)) {
      throw conflict('The exact approved grade selection is stale. Refresh targets rather than substituting a newer draft.')
    }
    const summary: RealGradeTargetSummary = {
      kind: 'grade', id: analysisTargetSummaryId(selection), workspaceId, dataKind: 'real', selection,
      label: version.rubric.name, sublabel: `${version.rubric.ladder} · GS-${version.grade} · approved v${version.version}`,
      rubricId: version.rubric.id, rubricVersion: version.version, criterionCount: version.rubric.criteria.length,
      context: sourceSet.context, approvedAt: approval.createdAt,
      newerDraftAvailable: Boolean(head.latestVersionId && head.latestVersionId !== version.id),
    }
    const seedBlob = checkedBlob(await this.deps.grades.blobs.read(sourceSet.seedBlobName), 'application/json')
    const seed = parseGradeSeedSnapshot(parseAnalysisJson(seedBlob)) as FrozenGradeTargetSnapshot['seed']
    const references: ResolvedGrade['references'] = []
    for (const source of sourceSet.sources) {
      if (!blobInGrade(source.documentBlobName, workspaceId, head.ladderId)) throw unavailable('Approved reference capture ownership is invalid.')
      const blob = checkedBlob(await this.deps.grades.blobs.read(source.documentBlobName), 'application/json')
      const document = parseAnalysisJson(blob) as ReferenceDocument
      if (validateReferenceDocument(document).length || document.id !== source.documentId || document.version !== source.documentVersion) {
        throw unavailable('An approved reference document is missing or invalid.')
      }
      references.push({ source, document, blob })
    }
    const seedReference = references.find(item => item.source.origin === 'seed-job')
    if (!seedReference || seedReference.document.id !== seed.document.id ||
      analysisHash(seedReference.document.paragraphs) !== analysisHash(seed.document.paragraphs) ||
      seedReference.source.sha256 !== seed.source.sha256) throw unavailable('The exact approved seed document is inconsistent.')
    if (validateGradeApproval(version, sourceSet, references.map(item => item.document)).length) {
      throw conflict('The approved version no longer has valid exact source-set evidence. No draft was substituted.')
    }
    if (review.outcome !== 'supported') throw conflict('This exact grade version does not have a supported grounding review.')
    const result: ResolvedGrade = {
      kind: 'grade', selection, summary, version, approval, review: { ...review, outcome: 'supported' }, sourceSet, seed, references,
      requirementEvidence: analysisRequirementEvidence({ kind: 'grade', version }),
    }
    // Reuse the worker's complete binding validation before exposing an eligible target.
    const previewRun = 'analysis-run-00000000-0000-4000-8000-000000000000'
    parseFrozenTargetSnapshot({
      ...result, schemaVersion: 1, snapshotId: 'analysis-snapshot-00000000-0000-4000-8000-000000000000',
      workspaceId, dataKind: 'real', frozenAt: approval.createdAt,
      references: references.map(item => ({
        source: item.source, document: {
          blobName: `${workspaceId}/${previewRun}/evidence/${item.blob.sha256}.json`,
          contentType: 'application/json', bytes: item.blob.bytes.byteLength, sha256: item.blob.sha256,
          documentId: item.document.id, documentVersion: item.document.version,
        },
      })),
    })
    return result
  }

  async resolve(workspaceId: string, selection: RealAnalysisTargetSelection): Promise<ResolvedAnalysisTarget> {
    assertWorkspaceMutationLease(workspaceId)
    if (selection.kind === 'job') {
      if (!this.deps.jobs) throw unavailable('Real job targets are unavailable.')
      const value = await this.deps.jobs.store.get(workspaceId, selection.jobId)
      if (!value) throw notFound('The selected real job was not found.')
      return (await this.jobTarget(workspaceId, validateJob(value.record, workspaceId, selection.jobId), selection))[0]
    }
    const head = await this.grade(workspaceId, gradeHeadId(selection.ladderId, selection.grade), 'grade-head', selection.ladderId)
    return this.gradeTarget(workspaceId, head, selection)
  }

  async list(workspaceId: string, continuationToken?: string, limit = 50): Promise<RealAnalysisTargetsPage> {
    validateAnalysisPage(limit, continuationToken)
    const scope = { workspaceId, kind: 'targets' as const }
    const after = analysisPageCursor(scope, continuationToken)
    if (after && !/^target-[a-f0-9]{48}$/.test(after)) throw invalidRequest('The target page cursor is invalid.')
    if (!this.deps.jobs && !this.deps.grades) throw unavailable('Real analysis target libraries are unavailable.')
    const summaries: RealAnalysisTargetSummary[] = []
    let count = 0
    if (this.deps.jobs && (await this.deps.jobs.store.getWorkspaceLifecycle(workspaceId)).state === 'active') {
      let token: string | undefined
      const seen = new Set<string>()
      do {
        const page = await this.deps.jobs.store.list(workspaceId, token)
        for (const value of page.jobs) {
          const job = validateJob(value.record, workspaceId)
          if (++count > 10_000) throw unavailable('The target library exceeds the safe discovery budget.')
          if (job.job.status === 'ready' && !analysisIsLocked(job.lifecycle) &&
            !analysisIsLocked(job.rubricLifecycle) && !job.job.rubricDeletedAt) {
            summaries.push(...(await this.jobTarget(workspaceId, job)).map(item => item.summary))
          }
          if (summaries.length > 10_000) throw unavailable('The saved target version library exceeds the safe discovery budget.')
        }
        token = page.continuationToken
        if (token && (seen.has(token) || seen.size >= 10_000)) throw unavailable('Job target pagination did not advance within the safe budget.')
        if (token) seen.add(token)
      } while (token)
    }
    if (this.deps.grades) {
      let token: string | undefined
      const seen = new Set<string>()
      do {
        const page = await this.deps.grades.store.list(workspaceId, { recordType: 'grade-head', limit: 100, continuationToken: token })
        for (const value of page.items) {
          const head = parseGradeEntity(value.record)
          if (head.recordType !== 'grade-head' || head.workspaceId !== workspaceId) throw unavailable('Grade target ownership is invalid.')
          if (++count > 10_000) throw unavailable('The target library exceeds the safe discovery budget.')
          if (head.approvedVersionId && head.approvalId && await this.gradeEligible(workspaceId, head)) {
            summaries.push((await this.gradeTarget(workspaceId, head)).summary)
          }
        }
        token = page.continuationToken
        if (token && (seen.has(token) || seen.size >= 10_000)) throw unavailable('Grade target pagination did not advance within the safe budget.')
        if (token) seen.add(token)
      } while (token)
    }
    if (new Set(summaries.map(item => item.id)).size !== summaries.length) throw unavailable('Target discovery returned duplicate identities.')
    const ordered = summaries.sort((a, b) => a.id.localeCompare(b.id)).filter(item => !after || item.id > after)
    const targets = ordered.slice(0, limit)
    return { targets, ...(ordered.length > limit ? { continuationToken: analysisPageToken(scope, targets.at(-1)!.id) } : {}) }
  }
}

export async function resolveAnalysisResume(
  deps: RealResumesDeps | undefined, workspaceId: string, selection: RealAnalysisResumeSelection, snapshotId: string, frozenAt: string,
): Promise<FrozenRealResumeSnapshot> {
  assertWorkspaceMutationLease(workspaceId)
  if (!deps) throw unavailable('Real resume sources are unavailable.')
  const stored = await deps.store.get(workspaceId, selection.resumeId)
  if (!stored) throw notFound('The selected real resume was not found.')
  const entity = parseResumeEntity(stored.record)
  if (entity.recordType !== 'resume' || entity.workspaceId !== workspaceId || entity.id !== selection.resumeId) {
    throw notFound('The selected resume was not found in this workspace.')
  }
  const record: RealResumeRecord = entity
  if (analysisIsLocked(record.lifecycle)) throw conflict('Archived or removed resumes cannot be selected for new analysis work.')
  const [workspace, control] = await Promise.all([deps.store.getControl(workspaceId), deps.store.getControl(workspaceId, record.id)])
  if ((workspace && workspace.record.state !== 'active') || (control && control.record.state !== 'active')) {
    throw conflict('The selected resume or its workspace is archived or removed.')
  }
  if (record.resume.status !== 'ready' || !record.capture || !record.captureManifest || !record.extraction || !record.profileBlob) {
    throw conflict('Every selected resume must be ready with complete captured source and profile evidence.')
  }
  const ref = record.extraction.document
  if (record.resume.documentId !== selection.documentId || record.resume.documentVersion !== selection.documentVersion ||
    ref.documentId !== selection.documentId || ref.documentVersion !== selection.documentVersion || ref.sha256 !== selection.documentSha256) {
    throw conflict('The selected resume document or hash is stale.')
  }
  const [documentBlob, profileBlob, original, captureBlob] = await Promise.all([
    deps.blobs.read(ref.blobName), deps.blobs.read(record.profileBlob.blobName), deps.blobs.read(record.capture.original.blobName),
    deps.blobs.read(record.captureManifest.blobName),
  ])
  const capture = parseResumeCaptureManifest(parseAnalysisJson(checkedBlob(
    captureBlob, 'application/json', record.captureManifest.sha256, record.captureManifest.bytes,
  )))
  if (capture.workspaceId !== workspaceId || capture.resumeId !== record.id || capture.inputFingerprint !== record.inputFingerprint ||
    analysisHash(capture.source) !== analysisHash(record.source) || analysisHash(capture.capture) !== analysisHash(record.capture)) {
    throw unavailable('The resume capture manifest does not bind this exact source.')
  }
  checkedBlob(original, record.capture.original.contentType, record.capture.original.sha256, record.capture.original.bytes)
  const document = parseAnalysisJson(checkedBlob(documentBlob, 'application/json', ref.sha256, ref.bytes))
  const profile: RealResumeProfile = parseRealResumeProfile(parseAnalysisJson(checkedBlob(
    profileBlob, 'application/json', record.profileBlob.sha256, record.profileBlob.bytes,
  )))
  return parseFrozenResumeSnapshot({
    schemaVersion: 1, snapshotId, workspaceId, dataKind: 'real', frozenAt, selection,
    ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
    resume: record.resume, source: record.source, capture: record.capture, extraction: record.extraction, profile, document,
  })
}

export async function copyAnalysisTargetEvidence(
  blobs: AnalysisBlobStore, workspaceId: string, runId: string, resolved: ResolvedAnalysisTarget, snapshotId: string, frozenAt: string,
): Promise<FrozenJobTargetSnapshot | FrozenGradeTargetSnapshot> {
  const base = { schemaVersion: 1 as const, snapshotId, workspaceId, dataKind: 'real' as const, frozenAt }
  if (resolved.kind === 'job') {
    const original = resolved.original
    assertAnalysis(isOriginalContentType(original.contentType), 'Unsupported captured job original content type.')
    const blobName = `${workspaceId}/${runId}/evidence/${original.sha256}.${originalExtension(original.contentType)}`
    const saved = (await blobs.putImmutable(blobName, original.bytes, original.contentType)).blob
    checkedBlob(saved, original.contentType, original.sha256, original.bytes.byteLength)
    return parseFrozenTargetSnapshot({
      ...resolved, ...base, original: { blobName, contentType: original.contentType, sha256: original.sha256, bytes: original.bytes.byteLength },
    }) as FrozenJobTargetSnapshot
  }
  const references: FrozenGradeTargetSnapshot['references'] = []
  for (const item of resolved.references) {
    const blobName = `${workspaceId}/${runId}/evidence/${item.blob.sha256}.json`
    const saved = (await blobs.putImmutable(blobName, item.blob.bytes, 'application/json')).blob
    checkedBlob(saved, 'application/json', item.blob.sha256, item.blob.bytes.byteLength)
    references.push({
      source: item.source, document: {
        blobName, contentType: 'application/json', sha256: saved.sha256, bytes: saved.bytes.byteLength,
        documentId: item.document.id, documentVersion: item.document.version,
      },
    })
  }
  assertAnalysis(references.length === resolved.sourceSet.sources.length, 'Not all references were copied.')
  return parseFrozenTargetSnapshot({ ...resolved, ...base, references }) as FrozenGradeTargetSnapshot
}
