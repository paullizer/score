import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  GRADE_LADDER_LIMITS as LIMITS, gradeHeadId,
  type GradeEntity, type GradeIssue, type GradeRubricVersionRecord, type GradeSourceSetRecord,
  type ReferenceDocument, type FrozenReferenceSource, type GradeSeedSnapshot, type GradeContext, type ReferenceCoverage,
} from '../../src/domain/real-grades'
import type { Citation } from '../../src/domain/types'
import {
  UPLOAD_CONTENT_TYPES, WORD_DOCUMENT_LIMITS, isOriginalContentType, isWordContentType,
  originalExtension, storedDocumentContentType,
} from '../../src/domain/document-formats'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { originalBlobName, validateRealJobRecord, validateRealRubric, validateRealSourceDocument } from '../jobs/validation'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
const text = (max = 4000) => z.string().max(max).refine(value => value.trim().length > 0, 'Must not be blank.')
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-${UUID}$`))
const timestamp = z.iso.datetime({ precision: 3 })
const integer = z.number().int().min(1).max(1_000_000)
const grade = z.number().int().min(1).max(15)
const unique = <T>(values: T[]) => new Set(values).size === values.length
const grades = z.array(grade).min(1).max(LIMITS.maxGrades).refine(unique, 'Grades must be unique.')
const pages = z.array(z.number().int().min(1).max(100_000)).max(LIMITS.maxPdfPages).refine(unique, 'Pages must be unique.')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const url = z.string().max(LIMITS.maxUrlLength).url().refine(value => {
  const parsed = new URL(value)
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
}, 'Must be an HTTP(S) URL without credentials.')
const sourceId = id('source')
const purpose = z.enum(['grading', 'classification', 'qualification', 'agency', 'job-context', 'background', 'issuance'])
const origin = z.enum(['opm', 'upload', 'url', 'seed-job'])
const authority = z.enum(['current', 'superseded', 'unknown', 'conflicting', 'supplied'])
const completeness = z.enum(['complete', 'selected-pages', 'incomplete'])
const originalContentTypes = z.enum([
  UPLOAD_CONTENT_TYPES.pdf, UPLOAD_CONTENT_TYPES.docx, UPLOAD_CONTENT_TYPES.doc, 'text/html',
])

export const gradeContextSchema = z.strictObject({
  series: z.string().regex(/^\d{4}$/),
  agency: z.string().max(300),
  agencyType: z.enum(['dod', 'other-federal', 'non-federal', 'unknown']),
  supervision: z.enum(['nonsupervisory', 'supervisor', 'leader', 'unknown']),
  functions: z.array(z.enum(['research', 'development', 'test-evaluation'])).max(3).refine(unique),
  specialty: z.string().max(1000),
  confirmed: z.boolean(),
  answers: z.record(identifier, z.string().max(2000)).refine(value => Object.keys(value).length <= 30),
})

export const citationSchema = z.strictObject({
  documentId: identifier, documentVersion: integer, paragraphId: identifier,
  page: z.number().int().min(1).max(100_000), heading: z.string().max(2000), quote: text(32_000),
})
const citations = z.array(citationSchema).max(30)
const issueSchema = z.strictObject({
  id: identifier, code: identifier, severity: z.enum(['blocker', 'warning']),
  scope: z.enum(['context', 'source', 'grade', 'criterion', 'qualification']), message: text(8000),
  sourceId: sourceId.optional(), grade: grade.optional(), criterionId: identifier.optional(),
  citations: citations.optional(),
})
const issues = z.array(issueSchema).max(150)
const issueResolutions = z.array(z.strictObject({
  issue: issueSchema,
  reason: z.enum(['complete-source-extraction', 'captured-named-section', 'captured-reference-target']),
  evidence: z.strictObject({
    sourceId, documentId: identifier, documentVersion: integer, sha256: hash,
    targetUrl: url.optional(), intendedSection: z.string().max(2000).optional(),
  }),
})).max(150)
const error = z.strictObject({ code: identifier, message: text(2000), retryable: z.boolean() })
const coverage = z.strictObject({
  series: z.array(z.string().regex(/^\d{4}$/)).max(300).refine(unique),
  grades: z.array(grade).max(15).refine(unique),
  functions: z.array(text(100)).max(20).refine(unique),
  state: z.enum(['confirmed', 'conditional', 'unknown', 'conflicting']), explanation: text(4000),
})
const relatedLink = z.strictObject({
  url, label: text(500), relation: z.enum(['grading', 'qualification', 'exclusion', 'supersession', 'background']),
  page: integer.optional(),
})
const base = {
  id: identifier, workspaceId: z.string().regex(WORKSPACE_ID_PATTERN), createdAt: timestamp, updatedAt: timestamp,
}
const child = { ...base, ladderId: id('ladder') }
const blobName = z.string().max(700).refine(isSafeGradeBlobName, 'Invalid grade blob name.')
const provenance = z.strictObject({
  kind: z.enum(['generated', 'edited']), model: text(300), promptVersion: text(200),
})
const criterion = z.strictObject({
  id: identifier, key: z.enum(['technical', 'delivery', 'analysis', 'communication', 'leadership', 'policy', 'custom']),
  label: text(300), description: text(8000), weight: z.number().finite().min(0).max(100),
  guidance: z.string().max(12_000), sourceParagraphId: identifier.optional(),
  requirementType: z.enum(['required', 'preferred']).optional(), sourceCitations: citations.optional(),
  competencyId: identifier, support: z.enum(['direct', 'derived', 'gap', 'not-applicable']),
  gradeBasis: citations, interpretation: z.string().max(12_000),
})
export const editableGradeRubricSchema = z.strictObject({
  id: identifier, groupId: identifier, kind: z.literal('grade'), dataKind: z.literal('real'),
  jobId: id('job').optional(), ladder: text(300), grade: text(20),
  name: text(400), description: text(12_000), version: integer,
  criteria: z.array(criterion).max(LIMITS.maxCriteria), createdAt: timestamp,
})
const rubric = editableGradeRubricSchema.extend({ provenance })
export const gradeQualificationSchema = z.strictObject({
  id: identifier, text: text(32_000), citations, interpretation: z.string().max(12_000),
  support: z.enum(['direct', 'derived', 'gap']),
})
export const sourceDecisionSchema = z.strictObject({
  sourceId, selected: z.boolean(), applicability: z.enum(['applicable', 'background', 'excluded', 'uncertain']),
  reason: text(2000),
})

const frozenSource = z.strictObject({
  sourceId, title: text(500), origin, purpose, publisher: text(300),
  documentId: identifier, documentVersion: integer, documentBlobName: blobName, originalBlobName: blobName,
  sha256: hash, url: url.optional(), intendedSection: z.string().max(2000).optional(),
  revision: text(1000).optional(), authorityStatus: authority, coverage,
  pageCount: z.number().int().min(1).max(100_000), selectedPages: pages, completeness, issues,
  issueResolutions: issueResolutions.optional(),
})
const ladderSchema = z.strictObject({
  ...base, id: id('ladder'), recordType: z.literal('grade-ladder'),
  name: text(160), context: gradeContextSchema, grades,
  seedJobId: id('job'), seedRubricId: identifier, seedRubricVersion: integer, seedJobTitle: text(500),
  seedBlobName: blobName, sourceIds: z.array(sourceId).min(1).max(LIMITS.maxSources + 1).refine(unique),
  sourceRevision: integer, sourceSetId: id('source-set').optional(), generationId: identifier.optional(),
  discovery: z.strictObject({
    seriesTitle: text(500).optional(), seriesStatus: z.enum(['listed', 'retired', 'unknown', 'conflicting']),
    catalogVersion: text(200), capturedAt: timestamp, artifactBlobName: blobName,
  }).optional(),
  status: z.enum(['draft', 'discovering', 'sources-ready', 'generating', 'review', 'incomplete', 'approved', 'error', 'cancelled']),
  issues, createdBy: text(200), inputFingerprint: hash,
})
const sourceSchema = z.strictObject({
  ...child, id: sourceId, recordType: z.literal('grade-source'), origin, purpose,
  title: text(500), publisher: text(300), requestedUrl: url.optional(), finalUrl: url.optional(),
  intendedSection: z.string().max(2000).optional(), redirects: z.array(url).max(20),
  discoveryPath: z.array(z.string().max(LIMITS.maxUrlLength)).max(30),
  coverage, revision: text(1000).optional(), authorityStatus: authority,
  relatedLinks: z.array(relatedLink).max(LIMITS.maxReferenceLinks),
  status: z.enum(['queued', 'extracting', 'ready', 'error', 'cancelled']),
  documentId: identifier, documentVersion: integer,
  originalBlobName: blobName.optional(), originalContentType: originalContentTypes.optional(),
  documentBlobName: blobName.optional(), sha256: hash.optional(),
  bytes: z.number().int().min(1).max(24 * 1024 * 1024).optional(), capturedAt: timestamp.optional(),
  extractionMethod: z.enum(['document-intelligence', 'html', 'browser', 'seed-snapshot']).optional(),
  extractionVersion: text(200).optional(),
  completeness: z.enum(['pending', 'complete', 'selected-pages', 'incomplete']),
  pageCount: z.number().int().min(1).max(100_000).optional(), selectedPages: pages, issues,
  error: error.optional(), inputFingerprint: hash,
  issueResolutions: issueResolutions.optional(),
})
const sourceSetSchema = z.strictObject({
  ...child, id: id('source-set'), recordType: z.literal('grade-source-set'), revision: integer,
  context: gradeContextSchema, grades, seedBlobName: blobName,
  sources: z.array(frozenSource).min(1).max(LIMITS.maxSources + 1),
  decisions: z.array(sourceDecisionSchema).min(1).max(LIMITS.maxSources + 1),
  issues, contentHash: hash, confirmedBy: text(200),
})
const competencySchema = z.strictObject({
  id: identifier, label: text(300), description: text(8000),
  seedCriterionIds: z.array(identifier).max(LIMITS.maxCriteria).refine(unique), citations,
})
const planSchema = z.strictObject({
  ...child, id: id('competency-plan'), recordType: z.literal('grade-competency-plan'),
  generationId: identifier, sourceSetId: id('source-set'),
  competencies: z.array(competencySchema).min(1).max(LIMITS.maxCriteria), issues,
  model: text(300), promptVersion: text(200),
})
const versionSchema = z.strictObject({
  ...child, id: id('grade-version'), recordType: z.literal('grade-version'),
  grade, version: integer, generationId: identifier, sourceSetId: id('source-set'), rubric,
  qualifications: z.array(gradeQualificationSchema).max(50), issues,
  createdBy: text(200), contentHash: hash,
})
const reviewSchema = z.strictObject({
  ...child, id: id('grade-review'), recordType: z.literal('grade-review'), grade,
  versionId: id('grade-version'), versionHash: hash, sourceSetId: id('source-set'),
  outcome: z.enum(['supported', 'needs-sources']), issues, model: text(300), promptVersion: text(200),
})
const approvalSchema = z.strictObject({
  ...child, id: id('grade-approval'), recordType: z.literal('grade-approval'), grade,
  versionId: id('grade-version'), versionHash: hash, reviewId: id('grade-review'),
  sourceSetId: id('source-set'), approvedBy: text(200),
})
const headSchema = z.strictObject({
  ...child, recordType: z.literal('grade-head'), grade,
  status: z.enum(['draft', 'queued', 'processing', 'needs-sources', 'ready-for-review', 'approved', 'error', 'cancelled']),
  generationId: identifier.optional(), sourceSetId: id('source-set').optional(),
  latestVersionId: id('grade-version').optional(), latestReviewId: id('grade-review').optional(),
  approvedVersionId: id('grade-version').optional(), approvalId: id('grade-approval').optional(),
  issues, error: error.optional(),
})
const workInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('discover') }),
  z.strictObject({ kind: z.literal('extract-source'), sourceId, documentVersion: integer.optional() }),
  z.strictObject({ kind: z.literal('plan-competencies'), sourceSetId: id('source-set'), generationId: identifier }),
  z.strictObject({
    kind: z.literal('generate-grade'), sourceSetId: id('source-set'), generationId: identifier,
    competencyPlanId: id('competency-plan'), grade,
  }),
  z.strictObject({
    kind: z.literal('review-grade'), sourceSetId: id('source-set'), generationId: identifier,
    versionId: id('grade-version'), grade,
  }),
])
const workSchema = z.strictObject({
  ...child, id: id('grade-work'), recordType: z.literal('grade-work'), input: workInput,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number().int().min(0).max(1000), requestFingerprint: hash.optional(),
  nextAttemptAt: timestamp.optional(), lease: z.strictObject({ owner: text(200), expiresAt: timestamp }).optional(),
  error: error.optional(),
})
const entitySchema = z.discriminatedUnion('recordType', [
  ladderSchema, sourceSchema, sourceSetSchema, planSchema, versionSchema, reviewSchema, approvalSchema, headSchema, workSchema,
])

export const createGradeInputSchema = z.strictObject({
  name: text(160), jobId: id('job'), rubricId: identifier, rubricVersion: integer,
  context: gradeContextSchema, grades,
})
export const updateGradeInputSchema = z.strictObject({
  name: text(160).optional(), context: gradeContextSchema.optional(), grades: grades.optional(),
}).refine(value => Object.keys(value).length > 0)
export const confirmGradeInputSchema = z.strictObject({
  decisions: z.array(sourceDecisionSchema).max(LIMITS.maxSources + 1).refine(
    values => unique(values.map(value => value.sourceId)), 'Source decisions must be unique.',
  ),
})
export const addGradeUrlInputSchema = z.strictObject({ url, selectedPages: pages.optional() })
export const updateGradeSourceInputSchema = z.strictObject({ selectedPages: pages })
export const gradeActionInputSchema = z.strictObject({ workId: id('grade-work').optional(), grade: grade.optional() })
  .refine(value => !(value.workId && value.grade), 'Choose a work item or a grade, not both.')
export const editGradeInputSchema = z.strictObject({
  rubric: editableGradeRubricSchema, qualifications: z.array(gradeQualificationSchema).max(50),
})
export const approveGradeInputSchema = z.strictObject({ versionId: id('grade-version'), reviewId: id('grade-review') })
export const emptyGradeInputSchema = z.strictObject({})

export const MAX_GRADE_RECORD_BYTES = 512 * 1024
export const MUTABLE_GRADE_TYPES = new Set<GradeEntity['recordType']>([
  'grade-ladder', 'grade-source', 'grade-head', 'grade-work',
])

export function isGradeId(value: string, prefix: string): boolean {
  return new RegExp(`^${prefix}-${UUID}$`).test(value)
}

export function isSafeGradeBlobName(value: string): boolean {
  const parts = value.split('/')
  if (!WORKSPACE_ID_PATTERN.test(parts[0] ?? '') || !isGradeId(parts[1] ?? '', 'ladder')) return false
  if (parts.length === 3) return ['seed.json', 'initialization.json'].includes(parts[2]) ||
    new RegExp(`^discovery-${UUID}\\.json$`).test(parts[2])
  if (parts.length === 4 && parts[2] === 'requests') return new RegExp(`^${UUID}\\.json$`).test(parts[3])
  if (!isGradeId(parts[2] ?? '', 'source')) return false
  if (parts.length === 4) return /^(?:original\.(?:pdf|docx|doc|html)|capture\.json|document-v(?:[1-9]\d{0,5}|1000000)\.json)$/.test(parts[3])
  return parts.length === 5 && parts[3] === 'chunks' &&
    /^v(?:[1-9]\d{0,5}|1000000)-[A-Za-z0-9._-]{1,120}\.json$/.test(parts[4])
}

export function blobInGrade(name: string, workspaceId: string, ladderId: string): boolean {
  return isSafeGradeBlobName(name) && name.startsWith(`${workspaceId}/${ladderId}/`)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${Array.from(value, item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('Grade hashes require JSON-serializable content.')
  return result
}

export function gradeContentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function gradeVersionHash(value: Omit<GradeRubricVersionRecord, 'contentHash'> | GradeRubricVersionRecord): string {
  return gradeRecordHash(value)
}

export function gradeSourceSetHash(value: Omit<GradeSourceSetRecord, 'contentHash'> | GradeSourceSetRecord): string {
  return gradeRecordHash(value)
}

export function gradeRecordHash(
  value: GradeRubricVersionRecord | GradeSourceSetRecord |
    Omit<GradeRubricVersionRecord, 'contentHash'> | Omit<GradeSourceSetRecord, 'contentHash'>,
): string {
  if (value.recordType !== 'grade-version' && value.recordType !== 'grade-source-set') {
    throw new Error('Only immutable grade versions and source sets use gradeRecordHash.')
  }
  const content: Record<string, unknown> = { ...value }
  delete content.contentHash
  return gradeContentHash(content)
}

const seedSnapshotSchema = z.strictObject({
  job: z.strictObject({
    id: id('job'), title: text(500), organization: z.string().max(1000), location: z.string().max(1000),
    arrangement: z.string().max(1000), employmentType: z.string().max(1000),
    grade: z.string().max(200), series: z.string().max(200), source: z.enum(['pdf', 'docx', 'doc', 'url']),
    sourceLabel: text(LIMITS.maxUrlLength), batchId: z.string().uuid().optional(),
    documentId: identifier, rubricId: identifier, status: z.literal('ready'), createdAt: timestamp, dataKind: z.literal('real'),
    errorStage: z.enum(['download', 'parsing', 'rubric']).optional(), error: text(2000).optional(),
  }),
  rubric: z.unknown(), document: z.unknown(),
  source: z.strictObject({
    kind: z.enum(['pdf', 'docx', 'doc', 'url']), displayName: text(LIMITS.maxUrlLength), url: url.optional(), finalUrl: url.optional(),
    originalBlobName: blobName, originalContentType: originalContentTypes,
    sha256: hash, bytes: z.number().int().min(1).max(24 * 1024 * 1024),
    capturedAt: timestamp.optional(), extractionMethod: z.enum(['document-intelligence', 'legacy-word', 'html', 'browser']).optional(),
  }),
  capturedAt: timestamp,
})

export function parseGradeSeedSnapshot(value: unknown): GradeSeedSnapshot {
  const snapshot = seedSnapshotSchema.parse(value) as GradeSeedSnapshot
  assert(validateRealSourceDocument(snapshot.document).length === 0, 'Seed job document is invalid.')
  assert(snapshot.rubric && validateRealRubric(snapshot.rubric, snapshot.document).length === 0, 'Seed job rubric is invalid.')
  assert(snapshot.job.documentId === snapshot.document.id && snapshot.job.rubricId === snapshot.rubric.id &&
    snapshot.rubric.jobId === snapshot.job.id && snapshot.job.source === snapshot.source.kind &&
    snapshot.job.sourceLabel === snapshot.source.displayName, 'Seed evidence identity mismatch.')
  const name = snapshot.source.originalBlobName!
  const parts = name.split('/')
  assert(parts.length === 4 && isGradeId(parts[2], 'source') &&
    parts[3] === `original.${originalExtension(snapshot.source.originalContentType!)}`,
  'Seed original must be an independently captured grade source.')
  assert(validateRealJobRecord({
    id: snapshot.job.id, workspaceId: parts[0], recordType: 'job', job: snapshot.job,
    source: { ...snapshot.source, originalBlobName: originalBlobName(parts[0], snapshot.job.id, snapshot.source.originalContentType!) },
    inputFingerprint: 'captured-seed', createdBy: 'seed-capture', updatedAt: snapshot.capturedAt, attempts: 0, warnings: [],
  }), 'Seed source format or provenance is invalid.')
  assert(snapshot.source.extractionMethod !== 'legacy-word' || snapshot.source.originalContentType === UPLOAD_CONTENT_TYPES.doc,
    'Legacy Word extraction requires a DOC seed original.')
  if (isWordContentType(snapshot.source.originalContentType)) {
    assert(snapshot.source.extractionMethod === (snapshot.source.originalContentType === UPLOAD_CONTENT_TYPES.doc ? 'legacy-word' : 'document-intelligence') &&
      snapshot.source.displayName.toLowerCase().endsWith(`.${originalExtension(snapshot.source.originalContentType)}`) &&
      snapshot.source.capturedAt && snapshot.source.capturedAt >= snapshot.job.createdAt && snapshot.source.capturedAt <= snapshot.capturedAt &&
      snapshot.source.bytes! <= WORD_DOCUMENT_LIMITS.maxFileBytes && snapshot.document.paragraphs.every(paragraph => paragraph.page === 1),
    'Word seed extraction must preserve captured sections without printed page numbers.')
  }
  return snapshot
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid grade record: ${message}`)
}

