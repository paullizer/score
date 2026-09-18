import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  GRADE_LADDER_LIMITS as LIMITS, gradeHeadId,
  type GradeEntity, type GradeHeadRecord, type GradeLadderDetail, type GradeLadderRecord,
  type GradeLadderSummary, type GradeLevelDetail, type GradeRubricVersionRecord, type GradeSeedSnapshot,
  type GradeSourceSetRecord, type GradeWorkRecord, type ReferenceDocument, type ReferenceSourceRecord,
  type VersionedGradeEntity, type FrozenReferenceSource, type GradeApprovalRecord, type SourceDecision,
  type GradeContext, type GradeIssue,
} from '../../src/domain/real-grades'
import type { RealJobRecord } from '../../src/domain/real-jobs'
import { isOriginalContentType, MAX_MARKDOWN_BYTES, originalFileExtension } from '../../src/domain/source-files'
import type { RealJobsDeps } from '../jobs/routes'
import {
  extractedBlobName, isBlobInJobPrefix, originalBlobName, validateRealJobRecord,
  validateRealRubric, validateRealSourceDocument,
} from '../jobs/validation'
import { conflict, invalidRequest, notFound, unavailable } from '../errors'
import { StoreConflictError, StoreNotFoundError } from '../store'
import { reconcileReferenceIssues } from '../../worker/references/issue-lifecycle'
import type { GradeBlob, GradeBlobStore, GradeStore, GradeTransaction } from './store'
import {
  addGradeUrlInputSchema, approveGradeInputSchema, blobInGrade, confirmGradeInputSchema,
  createGradeInputSchema, editGradeInputSchema, gradeActionInputSchema, gradeContentHash, gradeIssuesFor, gradeCoverageMatchesContext,
  gradeSourceSetHash, gradeVersionHash, isGradeId, parseGradeEntity, parseGradeSeedSnapshot, updateGradeInputSchema,
  validateGradeApproval, validateGradeVersion, validateReferenceDocument,
} from './validation'

export interface RealGradesDeps {
  readonly store: GradeStore
  readonly blobs: GradeBlobStore
}

type Kind = GradeEntity['recordType']
type Entity<K extends Kind> = Extract<GradeEntity, { recordType: K }>
type Stored<K extends Kind> = VersionedGradeEntity<Entity<K>>
type Operations = Map<string, GradeTransaction>
type CreateInput = z.infer<typeof createGradeInputSchema>
type ConfirmInput = z.infer<typeof confirmGradeInputSchema>
type ActionInput = z.infer<typeof gradeActionInputSchema>

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const copy = <T>(value: T): T => structuredClone(value)
const isActive = (work: GradeWorkRecord) => work.status === 'queued' || work.status === 'running'
const workGrade = (work: GradeWorkRecord) => 'grade' in work.input ? work.input.grade : undefined
const generationWork = (work: GradeWorkRecord) => 'generationId' in work.input
const replacement = (operations: Operations, current: VersionedGradeEntity, record: GradeEntity) =>
  operations.set(record.id, { kind: 'replace', record, etag: current.etag })
const creation = (operations: Operations, record: GradeEntity) => operations.set(record.id, { kind: 'create', record })

const receiptSchema = z.strictObject({
  operation: z.string().min(1).max(50), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ precision: 3 }), createdBy: z.string().min(1).max(200),
})
const initializationSchema = z.strictObject({
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), createdBy: z.string().min(1).max(200), seed: z.unknown(),
})

function json(blob: GradeBlob): unknown {
  if (blob.contentType !== 'application/json') throw unavailable('Captured grade data has invalid content metadata.')
  try { return JSON.parse(Buffer.from(blob.bytes).toString('utf8')) } catch {
    throw unavailable('Captured grade data could not be read.')
  }
}

function currentSourceSet(ladder: GradeLadderRecord, sourceSet: GradeSourceSetRecord): void {
  if (ladder.sourceSetId !== sourceSet.id || ladder.sourceRevision !== sourceSet.revision ||
    ladder.workspaceId !== sourceSet.workspaceId || ladder.id !== sourceSet.ladderId ||
    gradeContentHash(ladder.context) !== gradeContentHash(sourceSet.context) ||
    gradeContentHash(ladder.grades) !== gradeContentHash(sourceSet.grades)) {
    throw conflict('The source set is no longer current. Confirm the updated sources before generating.')
  }
}

function requireMatch(value: VersionedGradeEntity, expected: string): void {
  if (value.etag !== expected) throw conflict('This grade workflow changed since it was last loaded.')
}

function frozen(source: ReferenceSourceRecord): FrozenReferenceSource {
  if (source.status !== 'ready' || !source.documentBlobName || !source.originalBlobName || !source.sha256 ||
    !source.pageCount || source.completeness === 'pending') throw conflict('Only captured, ready sources can be confirmed.')
  return {
    sourceId: source.id, title: source.title, origin: source.origin, purpose: source.purpose, publisher: source.publisher,
    documentId: source.documentId, documentVersion: source.documentVersion,
    documentBlobName: source.documentBlobName, originalBlobName: source.originalBlobName, sha256: source.sha256,
    // Preserve legacy PDF/HTML snapshot shapes and hashes.
    ...(source.originalContentType === 'text/markdown' ? { originalContentType: source.originalContentType } : {}),
    ...(source.finalUrl ?? source.requestedUrl ? { url: source.finalUrl ?? source.requestedUrl } : {}),
    ...(source.intendedSection !== undefined ? { intendedSection: source.intendedSection } : {}),
    ...(source.revision !== undefined ? { revision: source.revision } : {}),
    authorityStatus: source.authorityStatus, coverage: copy(source.coverage), pageCount: source.pageCount,
    selectedPages: [...source.selectedPages], completeness: source.completeness, issues: copy(source.issues),
  }
}

function reviewedScope(
  source: FrozenReferenceSource, decision: SourceDecision, context: GradeContext, grades: number[],
): { source: FrozenReferenceSource; issue?: GradeIssue } {
  if (!context.confirmed || !decision.selected || decision.applicability !== 'applicable' || !decision.reason.trim() ||
    source.coverage.state === 'conflicting' || !gradeCoverageMatchesContext(source.coverage, context)) return { source }
  const suppliedAgency = ['upload', 'url'].includes(source.origin) && source.purpose === 'agency' &&
    source.authorityStatus === 'supplied'
  const conditionalOpm = source.origin === 'opm' && source.authorityStatus === 'current' && source.coverage.state === 'conditional'
  if (!conditionalOpm && !(suppliedAgency && (source.coverage.state !== 'confirmed' ||
    !source.coverage.series.length || !source.coverage.grades.length))) return { source }
  const functions = [...context.functions, ...(context.supervision === 'unknown' ? [] : [context.supervision])]
  return {
    source: {
      ...source,
      coverage: {
        ...source.coverage,
        series: source.coverage.series.length ? [...source.coverage.series] : [context.series],
        grades: source.coverage.grades.length ? [...source.coverage.grades] : [...grades],
        functions: source.coverage.functions.length ? [...source.coverage.functions] : functions,
        state: 'confirmed',
        explanation: `Reviewer-confirmed applicability to this frozen position context, not a finding of grade support or official OPM certification. Previously unspecified scope is limited to the reviewed context. Review reason: ${decision.reason}`,
      },
    },
    issue: {
      id: `reviewed-scope-${source.sourceId}`, code: 'reviewer-confirmed-scope', severity: 'warning', scope: 'source',
      sourceId: source.sourceId,
      message: `The reviewer confirmed applicability for this source set. Original recorded coverage state: ${source.coverage.state}. Original explanation: ${source.coverage.explanation} Source authority, explicit coverage limits, exemptions, missing sections, and substantive issues remain unchanged; exact grade evidence and independent semantic review are still required.`,
    },
  }
}

