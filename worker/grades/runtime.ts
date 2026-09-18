import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { PDFDocument } from 'pdf-lib'
import {
  GRADE_LADDER_LIMITS, gradeHeadId, gradeRecordIs,
  type GradeCompetencyPlanRecord, type GradeEntity, type GradeHeadRecord,
  type GradeIssue, type GradeLadderRecord, type GradeProcessingError, type GradeReviewRecord,
  type GradeRubricVersionRecord, type GradeSeedSnapshot, type GradeSourceSetRecord,
  type GradeWorkInput, type GradeWorkRecord, type ReferenceDocument, type ReferenceSourceRecord,
  type OpmDiscoveryResult, type VersionedGradeEntity,
} from '../../src/domain/real-grades'
import type { GradeBlobStore, GradeListOptions, GradeStore, GradeTransaction } from '../../server/grades/store'
import { StoreConflictError } from '../../server/store'
import type {
  DiscoverOpmSources, DiscoveryOptions, ExtractReferenceDocument, FetchReferenceOriginal,
  ReferenceOriginal,
} from '../references/contracts'
import type {
  DraftGradeRubric, GradeModelInvoker, PlanGradeCompetencies, ReviewGradeRubric,
} from './contracts'
import type { DocumentIntelligenceClientOptions } from '../runtime'
import { GradeModelError } from './model-errors'
import { reconcileReferenceIssues } from '../references/issue-lifecycle'

const LEASE_MS = 120_000
const HEARTBEAT_MS = 25_000
const RUN_BUDGET_MS = 11 * 60_000
const MAX_ATTEMPTS = 3

export class GradeWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GradeWorkerError'
  }
}

class LostGradeWork extends Error {
  constructor() { super('The grade task was cancelled, superseded, or claimed by another worker.'); this.name = 'LostGradeWork' }
}

class DeferredGradeWork extends Error {
  constructor() { super('Processing will resume in the next worker execution.'); this.name = 'DeferredGradeWork' }
}

export interface GradeWorkerDependencies {
  store: GradeStore
  blobs: GradeBlobStore
  discover: DiscoverOpmSources
  fetchOriginal: FetchReferenceOriginal
  extractReference: ExtractReferenceDocument
  planCompetencies: PlanGradeCompetencies
  draftGrade: DraftGradeRubric
  reviewGrade: ReviewGradeRubric
  invokeModel: GradeModelInvoker
  documentIntelligence: Omit<DocumentIntelligenceClientOptions, 'signal'>
  sourceOptions?: Omit<DiscoveryOptions, 'signal'>
  parseSeed: (value: unknown) => GradeSeedSnapshot
  parseDocument: (value: unknown) => ReferenceDocument
  parseDiscovery: (value: unknown) => OpmDiscoveryResult
  validateVersion: (version: GradeRubricVersionRecord, sourceSet: GradeSourceSetRecord, documents: ReferenceDocument[]) => string[]
  recordHash: (record: GradeRubricVersionRecord | GradeSourceSetRecord) => string
  now?: () => Date
}

export interface GradeWorkerOptions {
  maxItems?: number
  budgetMilliseconds?: number
  owner?: string
  signal?: AbortSignal
}