function assertSourceAuthority(source: {
  origin: string; purpose: string; authorityStatus: string; publisher: string; url?: string;
  requestedUrl?: string; finalUrl?: string;
}): void {
  if (source.origin === 'opm') {
    const address = source.url ?? source.finalUrl ?? source.requestedUrl
    assert(address && ['http:', 'https:'].includes(new URL(address).protocol) &&
      /^(?:[a-z0-9-]+\.)*opm\.gov$/i.test(new URL(address).hostname) &&
      /\bopm\b|office of personnel management/i.test(source.publisher),
    'OPM authority requires a captured OPM origin and publisher.')
    assert(source.authorityStatus !== 'supplied', 'OPM sources cannot be supplied authority.')
  } else {
    assert(source.authorityStatus === 'supplied', 'Supplied sources cannot acquire OPM authority.')
    assert(source.purpose === (source.origin === 'seed-job' ? 'job-context' : 'agency') ||
      source.purpose === 'background', 'Supplied sources must retain their scoped purpose.')
  }
}

function assertSourceBinding(source: {
  sourceId: string; documentVersion: number; originalBlobName: string; documentBlobName: string;
  selectedPages: number[]; pageCount: number; completeness: string; origin: string; purpose: string; url?: string;
}, workspaceId: string, ladderId: string): void {
  const prefix = `${workspaceId}/${ladderId}/${source.sourceId}/`
  const contentType = storedDocumentContentType(source.originalBlobName)
  assert(source.documentBlobName === `${prefix}document-v${source.documentVersion}.json`, 'Document blob/version ownership mismatch.')
  assert(isOriginalContentType(contentType) && source.originalBlobName === `${prefix}original.${originalExtension(contentType)}`,
  'Original blob ownership mismatch.')
  if (isWordContentType(contentType)) {
    assert(source.origin === 'seed-job' && source.purpose === 'job-context' && !source.url && source.selectedPages.length === 0 &&
      source.pageCount === 1 && source.completeness === 'complete', 'Word evidence must be a complete captured seed section.')
  }
  assert(source.selectedPages.every(page => page <= source.pageCount), 'Selected page exceeds the original page count.')
  assert(source.completeness !== 'selected-pages' || source.selectedPages.length > 0, 'Selected-page extraction must identify its pages.')
  assert(source.selectedPages.length > 0 || source.pageCount <= LIMITS.maxPdfPages, 'Large references require page selection.')
}