export class GradeService {
  private readonly store: GradeStore
  private readonly blobs: GradeBlobStore
  private readonly jobs?: RealJobsDeps
  private readonly clock: () => Date

  constructor(grades: RealGradesDeps, jobs?: RealJobsDeps, now?: () => Date) {
    this.store = grades.store
    this.blobs = grades.blobs
    this.jobs = jobs
    this.clock = now ?? (() => new Date())
  }

  private now(): string { return this.clock().toISOString() }

  private async optional<K extends Kind>(workspaceId: string, id: string, kind: K, ladderId?: string): Promise<Stored<K> | undefined> {
    const value = await this.store.get(workspaceId, id)
    if (!value) return undefined
    const record = parseGradeEntity(value.record)
    if (record.workspaceId !== workspaceId || record.id !== id || record.recordType !== kind ||
      (ladderId !== undefined && (!('ladderId' in record) || record.ladderId !== ladderId))) {
      throw notFound('The requested grade record was not found.')
    }
    return { record, etag: value.etag } as Stored<K>
  }

  private async get<K extends Kind>(workspaceId: string, id: string, kind: K, ladderId?: string): Promise<Stored<K>> {
    const value = await this.optional(workspaceId, id, kind, ladderId)
    if (!value) throw notFound('The requested grade record was not found.')
    return value
  }