function bytesOf(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function putArtifact(blobs: GradeBlobStore, name: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const result = await blobs.putImmutable(name, bytes, contentType)
  if (result.blob.contentType !== contentType || hash(result.blob.bytes) !== hash(bytes)) {
    throw new GradeWorkerError('immutable-grade-artifact-conflict', 'An existing immutable processing artifact differs from this result. Review the preserved source and start a new source or generation revision.')
  }
}

function derivedId(prefix: string, key: string): string {
  const value = hash(key).slice(0, 32)
  return `${prefix}-${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requireRecord<K extends GradeEntity['recordType']>(
  store: GradeStore, workspaceId: string, id: string, kind: K,
): Promise<VersionedGradeEntity<Extract<GradeEntity, { recordType: K }>>> {
  const value = await store.get(workspaceId, id)
  if (!value || value.record.workspaceId !== workspaceId || value.record.id !== id || !gradeRecordIs(value.record, kind)) {
    throw new GradeWorkerError('grade-record-missing', 'A required grade-workflow record is missing or has an unexpected type.')
  }
  return { record: value.record, etag: value.etag }
}

async function listRecords(store: GradeStore, workspaceId: string, options: GradeListOptions): Promise<VersionedGradeEntity[]> {
  const records: VersionedGradeEntity[] = []
  const tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await store.list(workspaceId, { ...options, limit: 100, continuationToken })
    for (const value of page.items) {
      if (value.record.workspaceId !== workspaceId || value.record.recordType !== options.recordType ||
        (options.ladderId && (!('ladderId' in value.record) || value.record.ladderId !== options.ladderId))) {
        throw new GradeWorkerError('grade-record-scope', 'The grade store returned a record outside the requested scope.')
      }
      records.push(value)
    }
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (tokens.has(continuationToken) || records.length > 10_000) {
        throw new GradeWorkerError('grade-pagination-invalid', 'The grade store pagination exceeded its supported bounds.')
      }
      tokens.add(continuationToken)
    }
  } while (continuationToken)
  return records
}

function scopedIssues(issues: GradeIssue[], grade: number): GradeIssue[] {
  return issues.filter(issue => issue.grade === undefined || issue.grade === grade)
}

function uniqueIssues(issues: GradeIssue[]): GradeIssue[] {
  return [...new Map(issues.map(issue => [`${issue.id}:${issue.grade ?? ''}:${issue.sourceId ?? ''}`, issue])).values()]
}

function workRecord(
  ladder: GradeLadderRecord, id: string, input: GradeWorkInput, now: string,
): GradeWorkRecord {
  return {
    id, workspaceId: ladder.workspaceId, ladderId: ladder.id, recordType: 'grade-work',
    input, status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
  }
}

function ensureSourceInLadder(source: ReferenceSourceRecord, ladder: GradeLadderRecord): void {
  if (source.workspaceId !== ladder.workspaceId || source.ladderId !== ladder.id || !ladder.sourceIds.includes(source.id)) {
    throw new LostGradeWork()
  }
}

function ensureGeneration(ladder: GradeLadderRecord, sourceSetId: string, generationId: string): void {
  if (ladder.sourceSetId !== sourceSetId || ladder.generationId !== generationId || ladder.status === 'cancelled') {
    throw new LostGradeWork()
  }
}

function ensureHeadGeneration(head: GradeHeadRecord, sourceSetId: string, generationId: string): void {
  if (head.sourceSetId !== sourceSetId || head.generationId !== generationId || head.status === 'cancelled') {
    throw new LostGradeWork()
  }
}

class GradeLease {
  private queue: Promise<unknown> = Promise.resolve()
  private timer?: NodeJS.Timeout
  private readonly controller = new AbortController()
  private readonly deadlineTimer: NodeJS.Timeout
  private readonly abortParent: () => void
  readonly signal: AbortSignal

  constructor(
    readonly claimed: VersionedGradeEntity<GradeWorkRecord>,
    private readonly store: GradeStore,
    private readonly owner: string,
    private readonly now: () => Date,
    deadline: number,
    private readonly parent?: AbortSignal,
  ) {
    this.signal = this.controller.signal
    this.abortParent = () => this.controller.abort(new DeferredGradeWork())
    this.deadlineTimer = setTimeout(this.abortParent, Math.max(1, deadline - now().getTime()))
    this.deadlineTimer.unref()
    if (parent?.aborted) this.abortParent()
    else parent?.addEventListener('abort', this.abortParent, { once: true })
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.atomic(async () => [], 'running').catch(error => {
        if (!(error instanceof LostGradeWork) && !this.signal.aborted) {
          console.error('Grade task heartbeat failed:', { taskId: this.claimed.record.id, name: error instanceof Error ? error.name : 'UnknownError' })
        }
        if (!this.signal.aborted) this.controller.abort(new LostGradeWork())
      })
    }, HEARTBEAT_MS)
    this.timer.unref()
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async current(allowAborted = false): Promise<VersionedGradeEntity<GradeWorkRecord>> {
    if (this.signal.aborted && !allowAborted) throw this.signal.reason
    const live = await requireRecord(this.store, this.claimed.record.workspaceId, this.claimed.record.id, 'grade-work')
    if (live.record.status !== 'running' || live.record.lease?.owner !== this.owner) throw new LostGradeWork()
    return live
  }

  async check(): Promise<void> {
    await this.exclusive(() => this.current())
  }

  async atomic(
    changes: (work: GradeWorkRecord) => Promise<GradeTransaction[]>,
    status: GradeWorkRecord['status'],
    finish?: Partial<Pick<GradeWorkRecord, 'error' | 'attempts' | 'nextAttemptAt'>>,
    allowAborted = false,
  ): Promise<void> {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const live = await this.current(allowAborted)
        const operations = await changes(live.record)
        if (this.signal.aborted && !allowAborted) throw this.signal.reason
        const currentTime = this.now()
        const record: GradeWorkRecord = {
          ...live.record, status, updatedAt: currentTime.toISOString(),
          lease: status === 'running' ? { owner: this.owner, expiresAt: new Date(currentTime.getTime() + LEASE_MS).toISOString() } : undefined,
          nextAttemptAt: status === 'running' ? new Date(currentTime.getTime() + LEASE_MS).toISOString() : undefined,
          error: undefined, ...finish,
        }
        try {
          await this.store.transact(record.workspaceId, [...operations, { kind: 'replace', record, etag: live.etag }])
          return
        } catch (error) {
          if (!(error instanceof StoreConflictError) || attempt === 7) throw error
        }
      }
    })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    clearTimeout(this.deadlineTimer)
    this.parent?.removeEventListener('abort', this.abortParent)
    await this.queue
  }
}

async function activeLadder(deps: GradeWorkerDependencies, work: GradeWorkRecord): Promise<VersionedGradeEntity<GradeLadderRecord>> {
  const ladder = await requireRecord(deps.store, work.workspaceId, work.ladderId, 'grade-ladder')
  if (ladder.record.status === 'cancelled') throw new LostGradeWork()
  return ladder
}

async function loadSourceSet(
  deps: GradeWorkerDependencies, work: GradeWorkRecord, sourceSetId: string, generationId: string,
): Promise<{ sourceSet: GradeSourceSetRecord; documents: ReferenceDocument[]; ladder: GradeLadderRecord }> {
  const { record: ladder } = await activeLadder(deps, work)
  ensureGeneration(ladder, sourceSetId, generationId)
  const { record: sourceSet } = await requireRecord(deps.store, work.workspaceId, sourceSetId, 'grade-source-set')
  if (sourceSet.ladderId !== ladder.id || sourceSet.revision !== ladder.sourceRevision ||
    sourceSet.seedBlobName !== ladder.seedBlobName ||
    deps.recordHash(sourceSet) !== sourceSet.contentHash) {
    throw new GradeWorkerError('source-set-integrity', 'The confirmed source set no longer matches its recorded inputs.')
  }
  const documents: ReferenceDocument[] = []
  for (const source of sourceSet.sources) {
    const blob = await deps.blobs.read(source.documentBlobName)
    if (!blob) throw new GradeWorkerError('reference-document-missing', 'A captured reference document is unavailable.')
    let document: ReferenceDocument
    try { document = deps.parseDocument(JSON.parse(Buffer.from(blob.bytes).toString('utf8'))) } catch (error) {
      throw new GradeWorkerError('reference-document-invalid', 'A captured reference document failed validation.', false, { cause: error })
    }
    if (document.id !== source.documentId || document.version !== source.documentVersion) {
      throw new GradeWorkerError('reference-version-mismatch', 'A captured reference does not match the confirmed document version.')
    }
    documents.push(document)
  }
  return { sourceSet, documents, ladder }
}

async function loadSeed(deps: GradeWorkerDependencies, ladder: GradeLadderRecord): Promise<GradeSeedSnapshot> {
  const blob = await deps.blobs.read(ladder.seedBlobName)
  if (!blob) throw new GradeWorkerError('seed-missing', 'The immutable source-job snapshot is unavailable.')
  let seed: GradeSeedSnapshot
  try { seed = deps.parseSeed(JSON.parse(Buffer.from(blob.bytes).toString('utf8'))) } catch (error) {
    throw new GradeWorkerError('seed-invalid', 'The captured source-job snapshot failed validation.', false, { cause: error })
  }
  if (seed.job.id !== ladder.seedJobId || seed.rubric.id !== ladder.seedRubricId || seed.rubric.version !== ladder.seedRubricVersion) {
    throw new GradeWorkerError('seed-version-mismatch', 'The source-job snapshot does not match the selected rubric version.')
  }
  return seed
}

async function discoverSources(deps: GradeWorkerDependencies, lease: GradeLease, now: () => Date): Promise<void> {
  const work = lease.claimed.record
  const before = await activeLadder(deps, work)
  const contextKey = JSON.stringify(before.record.context)
  const artifactBlobName = `${work.workspaceId}/${work.ladderId}/discovery-${work.id.replace(/^grade-work-/, '')}.json`
  const artifact = await deps.blobs.read(artifactBlobName)
  let discovered: OpmDiscoveryResult
  let capturedAt: string
  if (artifact) {
    const saved: unknown = JSON.parse(Buffer.from(artifact.bytes).toString('utf8'))
    if (!isObject(saved) || saved.contextKey !== contextKey || typeof saved.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(saved.capturedAt))) {
      throw new GradeWorkerError('discovery-snapshot-invalid', 'The saved discovery does not match this task context. Start a new source discovery.')
    }
    discovered = deps.parseDiscovery(saved.result)
    capturedAt = saved.capturedAt
  } else {
    discovered = await deps.discover(before.record.context, { ...deps.sourceOptions, signal: lease.signal })
    capturedAt = now().toISOString()
  }
  await lease.check()
  if (discovered.series !== before.record.context.series) {
    throw new GradeWorkerError('discovery-series-mismatch', 'OPM discovery returned references for a different occupational series.')
  }
  if (!artifact) await putArtifact(deps.blobs, artifactBlobName, bytesOf({ result: discovered, contextKey, capturedAt }), 'application/json')
  await lease.atomic(async () => {
    const current = await activeLadder(deps, work)
    if (JSON.stringify(current.record.context) !== contextKey) throw new LostGradeWork()
    const retained: ReferenceSourceRecord[] = []
    const removed = new Set<string>()
    for (const sourceId of current.record.sourceIds) {
      const { record } = await requireRecord(deps.store, work.workspaceId, sourceId, 'grade-source')
      ensureSourceInLadder(record, current.record)
      if (record.origin === 'opm') removed.add(sourceId)
      else retained.push(record)
    }
    const available = Math.max(0, GRADE_LADDER_LIMITS.maxSources - retained.filter(source => source.origin !== 'seed-job').length)
    const candidateMap = new Map(discovered.candidates.map(candidate => [
      `${candidate.url}\0${candidate.intendedSection ?? ''}\0${candidate.purpose}`, candidate,
    ]))
    const candidates = [...candidateMap.values()]
    const issues = [...discovered.issues]
    if (candidates.length > available) {
      issues.push({
        id: `source-limit-${work.id}`, code: 'reference-limit-reached', severity: 'blocker', scope: 'source',
        message: `Discovery found ${candidates.length} references but only ${available} supporting-source slots remain. Review or reduce references before approving any grade.`,
      })
    }
    const operations: GradeTransaction[] = []
    const sourceIds = retained.map(source => source.id)
    for (const [index, candidate] of candidates.slice(0, available).entries()) {
      const sourceId = derivedId('source', `${work.id}:${index}:${candidate.url}:${candidate.intendedSection ?? ''}`)
      const source: ReferenceSourceRecord = {
        id: sourceId, workspaceId: work.workspaceId, ladderId: work.ladderId, recordType: 'grade-source',
        createdAt: capturedAt, updatedAt: capturedAt, origin: 'opm', purpose: candidate.purpose,
        title: candidate.title, publisher: candidate.publisher, requestedUrl: candidate.url,
        intendedSection: candidate.intendedSection, redirects: [], discoveryPath: candidate.discoveryPath,
        coverage: candidate.coverage, revision: candidate.revision, authorityStatus: candidate.authorityStatus,
        relatedLinks: candidate.relatedLinks, status: 'queued', documentId: `document-${sourceId.slice('source-'.length)}`,
        documentVersion: 1, completeness: 'pending', selectedPages: [],
        issues: candidate.issues.map(issue => ({ ...issue, sourceId })),
        inputFingerprint: hash(`${candidate.url}\0${candidate.intendedSection ?? ''}\0${candidate.purpose}`),
      }
      sourceIds.push(sourceId)
      operations.push({ kind: 'create', record: source }, {
        kind: 'create',
        record: workRecord(current.record, derivedId('grade-work', `${work.id}:${sourceId}`), { kind: 'extract-source', sourceId, documentVersion: 1 }, capturedAt),
      })
    }
    if (removed.size) {
      const tasks = await listRecords(deps.store, work.workspaceId, { recordType: 'grade-work', ladderId: work.ladderId })
      for (const task of tasks) {
        if (gradeRecordIs(task.record, 'grade-work') && ['queued', 'running'].includes(task.record.status) &&
          task.record.input.kind === 'extract-source' && removed.has(task.record.input.sourceId)) {
          operations.push({ kind: 'replace', etag: task.etag, record: { ...task.record, status: 'cancelled', lease: undefined, nextAttemptAt: undefined, updatedAt: capturedAt } })
        }
      }
    }
    operations.push({
      kind: 'replace', etag: current.etag,
      record: {
        ...current.record, sourceIds, sourceRevision: current.record.sourceRevision + 1,
        sourceSetId: undefined, generationId: undefined, status: 'sources-ready', updatedAt: capturedAt, issues,
        discovery: {
          seriesTitle: discovered.seriesTitle, seriesStatus: discovered.seriesStatus, catalogVersion: discovered.catalogVersion,
          capturedAt, artifactBlobName,
        },
      },
    })
    return operations
  }, 'succeeded')
}

interface CaptureManifest {
  sourceId: string
  blobName: string
  contentType: ReferenceOriginal['contentType']
  sha256: string
  bytes: number
  capturedAt: string
  finalUrl?: string
  redirects: string[]
}

function parseCapture(value: unknown, source: ReferenceSourceRecord): CaptureManifest {
  if (!isObject(value) || value.sourceId !== source.id || typeof value.blobName !== 'string' ||
    !['application/pdf', 'text/html'].includes(String(value.contentType)) ||
    value.blobName !== `${source.workspaceId}/${source.ladderId}/${source.id}/original.${value.contentType === 'application/pdf' ? 'pdf' : 'html'}` ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
    typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) ||
    (value.finalUrl !== undefined && typeof value.finalUrl !== 'string') ||
    !Array.isArray(value.redirects) || value.redirects.some(url => typeof url !== 'string')) {
    throw new GradeWorkerError('reference-capture-invalid', 'The immutable source capture metadata is invalid.')
  }
  return {
    sourceId: source.id, blobName: value.blobName, contentType: value.contentType === 'application/pdf' ? 'application/pdf' : 'text/html',
    sha256: value.sha256, bytes: value.bytes, capturedAt: value.capturedAt,
    finalUrl: value.finalUrl, redirects: value.redirects,
  }
}

async function captureOriginal(
  deps: GradeWorkerDependencies, source: ReferenceSourceRecord, lease: GradeLease, now: () => Date,
): Promise<{ original: ReferenceOriginal; capture: CaptureManifest }> {
  if (source.originalBlobName) {
    const blob = await deps.blobs.read(source.originalBlobName)
    if (blob) {
      if (source.originalContentType !== 'application/pdf' && source.originalContentType !== 'text/html') {
        throw new GradeWorkerError('reference-content-type', 'The saved reference content type is missing.')
      }
      if (source.sha256 && source.sha256 !== hash(blob.bytes)) {
        throw new GradeWorkerError('reference-hash-mismatch', 'The original reference bytes do not match their recorded hash.')
      }
      return {
        original: { bytes: blob.bytes, contentType: source.originalContentType, finalUrl: source.finalUrl, redirects: source.redirects },
        capture: {
          sourceId: source.id, blobName: source.originalBlobName, contentType: source.originalContentType,
          sha256: hash(blob.bytes), bytes: blob.bytes.byteLength, capturedAt: source.capturedAt ?? source.createdAt,
          finalUrl: source.finalUrl, redirects: source.redirects,
        },
      }
    }
    if (source.origin === 'upload') throw new GradeWorkerError('uploaded-source-missing', 'The uploaded reference PDF is unavailable; add the source again.')
  }
  const manifestName = `${source.workspaceId}/${source.ladderId}/${source.id}/capture.json`
  const manifestBlob = await deps.blobs.read(manifestName)
  let manifest = manifestBlob ? parseCapture(JSON.parse(Buffer.from(manifestBlob.bytes).toString('utf8')), source) : undefined
  if (manifest) {
    const blob = await deps.blobs.read(manifest.blobName)
    if (blob) {
      if (hash(blob.bytes) !== manifest.sha256 || blob.bytes.byteLength !== manifest.bytes) {
        throw new GradeWorkerError('reference-hash-mismatch', 'The original reference does not match its immutable capture manifest.')
      }
      return { original: { bytes: blob.bytes, contentType: manifest.contentType, finalUrl: manifest.finalUrl, redirects: manifest.redirects }, capture: manifest }
    }
  }
  const original = await deps.fetchOriginal(source, { ...deps.sourceOptions, signal: lease.signal })
  await lease.check()
  const originalHash = hash(original.bytes)
  if (manifest && (manifest.sha256 !== originalHash || manifest.contentType !== original.contentType || manifest.finalUrl !== original.finalUrl)) {
    throw new GradeWorkerError('reference-changed-during-capture', 'The reference changed while its first capture was interrupted. Add it as a new source to review the changed evidence.')
  }
  manifest ??= {
    sourceId: source.id,
    blobName: `${source.workspaceId}/${source.ladderId}/${source.id}/original.${original.contentType === 'application/pdf' ? 'pdf' : 'html'}`,
    contentType: original.contentType, sha256: originalHash, bytes: original.bytes.byteLength,
    capturedAt: now().toISOString(), finalUrl: original.finalUrl, redirects: original.redirects,
  }
  if (!manifestBlob) await putArtifact(deps.blobs, manifestName, bytesOf(manifest), 'application/json')
  await lease.check()
  await putArtifact(deps.blobs, manifest.blobName, original.bytes, original.contentType)
  return { original, capture: manifest }
}

async function extractSource(deps: GradeWorkerDependencies, lease: GradeLease, now: () => Date): Promise<void> {
  const work = lease.claimed.record
  if (work.input.kind !== 'extract-source') throw new GradeWorkerError('invalid-work-kind', 'The task is not a reference-extraction task.')
  const sourceId = work.input.sourceId
  const currentLadder = await activeLadder(deps, work)
  const initial = await requireRecord(deps.store, work.workspaceId, sourceId, 'grade-source')
  ensureSourceInLadder(initial.record, currentLadder.record)
  if (initial.record.origin === 'seed-job') throw new GradeWorkerError('seed-not-extractable', 'The captured seed context must not be re-extracted as a reference.')
  const documentVersion = initial.record.documentVersion
  if (work.input.documentVersion !== undefined && work.input.documentVersion !== documentVersion) throw new LostGradeWork()
  const { original, capture } = await captureOriginal(deps, initial.record, lease, now)
  let pageCount: number | undefined
  if (original.contentType === 'application/pdf') {
    try { pageCount = (await PDFDocument.load(original.bytes, { updateMetadata: false })).getPageCount() } catch (error) {
      throw new GradeWorkerError('invalid-reference-pdf', 'The reference PDF is unreadable or password-protected.', false, { cause: error })
    }
  }
  let source = initial.record
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    const fresh = await requireRecord(deps.store, work.workspaceId, sourceId, 'grade-source')
    ensureSourceInLadder(fresh.record, ladder.record)
    if (fresh.record.documentVersion !== documentVersion || fresh.record.status === 'cancelled') throw new LostGradeWork()
    source = {
      ...fresh.record, status: 'extracting', originalBlobName: capture.blobName, originalContentType: capture.contentType,
      sha256: capture.sha256, bytes: capture.bytes, capturedAt: capture.capturedAt, finalUrl: capture.finalUrl,
      redirects: capture.redirects, pageCount, error: undefined, updatedAt: now().toISOString(),
    }
    return [
      { kind: 'replace', etag: fresh.etag, record: source },
      { kind: 'replace', etag: ladder.etag, record: { ...ladder.record, updatedAt: now().toISOString() } },
    ]
  }, 'running')
  if (pageCount !== undefined) {
    const selectedCount = source.selectedPages.length || pageCount
    if (selectedCount > GRADE_LADDER_LIMITS.maxPdfPages) {
      throw new GradeWorkerError('reference-pages-required', `This reference has ${pageCount} pages. Select at most ${GRADE_LADDER_LIMITS.maxPdfPages} relevant pages before retrying.`)
    }
    await lease.atomic(async () => {
      const ladder = await activeLadder(deps, work)
      let total = 0
      for (const id of ladder.record.sourceIds) {
        const { record } = await requireRecord(deps.store, work.workspaceId, id, 'grade-source')
        if (record.origin !== 'seed-job' && record.originalContentType === 'application/pdf' &&
          record.status !== 'cancelled' && record.status !== 'error') {
          total += record.selectedPages.length || record.pageCount || 0
        }
      }
      if (total > GRADE_LADDER_LIMITS.maxTotalPdfPages) {
        throw new GradeWorkerError('reference-page-budget', `The active reference selections exceed ${GRADE_LADDER_LIMITS.maxTotalPdfPages} PDF pages. Reduce page selections before retrying.`)
      }
      return [{ kind: 'replace', etag: ladder.etag, record: { ...ladder.record, updatedAt: now().toISOString() } }]
    }, 'running')
  }
  const chunkName = (key: string) => {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(key)) throw new GradeWorkerError('invalid-chunk-key', 'The reference extractor returned an unsafe cache key.')
    return `${work.workspaceId}/${work.ladderId}/${sourceId}/chunks/v${documentVersion}-${key}.json`
  }
  const extraction = await deps.extractReference(source, original, {
    ...deps.sourceOptions, documentIntelligence: deps.documentIntelligence, signal: lease.signal,
    readChunk: key => deps.blobs.read(chunkName(key)),
    writeChunk: async (key, bytes, contentType) => {
      await lease.check()
      await putArtifact(deps.blobs, chunkName(key), bytes, contentType)
    },
  })
  await lease.check()
  const document = deps.parseDocument(extraction.document)
  if (document.id !== source.documentId || document.version !== documentVersion) {
    throw new GradeWorkerError('extracted-version-mismatch', 'Reference extraction returned an unexpected document identity.')
  }
  const documentBlobName = `${work.workspaceId}/${work.ladderId}/${sourceId}/document-v${documentVersion}.json`
  await putArtifact(deps.blobs, documentBlobName, bytesOf(document), 'application/json')
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    const fresh = await requireRecord(deps.store, work.workspaceId, sourceId, 'grade-source')
    ensureSourceInLadder(fresh.record, ladder.record)
    if (fresh.record.documentVersion !== documentVersion || fresh.record.status === 'cancelled') throw new LostGradeWork()
    const warnings: GradeIssue[] = extraction.warnings.map((message, index) => ({
      id: `extraction-${sourceId}-${documentVersion}-${index}`, code: 'reference-extraction-warning',
      severity: 'warning', scope: 'source', sourceId, message,
    }))
    if (document.completeness === 'incomplete') warnings.push({
      id: `incomplete-${sourceId}-${documentVersion}`, code: 'reference-incomplete', severity: 'blocker', scope: 'source', sourceId,
      message: 'This reference extraction is incomplete. Supply the missing context before using it to approve grade expectations.',
    })
    const ready: ReferenceSourceRecord = {
      ...fresh.record, status: 'ready', documentBlobName, completeness: document.completeness,
      pageCount: document.pageCount, selectedPages: document.selectedPages, extractionMethod: extraction.method,
      extractionVersion: extraction.extractionVersion,
      relatedLinks: [...new Map([...fresh.record.relatedLinks, ...extraction.links].map(link => [`${link.url}:${link.relation}`, link])).values()],
      issues: uniqueIssues([...fresh.record.issues, ...warnings]), error: undefined, updatedAt: now().toISOString(),
    }
    ready.issueResolutions = reconcileReferenceIssues(ready, extraction).resolved
    return [
      { kind: 'replace', etag: fresh.etag, record: ready },
      { kind: 'replace', etag: ladder.etag, record: { ...ladder.record, updatedAt: now().toISOString() } },
    ]
  }, 'succeeded')
}

async function planCompetencies(deps: GradeWorkerDependencies, lease: GradeLease, now: () => Date): Promise<void> {
  const work = lease.claimed.record
  if (work.input.kind !== 'plan-competencies') throw new GradeWorkerError('invalid-work-kind', 'The task is not a competency-planning task.')
  const { sourceSetId, generationId } = work.input
  const input = await loadSourceSet(deps, work, sourceSetId, generationId)
  const seed = await loadSeed(deps, input.ladder)
  const result = await deps.planCompetencies({ seed, sourceSet: input.sourceSet, documents: input.documents }, deps.invokeModel, lease.signal)
  await lease.check()
  const createdAt = now().toISOString()
  const plan: GradeCompetencyPlanRecord = {
    id: derivedId('competency-plan', work.id), workspaceId: work.workspaceId, ladderId: work.ladderId,
    recordType: 'grade-competency-plan', createdAt, updatedAt: createdAt, sourceSetId, generationId,
    competencies: result.competencies, issues: result.issues, model: result.model, promptVersion: result.promptVersion,
  }
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    ensureGeneration(ladder.record, sourceSetId, generationId)
    const operations: GradeTransaction[] = [{ kind: 'create', record: plan }]
    for (const grade of input.sourceSet.grades) {
      const head = await requireRecord(deps.store, work.workspaceId, gradeHeadId(work.ladderId, grade), 'grade-head')
      if (head.record.status === 'cancelled') continue
      ensureHeadGeneration(head.record, sourceSetId, generationId)
      operations.push({
        kind: 'create',
        record: workRecord(ladder.record, derivedId('grade-work', `${work.id}:${grade}`), {
          kind: 'generate-grade', sourceSetId, generationId, competencyPlanId: plan.id, grade,
        }, createdAt),
      }, {
        kind: 'replace', etag: head.etag,
        record: { ...head.record, status: 'queued', issues: scopedIssues(result.issues, grade), error: undefined, updatedAt: createdAt },
      })
    }
    operations.push({
      kind: 'replace', etag: ladder.etag,
      record: { ...ladder.record, status: operations.some(operation => operation.record.recordType === 'grade-work') ? 'generating' : 'incomplete', updatedAt: createdAt },
    })
    return operations
  }, 'succeeded')
}

async function generateGrade(deps: GradeWorkerDependencies, lease: GradeLease, now: () => Date): Promise<void> {
  const work = lease.claimed.record
  if (work.input.kind !== 'generate-grade') throw new GradeWorkerError('invalid-work-kind', 'The task is not a grade-generation task.')
  const { sourceSetId, generationId, competencyPlanId, grade } = work.input
  const input = await loadSourceSet(deps, work, sourceSetId, generationId)
  if (!input.sourceSet.grades.includes(grade) || !input.ladder.grades.includes(grade)) throw new LostGradeWork()
  const { record: plan } = await requireRecord(deps.store, work.workspaceId, competencyPlanId, 'grade-competency-plan')
  if (plan.ladderId !== work.ladderId || plan.generationId !== generationId || plan.sourceSetId !== sourceSetId) {
    throw new GradeWorkerError('competency-plan-mismatch', 'The competency plan does not belong to this grade generation.')
  }
  const head = await requireRecord(deps.store, work.workspaceId, gradeHeadId(work.ladderId, grade), 'grade-head')
  ensureHeadGeneration(head.record, sourceSetId, generationId)
  const previousId = head.record.latestVersionId
  const previous = previousId ? await requireRecord(deps.store, work.workspaceId, previousId, 'grade-version') : undefined
  const versionId = derivedId('grade-version', work.id)
  const versionNumber = (previous?.record.version ?? 0) + 1
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    ensureGeneration(ladder.record, sourceSetId, generationId)
    const fresh = await requireRecord(deps.store, work.workspaceId, head.record.id, 'grade-head')
    ensureHeadGeneration(fresh.record, sourceSetId, generationId)
    if (fresh.record.latestVersionId !== previousId) throw new LostGradeWork()
    return [{ kind: 'replace', etag: fresh.etag, record: { ...fresh.record, status: 'processing', updatedAt: now().toISOString() } },
      { kind: 'replace', etag: ladder.etag, record: { ...ladder.record, updatedAt: now().toISOString() } }]
  }, 'running')
  const createdAt = now().toISOString()
  const result = await deps.draftGrade({
    ...input, competencies: plan.competencies, grade, versionId, version: versionNumber, createdAt,
  }, deps.invokeModel, lease.signal)
  await lease.check()
  const version: GradeRubricVersionRecord = {
    id: versionId, workspaceId: work.workspaceId, ladderId: work.ladderId, recordType: 'grade-version',
    grade, version: versionNumber, generationId, sourceSetId, rubric: result.rubric, qualifications: result.qualifications,
    issues: uniqueIssues([...scopedIssues(plan.issues, grade), ...result.issues]),
    createdAt, updatedAt: createdAt, createdBy: 'grade-worker', contentHash: '',
  }
  version.contentHash = deps.recordHash(version)
  const errors = deps.validateVersion(version, input.sourceSet, input.documents)
  if (errors.length) throw new GradeWorkerError('invalid-grade-output', `The generated grade did not pass source validation: ${errors.join(' ')}`)
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    ensureGeneration(ladder.record, sourceSetId, generationId)
    const fresh = await requireRecord(deps.store, work.workspaceId, head.record.id, 'grade-head')
    ensureHeadGeneration(fresh.record, sourceSetId, generationId)
    if (fresh.record.latestVersionId !== previousId) throw new LostGradeWork()
    return [
      { kind: 'create', record: version },
      {
        kind: 'create',
        record: workRecord(ladder.record, derivedId('grade-work', `${work.id}:review`), {
          kind: 'review-grade', grade, sourceSetId, generationId, versionId,
        }, now().toISOString()),
      },
      {
        kind: 'replace', etag: fresh.etag,
        record: { ...fresh.record, latestVersionId: versionId, latestReviewId: undefined, status: 'processing', issues: version.issues, error: undefined, updatedAt: now().toISOString() },
      },
      { kind: 'replace', etag: ladder.etag, record: { ...ladder.record, updatedAt: now().toISOString() } },
    ]
  }, 'succeeded')
}

async function reviewGrade(deps: GradeWorkerDependencies, lease: GradeLease, now: () => Date): Promise<void> {
  const work = lease.claimed.record
  if (work.input.kind !== 'review-grade') throw new GradeWorkerError('invalid-work-kind', 'The task is not a grade-review task.')
  const { sourceSetId, generationId, versionId, grade } = work.input
  const input = await loadSourceSet(deps, work, sourceSetId, generationId)
  if (!input.sourceSet.grades.includes(grade) || !input.ladder.grades.includes(grade)) throw new LostGradeWork()
  const { record: version } = await requireRecord(deps.store, work.workspaceId, versionId, 'grade-version')
  if (version.ladderId !== work.ladderId || version.grade !== grade || version.sourceSetId !== sourceSetId ||
    version.generationId !== generationId || deps.recordHash(version) !== version.contentHash) {
    throw new GradeWorkerError('grade-version-integrity', 'The grade draft does not match its saved generation and content hash.')
  }
  const currentHead = await requireRecord(deps.store, work.workspaceId, gradeHeadId(work.ladderId, grade), 'grade-head')
  ensureHeadGeneration(currentHead.record, sourceSetId, generationId)
  if (currentHead.record.latestVersionId !== versionId) throw new LostGradeWork()
  const result = await deps.reviewGrade({ version, sourceSet: input.sourceSet, documents: input.documents }, deps.invokeModel, lease.signal)
  await lease.check()
  const validationIssues: GradeIssue[] = deps.validateVersion(version, input.sourceSet, input.documents).map((message, index) => ({
    id: `validation-${versionId}-${index}`, code: 'grade-validation', severity: 'blocker', scope: 'grade', grade, message,
  }))
  const issues = uniqueIssues([
    ...scopedIssues(input.sourceSet.issues, grade), ...scopedIssues(version.issues, grade),
    ...scopedIssues(input.sourceSet.sources.flatMap(source => source.issues), grade),
    ...scopedIssues(result.issues, grade), ...validationIssues,
  ])
  const missing = version.rubric.criteria.some(criterion => criterion.support === 'gap') ||
    version.qualifications.some(qualification => qualification.support === 'gap')
  const complete = version.rubric.criteria.length > 0 &&
    Math.abs(version.rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0) - 100) < 0.000001
  const supported = result.outcome === 'supported' && !missing && complete && !issues.some(issue => issue.severity === 'blocker')
  if (!supported && !issues.some(issue => issue.severity === 'blocker')) issues.push({
    id: `incomplete-${versionId}`, code: 'grade-needs-sources', severity: 'blocker', scope: 'grade', grade,
    message: 'This grade needs additional source support or complete reviewable criteria before approval.',
  })
  const createdAt = now().toISOString()
  const review: GradeReviewRecord = {
    id: derivedId('grade-review', work.id), workspaceId: work.workspaceId, ladderId: work.ladderId, recordType: 'grade-review',
    grade, versionId, versionHash: version.contentHash, sourceSetId, outcome: supported ? 'supported' : 'needs-sources',
    issues, model: result.model, promptVersion: result.promptVersion, createdAt, updatedAt: createdAt,
  }
  await lease.atomic(async () => {
    const ladder = await activeLadder(deps, work)
    ensureGeneration(ladder.record, sourceSetId, generationId)
    const head = await requireRecord(deps.store, work.workspaceId, gradeHeadId(work.ladderId, grade), 'grade-head')
    ensureHeadGeneration(head.record, sourceSetId, generationId)
    if (head.record.latestVersionId !== versionId) throw new LostGradeWork()
    const nextHead: GradeHeadRecord = {
      ...head.record, latestReviewId: review.id, status: supported ? 'ready-for-review' : 'needs-sources',
      issues, error: undefined, updatedAt: createdAt,
    }
    const heads: GradeHeadRecord[] = []
    for (const selectedGrade of ladder.record.grades) {
      heads.push(selectedGrade === grade ? nextHead :
        (await requireRecord(deps.store, work.workspaceId, gradeHeadId(work.ladderId, selectedGrade), 'grade-head')).record)
    }
    const status = heads.some(item => ['queued', 'processing'].includes(item.status)) ? 'generating'
      : heads.some(item => ['needs-sources', 'error', 'cancelled'].includes(item.status)) ? 'incomplete' : 'review'
    return [
      { kind: 'create', record: review },
      { kind: 'replace', etag: head.etag, record: nextHead },
      { kind: 'replace', etag: ladder.etag, record: { ...ladder.record, status, updatedAt: createdAt } },
    ]
  }, 'succeeded')
}

function processingError(error: unknown): GradeProcessingError {
  const code = isObject(error) && typeof error.code === 'string' ? error.code : 'grade-processing-failed'
  const retryable = isObject(error) && typeof error.retryable === 'boolean' ? error.retryable :
    error instanceof StoreConflictError || error instanceof TypeError ||
    (isObject(error) && [408, 429, 500, 502, 503, 504].includes(Number(error.statusCode ?? error.status ?? error.code)))
  return {
    code, retryable,
    message: error instanceof Error ? error.message : 'The grade processing stage failed. Review the source and retry.',
  }
}

async function recordFailure(deps: GradeWorkerDependencies, lease: GradeLease, error: unknown, now: () => Date): Promise<void> {
  const failure = processingError(error)
  const deferred = error instanceof DeferredGradeWork
  const stale = error instanceof LostGradeWork
  await lease.atomic(async work => {
    if (stale) return []
    const ladder = await requireRecord(deps.store, work.workspaceId, work.ladderId, 'grade-ladder')
    const terminal = !deferred && (!failure.retryable || work.attempts >= MAX_ATTEMPTS)
    const sourceGap = error instanceof GradeModelError && error.code === 'model-context-limit'
    const modelIssues = error instanceof GradeModelError ? [...error.issues] : []
    const operations: GradeTransaction[] = []
    if (work.input.kind === 'extract-source') {
      const value = await deps.store.get(work.workspaceId, work.input.sourceId)
      if (value && gradeRecordIs(value.record, 'grade-source') && value.record.origin !== 'seed-job' &&
        ladder.record.sourceIds.includes(value.record.id) &&
        (work.input.documentVersion === undefined || work.input.documentVersion === value.record.documentVersion)) {
        operations.push({
          kind: 'replace', etag: value.etag,
          record: { ...value.record, status: terminal ? 'error' : 'queued', error: deferred ? undefined : failure, updatedAt: now().toISOString() },
        })
      }
    } else if (work.input.kind === 'generate-grade' || work.input.kind === 'review-grade') {
      const value = await deps.store.get(work.workspaceId, gradeHeadId(work.ladderId, work.input.grade))
      if (value && gradeRecordIs(value.record, 'grade-head') && value.record.generationId === work.input.generationId &&
        value.record.sourceSetId === work.input.sourceSetId &&
        (work.input.kind !== 'review-grade' || value.record.latestVersionId === work.input.versionId)) {
        operations.push({
          kind: 'replace', etag: value.etag,
          record: {
            ...value.record, status: terminal ? sourceGap ? 'needs-sources' : 'error' : 'queued',
            issues: uniqueIssues([...value.record.issues, ...scopedIssues(modelIssues, value.record.grade)]),
            error: deferred ? undefined : failure, updatedAt: now().toISOString(),
          },
        })
      }
    }
    const currentGeneration = !('generationId' in work.input) || work.input.generationId === ladder.record.generationId
    if (terminal && !stale && currentGeneration && ladder.record.status !== 'cancelled') {
      const issue: GradeIssue = {
        id: `processing-${work.id}`, code: failure.code, severity: 'warning', scope: 'source', message: failure.message,
        ...(work.input.kind === 'extract-source' ? { sourceId: work.input.sourceId } : {}),
        ...('grade' in work.input ? { grade: work.input.grade } : {}),
      }
      operations.push({
        kind: 'replace', etag: ladder.etag,
        record: {
          ...ladder.record, status: !sourceGap && ['discover', 'plan-competencies'].includes(work.input.kind) ? 'error' : 'incomplete',
          issues: uniqueIssues([...ladder.record.issues, ...modelIssues, issue]), updatedAt: now().toISOString(),
        },
      })
    }
    return operations
  }, stale ? 'cancelled' : deferred || (failure.retryable && lease.claimed.record.attempts < MAX_ATTEMPTS) ? 'queued' : 'failed', {
    error: deferred || stale ? undefined : failure,
    attempts: deferred ? Math.max(0, lease.claimed.record.attempts - 1) : lease.claimed.record.attempts,
    nextAttemptAt: deferred ? new Date(now().getTime() + 5000).toISOString() :
      !stale && failure.retryable && lease.claimed.record.attempts < MAX_ATTEMPTS
        ? new Date(now().getTime() + 30_000 * 2 ** (lease.claimed.record.attempts - 1)).toISOString() : undefined,
  }, true)
}

async function claim(
  deps: GradeWorkerDependencies, candidate: VersionedGradeEntity<GradeWorkRecord>, owner: string, now: () => Date,
): Promise<VersionedGradeEntity<GradeWorkRecord> | undefined> {
  const time = now()
  if (!['queued', 'running'].includes(candidate.record.status) ||
    (candidate.record.lease && Date.parse(candidate.record.lease.expiresAt) > time.getTime()) ||
    (candidate.record.nextAttemptAt && Date.parse(candidate.record.nextAttemptAt) > time.getTime())) return
  const record: GradeWorkRecord = {
    ...candidate.record, status: 'running', attempts: Math.min(candidate.record.attempts + 1, MAX_ATTEMPTS),
    lease: { owner, expiresAt: new Date(time.getTime() + LEASE_MS).toISOString() },
    nextAttemptAt: new Date(time.getTime() + LEASE_MS).toISOString(), error: undefined, updatedAt: time.toISOString(),
  }
  try {
    const result = await deps.store.replace(record, candidate.etag)
    if (!gradeRecordIs(result.record, 'grade-work')) throw new GradeWorkerError('work-record-type', 'The grade store returned an unexpected task type.')
    return { record: result.record, etag: result.etag }
  } catch (error) {
    if (error instanceof StoreConflictError) return
    throw error
  }
}

export async function processGradeWork(
  claimed: VersionedGradeEntity<GradeWorkRecord>, deps: GradeWorkerDependencies,
  options: { owner: string; deadline: number; signal?: AbortSignal; attemptLimitReached?: boolean },
): Promise<'succeeded' | 'failed' | 'deferred' | 'cancelled'> {
  const now = deps.now ?? (() => new Date())
  const lease = new GradeLease(claimed, deps.store, options.owner, now, options.deadline, options.signal)
  lease.start()
  try {
    await lease.check()
    if (options.attemptLimitReached) throw new GradeWorkerError('grade-attempt-limit', 'The stage stopped after three processing attempts.')
    switch (claimed.record.input.kind) {
      case 'discover': await discoverSources(deps, lease, now); break
      case 'extract-source': await extractSource(deps, lease, now); break
      case 'plan-competencies': await planCompetencies(deps, lease, now); break
      case 'generate-grade': await generateGrade(deps, lease, now); break
      case 'review-grade': await reviewGrade(deps, lease, now); break
    }
    return 'succeeded'
  } catch (caught) {
    const error = lease.signal.aborted ? lease.signal.reason : caught
    const authoritative = await deps.store.get(claimed.record.workspaceId, claimed.record.id)
    if (authoritative && gradeRecordIs(authoritative.record, 'grade-work') && authoritative.record.status === 'succeeded') {
      return 'succeeded'
    }
    if (authoritative && gradeRecordIs(authoritative.record, 'grade-work') && authoritative.record.status === 'cancelled') {
      return 'cancelled'
    }
    try { await recordFailure(deps, lease, error, now) } catch (failure) {
      if (!(failure instanceof LostGradeWork)) throw failure
    }
    if (error instanceof LostGradeWork) return 'cancelled'
    if (error instanceof DeferredGradeWork) return 'deferred'
    console.error('Grade processing stage failed:', {
      taskId: claimed.record.id, kind: claimed.record.input.kind, code: processingError(error).code,
    })
    return 'failed'
  } finally {
    await lease.stop()
  }
}

export async function runGradeWorker(
  deps: GradeWorkerDependencies, options: GradeWorkerOptions = {},
): Promise<{ claimed: number; succeeded: number; failed: number; deferred: number; cancelled: number }> {
  const maxItems = options.maxItems ?? 5
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) throw new GradeWorkerError('invalid-worker-limit', 'Grade worker maxItems must be between 1 and 20.')
  const now = deps.now ?? (() => new Date())
  const deadline = now().getTime() + (options.budgetMilliseconds ?? RUN_BUDGET_MS)
  const owner = options.owner ?? `grade-worker-${randomUUID()}`
  const results = { claimed: 0, succeeded: 0, failed: 0, deferred: 0, cancelled: 0 }
  const candidates = await deps.store.listPending(now().toISOString(), maxItems * 3)
  for (const candidate of candidates) {
    if (options.signal?.aborted || now().getTime() >= deadline || results.claimed >= maxItems) break
    const claimed = await claim(deps, candidate, owner, now)
    if (!claimed) continue
    results.claimed++
    const outcome = await processGradeWork(claimed, deps, {
      owner, deadline, signal: options.signal, attemptLimitReached: candidate.record.attempts >= MAX_ATTEMPTS,
    })
    results[outcome]++
    if (outcome === 'deferred') break
    await delay(0)
  }
  return results
}