export function parseGradeEntity(value: unknown): GradeEntity {
  assert(Buffer.byteLength(JSON.stringify(value) ?? '') <= MAX_GRADE_RECORD_BYTES, 'Cosmos payload is too large.')
  const record = entitySchema.parse(value) as GradeEntity
  assert(record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt.')
  if (record.recordType === 'grade-ladder') {
    assert(record.seedBlobName === `${record.workspaceId}/${record.id}/seed.json`, 'Seed blob ownership mismatch.')
    if (record.discovery) assert(blobInGrade(record.discovery.artifactBlobName, record.workspaceId, record.id) &&
      /^discovery-/.test(record.discovery.artifactBlobName.split('/').at(-1)!), 'Discovery artifact ownership mismatch.')
  }
  if (record.recordType === 'grade-head') {
    assert(record.id === gradeHeadId(record.ladderId, record.grade), 'Grade head identity mismatch.')
    assert(Boolean(record.approvalId) === Boolean(record.approvedVersionId), 'Approval pointers must be paired.')
    if (record.status === 'approved') assert(record.approvalId && record.latestVersionId === record.approvedVersionId,
      'An approved head must identify its approved latest version.')
  }
  if (record.recordType === 'grade-source') {
    assertSourceAuthority(record)
    const prefix = `${record.workspaceId}/${record.ladderId}/${record.id}/`
    if (record.documentBlobName) assert(record.documentBlobName === `${prefix}document-v${record.documentVersion}.json`,
      'Document blob/version ownership mismatch.')
    if (record.originalBlobName) assert(record.originalContentType &&
      record.originalBlobName === `${prefix}original.${originalExtension(record.originalContentType)}`, 'Original blob ownership mismatch.')
    if (isWordContentType(record.originalContentType)) {
      assert(record.origin === 'seed-job' && record.purpose === 'job-context' &&
        record.originalBlobName && record.documentBlobName && record.sha256 && record.bytes && record.capturedAt &&
        record.bytes <= WORD_DOCUMENT_LIMITS.maxFileBytes && record.extractionMethod === 'seed-snapshot' && record.extractionVersion &&
        !record.requestedUrl && !record.finalUrl && record.redirects.length === 0 &&
        record.selectedPages.length === 0 && record.pageCount === 1 && record.completeness === 'complete',
      'Word originals are only supported as immutable captured seed-job context.')
    }
    if (record.pageCount) assert(record.selectedPages.every(page => page <= record.pageCount!), 'Selected page exceeds page count.')
    if (record.status === 'ready') {
      assert(record.originalBlobName && record.documentBlobName && record.sha256 && record.bytes &&
        record.pageCount && record.capturedAt && record.extractionMethod && record.extractionVersion &&
        record.completeness !== 'pending', 'Ready sources require complete captured metadata.')
      assertSourceBinding({
        ...record, sourceId: record.id, pageCount: record.pageCount,
        originalBlobName: record.originalBlobName, documentBlobName: record.documentBlobName,
      }, record.workspaceId, record.ladderId)
    }
  }
  if (record.recordType === 'grade-source-set') {
    assert(record.seedBlobName === `${record.workspaceId}/${record.ladderId}/seed.json`, 'Seed blob ownership mismatch.')
    assert(unique(record.sources.map(source => source.sourceId)) && unique(record.sources.map(source => source.documentId)),
      'Frozen sources and documents must be unique.')
    assert(unique(record.decisions.map(decision => decision.sourceId)), 'Source decisions must be unique.')
    assert(record.sources.filter(source => source.origin === 'seed-job').length === 1, 'The frozen set must include exactly one seed.')
    assert(record.sources.filter(source => source.origin !== 'seed-job' && source.originalBlobName.endsWith('.pdf')).reduce(
      (count, source) => count + (source.selectedPages.length || source.pageCount), 0,
    ) <= LIMITS.maxTotalPdfPages, 'Frozen source set exceeds the total selected PDF page budget.')
    for (const source of record.sources) {
      assertSourceAuthority(source)
      assertSourceBinding(source, record.workspaceId, record.ladderId)
      const decision = record.decisions.find(item => item.sourceId === source.sourceId)
      assert(decision?.selected, 'Frozen sources must be selected.')
      if (source.origin === 'seed-job') assert(decision.applicability === 'applicable', 'Seed evidence is automatic.')
    }
    assert(record.decisions.filter(decision => decision.selected).every(
      decision => record.sources.some(source => source.sourceId === decision.sourceId),
    ), 'Selected decisions must have a frozen source.')
    assert(record.contentHash === gradeSourceSetHash(record), 'Frozen source-set hash mismatch.')
  }
  if (record.recordType === 'grade-version') {
    assert(record.rubric.id === record.id && record.rubric.groupId === gradeHeadId(record.ladderId, record.grade) &&
      record.rubric.createdAt === record.createdAt && record.rubric.version === record.version &&
      record.rubric.grade === `GS-${record.grade}`, 'Rubric identity, version, or grade mismatch.')
    assert(unique(record.rubric.criteria.map(item => item.id)) && unique(record.rubric.criteria.map(item => item.competencyId)),
      'Criteria and competencies must be unique within a grade.')
    assert(record.rubric.criteria.every(item => item.id === item.competencyId), 'Criterion IDs must preserve their common competency identity.')
    assert(unique(record.qualifications.map(item => item.id)), 'Qualifications must be unique.')
    assert(record.contentHash === gradeVersionHash(record), 'Grade version hash mismatch.')
  }
  if (record.recordType === 'grade-competency-plan') assert(unique(record.competencies.map(item => item.id)), 'Competency IDs must be unique.')
  return record
}

const referenceDocumentSchema = z.strictObject({
  id: identifier, version: integer, kind: z.literal('reference'), title: text(500), sample: z.literal(false),
  paragraphs: z.array(z.strictObject({
    id: identifier, page: z.number().int().min(1).max(100_000), heading: z.string().max(2000), text: text(LIMITS.maxSourceCharacters),
    sectionId: identifier.optional(),
    table: z.strictObject({ headers: z.array(z.string().max(2000)).max(100), row: z.number().int().min(0).max(100_000) }).optional(),
  })).min(1).max(50_000),
  pageCount: z.number().int().min(1).max(100_000), selectedPages: pages, completeness,
})

export function validateReferenceDocument(value: unknown): string[] {
  const parsed = referenceDocumentSchema.safeParse(value)
  if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  const document = parsed.data
  const errors: string[] = []
  if (!unique(document.paragraphs.map(paragraph => paragraph.id))) errors.push('Reference paragraph IDs must be unique.')
  if (document.selectedPages.some(page => page > document.pageCount)) errors.push('Selected page exceeds the original page count.')
  if (document.completeness === 'selected-pages' && document.selectedPages.length === 0) errors.push('Selected-page documents must identify selected pages.')
  if (document.selectedPages.length === 0 && document.pageCount > LIMITS.maxPdfPages) errors.push('Large references require explicit page selection.')
  if (document.paragraphs.some(paragraph => paragraph.page > document.pageCount ||
    (document.selectedPages.length > 0 && !document.selectedPages.includes(paragraph.page)))) {
    errors.push('Reference paragraph is outside its captured page selection.')
  }
  if (document.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + paragraph.heading.length +
    (paragraph.table?.headers.join('').length ?? 0), 0) > LIMITS.maxSourceCharacters) {
    errors.push('Reference document exceeds the extracted-character budget.')
  }
  return errors
}