  private async all<K extends Kind>(workspaceId: string, ladderId: string, kind: K, status?: string): Promise<Stored<K>[]> {
    const values: Stored<K>[] = []
    let continuationToken: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.store.list(workspaceId, { recordType: kind, ladderId, status, limit: 100, continuationToken })
      for (const item of page.items) {
        const record = parseGradeEntity(item.record)
        if (record.workspaceId !== workspaceId || record.recordType !== kind || !('ladderId' in record) || record.ladderId !== ladderId) {
          throw unavailable('A grade query returned invalid ownership.')
        }
        values.push({ record, etag: item.etag } as Stored<K>)
      }
      continuationToken = page.continuationToken
      if (continuationToken && (seen.has(continuationToken) || values.length > 10_000)) throw unavailable('The grade workflow is too large to load safely.')
      if (continuationToken) seen.add(continuationToken)
    } while (continuationToken)
    return values
  }

  private async active(workspaceId: string, ladderId: string): Promise<Stored<'grade-work'>[]> {
    const values = (await Promise.all(['queued', 'running'].map(status => this.all(workspaceId, ladderId, 'grade-work', status)))).flat()
    if (values.length > 65) throw conflict('Too many active stages. Let processing finish before changing this workflow.')
    return values
  }

  private async commit(workspaceId: string, operations: Operations): Promise<void> {
    const batch = [...operations.values()]
    for (const operation of batch) parseGradeEntity(operation.record)
    try { await this.store.transact(workspaceId, batch) } catch (error) {
      if (error instanceof StoreConflictError || error instanceof StoreNotFoundError) {
        throw conflict('The grade workflow changed before this operation could be saved. Reload and retry.')
      }
      throw error
    }
  }

  private async immutableJson(name: string, value: unknown): Promise<GradeBlob> {
    const result = await this.blobs.putImmutable(name, Buffer.from(JSON.stringify(value)), 'application/json')
    if (gradeContentHash(json(result.blob)) !== gradeContentHash(value)) {
      throw conflict('An immutable grade snapshot already exists with different content.')
    }
    return result.blob
  }

  private async receipt(workspaceId: string, ladderId: string, key: string, operation: string, input: unknown, actor: string) {
    const fingerprint = gradeContentHash({ operation, input })
    const candidate = { operation, fingerprint, createdAt: this.now(), createdBy: actor }
    const result = await this.blobs.putImmutable(
      `${workspaceId}/${ladderId}/requests/${key}.json`, Buffer.from(JSON.stringify(candidate)), 'application/json',
    )
    const receipt = receiptSchema.parse(json(result.blob))
    if (receipt.operation !== operation || receipt.fingerprint !== fingerprint) {
      throw conflict('This idempotency key has already been used for a different request.')
    }
    return receipt
  }

  private work(ladder: GradeLadderRecord, input: GradeWorkRecord['input'], timestamp: string, key: string = randomUUID(), fingerprint?: string): GradeWorkRecord {
    return {
      id: `grade-work-${key}`, recordType: 'grade-work', workspaceId: ladder.workspaceId, ladderId: ladder.id,
      createdAt: timestamp, updatedAt: timestamp, input, status: 'queued', attempts: 0, nextAttemptAt: timestamp,
      ...(fingerprint ? { requestFingerprint: fingerprint } : {}),
    }
  }

  private head(ladder: GradeLadderRecord, grade: number, timestamp: string): GradeHeadRecord {
    return {
      id: gradeHeadId(ladder.id, grade), recordType: 'grade-head', workspaceId: ladder.workspaceId,
      ladderId: ladder.id, grade, createdAt: timestamp, updatedAt: timestamp, status: 'draft', issues: [],
    }
  }

  private cancelWork(operations: Operations, value: Stored<'grade-work'>, timestamp: string): void {
    const record = { ...value.record, status: 'cancelled' as const, updatedAt: timestamp }
    delete record.lease
    delete record.nextAttemptAt
    replacement(operations, value, record)
  }

  private async invalidate(ladder: GradeLadderRecord, operations: Operations, timestamp: string, cancelDiscovery = true): Promise<void> {
    delete ladder.sourceSetId
    delete ladder.generationId
    ladder.sourceRevision += 1
    ladder.updatedAt = timestamp
    ladder.status = 'draft'
    const [work, heads] = await Promise.all([
      this.active(ladder.workspaceId, ladder.id), this.all(ladder.workspaceId, ladder.id, 'grade-head'),
    ])
    for (const item of work) {
      if (generationWork(item.record) || (cancelDiscovery && item.record.input.kind === 'discover')) this.cancelWork(operations, item, timestamp)
    }
    for (const item of heads) {
      const head = { ...item.record, status: 'draft' as const, updatedAt: timestamp }
      delete head.generationId
      delete head.latestReviewId
      delete head.error
      replacement(operations, item, head)
    }
    for (const grade of ladder.grades) {
      if (!heads.some(item => item.record.grade === grade)) creation(operations, this.head(ladder, grade, timestamp))
    }
  }

  private async summary(value: Stored<'grade-ladder'>): Promise<GradeLadderSummary> {
    const heads = await Promise.all(value.record.grades.map(grade =>
      this.get(value.record.workspaceId, gradeHeadId(value.record.id, grade), 'grade-head', value.record.id)))
    return { ladder: value.record, etag: value.etag, levels: heads.map(value => ({ head: value.record, etag: value.etag })) }
  }

  async list(workspaceId: string, continuationToken?: string, limit = 50) {
    const page = await this.store.list(workspaceId, { recordType: 'grade-ladder', continuationToken, limit })
    const ladders = await Promise.all(page.items.map(value => {
      const record = parseGradeEntity(value.record)
      if (record.recordType !== 'grade-ladder' || record.workspaceId !== workspaceId) throw unavailable('Invalid grade list ownership.')
      return this.summary({ record, etag: value.etag })
    }))
    return { ladders, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
  }

  async detail(workspaceId: string, ladderId: string): Promise<GradeLadderDetail> {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    const [base, sources, sourceSet, work] = await Promise.all([
      this.summary(current),
      Promise.all(current.record.sourceIds.map(id => this.get(workspaceId, id, 'grade-source', ladderId))),
      current.record.sourceSetId ? this.get(workspaceId, current.record.sourceSetId, 'grade-source-set', ladderId) : undefined,
      this.store.list(workspaceId, { recordType: 'grade-work', ladderId, limit: 100 }),
    ])
    const levels: GradeLevelDetail[] = await Promise.all(base.levels.map(async level => {
      const [version, review, approval] = await Promise.all([
        level.head.latestVersionId ? this.get(workspaceId, level.head.latestVersionId, 'grade-version', ladderId) : undefined,
        level.head.latestReviewId ? this.get(workspaceId, level.head.latestReviewId, 'grade-review', ladderId) : undefined,
        level.head.approvalId ? this.get(workspaceId, level.head.approvalId, 'grade-approval', ladderId) : undefined,
      ])
      if ([version?.record, review?.record, approval?.record].some(record => record && record.grade !== level.head.grade)) {
        throw unavailable('The stored grade head has invalid version ownership.')
      }
      return { ...level, version: version?.record ?? null, review: review?.record ?? null, approval: approval?.record ?? null }
    }))
    const workItems = work.items.map(item => {
      const record = parseGradeEntity(item.record)
      if (record.recordType !== 'grade-work' || record.workspaceId !== workspaceId || record.ladderId !== ladderId) {
        throw unavailable('The stored grade work has invalid ownership.')
      }
      return record
    })
    return { ...base, levels, sources: sources.map(source => source.record), sourceSet: sourceSet?.record ?? null, workItems }
  }

  private validateSeed(value: unknown, workspaceId: string, ladderId: string, input: CreateInput): GradeSeedSnapshot {
    const parsed = parseGradeSeedSnapshot(value)
    if (!parsed.job || !parsed.source || !parsed.document || !parsed.rubric ||
      parsed.job.id !== input.jobId || parsed.rubric.id !== input.rubricId ||
      parsed.rubric.version !== input.rubricVersion ||
      parsed.job.status !== 'ready' || parsed.job.documentId !== parsed.document.id ||
      parsed.rubric.jobId !== parsed.job.id ||
      parsed.source.originalBlobName !== `${workspaceId}/${ladderId}/source-${ladderId.slice(7)}/original.${originalFileExtension(parsed.source.originalContentType!)}`) {
      throw unavailable('The prepared seed has invalid ownership or version metadata.')
    }
    const check: RealJobRecord = {
      id: parsed.job.id, workspaceId, recordType: 'job', job: parsed.job,
      source: { ...parsed.source, originalBlobName: originalBlobName(workspaceId, parsed.job.id, parsed.source.originalContentType!) },
      extractedBlobName: extractedBlobName(workspaceId, parsed.job.id), inputFingerprint: 'captured-seed',
      createdBy: 'seed-capture', updatedAt: parsed.capturedAt, attempts: 0, warnings: [],
    }
    if (!validateRealJobRecord(check) || validateRealSourceDocument(parsed.document, parsed.source.originalContentType).length ||
      validateRealRubric(parsed.rubric, parsed.document, parsed.source.originalContentType).length) {
      throw unavailable('The prepared seed contains invalid job, rubric, or source data.')
    }
    return parsed
  }

  async create(workspaceId: string, key: string, input: CreateInput, actor: string): Promise<GradeLadderDetail> {
    const ladderId = `ladder-${key}`
    const fingerprint = gradeContentHash({ operation: 'create', input })
    const existing = await this.optional(workspaceId, ladderId, 'grade-ladder')
    if (existing) {
      if (existing.record.inputFingerprint !== fingerprint) throw conflict('This idempotency key was used for different ladder input.')
      return this.detail(workspaceId, ladderId)
    }
    const initializationName = `${workspaceId}/${ladderId}/initialization.json`
    let initializationBlob = await this.blobs.read(initializationName)
    if (!initializationBlob) {
      if (!this.jobs) throw unavailable('Real job access is required to capture a new grade-ladder seed.')
      const current = await this.jobs.store.get(workspaceId, input.jobId)
      if (!current || !validateRealJobRecord(current.record) || current.record.workspaceId !== workspaceId || current.record.id !== input.jobId) {
        throw notFound('The requested seed job was not found.')
      }
      if (current.record.job.status !== 'ready') throw conflict('Grade ladders require a ready real job.')
      const versions = await this.jobs.store.listRubrics(workspaceId, input.jobId)
      const rubric = versions.find(value => value.id === input.rubricId && value.version === input.rubricVersion)
      if (!rubric || rubric.jobId !== input.jobId) throw notFound('The selected saved job rubric version was not found.')
      const source = current.record.source
      if (!current.record.extractedBlobName || !source.originalBlobName || !source.originalContentType ||
        !isBlobInJobPrefix(current.record.extractedBlobName, workspaceId, input.jobId) ||
        !isBlobInJobPrefix(source.originalBlobName, workspaceId, input.jobId)) {
        throw conflict('The seed job does not have complete captured source evidence.')
      }
      const [documentBlob, original] = await Promise.all([
        this.jobs.blobs.read(current.record.extractedBlobName), this.jobs.blobs.read(source.originalBlobName),
      ])
      if (!documentBlob || !original || original.contentType !== source.originalContentType ||
        original.sha256 !== digest(original.bytes) || (source.sha256 && original.sha256 !== source.sha256) ||
        (source.bytes !== undefined && source.bytes !== original.bytes.byteLength) ||
        (source.originalContentType === 'text/markdown' && original.bytes.byteLength > MAX_MARKDOWN_BYTES)) {
        throw unavailable('The seed job evidence is unavailable or has changed.')
      }
      const document = json(documentBlob) as GradeSeedSnapshot['document']
      if (validateRealSourceDocument(document, source.originalContentType).length || document.id !== current.record.job.documentId ||
        validateRealRubric(rubric, document, source.originalContentType).length) {
        throw unavailable('The selected seed rubric or document has invalid stored evidence.')
      }
      const originalName = `${workspaceId}/${ladderId}/source-${key}/original.${originalFileExtension(source.originalContentType)}`
      const captured = await this.blobs.putImmutable(originalName, original.bytes, original.contentType)
      if (captured.blob.sha256 !== original.sha256 || digest(captured.blob.bytes) !== original.sha256 ||
        captured.blob.bytes.byteLength !== original.bytes.byteLength || captured.blob.contentType !== original.contentType) {
        throw conflict('The prepared seed original differs from this request. Use a new idempotency key.')
      }
      const seed: GradeSeedSnapshot = {
        job: { ...copy(current.record.job), rubricId: rubric.id }, rubric: copy(rubric), document,
        source: { ...copy(source), originalBlobName: originalName, sha256: original.sha256, bytes: original.bytes.byteLength },
        capturedAt: this.now(),
      }
      const candidate = { inputFingerprint: fingerprint, createdBy: actor, seed }
      initializationBlob = (await this.blobs.putImmutable(initializationName, Buffer.from(JSON.stringify(candidate)), 'application/json')).blob
    }
    // The winning Blob is the preparation record. Its timestamp and exact saved version survive
    // ambiguous Cosmos publication, changed job rubrics, and competing initializers.
    const prepared = initializationSchema.parse(json(initializationBlob))
    if (prepared.inputFingerprint !== fingerprint) throw conflict('This idempotency key was used for different ladder input.')
    const seed = this.validateSeed(prepared.seed, workspaceId, ladderId, input)
    const timestamp = seed.capturedAt
    await this.immutableJson(`${workspaceId}/${ladderId}/seed.json`, seed)
    const document: ReferenceDocument = {
      ...copy(seed.document), kind: 'reference', sample: false,
      pageCount: Math.max(...seed.document.paragraphs.map(paragraph => paragraph.page)), selectedPages: [], completeness: 'complete',
    }
    const documentName = `${workspaceId}/${ladderId}/source-${key}/document-v${document.version}.json`
    await this.immutableJson(documentName, document)
    const source: ReferenceSourceRecord = {
      id: `source-${key}`, recordType: 'grade-source', workspaceId, ladderId,
      createdAt: timestamp, updatedAt: timestamp, origin: 'seed-job', purpose: 'job-context',
      title: seed.job.title, publisher: seed.job.organization || 'Imported job',
      ...(seed.source.url ? { requestedUrl: seed.source.url } : {}),
      ...(seed.source.finalUrl ? { finalUrl: seed.source.finalUrl } : {}),
      redirects: [], discoveryPath: [], coverage: {
        series: [input.context.series], grades: [...input.grades], functions: [],
        state: 'confirmed', explanation: 'Captured role context, not an independent federal grading standard.',
      },
      authorityStatus: 'supplied', relatedLinks: [], status: 'ready', documentId: document.id,
      documentVersion: document.version, originalBlobName: seed.source.originalBlobName,
      originalContentType: seed.source.originalContentType, documentBlobName: documentName,
      sha256: seed.source.sha256, bytes: seed.source.bytes, capturedAt: timestamp,
      extractionMethod: 'seed-snapshot', extractionVersion: 'grade-seed-v1', completeness: 'complete',
      pageCount: document.pageCount, selectedPages: [], issues: [], inputFingerprint: fingerprint,
    }
    const ladder: GradeLadderRecord = {
      id: ladderId, recordType: 'grade-ladder', workspaceId, createdAt: timestamp, updatedAt: timestamp,
      name: input.name, context: copy(input.context), grades: [...input.grades],
      seedJobId: input.jobId, seedRubricId: seed.rubric.id, seedRubricVersion: seed.rubric.version,
      seedJobTitle: seed.job.title, seedBlobName: `${workspaceId}/${ladderId}/seed.json`,
      sourceIds: [source.id], sourceRevision: 1, status: 'discovering', issues: [],
      createdBy: prepared.createdBy, inputFingerprint: fingerprint,
    }
    const operations: Operations = new Map()
    for (const record of [ladder, source, this.work(ladder, { kind: 'discover' }, timestamp, key, fingerprint),
      ...input.grades.map(grade => this.head(ladder, grade, timestamp))]) creation(operations, record)
    try { await this.commit(workspaceId, operations) } catch (error) {
      const published = await this.optional(workspaceId, ladderId, 'grade-ladder')
      if (!published || published.record.inputFingerprint !== fingerprint) throw error
    }
    return this.detail(workspaceId, ladderId)
  }

  async update(workspaceId: string, ladderId: string, input: z.infer<typeof updateGradeInputSchema>, etag: string) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    requireMatch(current, etag)
    const ladder = { ...copy(current.record), ...copy(input), updatedAt: this.now() }
    const operations: Operations = new Map()
    if (gradeContentHash(current.record.context) !== gradeContentHash(ladder.context) ||
      gradeContentHash(current.record.grades) !== gradeContentHash(ladder.grades)) {
      await this.invalidate(ladder, operations, ladder.updatedAt)
      if (gradeContentHash(current.record.context) !== gradeContentHash(ladder.context)) delete ladder.discovery
    }
    replacement(operations, current, ladder)
    await this.commit(workspaceId, operations)
    return this.detail(workspaceId, ladderId)
  }

  async discover(workspaceId: string, ladderId: string, key: string, actor: string, etag: string) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    const receipt = await this.receipt(workspaceId, ladderId, key, 'discover', { etag }, actor)
    const existing = await this.optional(workspaceId, `grade-work-${key}`, 'grade-work', ladderId)
    if (existing) {
      if (existing.record.requestFingerprint !== receipt.fingerprint) throw conflict('This work key was already used.')
      return this.detail(workspaceId, ladderId)
    }
    requireMatch(current, etag)
    const ladder = copy(current.record)
    const operations: Operations = new Map()
    await this.invalidate(ladder, operations, receipt.createdAt)
    ladder.status = 'discovering'
    delete ladder.discovery
    creation(operations, this.work(ladder, { kind: 'discover' }, receipt.createdAt, key, receipt.fingerprint))
    replacement(operations, current, ladder)
    try { await this.commit(workspaceId, operations) } catch (error) {
      const published = await this.optional(workspaceId, `grade-work-${key}`, 'grade-work', ladderId)
      if (published?.record.requestFingerprint !== receipt.fingerprint) throw error
    }
    return this.detail(workspaceId, ladderId)
  }

  private async addSource(
    workspaceId: string, ladderId: string, key: string, actor: string,
    input: { kind: 'pdf'; filename: string; bytes: Uint8Array; selectedPages: number[]; pageCount: number } |
      { kind: 'url'; url: string; selectedPages: number[] },
  ) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    const fingerprintInput = input.kind === 'pdf'
      ? { kind: 'pdf', filename: input.filename, sha256: digest(input.bytes), selectedPages: input.selectedPages }
      : input
    const receipt = await this.receipt(workspaceId, ladderId, key, 'add-source', fingerprintInput, actor)
    const sourceId = `source-${key}`
    const existing = await this.optional(workspaceId, sourceId, 'grade-source', ladderId)
    if (existing) {
      if (existing.record.inputFingerprint !== receipt.fingerprint) throw conflict('This source key was already used for different input.')
      return this.detail(workspaceId, ladderId)
    }
    const sources = await Promise.all(current.record.sourceIds.map(id => this.get(workspaceId, id, 'grade-source', ladderId)))
    if (sources.filter(value => value.record.origin !== 'seed-job').length >= LIMITS.maxSources) {
      throw invalidRequest(`A ladder supports at most ${LIMITS.maxSources} supporting references, in addition to its automatic seed.`)
    }
    const timestamp = receipt.createdAt
    const source: ReferenceSourceRecord = {
      id: sourceId, workspaceId, ladderId, recordType: 'grade-source', createdAt: timestamp, updatedAt: timestamp,
      origin: input.kind === 'pdf' ? 'upload' : 'url', purpose: 'agency',
      title: input.kind === 'pdf' ? input.filename : new URL(input.url).hostname,
      publisher: 'User-supplied agency reference',
      ...(input.kind === 'url' ? { requestedUrl: input.url } : {}),
      redirects: [], discoveryPath: [], coverage: {
        series: [], grades: [], functions: [], state: 'unknown',
        explanation: 'Applicability must be established from the captured document; submission does not establish federal authority.',
      },
      authorityStatus: 'supplied', relatedLinks: [], status: 'queued', documentId: `reference-${key}`, documentVersion: 1,
      completeness: 'pending', selectedPages: [...input.selectedPages], issues: [], inputFingerprint: receipt.fingerprint,
    }
    if (input.kind === 'pdf') {
      source.originalBlobName = `${workspaceId}/${ladderId}/${sourceId}/original.pdf`
      source.originalContentType = 'application/pdf'
      source.pageCount = input.pageCount
      const original = await this.blobs.putImmutable(source.originalBlobName, input.bytes, 'application/pdf')
      if (original.blob.sha256 !== digest(input.bytes) || original.blob.contentType !== 'application/pdf') {
        throw conflict('The captured PDF already exists with different content.')
      }
      source.sha256 = original.blob.sha256
      source.bytes = original.blob.bytes.byteLength
      source.capturedAt = timestamp
    }
    const ladder = copy(current.record)
    const operations: Operations = new Map()
    await this.invalidate(ladder, operations, this.now(), false)
    ladder.sourceIds.push(sourceId)
    creation(operations, source)
    creation(operations, this.work(ladder, { kind: 'extract-source', sourceId, documentVersion: 1 }, timestamp, key, receipt.fingerprint))
    replacement(operations, current, ladder)
    try { await this.commit(workspaceId, operations) } catch (error) {
      const published = await this.optional(workspaceId, sourceId, 'grade-source', ladderId)
      if (published?.record.inputFingerprint !== receipt.fingerprint) throw error
    }
    return this.detail(workspaceId, ladderId)
  }

  async addPdf(workspaceId: string, ladderId: string, key: string, actor: string, filename: string,
    bytes: Uint8Array, selectedPages: number[], pageCount: number) {
    return this.addSource(workspaceId, ladderId, key, actor, { kind: 'pdf', filename, bytes, selectedPages, pageCount })
  }

  async addUrl(workspaceId: string, ladderId: string, key: string, actor: string, input: z.infer<typeof addGradeUrlInputSchema>) {
    return this.addSource(workspaceId, ladderId, key, actor, { kind: 'url', url: input.url, selectedPages: input.selectedPages ?? [] })
  }

  async selectPages(workspaceId: string, ladderId: string, sourceId: string, pages: number[], etag: string) {
    const [current, stored] = await Promise.all([
      this.get(workspaceId, ladderId, 'grade-ladder'), this.get(workspaceId, sourceId, 'grade-source', ladderId),
    ])
    requireMatch(current, etag)
    if (!current.record.sourceIds.includes(sourceId)) throw notFound('The source is not in this ladder.')
    if (stored.record.origin === 'seed-job') throw invalidRequest('The captured seed evidence cannot be changed.')
    if (stored.record.pageCount && (pages.some(page => page > stored.record.pageCount!) ||
      (!pages.length && stored.record.pageCount > LIMITS.maxPdfPages))) {
      throw invalidRequest('Page selection is outside the original document or exceeds the selected-page budget.')
    }
    if (gradeContentHash(pages) === gradeContentHash(stored.record.selectedPages)) return this.detail(workspaceId, ladderId)
    const timestamp = this.now()
    const source: ReferenceSourceRecord = {
      ...copy(stored.record), selectedPages: pages, documentVersion: stored.record.documentVersion + 1,
      completeness: 'pending', status: 'queued', updatedAt: timestamp,
      issues: stored.record.issues.filter(issue => !['reference-extraction-warning', 'reference-incomplete'].includes(issue.code)),
    }
    delete source.documentBlobName
    delete source.extractionMethod
    delete source.extractionVersion
    delete source.error
    const operations: Operations = new Map()
    const ladder = copy(current.record)
    await this.invalidate(ladder, operations, timestamp)
    for (const work of await this.active(workspaceId, ladderId)) {
      if (work.record.input.kind === 'extract-source' && work.record.input.sourceId === sourceId) this.cancelWork(operations, work, timestamp)
    }
    replacement(operations, stored, source)
    replacement(operations, current, ladder)
    creation(operations, this.work(ladder, { kind: 'extract-source', sourceId, documentVersion: source.documentVersion }, timestamp))
    await this.commit(workspaceId, operations)
    return this.detail(workspaceId, ladderId)
  }

  async sourceSet(workspaceId: string, ladderId: string, sourceSetId: string): Promise<GradeSourceSetRecord> {
    await this.get(workspaceId, ladderId, 'grade-ladder')
    return (await this.get(workspaceId, sourceSetId, 'grade-source-set', ladderId)).record
  }

  private async readReference(workspaceId: string, ladderId: string, source: FrozenReferenceSource): Promise<ReferenceDocument> {
    if (!blobInGrade(source.documentBlobName, workspaceId, ladderId) ||
      !source.documentBlobName.startsWith(`${workspaceId}/${ladderId}/${source.sourceId}/`)) {
      throw unavailable('The source document has invalid blob ownership.')
    }
    const blob = await this.blobs.read(source.documentBlobName)
    if (!blob) throw unavailable('The captured reference document is unavailable.')
    const document = json(blob) as ReferenceDocument
    if (validateReferenceDocument(document).length || document.id !== source.documentId ||
      document.version !== source.documentVersion || document.pageCount !== source.pageCount ||
      document.completeness !== source.completeness ||
      gradeContentHash([...document.selectedPages].sort((a, b) => a - b)) !== gradeContentHash([...source.selectedPages].sort((a, b) => a - b))) {
      throw unavailable('The captured reference document does not match its frozen source metadata.')
    }
    return document
  }

  private async resolveSource(workspaceId: string, ladderId: string, sourceId: string, sourceSetId?: string): Promise<FrozenReferenceSource> {
    const ladder = await this.get(workspaceId, ladderId, 'grade-ladder')
    if (sourceSetId !== undefined) {
      const set = await this.get(workspaceId, sourceSetId, 'grade-source-set', ladderId)
      const source = set.record.sources.find(value => value.sourceId === sourceId)
      if (!source) throw notFound('The source is not in the requested historical source set.')
      return source
    }
    if (!ladder.record.sourceIds.includes(sourceId)) throw notFound('The source is not in this ladder.')
    const source = (await this.get(workspaceId, sourceId, 'grade-source', ladderId)).record
    if (source.status !== 'ready') throw notFound('The source document extraction has not completed.')
    return frozen(source)
  }

  async document(workspaceId: string, ladderId: string, sourceId: string, sourceSetId?: string) {
    return this.readReference(workspaceId, ladderId, await this.resolveSource(workspaceId, ladderId, sourceId, sourceSetId))
  }

  async original(workspaceId: string, ladderId: string, sourceId: string, sourceSetId?: string): Promise<GradeBlob> {
    let name: string | undefined
    let sha256: string | undefined
    if (sourceSetId) {
      const source = await this.resolveSource(workspaceId, ladderId, sourceId, sourceSetId)
      name = source.originalBlobName
      sha256 = source.sha256
    } else {
      const ladder = await this.get(workspaceId, ladderId, 'grade-ladder')
      if (!ladder.record.sourceIds.includes(sourceId)) throw notFound('The source is not in this ladder.')
      const source = (await this.get(workspaceId, sourceId, 'grade-source', ladderId)).record
      name = source.originalBlobName
      sha256 = source.sha256
    }
    if (!name || !sha256) throw notFound('The original source has not been captured.')
    if (!blobInGrade(name, workspaceId, ladderId) || !name.startsWith(`${workspaceId}/${ladderId}/${sourceId}/`)) {
      throw unavailable('The source original has invalid blob ownership.')
    }
    const blob = await this.blobs.read(name)
    if (!blob) throw notFound('The captured source original is unavailable.')
    if (blob.sha256 !== sha256 || digest(blob.bytes) !== sha256 || !isOriginalContentType(blob.contentType) ||
      !name.endsWith(`/original.${originalFileExtension(blob.contentType)}`)) {
      throw unavailable('The captured source original does not match its immutable metadata.')
    }
    return blob
  }

  async confirm(workspaceId: string, ladderId: string, key: string, actor: string, input: ConfirmInput, etag: string) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    const receipt = await this.receipt(workspaceId, ladderId, key, 'confirm', { input, etag }, actor)
    const existing = await this.optional(workspaceId, `source-set-${key}`, 'grade-source-set', ladderId)
    if (existing) return this.detail(workspaceId, ladderId)
    requireMatch(current, etag)
    if (!current.record.context.confirmed) throw conflict('Confirm the position context before confirming sources.')
    const sources = await Promise.all(current.record.sourceIds.map(id => this.get(workspaceId, id, 'grade-source', ladderId)))
    if (input.decisions.some(decision => !current.record.sourceIds.includes(decision.sourceId))) {
      throw invalidRequest('A source decision refers to a source outside this ladder.')
    }
    const decisions = sources.map(({ record: source }) => {
      const provided = input.decisions.find(decision => decision.sourceId === source.id)
      if (source.origin === 'seed-job') {
        if (provided && (!provided.selected || provided.applicability !== 'applicable')) {
          throw invalidRequest('The captured seed is automatic role evidence and cannot be excluded.')
        }
        return { sourceId: source.id, selected: true, applicability: 'applicable' as const, reason: 'Automatically captured seed role context.' }
      }
      return provided ?? { sourceId: source.id, selected: false, applicability: 'excluded' as const, reason: 'Not selected for this source set.' }
    })
    const selected = sources.filter(source => decisions.find(decision => decision.sourceId === source.record.id)?.selected)
    const captured = selected.map(source => frozen(source.record))
    if (captured.filter(source => source.origin !== 'seed-job').length > LIMITS.maxSources ||
      captured.filter(source => source.origin !== 'seed-job' && source.originalBlobName.endsWith('.pdf')).reduce(
        (total, source) => total + (source.selectedPages.length || source.pageCount), 0,
      ) > LIMITS.maxTotalPdfPages) throw invalidRequest('The selected source set exceeds its supporting-reference or total PDF page budget.')
    const documents = await Promise.all(captured.map(source => this.readReference(workspaceId, ladderId, source)))
    const selectedTargets = selected.map((source, index) => ({ source: source.record, document: documents[index] }))
    const reviewed = selected.map(({ record: source }, index) => {
      let snapshot = captured[index]
      const method = source.extractionMethod
      if (source.extractionVersion && (method === 'document-intelligence' || method === 'html' || method === 'browser')) {
        const reconciled = reconcileReferenceIssues(source, {
          document: documents[index], method, extractionVersion: source.extractionVersion,
          links: source.relatedLinks, warnings: [],
        }, selectedTargets)
        snapshot = { ...snapshot, issues: reconciled.issues, issueResolutions: reconciled.resolved }
      }
      return reviewedScope(snapshot, decisions.find(decision => decision.sourceId === source.id)!,
        current.record.context, current.record.grades)
    })
    const snapshots = reviewed.map(value => value.source)
    const pending = await this.active(workspaceId, ladderId)
    if (pending.some(value => value.record.input.kind === 'discover')) {
      throw conflict('Wait for source discovery to finish or cancel it before confirming the source set.')
    }
    const timestamp = receipt.createdAt
    const sourceSet: GradeSourceSetRecord = {
      id: `source-set-${key}`, recordType: 'grade-source-set', workspaceId, ladderId,
      createdAt: timestamp, updatedAt: timestamp, revision: current.record.sourceRevision,
      context: copy(current.record.context), grades: [...current.record.grades], seedBlobName: current.record.seedBlobName,
      sources: snapshots, decisions: copy(decisions),
      issues: [...copy(current.record.issues), ...reviewed.flatMap(value => value.issue ? [value.issue] : [])],
      contentHash: '', confirmedBy: receipt.createdBy,
    }
    for (const decision of decisions) {
      if (!decision.selected) continue
      const source = snapshots.find(source => source.sourceId === decision.sourceId)!
      const unresolvedScope = decision.applicability === 'applicable' && source.origin !== 'seed-job' &&
        (source.coverage.state !== 'confirmed' || !gradeCoverageMatchesContext(source.coverage, current.record.context) ||
          (source.origin === 'opm' && source.authorityStatus !== 'current'))
      if ((decision.applicability !== 'applicable' && decision.applicability !== 'background') || unresolvedScope) {
        const affected = source.coverage.grades.length ? current.record.grades.filter(grade => source.coverage.grades.includes(grade)) : [undefined]
        for (const grade of affected) sourceSet.issues.push({
          id: `applicability-${decision.sourceId}-${grade ?? 'all'}`,
          code: 'unresolved-applicability',
          severity: 'blocker', scope: 'source', sourceId: decision.sourceId, ...(grade !== undefined ? { grade } : {}),
          message: unresolvedScope
            ? 'Recorded source authority or coverage remains unknown, contradictory, or incompatible with the confirmed context. Reviewer selection does not override those restrictions.'
            : 'Selected source applicability remains unresolved.',
        })
      }
    }
    sourceSet.contentHash = gradeSourceSetHash(sourceSet)
    const ladder = { ...copy(current.record), sourceSetId: sourceSet.id, status: 'sources-ready' as const, updatedAt: this.now() }
    delete ladder.generationId
    const operations: Operations = new Map()
    for (const work of pending) if (generationWork(work.record)) this.cancelWork(operations, work, ladder.updatedAt)
    const heads = await this.all(workspaceId, ladderId, 'grade-head')
    for (const currentHead of heads) {
      const head = { ...currentHead.record, status: 'draft' as const, updatedAt: ladder.updatedAt }
      delete head.generationId
      delete head.latestReviewId
      delete head.error
      replacement(operations, currentHead, head)
    }
    // Source ETags and the ladder revision are guarded in the same partition batch as the freeze.
    for (const source of selected) replacement(operations, source, source.record)
    creation(operations, sourceSet)
    replacement(operations, current, ladder)
    try { await this.commit(workspaceId, operations) } catch (error) {
      if (!await this.optional(workspaceId, sourceSet.id, 'grade-source-set', ladderId)) throw error
    }
    return this.detail(workspaceId, ladderId)
  }

  async generate(workspaceId: string, ladderId: string, key: string, actor: string, etag: string) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    const receipt = await this.receipt(workspaceId, ladderId, key, 'generate', { etag }, actor)
    const existing = await this.optional(workspaceId, `grade-work-${key}`, 'grade-work', ladderId)
    if (existing) {
      if (existing.record.requestFingerprint !== receipt.fingerprint) throw conflict('This work key was already used.')
      return this.detail(workspaceId, ladderId)
    }
    requireMatch(current, etag)
    if (!current.record.sourceSetId) throw conflict('Confirm a source set before generating grade drafts.')
    const sourceSet = (await this.get(workspaceId, current.record.sourceSetId, 'grade-source-set', ladderId)).record
    currentSourceSet(current.record, sourceSet)
    const timestamp = this.now()
    const ladder: GradeLadderRecord = { ...copy(current.record), generationId: key, status: 'generating', updatedAt: timestamp }
    const operations: Operations = new Map()
    for (const work of await this.active(workspaceId, ladderId)) {
      if (generationWork(work.record)) this.cancelWork(operations, work, timestamp)
    }
    for (const grade of ladder.grades) {
      const currentHead = await this.get(workspaceId, gradeHeadId(ladderId, grade), 'grade-head', ladderId)
      const head: GradeHeadRecord = {
        ...copy(currentHead.record), status: 'queued', generationId: key, sourceSetId: sourceSet.id,
        updatedAt: timestamp, issues: gradeIssuesFor(sourceSet.issues, grade),
      }
      delete head.latestReviewId
      delete head.error
      replacement(operations, currentHead, head)
    }
    creation(operations, this.work(ladder, { kind: 'plan-competencies', sourceSetId: sourceSet.id, generationId: key }, receipt.createdAt, key, receipt.fingerprint))
    replacement(operations, current, ladder)
    try { await this.commit(workspaceId, operations) } catch (error) {
      const published = await this.optional(workspaceId, `grade-work-${key}`, 'grade-work', ladderId)
      if (published?.record.requestFingerprint !== receipt.fingerprint) throw error
    }
    return this.detail(workspaceId, ladderId)
  }

  private async activeVersion(workspaceId: string, ladderId: string, grade: number, etag: string) {
    const [ladder, head] = await Promise.all([
      this.get(workspaceId, ladderId, 'grade-ladder'), this.get(workspaceId, gradeHeadId(ladderId, grade), 'grade-head', ladderId),
    ])
    requireMatch(head, etag)
    if (!ladder.record.grades.includes(grade) || !head.record.latestVersionId || !head.record.sourceSetId ||
      !head.record.generationId || head.record.generationId !== ladder.record.generationId ||
      head.record.sourceSetId !== ladder.record.sourceSetId) {
      throw conflict('This grade is not a draft in the current source generation.')
    }
    const [version, sourceSet] = await Promise.all([
      this.get(workspaceId, head.record.latestVersionId, 'grade-version', ladderId),
      this.get(workspaceId, head.record.sourceSetId, 'grade-source-set', ladderId),
    ])
    if (version.record.grade !== grade || version.record.sourceSetId !== sourceSet.record.id ||
      version.record.generationId !== head.record.generationId) throw conflict('The grade head no longer matches this source generation.')
    currentSourceSet(ladder.record, sourceSet.record)
    return { ladder, head, version, sourceSet }
  }

  async edit(workspaceId: string, ladderId: string, grade: number, input: z.infer<typeof editGradeInputSchema>, actor: string, etag: string) {
    const current = await this.activeVersion(workspaceId, ladderId, grade, etag)
    const old = current.version.record
    const submitted = input.rubric
    if (submitted.id !== old.rubric.id || submitted.groupId !== old.rubric.groupId ||
      submitted.ladder !== old.rubric.ladder || submitted.grade !== old.rubric.grade ||
      submitted.jobId !== old.rubric.jobId || submitted.version !== old.version || submitted.createdAt !== old.rubric.createdAt) {
      throw invalidRequest('Draft identity, source generation, version, and provenance are server-owned.')
    }
    if (submitted.criteria.length !== old.rubric.criteria.length || submitted.criteria.some(criterion =>
      !old.rubric.criteria.some(previous => previous.id === criterion.id && previous.competencyId === criterion.competencyId))) {
      throw invalidRequest('The common competency identities cannot be changed by editing one grade.')
    }
    if (submitted.criteria.some(criterion => old.rubric.criteria.find(previous => previous.id === criterion.id)?.support !== criterion.support)) {
      throw invalidRequest('Criterion support classifications are server-owned and cannot be relabeled by a draft edit.')
    }
    const timestamp = this.now()
    const versionId = `grade-version-${randomUUID()}`
    const version: GradeRubricVersionRecord = {
      ...copy(old), id: versionId, version: old.version + 1,
      createdAt: timestamp, updatedAt: timestamp, createdBy: actor, contentHash: '',
      rubric: {
        ...copy(submitted), id: versionId, version: old.version + 1, createdAt: timestamp,
        provenance: {
          kind: 'edited', model: old.rubric.provenance?.model ?? 'grade-draft-editor',
          promptVersion: old.rubric.provenance?.promptVersion ?? 'grade-edit-v1',
        },
      },
      qualifications: copy(input.qualifications),
      issues: old.issues.filter(issue => issue.scope === 'context' || issue.scope === 'source'),
    }
    version.contentHash = gradeVersionHash(version)
    const documents = await Promise.all(current.sourceSet.record.sources.map(source => this.readReference(workspaceId, ladderId, source)))
    const errors = validateGradeVersion(version, current.sourceSet.record, documents)
    // Source gaps remain visible drafts. Editing cannot fabricate a quote, a grading authority,
    // protected-characteristic rule, or a complete-looking rubric with invalid scoring guidance.
    if (errors.length) throw invalidRequest(errors.slice(0, 20).join(' '))
    const head: GradeHeadRecord = {
      ...copy(current.head.record), latestVersionId: version.id, status: 'processing',
      updatedAt: timestamp, issues: gradeIssuesFor(version.issues, grade),
    }
    delete head.latestReviewId
    delete head.error
    const ladder = { ...copy(current.ladder.record), status: 'review' as const, updatedAt: timestamp }
    const operations: Operations = new Map()
    for (const work of await this.active(workspaceId, ladderId)) {
      if (workGrade(work.record) === grade) this.cancelWork(operations, work, timestamp)
    }
    creation(operations, version)
    creation(operations, this.work(ladder, {
      kind: 'review-grade', versionId: version.id, grade, sourceSetId: version.sourceSetId, generationId: version.generationId,
    }, timestamp))
    replacement(operations, current.head, head)
    replacement(operations, current.ladder, ladder)
    await this.commit(workspaceId, operations)
    return this.detail(workspaceId, ladderId)
  }

  async approve(workspaceId: string, ladderId: string, grade: number, input: z.infer<typeof approveGradeInputSchema>, actor: string, etag: string) {
    const current = await this.activeVersion(workspaceId, ladderId, grade, etag)
    const head = current.head.record
    if (head.status !== 'ready-for-review' || head.latestVersionId !== input.versionId || head.latestReviewId !== input.reviewId) {
      throw conflict('Approval requires the latest grade version and its successful grounding review.')
    }
    const review = (await this.get(workspaceId, input.reviewId, 'grade-review', ladderId)).record
    const version = current.version.record
    if (review.grade !== grade || review.versionId !== version.id || review.versionHash !== version.contentHash ||
      review.sourceSetId !== version.sourceSetId || review.outcome !== 'supported' ||
      version.contentHash !== gradeVersionHash(version)) {
      throw conflict('The semantic review does not support this exact latest version and source set.')
    }
    if (gradeIssuesFor([...current.ladder.record.issues, ...head.issues, ...review.issues], grade)
      .some(issue => issue.severity === 'blocker')) throw conflict('Unresolved content, source, or applicability blockers prevent approval.')
    const documents = await Promise.all(current.sourceSet.record.sources.map(source => this.readReference(workspaceId, ladderId, source)))
    const errors = validateGradeApproval(version, current.sourceSet.record, documents)
    if (errors.length) throw conflict(`Approval is blocked: ${errors.slice(0, 20).join(' ')}`)
    const timestamp = this.now()
    const approval: GradeApprovalRecord = {
      id: `grade-approval-${randomUUID()}`, recordType: 'grade-approval', workspaceId, ladderId, grade,
      createdAt: timestamp, updatedAt: timestamp, versionId: version.id, versionHash: version.contentHash,
      reviewId: review.id, sourceSetId: version.sourceSetId, approvedBy: actor,
    }
    const updatedHead: GradeHeadRecord = {
      ...copy(head), status: 'approved', approvedVersionId: version.id, approvalId: approval.id, updatedAt: timestamp,
    }
    const heads = await Promise.all(current.ladder.record.grades.map(value => this.get(workspaceId, gradeHeadId(ladderId, value), 'grade-head', ladderId)))
    const approved = heads.every(value => value.record.grade === grade ||
      (value.record.status === 'approved' && value.record.generationId === current.ladder.record.generationId &&
        value.record.sourceSetId === current.sourceSet.record.id))
    const ladder: GradeLadderRecord = { ...copy(current.ladder.record), status: approved ? 'approved' : 'review', updatedAt: timestamp }
    const operations: Operations = new Map()
    creation(operations, approval)
    replacement(operations, current.head, updatedHead)
    replacement(operations, current.ladder, ladder)
    await this.commit(workspaceId, operations)
    return this.detail(workspaceId, ladderId)
  }

  async versions(workspaceId: string, ladderId: string, grade: number, continuationToken?: string, limit = 50) {
    await this.get(workspaceId, ladderId, 'grade-ladder')
    await this.get(workspaceId, gradeHeadId(ladderId, grade), 'grade-head', ladderId)
    const page = await this.store.list(workspaceId, { recordType: 'grade-version', ladderId, grade, continuationToken, limit })
    const versions = page.items.map(value => {
      const record = parseGradeEntity(value.record)
      if (record.recordType !== 'grade-version' || record.workspaceId !== workspaceId ||
        record.ladderId !== ladderId || record.grade !== grade) throw unavailable('Invalid grade version history ownership.')
      return record
    })
    return { versions, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
  }

  private workIsCurrent(work: GradeWorkRecord, ladder: GradeLadderRecord): boolean {
    if ('generationId' in work.input) return work.input.generationId === ladder.generationId && work.input.sourceSetId === ladder.sourceSetId
    if (work.input.kind === 'extract-source') return ladder.sourceIds.includes(work.input.sourceId)
    return !ladder.sourceSetId
  }

  async action(workspaceId: string, ladderId: string, input: ActionInput, action: 'cancel' | 'retry', etag: string) {
    const current = await this.get(workspaceId, ladderId, 'grade-ladder')
    requireMatch(current, etag)
    if (input.grade !== undefined && !current.record.grades.includes(input.grade)) throw notFound('The requested grade is not in this ladder.')
    const timestamp = this.now()
    const work = await this.all(workspaceId, ladderId, 'grade-work')
    const explicit = input.workId ? await this.get(workspaceId, input.workId, 'grade-work', ladderId) : undefined
    let targets = explicit ? [explicit] : work.filter(value =>
      this.workIsCurrent(value.record, current.record) && (input.grade === undefined || workGrade(value.record) === input.grade))
    targets = targets.filter(value => action === 'cancel' ? isActive(value.record) : ['failed', 'cancelled'].includes(value.record.status))
    if (targets.length > 65) throw conflict('Too many stages for one action. Select an individual stage.')
    if (explicit && !targets.length) throw conflict(`The selected stage cannot be ${action === 'cancel' ? 'cancelled' : 'retried'}.`)
    if (action === 'retry') {
      if (!targets.length && input.grade !== undefined) {
        const head = await this.get(workspaceId, gradeHeadId(ladderId, input.grade), 'grade-head', ladderId)
        if (head.record.status !== 'cancelled' || !current.record.sourceSetId || !current.record.generationId ||
          head.record.sourceSetId !== current.record.sourceSetId || head.record.generationId !== current.record.generationId) {
          throw conflict('This grade has no current cancelled work to retry.')
        }
        const operations: Operations = new Map()
        const plan = (await this.all(workspaceId, ladderId, 'grade-competency-plan')).find(value =>
          value.record.generationId === current.record.generationId && value.record.sourceSetId === current.record.sourceSetId)
        if (plan) creation(operations, this.work(current.record, {
          kind: 'generate-grade', grade: input.grade, competencyPlanId: plan.record.id,
          generationId: current.record.generationId, sourceSetId: current.record.sourceSetId,
        }, timestamp))
        else if (!work.some(value => value.record.input.kind === 'plan-competencies' && isActive(value.record) &&
          this.workIsCurrent(value.record, current.record))) throw conflict('Retry competency planning before retrying this grade.')
        replacement(operations, head, { ...head.record, status: 'queued', updatedAt: timestamp })
        replacement(operations, current, { ...current.record, status: 'generating', updatedAt: timestamp })
        await this.commit(workspaceId, operations)
        return this.detail(workspaceId, ladderId)
      }
      if (!targets.length) throw conflict('There are no failed or cancelled current stages to retry. Add sources for unsupported grades instead.')
      const latestByInput = new Map<string, Stored<'grade-work'>>()
      for (const value of targets) {
        const key = gradeContentHash(value.record.input)
        const previous = latestByInput.get(key)
        if (!previous || previous.record.createdAt < value.record.createdAt) latestByInput.set(key, value)
      }
      targets = [...latestByInput.values()]
    }
    const operations: Operations = new Map()
    const affectedGrades = new Set<number>()
    for (const value of targets) {
      const record = copy(value.record)
      if (action === 'retry') {
        if (!this.workIsCurrent(record, current.record)) throw conflict('Superseded work cannot be retried. Start work against the current source set.')
        if (record.status === 'failed' && record.error && !record.error.retryable) {
          throw conflict('This stage has a terminal failure. Correct its input before starting new work.')
        }
        if (work.some(other => other.record.id !== record.id && isActive(other.record) &&
          gradeContentHash(other.record.input) === gradeContentHash(record.input))) {
          throw conflict('This stage already has active replacement work.')
        }
        if (record.input.kind === 'review-grade' || record.input.kind === 'generate-grade') {
          const head = await this.get(workspaceId, gradeHeadId(ladderId, record.input.grade), 'grade-head', ladderId)
          if (!['error', 'cancelled'].includes(head.record.status) ||
            head.record.generationId !== record.input.generationId || head.record.sourceSetId !== record.input.sourceSetId ||
            (record.input.kind === 'review-grade' && head.record.latestVersionId !== record.input.versionId)) {
            throw conflict('This work is no longer the failed or cancelled stage for the current grade version.')
          }
        }
        record.status = 'queued'
        record.attempts = 0
        record.nextAttemptAt = timestamp
        delete record.error
        delete record.lease
        record.updatedAt = timestamp
        replacement(operations, value, record)
      } else this.cancelWork(operations, value, timestamp)
      const grade = workGrade(record)
      if (grade !== undefined && this.workIsCurrent(record, current.record)) affectedGrades.add(grade)
      if (record.input.kind === 'plan-competencies' && this.workIsCurrent(record, current.record)) {
        for (const grade of current.record.grades) affectedGrades.add(grade)
      }
      if (record.input.kind === 'extract-source') {
        const source = await this.get(workspaceId, record.input.sourceId, 'grade-source', ladderId)
        if (action === 'retry' && (!['error', 'cancelled'].includes(source.record.status) ||
          (record.input.documentVersion !== undefined && record.input.documentVersion !== source.record.documentVersion))) {
          throw conflict('The current source extraction cannot be retried from this obsolete work item.')
        }
        if (record.input.documentVersion !== undefined && record.input.documentVersion !== source.record.documentVersion) continue
        const updated: ReferenceSourceRecord = {
          ...copy(source.record), status: action === 'retry' ? 'queued' : 'cancelled', updatedAt: timestamp,
        }
        delete updated.error
        replacement(operations, source, updated)
      }
    }
    if (input.grade !== undefined) affectedGrades.add(input.grade)
    const heads = await this.all(workspaceId, ladderId, 'grade-head')
    for (const value of heads) {
      if (!affectedGrades.has(value.record.grade) && (input.workId || input.grade !== undefined ||
        !['queued', 'processing', 'error', 'cancelled'].includes(value.record.status))) continue
      if (!current.record.grades.includes(value.record.grade) || ['approved', 'ready-for-review'].includes(value.record.status)) continue
      const updated: GradeHeadRecord = {
        ...copy(value.record), status: action === 'retry' ? 'queued' : 'cancelled', updatedAt: timestamp,
      }
      delete updated.error
      replacement(operations, value, updated)
    }
    const global = input.grade === undefined && input.workId === undefined
    const ladder: GradeLadderRecord = { ...copy(current.record), updatedAt: timestamp }
    if (action === 'cancel' && targets.some(value => value.record.input.kind === 'discover')) {
      ladder.sourceRevision += 1
      delete ladder.sourceSetId
      delete ladder.generationId
      delete ladder.discovery
      ladder.status = 'draft'
    }
    if (global && action === 'cancel') ladder.status = 'cancelled'
    else if (action === 'retry') {
      ladder.status = targets.some(value => value.record.input.kind === 'discover') ? 'discovering'
        : targets.some(value => generationWork(value.record)) ? 'generating' : 'draft'
    }
    replacement(operations, current, ladder)
    await this.commit(workspaceId, operations)
    return this.detail(workspaceId, ladderId)
  }
}

export function requireGradePathId(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !isGradeId(value, prefix)) throw notFound('The requested grade record was not found.')
  return value
}