export function gradeIssuesFor(issues: readonly GradeIssue[], grade: number): GradeIssue[] {
  return issues.filter(issue => issue.grade === undefined || issue.grade === grade)
}

export function gradeCoverageMatchesContext(coverage: ReferenceCoverage, context: GradeContext): boolean {
  const functions = new Set<string>([...context.functions, context.supervision])
  const aliases: Record<string, string> = { supervisory: 'supervisor', leadership: 'leader', 'non-supervisory': 'nonsupervisory' }
  return (!coverage.series.length || coverage.series.includes(context.series)) &&
    (!coverage.functions.length || coverage.functions.some(value => functions.has(aliases[value] ?? value)))
}

function coverageMatches(source: FrozenReferenceSource, set: GradeSourceSetRecord, grade: number): boolean {
  return source.coverage.state === 'confirmed' && gradeCoverageMatchesContext(source.coverage, set.context) &&
    (!source.coverage.grades.length || source.coverage.grades.includes(grade))
}

function protectedApplicantRule(value: string): boolean {
  // Subject-matter expertise in genetics, disability policy, religion, etc. is not an applicant characteristic.
  return /\b(?:must be|shall be|should be|only|prefer(?:red)?|requires?)\s+(?:a\s+)?(?:male|female|white|black|christian|muslim|jewish|heterosexual|able-bodied)\b/i.test(value) ||
    /\b(?:applicants?|candidates?|employees?|incumbents?)\s+(?:must|shall|should)\s+(?:not\s+)?(?:have|be)\s+(?:no\s+)?(?:disabilit(?:y|ies)|genetic (?:condition|disorder)|pregnant)\b/i.test(value) ||
    /\b(?:applicants?|candidates?)\s+(?:must|shall|should)\s+be\s+(?:under|over|younger than|older than)\s+\d+\b/i.test(value) ||
    /\b(?:score|rank|reward|prefer|evaluate|assess)(?:s|d|ing)?\s+(?:(?:the|an?)\s+)?(?:applicants?|candidates?)(?:['’]s?)?\s+(?:age|race|ethnicity|religion|sex|gender|pregnancy|disability status|marital status|national origin|sexual orientation|genetic (?:profile|traits|status))\b/i.test(value) ||
    /^(?:(?:applicant|candidate)\s+)?(?:age|race|ethnicity|religion|sex|gender|pregnancy|disability status|marital status|national origin|sexual orientation|genetic (?:profile|traits|status))(?:\s+(?:preference|score))?[.!]?\s*$/i.test(value.split('\n')[0])
}

function minimumQualificationClaim(value: string): boolean {
  return /\b(?:applicants?|candidates?)\s+(?:(?:must|shall|need to|are required to)\s+)?(?:have|hold|possess|complete)\b.{0,100}\b(?:degree|education|years? of (?:specialized )?experience|licen[sc]e|certification)\b/i.test(value) ||
    /\b(?:minimum(?: of)?|at least|must have)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?)\s+of\s+(?:specialized\s+)?experience\b/i.test(value)
}

function qualificationPassage(paragraph: ReferenceDocument['paragraphs'][number]): boolean {
  const headings = [paragraph.heading, ...(paragraph.table?.headers ?? [])].join('\n')
  return /\b(?:minimum qualifications?|qualification (?:requirements?|standards?)|basic (?:education(?:al)? )?requirements?|education(?:al)?\s+(?:and|or)\s+(?:specialized\s+)?experience(?:\s+requirements?)?)\b/i.test(headings) ||
    /^(?:GS[-\s]*\d+\s*[-–:]?\s*)?qualifications?\s*$/i.test(paragraph.heading.trim()) ||
    minimumQualificationClaim(paragraph.text)
}

function meaningfulUnscoredText(value: string): boolean {
  return value.trim().length >= 12 && /\p{L}/u.test(value) &&
    !/^(?:n\/a|none|tbd|todo|unknown|unsupported|gap|not[- ]applicable|placeholder)[.!?\s]*$/i.test(value.trim())
}

function validateVersion(
  version: GradeRubricVersionRecord, sourceSet: GradeSourceSetRecord, documents: ReferenceDocument[],
  approval: boolean,
): string[] {
  const errors: string[] = []
  try {
    parseGradeEntity(version)
    parseGradeEntity(sourceSet)
  } catch {
    return ['Grade version or frozen source set has an invalid stored shape or content hash.']
  }
  if (version.workspaceId !== sourceSet.workspaceId || version.ladderId !== sourceSet.ladderId ||
    version.sourceSetId !== sourceSet.id || !sourceSet.grades.includes(version.grade)) {
    errors.push('Grade version does not belong to this workspace, ladder, grade, and source set.')
  }
  if (approval && !sourceSet.context.confirmed) errors.push('Position applicability context has not been confirmed.')
  if (!Array.isArray(documents) || documents.length > LIMITS.maxSources + 1) return ['Invalid reference document set.']
  const bindings = new Map(sourceSet.sources.map(source => [source.documentId, source]))
  const docs = new Map<string, ReferenceDocument>()
  const paragraphs = new Map<string, Map<string, ReferenceDocument['paragraphs'][number]>>()
  for (const document of documents) {
    const documentErrors = validateReferenceDocument(document)
    if (documentErrors.length) {
      errors.push(...documentErrors)
      continue
    }
    const source = bindings.get(document.id)
    if (docs.has(document.id) || !source || source.documentVersion !== document.version ||
      source.pageCount !== document.pageCount || source.completeness !== document.completeness ||
      gradeContentHash([...source.selectedPages].sort((a, b) => a - b)) !== gradeContentHash([...document.selectedPages].sort((a, b) => a - b))) {
      errors.push('Reference document is duplicated, foreign, or different from its frozen source version.')
    }
    docs.set(document.id, document)
    paragraphs.set(document.id, new Map(document.paragraphs.map(paragraph => [paragraph.id, paragraph])))
  }
  if (sourceSet.sources.some(source => !docs.has(source.documentId))) errors.push('A frozen source document is missing.')
  if (approval) {
    for (const issue of gradeIssuesFor([...sourceSet.issues, ...version.issues], version.grade)) {
      if (issue.severity === 'blocker') errors.push(`Unresolved ${issue.scope} blocker: ${issue.message}`)
    }
    for (const source of sourceSet.sources) {
      for (const issue of gradeIssuesFor(source.issues, version.grade)) {
        if (issue.severity === 'blocker') errors.push(`Unresolved source blocker: ${issue.message}`)
      }
    }
  }
  function checkCitation(citation: Citation, use: 'context' | 'work' | 'basis' | 'exclusion' | 'qualification'): void {
    const source = bindings.get(citation.documentId)
    const document = docs.get(citation.documentId)
    const paragraph = paragraphs.get(citation.documentId)?.get(citation.paragraphId)
    if (!source || !document || citation.documentVersion !== source.documentVersion ||
      citation.documentVersion !== document.version || !paragraph ||
      citation.page !== paragraph.page || citation.heading !== paragraph.heading ||
      !citation.quote.trim() || !paragraph.text.includes(citation.quote)) {
      errors.push('Citation does not exactly match a frozen document, version, paragraph, page, heading, and quote.')
      return
    }
    if (use === 'context') return
    const decision = sourceSet.decisions.find(item => item.sourceId === source.sourceId)
    if (!decision?.selected || decision.applicability !== 'applicable' || source.completeness === 'incomplete') {
      errors.push('Citation uses unselected, incomplete, background, excluded, or uncertain source evidence.')
    }
    if (source.origin !== 'seed-job' && (!coverageMatches(source, sourceSet, version.grade) ||
      ['superseded', 'unknown', 'conflicting'].includes(source.authorityStatus))) {
      errors.push('Citation has unresolved series, grade, functional applicability, or source authority.')
    }
    if ((use === 'basis' || use === 'exclusion') && (!['grading', 'classification', 'agency'].includes(source.purpose) ||
      source.origin === 'seed-job' || (source.origin === 'opm' && source.authorityStatus !== 'current'))) {
      errors.push('Grade basis requires applicable work-level evidence, not seed context, qualifications, or background.')
    }
    if (use === 'exclusion' && qualificationPassage(paragraph)) {
      errors.push('Not-applicable rows require work-level exclusion evidence, not qualification-only passages.')
    }
    if (use === 'work' && ['qualification', 'issuance', 'background'].includes(source.purpose)) {
      errors.push('Qualifications, issuance metadata, and background cannot establish weighted work expectations.')
    }
    if (use === 'qualification' && !['qualification', 'agency', 'job-context'].includes(source.purpose)) {
      errors.push('Qualifications require separate qualification or scoped agency/job-prerequisite evidence.')
    }
  }
  if (!version.rubric.provenance) errors.push('Grade rubric must identify server-generated model/prompt provenance.')
  if (approval && !version.rubric.criteria.length) errors.push('A grade must contain nonempty supported criteria.')
  for (const issue of [...sourceSet.issues, ...version.issues, ...sourceSet.sources.flatMap(source => source.issues)]) {
    for (const citation of issue.citations ?? []) checkCitation(citation, 'context')
  }
  let supportedWeight = 0
  let supportedCount = 0
  for (const criterion of version.rubric.criteria) {
    const supported = ['direct', 'derived'].includes(criterion.support)
    const notApplicable = criterion.support === 'not-applicable'
    const labels = [...criterion.guidance.matchAll(/(?:^|[\n;|]|[.!?]\s+)\s*(?:score\s+)?([0-5])\s*[:.)=\-–—]\s*/gi)]
    if (supported) {
      supportedCount += 1
      supportedWeight += criterion.weight
      if (criterion.weight <= 0) errors.push('Every supported criterion needs a positive weight.')
    }
    if (approval && criterion.support === 'gap') errors.push('Criterion has an unresolved support gap.')
    if (supported && !criterion.interpretation.trim()) errors.push('Every criterion requires an explicit source-grounded interpretation.')
    if (supported && (!criterion.sourceCitations?.length || !criterion.gradeBasis.length)) {
      errors.push('Every supported criterion requires exact work and grade-basis citations.')
    }
    if (notApplicable) {
      if (criterion.weight !== 0 || criterion.gradeBasis.length || labels.length) {
        errors.push('Not-applicable rows must be unscored: weight 0, no gradeBasis, and no score anchors.')
      }
      if (!criterion.sourceCitations?.length) errors.push('Not-applicable rows require exact applicable work-level exclusion citations.')
      if (!meaningfulUnscoredText(criterion.interpretation) || !meaningfulUnscoredText(criterion.guidance)) {
        errors.push('Not-applicable rows require meaningful exclusion interpretation and unscored guidance.')
      }
    }
    for (const citation of criterion.sourceCitations ?? []) checkCitation(citation, notApplicable ? 'exclusion' : supported ? 'work' : 'context')
    for (const citation of criterion.gradeBasis) checkCitation(citation, supported ? 'basis' : 'context')
    if (criterion.sourceParagraphId && !(criterion.sourceCitations ?? []).some(citation => citation.paragraphId === criterion.sourceParagraphId)) {
      errors.push('Criterion sourceParagraphId must identify one of its exact citations.')
    }
    if (supported) {
      const anchors = labels.map((label, index) => criterion.guidance.slice(
        label.index! + label[0].length, labels[index + 1]?.index ?? criterion.guidance.length,
      ).trim().toLowerCase())
      if (labels.length !== 6 || labels.some((label, index) => Number(label[1]) !== index) ||
        !unique(anchors) || anchors.some(anchor => anchor.length < 4 || /^(?:n\/a|none|tbd|todo|gap|unknown|placeholder)[.!?\s]*$/.test(anchor))) {
        errors.push('Every criterion requires nonempty, distinct guidance for scores 0 through 5.')
      }
    }
    if (protectedApplicantRule(`${criterion.label}\n${criterion.description}\n${criterion.guidance}\n${criterion.interpretation}`)) {
      errors.push('Applicant protected characteristics cannot be scored as work-level criteria.')
    }
    if ((approval || supported) && minimumQualificationClaim(criterion.description)) {
      errors.push('Minimum applicant qualifications must remain separate from weighted work-level criteria.')
    }
  }
  if (approval && supportedCount === 0) errors.push('Approval requires at least one direct or derived supported criterion.')
  if (approval && Math.abs(supportedWeight - 100) > 0.000001) errors.push('Supported criterion weights must total exactly 100.')
  for (const qualification of version.qualifications) {
    if ((approval && qualification.support === 'gap') ||
      ((approval || qualification.support !== 'gap') && (!qualification.citations.length || !qualification.interpretation.trim()))) {
      errors.push('Qualification has an unresolved support or interpretation gap.')
    }
    for (const citation of qualification.citations) checkCitation(citation, approval || qualification.support !== 'gap' ? 'qualification' : 'context')
    if (protectedApplicantRule(qualification.text)) errors.push('Unsupported applicant protected-characteristic requirements are not permitted.')
  }
  return [...new Set(errors)]
}

/** Deterministic publication checks allow explicit unsupported drafts; approval adds support/blocker checks. */
export function validateGradeVersion(
  version: GradeRubricVersionRecord, sourceSet: GradeSourceSetRecord, documents: ReferenceDocument[],
): string[] {
  return validateVersion(version, sourceSet, documents, false)
}

export function validateGradeApproval(
  version: GradeRubricVersionRecord, sourceSet: GradeSourceSetRecord, documents: ReferenceDocument[],
): string[] {
  return validateVersion(version, sourceSet, documents, true)
}
