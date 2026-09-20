import { createHash } from 'node:crypto'
import { z } from 'zod'
import { REPORT_LIMITS } from '../../src/domain/analysis-reports'
import type { RealAnalysisNarrativeRecord } from '../../src/domain/analysis-narratives'
import {
  SUMMARY_LIMITS, summaryDiagnosticSchema, summaryHistoryReferenceSchema, type AnalysisSummaryHistoryReference,
} from '../../src/domain/analysis-summary-history'
import {
  ANALYSIS_CITATION_REASONS, ANALYSIS_DIAGNOSTIC_FIELDS, ANALYSIS_DIAGNOSTIC_LIMITS,
  ANALYSIS_DIAGNOSTIC_REASONS, ANALYSIS_REVIEW_ISSUE_CODES, ANALYSIS_SCHEMA_ISSUE_CODES, ANALYSIS_TELEMETRY_EVENTS,
  type AnalysisFailureDiagnostic, type AnalysisFailureDiagnosticReference,
} from '../../src/domain/analysis-diagnostics'
import {
  ANALYSIS_LIMITS, type AnalysisEntity, type FrozenRealResumeSnapshot, type FrozenRealAnalysisTargetSnapshot,
  type FrozenRequirementEvidence, type RealAnalysisInitializationManifest, type RealAnalysisResult,
  type RealAnalysisResultSummary, type RealAnalysisAssessmentOutput,
  type RealAnalysisComparisonRecord, type RealAnalysisRunRecord, type RealAnalysisTargetSelection,
} from '../../src/domain/real-analyses'
import type { GradeRubricVersionRecord, GradeSourceSetRecord } from '../../src/domain/real-grades'
import type { RealResumeDocument } from '../../src/domain/real-resumes'
import { isSafeUploadedFilename, MAX_MARKDOWN_BYTES } from '../../src/domain/source-files'
import type { Citation, SourceDocument } from '../../src/domain/types'
import {
  DOCUMENT_BLOB_CONTENT_TYPES, ORIGINAL_CONTENT_TYPES, UPLOAD_CONTENT_TYPES, UPLOAD_FORMATS, WORD_DOCUMENT_LIMITS,
  documentPagination, isWordContentType, originalExtension,
} from '../../src/domain/document-formats'
import { WORKSPACE_ID_PATTERN } from '../ids'
import {
  citationSchema, gradeContextSchema, gradeIssuesFor,
  parseGradeEntity, parseGradeSeedSnapshot,
} from '../grades/validation'
import { isNormalizedDisplayName, validateRealJobRecord, validateRealRubric, validateRealSourceDocument } from '../jobs/validation'
import {
  isSafeResumeFilename, normalizeResumePublicUrl, parseRealResumeProfile, resumeOriginalBlobName,
  resumeDocumentBlobName, validateRealResumeDocument,
} from '../resumes/validation'
import {
  analysisAssessmentHash, analysisHash, analysisRequirementEvidenceForInput, calculateAnalysisSummary,
} from './deterministic'
export {
  analysisAssessmentHash, analysisHash, analysisRequirementEvidenceForInput, calculateAnalysisSummary,
} from './deterministic'

export const MAX_ANALYSIS_RECORD_BYTES = 128 * 1024
export const MAX_ANALYSIS_TRANSACTION_BYTES = 1_800_000
export const MAX_ANALYSIS_JSON_BYTES = 24 * 1024 * 1024
export const MAX_ANALYSIS_ORIGINAL_BYTES = 24 * 1024 * 1024
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-${UUID}$`))
const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
const text = (max: number) => z.string().max(max).refine(value => value.trim().length > 0)
const displayName = z.string().refine(isNormalizedDisplayName, 'Invalid normalized display name.')
const timestamp = z.iso.datetime({ precision: 3 })
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const integer = z.number().int().min(1).max(1_000_000)
const count = z.number().int().min(0).max(ANALYSIS_LIMITS.maxComparisons)
const workspace = z.string().regex(WORKSPACE_ID_PATTERN)
const unique = <T>(values: T[]) => new Set(values).size === values.length
const runId = id('analysis-run')
const comparisonId = id('analysis-comparison')
const snapshotId = id('analysis-snapshot')
export const analysisNarrativeTargetIdSchema = z.string().regex(/^target-[a-f0-9]{48}$/)
const citations = z.array(citationSchema).max(60)
const originalContentTypes = z.enum(ORIGINAL_CONTENT_TYPES)
const contentTypes = z.enum(DOCUMENT_BLOB_CONTENT_TYPES)
const blobReferenceSchema = z.strictObject({
  blobName: z.string().max(700), contentType: contentTypes, sha256: hash,
  bytes: z.number().int().min(1).max(MAX_ANALYSIS_JSON_BYTES),
})
const originalReferenceSchema = blobReferenceSchema.extend({
  contentType: originalContentTypes,
}).refine(value => value.contentType !== 'text/markdown' || value.bytes <= MAX_MARKDOWN_BYTES,
  'Markdown originals exceed the supported size.')
  .refine(value => !isWordContentType(value.contentType) || value.bytes <= WORD_DOCUMENT_LIMITS.maxFileBytes,
    'Word originals exceed the supported size.')
const jsonReferenceSchema = blobReferenceSchema.extend({ contentType: z.literal('application/json') })
export const analysisFailureDiagnosticReferenceSchema = z.strictObject({
  attemptId: z.string().uuid(), createdAt: timestamp, blob: jsonReferenceSchema,
})
const documentReferenceSchema = jsonReferenceSchema.extend({ documentId: identifier, documentVersion: integer })

export const analysisResumeSelectionSchema = z.strictObject({
  resumeId: id('resume'), documentId: identifier, documentVersion: integer, documentSha256: hash,
})
export const analysisTargetSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('job'), jobId: id('job'), rubricId: identifier, rubricVersion: integer, rubricHash: hash,
    documentId: identifier, documentVersion: integer, documentSha256: hash,
  }),
  z.strictObject({
    kind: z.literal('grade'), ladderId: id('ladder'), grade: z.number().int().min(1).max(15),
    versionId: id('grade-version'), version: integer, versionHash: hash,
    approvalId: id('grade-approval'), reviewId: id('grade-review'),
    sourceSetId: id('source-set'), sourceSetHash: hash,
  }),
])
export const createAnalysisInputSchema = z.strictObject({
  name: text(160),
  resumes: z.array(analysisResumeSelectionSchema).min(1).max(ANALYSIS_LIMITS.maxComparisons),
  targets: z.array(analysisTargetSelectionSchema).min(1).max(ANALYSIS_LIMITS.maxComparisons),
}).superRefine((value, ctx) => {
  if (value.resumes.length * value.targets.length > ANALYSIS_LIMITS.maxComparisons) {
    ctx.addIssue({ code: 'custom', message: `An analysis run may contain at most ${ANALYSIS_LIMITS.maxComparisons} comparisons.` })
  }
  if (!unique(value.resumes.map(item => item.resumeId))) {
    ctx.addIssue({ code: 'custom', path: ['resumes'], message: 'Resume selections must not repeat.' })
  }
  if (!unique(value.targets.map(analysisTargetKey))) {
    ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Target versions must not repeat.' })
  }
})
export const retryAnalysisInputSchema = z.strictObject({
  comparisonIds: z.array(comparisonId).min(1).max(ANALYSIS_LIMITS.maxComparisons).refine(unique).optional(),
})
export const emptyAnalysisInputSchema = z.strictObject({})
export const generateAnalysisSummariesInputSchema = z.strictObject({
  mode: z.enum(['missing', 'all']), targetId: analysisNarrativeTargetIdSchema.optional(),
})
export const reportComparisonIdsSchema = z.array(comparisonId).min(1).max(REPORT_LIMITS.batchComparisons).refine(unique)
export const analysisLifecycleInputSchema = z.strictObject({ action: z.enum(['archive', 'unarchive', 'delete']) })

const targetSummaryBase = {
  id: identifier, workspaceId: workspace, dataKind: z.literal('real'),
  label: text(500), displayName: displayName.optional(), sublabel: z.string().max(1500), rubricId: identifier, rubricVersion: integer,
  criterionCount: z.number().int().min(1).max(20),
}
const targetSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...targetSummaryBase, kind: z.literal('job'), selection: analysisTargetSelectionSchema.options[0] }),
  z.strictObject({
    ...targetSummaryBase, kind: z.literal('grade'), selection: analysisTargetSelectionSchema.options[1],
    context: gradeContextSchema, approvedAt: timestamp, newerDraftAvailable: z.boolean(),
  }),
])
const resumeSummarySchema = z.strictObject({
  workspaceId: workspace, dataKind: z.literal('real'), selection: analysisResumeSelectionSchema,
  name: text(2000).nullable(), displayName: displayName.optional(), role: text(2000).nullable(),
  sourceLabel: text(4096), capturedAt: timestamp,
})
const resumeReferenceSchema = z.strictObject({ snapshotId, blob: jsonReferenceSchema, summary: resumeSummarySchema })
const targetReferenceSchema = z.strictObject({ snapshotId, blob: jsonReferenceSchema, summary: targetSummarySchema })
const errorSchema = z.strictObject({
  code: z.enum([
    'invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit',
    'invalid-model-output', 'invalid-citation', 'grounding-failed', 'service-unavailable',
    'storage-error', 'timeout', 'internal-error',
  ]),
  stage: z.enum(['initialization', 'assessment', 'grounding', 'publication']), message: text(2000), retryable: z.boolean(),
})
const work = {
  attempts: z.number().int().min(0).max(ANALYSIS_LIMITS.maxAutomaticAttempts), retryCount: z.number().int().min(0).max(1_000_000),
  attemptId: z.string().uuid().optional(), nextAttemptAt: timestamp.optional(),
  lease: z.strictObject({ owner: text(200), expiresAt: timestamp, heartbeatAt: timestamp }).optional(),
  error: errorSchema.optional(),
}
const base = { workspaceId: workspace, dataKind: z.literal('real'), createdAt: timestamp, updatedAt: timestamp, ...work }
const progressSchema = z.strictObject({
  total: count, initialized: count, queued: count, running: count, complete: count,
  failed: count, cancelled: count, scored: count, unscored: count,
})
const coverageSchema = z.strictObject({
  totalCriteria: z.number().int().min(1).max(20),
  supported: count, partial: count, missing: count, notAssessed: count, notApplicable: count,
  assessedWeight: z.number().finite().min(0).max(100.000001), totalWeight: z.number().finite().min(0).max(100.000001),
})
const overallSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), score: z.number().finite().min(0).max(100) }),
  z.strictObject({
    status: z.literal('withheld'), score: z.null(),
    reason: z.enum(['unassessed-weighted-criteria', 'no-assessable-weight']), message: text(2000),
  }),
])
const resultSummarySchema = z.strictObject({
  completion: z.enum(['assessed', 'limited']), overall: overallSchema, coverage: coverageSchema,
})
const runSchema = z.strictObject({
  ...base, id: runId, recordType: z.literal('analysis-run'), name: text(160), createdBy: text(200),
  displayName: displayName.optional(),
  lifecycle: z.strictObject({
    archivedAt: timestamp.optional(), deletingAt: timestamp.optional(), deletedAt: timestamp.optional(),
    parentKey: text(250).optional(),
  }).optional(),
  idempotencyKey: z.string().uuid(), inputFingerprint: hash,
  status: z.enum(['initializing', 'queued', 'running', 'complete', 'partial', 'failed', 'cancelled']),
  manifest: jsonReferenceSchema,
  initialization: z.strictObject({ nextComparisonIndex: count, completedAt: timestamp.optional() }),
  progress: progressSchema, completedAt: timestamp.optional(),
  cancellation: z.strictObject({
    requestedAt: timestamp, requestedBy: text(200), nextComparisonIndex: count, completedAt: timestamp.optional(),
  }).optional(),
  narrativeRequestId: z.string().uuid().optional(),
  narrativeCancelledAt: timestamp.optional(),
})
const comparisonSchema = z.strictObject({
  ...base, id: comparisonId, recordType: z.literal('analysis-comparison'), runId, index: count,
  status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
  resume: resumeReferenceSchema, target: targetReferenceSchema,
  result: jsonReferenceSchema.optional(), resultSummary: resultSummarySchema.optional(),
  completedAt: timestamp.optional(), cancelledAt: timestamp.optional(),
  failureDiagnostic: analysisFailureDiagnosticReferenceSchema.optional(),
  diagnosticCapture: z.strictObject({
    attemptId: z.string().uuid(), status: z.enum(['saved', 'unavailable']), pipelineVersion: text(200),
  }).optional(),
})
const narrativeIdentity = z.strictObject({ snapshotId, sha256: hash })
const narrativePublicationSchema = z.strictObject({
  revision: hash, inputFingerprint: hash, generationId: z.string().uuid(), publishedAt: timestamp,
  blob: jsonReferenceSchema,
})
const narrativeBase = {
  ...base, schemaVersion: z.literal(1), runId, manifestSha256: hash, targetId: analysisNarrativeTargetIdSchema,
  targetSnapshot: narrativeIdentity,
  status: z.enum(['waiting', 'queued', 'running', 'ready', 'failed', 'cancelled']),
  generationId: z.string().uuid(), requestId: z.string().uuid(), requestedAt: timestamp,
  requestedBy: text(200).nullable(),
  reason: z.enum(['missing', 'all', 'comparison-completed', 'comparison-changed']),
  inputFingerprint: hash.nullable(), waitingFor: z.enum(['scoring', 'candidate-narratives']).optional(),
  published: narrativePublicationSchema.optional(),
  history: summaryHistoryReferenceSchema.optional(),
  summaryRound: z.number().int().min(1).max(SUMMARY_LIMITS.rounds).optional(),
  error: z.strictObject({
    code: z.enum([...errorSchema.shape.code.options, 'dependency-failed']),
    stage: z.enum(['dependencies', 'candidate-generation', 'target-generation', 'grounding', 'publication']),
    message: text(2000), retryable: z.boolean(), diagnostic: summaryDiagnosticSchema.optional(),
  }).optional(),
}
const candidateNarrativeSchema = z.strictObject({
  ...narrativeBase, id: z.string(), recordType: z.literal('analysis-candidate-narrative'),
  comparisonId, resumeSnapshot: narrativeIdentity, resultSha256: hash, inputFingerprint: hash,
})
const targetNarrativeSchema = z.strictObject({
  ...narrativeBase, id: z.string(), recordType: z.literal('analysis-target-narrative'),
})
const narrativeRequestSchema = z.strictObject({
  ...base, id: z.string(), recordType: z.literal('analysis-narrative-request'), runId, manifestSha256: hash,
  requestId: z.string().uuid(), requestedBy: text(200), mode: z.enum(['missing', 'all']),
  targetId: analysisNarrativeTargetIdSchema.nullable(), scopeRevision: hash, plan: jsonReferenceSchema,
  status: z.enum(['queued', 'complete', 'cancelled']),
  nextIndex: z.number().int().min(0).max(ANALYSIS_LIMITS.maxComparisons * 2),
  scheduled: z.strictObject({ candidates: count, targets: count }),
})
const entitySchema = z.discriminatedUnion('recordType', [
  runSchema, comparisonSchema, candidateNarrativeSchema, targetNarrativeSchema, narrativeRequestSchema,
])
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: workspace, runId,
  createdAt: timestamp, createdBy: text(200), inputFingerprint: hash, request: createAnalysisInputSchema,
  resumes: z.array(resumeReferenceSchema).min(1).max(ANALYSIS_LIMITS.maxComparisons),
  targets: z.array(targetReferenceSchema).min(1).max(ANALYSIS_LIMITS.maxComparisons),
  comparisons: z.array(z.strictObject({
    id: comparisonId, index: count, resumeSnapshotId: snapshotId, targetSnapshotId: snapshotId,
  })).min(1).max(ANALYSIS_LIMITS.maxComparisons),
})

export function analysisBytesHash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function analysisInputFingerprint(value: unknown): string { return analysisHash({ operation: 'create-analysis', input: value }) }
export function analysisTargetKey(selection: RealAnalysisTargetSelection): string {
  return selection.kind === 'job' ? `${selection.jobId}:${selection.rubricId}:${selection.rubricVersion}`
    : `${selection.ladderId}:${selection.grade}:${selection.versionId}:${selection.version}`
}
export function analysisTargetSummaryId(selection: RealAnalysisTargetSelection): string {
  return `target-${analysisHash(analysisTargetKey(selection)).slice(0, 48)}`
}
export function parseAnalysisTargetSummary(value: unknown) {
  const summary = targetSummarySchema.parse(value)
  assertAnalysis(summary.id === analysisTargetSummaryId(summary.selection), 'Target summary identity mismatch.')
  return summary
}
export function isAnalysisId(value: string, kind: 'run' | 'comparison' | 'snapshot'): boolean {
  return new RegExp(`^analysis-${kind}-${UUID}$`).test(value)
}
export function analysisNarrativeId(kind: 'candidate' | 'target' | 'request', runId: string, subjectId: string): string {
  return `analysis-${kind === 'request' ? 'narrative-request' : `${kind}-narrative`}:${runId}:${subjectId}`
}
export function isAnalysisRecordId(value: string): boolean {
  if (isAnalysisId(value, 'run') || isAnalysisId(value, 'comparison')) return true
  const [kind, run, subject, extra] = value.split(':')
  if (extra !== undefined || !isAnalysisId(run ?? '', 'run')) return false
  return kind === 'analysis-candidate-narrative' ? isAnalysisId(subject ?? '', 'comparison')
    : kind === 'analysis-target-narrative' ? analysisNarrativeTargetIdSchema.safeParse(subject).success
      : kind === 'analysis-narrative-request' && new RegExp(`^${UUID}$`).test(subject ?? '')
}
export function analysisNarrativeBlobName(
  workspaceId: string, runId: string, kind: 'candidate' | 'target', subjectId: string, generationId: string, attemptId: string,
): string {
  const name = `${workspaceId}/${runId}/narratives/${kind}/${subjectId}/${generationId}/${attemptId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid narrative publication identity.')
  return name
}
export function analysisNarrativeRequestBlobName(workspaceId: string, runId: string, requestId: string): string {
  const name = `${workspaceId}/${runId}/narratives/requests/${requestId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid narrative request identity.')
  return name
}
export function analysisSummaryHistoryBlobName(
  workspaceId: string, runId: string, kind: 'candidate' | 'target', subjectId: string,
  generationId: string, attemptId: string, entryId: string,
): string {
  const name = `${workspaceId}/${runId}/narrative-history/${kind}/${subjectId}/${generationId}/${attemptId}/${entryId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid summary checkpoint identity.')
  return name
}
export function analysisSummaryActionBlobName(workspaceId: string, runId: string, requestId: string): string {
  const name = `${workspaceId}/${runId}/narrative-actions/${requestId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid summary action identity.')
  return name
}
export function assertAnalysisSummaryHistoryReference(
  reference: AnalysisSummaryHistoryReference, workspaceId: string, runId: string, kind: 'candidate' | 'target', subjectId: string,
): void {
  summaryHistoryReferenceSchema.parse(reference)
  const parts = reference.blob.blobName.split('/')
  assertAnalysis(reference.blob.blobName === analysisSummaryHistoryBlobName(
    workspaceId, runId, kind, subjectId, reference.generationId, parts[6], reference.id,
  ), 'Summary history belongs to another subject, generation, or checkpoint.')
}
export function analysisDeterministicId(kind: 'comparison' | 'snapshot', run: string, key: string | number): string {
  const hex = analysisHash({ kind, run, key }).slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  const value = hex.join('')
  return `analysis-${kind}-${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
export function isSafeAnalysisBlobName(name: string): boolean {
  const parts = name.split('/')
  if (!WORKSPACE_ID_PATTERN.test(parts[0] ?? '') || !isAnalysisId(parts[1] ?? '', 'run')) return false
  if (parts.length === 3) return parts[2] === 'manifest.json'
  if (parts.length === 4 && parts[2] === 'evidence') return /^[a-f0-9]{64}\.(?:json|pdf|md|docx|doc|html)$/.test(parts[3])
  if (parts.length === 5 && parts[2] === 'snapshots' && isAnalysisId(parts[3], 'snapshot')) return /^[a-f0-9]{64}\.json$/.test(parts[4])
  if (parts[2] === 'narrative-actions') return parts.length === 4 && new RegExp(`^${UUID}\\.json$`).test(parts[3])
  if (parts[2] === 'narrative-history') return parts.length === 8 &&
    (parts[3] === 'candidate' ? isAnalysisId(parts[4], 'comparison')
      : parts[3] === 'target' && analysisNarrativeTargetIdSchema.safeParse(parts[4]).success) &&
    new RegExp(`^${UUID}$`).test(parts[5]) && new RegExp(`^${UUID}$`).test(parts[6]) &&
    new RegExp(`^${UUID}\\.json$`).test(parts[7])
  if (parts[2] === 'narratives') {
    if (parts.length === 5 && parts[3] === 'requests') return new RegExp(`^${UUID}\\.json$`).test(parts[4])
    return parts.length === 7 &&
      (parts[3] === 'candidate' ? isAnalysisId(parts[4], 'comparison')
        : parts[3] === 'target' && analysisNarrativeTargetIdSchema.safeParse(parts[4]).success) &&
      new RegExp(`^${UUID}$`).test(parts[5]) && new RegExp(`^${UUID}\\.json$`).test(parts[6])
  }
  return parts.length === 5 && ['results', 'diagnostics'].includes(parts[2]) && isAnalysisId(parts[3], 'comparison') &&
    new RegExp(`^${UUID}\\.json$`).test(parts[4])
}
export function analysisBlobInRun(name: string, workspaceId: string, runId: string): boolean {
  return isSafeAnalysisBlobName(name) && name.startsWith(`${workspaceId}/${runId}/`)
}
export { analysisCancellationNeedsRetry } from '../../src/domain/real-analyses'
export function assertAnalysis(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid analysis data: ${message}`)
}
function bounded(value: unknown, maximum = MAX_ANALYSIS_JSON_BYTES): void {
  assertAnalysis(Buffer.byteLength(JSON.stringify(value) ?? '') <= maximum, 'Payload is too large.')
}
function snapshotReference(
  value: z.infer<typeof resumeReferenceSchema> | z.infer<typeof targetReferenceSchema>, workspaceId: string, runId: string,
): void {
  assertAnalysis(value.summary.workspaceId === workspaceId &&
    value.blob.blobName === `${workspaceId}/${runId}/snapshots/${value.snapshotId}/${value.blob.sha256}.json`,
  'Snapshot reference ownership mismatch.')
}
function validateSummary(summary: RealAnalysisResultSummary): void {
  const c = summary.coverage
  assertAnalysis(c.totalCriteria === c.supported + c.partial + c.missing + c.notAssessed + c.notApplicable &&
    c.assessedWeight <= c.totalWeight + 0.000001, 'Invalid evidence coverage.')
  assertAnalysis(summary.completion !== 'assessed' || (c.notAssessed === 0 && summary.overall.status === 'available'),
    'Completion and evidence coverage disagree.')
  assertAnalysis(summary.overall.status !== 'available' || (c.totalWeight > 0 && Math.abs(c.assessedWeight - c.totalWeight) <= 0.000001),
    'An unassessed weighted criterion cannot have an overall score.')
}

export function parseAnalysisEntity(value: unknown): AnalysisEntity {
  bounded(value, MAX_ANALYSIS_RECORD_BYTES)
  const record = entitySchema.parse(value) as AnalysisEntity
  assertAnalysis(record.updatedAt >= record.createdAt, 'updatedAt precedes creation.')
  if (record.lease) assertAnalysis(record.lease.expiresAt > record.lease.heartbeatAt, 'Invalid lease interval.')
  if (record.recordType === 'analysis-run') {
    assertAnalysis(record.id === `analysis-run-${record.idempotencyKey}` &&
      record.manifest.blobName === `${record.workspaceId}/${record.id}/manifest.json`, 'Run manifest or idempotency identity mismatch.')
    const p = record.progress
    assertAnalysis(p.total > 0 && p.initialized <= p.total && p.initialized === record.initialization.nextComparisonIndex &&
      p.queued + p.running + p.complete + p.failed + p.cancelled === p.initialized &&
      p.scored + p.unscored === p.complete, 'Run progress is inconsistent.')
    assertAnalysis(!record.initialization.completedAt || p.initialized === p.total, 'Initialization completed before all pairs existed.')
    if (['queued', 'running', 'complete', 'partial'].includes(record.status)) {
      assertAnalysis(p.initialized === p.total && record.initialization.completedAt, 'Active scoring requires complete initialization.')
    }
    if (record.status === 'queued') assertAnalysis(p.queued > 0 && p.running === 0, 'Queued run must have queued comparisons.')
    if (record.status === 'running') assertAnalysis(p.running > 0, 'Running run must have running comparisons.')
    if (record.status === 'initializing') assertAnalysis(p.initialized < p.total && !record.cancellation, 'Initialization state has no remaining work.')
    if (record.status === 'complete') assertAnalysis(p.complete === p.total && record.completedAt, 'Completed run has unfinished work.')
    if (record.status === 'partial') assertAnalysis(p.complete > 0 && p.complete < p.total && p.queued + p.running === 0 && record.completedAt,
      'Partial run has inconsistent progress.')
    if (record.cancellation) {
      assertAnalysis(record.status === 'cancelled' && record.cancellation.nextComparisonIndex <= p.initialized &&
        record.cancellation.nextComparisonIndex <= p.total, 'Cancellation cursor or run state mismatch.')
      if (record.cancellation.completedAt) assertAnalysis(record.cancellation.nextComparisonIndex === p.total &&
        p.queued + p.running === 0 && record.completedAt, 'Cancellation is unfinished.')
    }
    if (record.narrativeCancelledAt) assertAnalysis(record.narrativeCancelledAt <= record.updatedAt,
      'Narrative cancellation fence is ahead of the run.')
  } else if (record.recordType === 'analysis-comparison') {
    assertAnalysis(record.index < ANALYSIS_LIMITS.maxComparisons &&
      record.id === analysisDeterministicId('comparison', record.runId, record.index), 'Comparison identity mismatch.')
    snapshotReference(record.resume, record.workspaceId, record.runId)
    snapshotReference(record.target, record.workspaceId, record.runId)
    if (record.failureDiagnostic) {
      assertAnalysisFailureDiagnosticReference(record.failureDiagnostic, record.workspaceId, record.runId, record.id)
      assertAnalysis(record.failureDiagnostic.createdAt >= record.createdAt && record.failureDiagnostic.createdAt <= record.updatedAt,
        'Failure diagnostic timestamp is outside the comparison history.')
    }
    if (record.diagnosticCapture?.status === 'saved') {
      assertAnalysis(record.failureDiagnostic?.attemptId === record.diagnosticCapture.attemptId,
        'Saved diagnostic capture must identify its immutable artifact.')
    }
    assertAnalysis(Boolean(record.result) === Boolean(record.resultSummary) &&
      (record.status === 'complete') === Boolean(record.result), 'Only completed comparisons can have results.')
    if (record.status === 'complete') {
      assertAnalysis(record.completedAt && record.result && record.attemptId &&
        record.result.blobName === analysisResultBlobName(record.workspaceId, record.runId, record.id, record.attemptId) &&
        !record.lease && !record.nextAttemptAt && !record.error && !record.cancelledAt, 'Completed result has invalid publication metadata.')
      validateSummary(record.resultSummary!)
    }
    if (record.status === 'cancelled') assertAnalysis(record.cancelledAt && !record.lease && !record.nextAttemptAt,
      'Cancelled comparisons must release work.')
    if (record.status === 'failed') assertAnalysis(record.error && !record.lease && !record.nextAttemptAt, 'Failed comparison must retain a terminal error.')
  } else if (record.recordType === 'analysis-narrative-request') {
    assertAnalysis(record.id === analysisNarrativeId('request', record.runId, record.requestId) &&
      record.plan.blobName === analysisNarrativeRequestBlobName(record.workspaceId, record.runId, record.requestId),
    'Narrative request identity mismatch.')
    const total = record.scheduled.candidates + record.scheduled.targets
    assertAnalysis(record.nextIndex <= total && (record.status === 'queued' ? record.nextIndex < total : record.nextIndex === total) &&
      !record.lease && !record.attemptId && record.attempts === 0 && record.retryCount === 0 && !record.error && !record.nextAttemptAt,
    'Invalid bounded narrative scheduling cursor.')
  } else {
    validateNarrativeRecord(record)
  }
  return record
}

function validateNarrativeRecord(record: RealAnalysisNarrativeRecord): void {
  const kind = record.recordType === 'analysis-candidate-narrative' ? 'candidate' : 'target'
  const subject = record.recordType === 'analysis-candidate-narrative' ? record.comparisonId : record.targetId
  assertAnalysis(record.id === analysisNarrativeId(kind, record.runId, subject) &&
    record.requestedAt >= record.createdAt && record.requestedAt <= record.updatedAt, 'Narrative identity or request time mismatch.')
  if (kind === 'candidate') assertAnalysis(record.status !== 'waiting' && !record.waitingFor, 'Candidate work cannot wait on other narratives.')
  if (record.recordType === 'analysis-candidate-narrative') assertAnalysis(record.inputFingerprint === analysisHash({
    kind: 'candidate', workspaceId: record.workspaceId, runId: record.runId, manifestSha256: record.manifestSha256,
    targetId: record.targetId, targetSnapshot: record.targetSnapshot, comparisonId: record.comparisonId,
    resumeSnapshot: record.resumeSnapshot, resultSha256: record.resultSha256,
  }), 'Candidate narrative fingerprint does not bind its saved input identities.')
  if (record.status === 'waiting') assertAnalysis(record.inputFingerprint === null && record.waitingFor && !record.lease,
    'Waiting target work must identify its prerequisites.')
  else assertAnalysis(!record.waitingFor, 'Only waiting targets have prerequisite state.')
  if (record.status === 'running') assertAnalysis(record.attemptId && record.attempts > 0 && record.lease &&
    record.inputFingerprint && !record.nextAttemptAt && !record.error, 'Running narrative work requires a fingerprint and lease.')
  else assertAnalysis(!record.lease, 'Only running narratives retain a lease.')
  if (record.status === 'queued') assertAnalysis(record.inputFingerprint && record.nextAttemptAt, 'Queued narrative work requires exact inputs and a due time.')
  if (record.status === 'failed') assertAnalysis(record.error && !record.nextAttemptAt, 'Failed narrative work requires a safe terminal error.')
  if (record.status === 'cancelled') assertAnalysis(!record.nextAttemptAt, 'Cancelled narrative work cannot remain scheduled.')
  if (record.published) {
    const publication = record.published
    const parts = publication.blob.blobName.split('/')
    assertAnalysis(publication.revision === publication.blob.sha256 && publication.publishedAt <= record.updatedAt &&
      publication.blob.blobName === analysisNarrativeBlobName(record.workspaceId, record.runId, kind, subject,
        publication.generationId, parts[6]?.replace(/\.json$/, '')),
    'Narrative publication ownership or revision mismatch.')
  }
  if (record.history) {
    assertAnalysisSummaryHistoryReference(record.history, record.workspaceId, record.runId, kind, subject)
    assertAnalysis(record.history.createdAt >= record.createdAt && record.history.createdAt <= record.updatedAt,
      'Summary checkpoint time is outside its work record history.')
  }
  if (record.status === 'ready') assertAnalysis(record.published && record.inputFingerprint && record.attemptId &&
    record.published.generationId === record.generationId && record.published.inputFingerprint === record.inputFingerprint &&
    record.published.blob.blobName === analysisNarrativeBlobName(record.workspaceId, record.runId, kind, subject, record.generationId, record.attemptId) &&
    !record.nextAttemptAt && !record.error, 'Ready narratives require the current published generation.')
}

export function parseAnalysisInitializationManifest(value: unknown): RealAnalysisInitializationManifest {
  bounded(value)
  const manifest = manifestSchema.parse(value) as RealAnalysisInitializationManifest
  assertAnalysis(manifest.inputFingerprint === analysisInputFingerprint(manifest.request), 'Manifest input fingerprint mismatch.')
  assertAnalysis(manifest.resumes.length === manifest.request.resumes.length && manifest.targets.length === manifest.request.targets.length &&
    manifest.comparisons.length === manifest.resumes.length * manifest.targets.length, 'Manifest selections or pair count mismatch.')
  for (const [index, ref] of manifest.resumes.entries()) {
    snapshotReference(ref, manifest.workspaceId, manifest.runId)
    assertAnalysis(ref.snapshotId === analysisDeterministicId('snapshot', manifest.runId, `resume:${index}`) &&
      analysisHash(ref.summary.selection) === analysisHash(manifest.request.resumes[index]), 'Manifest resume identity mismatch.')
  }

  for (const [index, ref] of manifest.targets.entries()) {
    snapshotReference(ref, manifest.workspaceId, manifest.runId)
    assertAnalysis(ref.snapshotId === analysisDeterministicId('snapshot', manifest.runId, `target:${index}`) &&
      analysisHash(ref.summary.selection) === analysisHash(manifest.request.targets[index]), 'Manifest target identity mismatch.')
  }
  for (const [index, pair] of manifest.comparisons.entries()) {
    assertAnalysis(pair.index === index && pair.id === analysisDeterministicId('comparison', manifest.runId, index) &&
      pair.resumeSnapshotId === manifest.resumes[Math.floor(index / manifest.targets.length)].snapshotId &&
      pair.targetSnapshotId === manifest.targets[index % manifest.targets.length].snapshotId, 'Manifest pair identity mismatch.')
  }
  return manifest
}

export function analysisResultBlobName(workspaceId: string, runId: string, comparisonId: string, attemptId: string): string {
  const name = `${workspaceId}/${runId}/results/${comparisonId}/${attemptId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid result publication identity.')
  return name
}

export function analysisDiagnosticBlobName(workspaceId: string, runId: string, comparisonId: string, attemptId: string): string {
  const name = `${workspaceId}/${runId}/diagnostics/${comparisonId}/${attemptId}.json`
  assertAnalysis(isSafeAnalysisBlobName(name), 'Invalid failure diagnostic identity.')
  return name
}

export function assertAnalysisFailureDiagnosticReference(
  reference: AnalysisFailureDiagnosticReference, workspaceId: string, runId: string, comparisonId: string,
): void {
  analysisFailureDiagnosticReferenceSchema.parse(reference)
  assertAnalysis(reference.blob.blobName === analysisDiagnosticBlobName(workspaceId, runId, comparisonId, reference.attemptId),
    'Failure diagnostic belongs to another comparison or attempt.')
}

const frozenBase = {
  schemaVersion: z.literal(1), snapshotId, workspaceId: workspace, dataKind: z.literal('real'), frozenAt: timestamp,
}
const resumeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(UPLOAD_FORMATS), displayName: text(4096), fileName: text(255) }),
  z.strictObject({ kind: z.literal('url'), displayName: text(4096), url: z.string().url().max(4096) }),
])
const resumeSnapshotSchema = z.strictObject({
  ...frozenBase, selection: analysisResumeSelectionSchema,
  displayName: displayName.optional(),
  resume: z.strictObject({
    id: id('resume'), dataKind: z.literal('real'), name: text(2000).nullable(),
    role: text(2000).nullable(), location: text(2000).nullable(), experience: text(2000).nullable(),
    documentId: identifier, documentVersion: integer, sourceLabel: text(4096), batchId: z.string().uuid(),
    status: z.literal('ready'), createdAt: timestamp,
  }),
  source: resumeSourceSchema,
  capture: z.strictObject({
    original: originalReferenceSchema,
    capturedAt: timestamp, finalUrl: z.string().url().max(4096).optional(), redirects: z.array(z.string().url().max(4096)).max(20),
  }),
  extraction: z.strictObject({
    method: z.enum(['document-intelligence', 'legacy-word', 'html', 'browser', 'markdown']), version: text(200), extractedAt: timestamp,
    pagination: z.enum(['pdf-pages', 'html-sections', 'markdown-sections', 'captured-sections']), pageCount: z.number().int().min(1).max(50).nullable(),
    normalizedCharacters: z.number().int().min(1).max(180_000), document: documentReferenceSchema,
  }),
  profile: z.unknown(), document: z.unknown(),
})
export function citationMatchesDocument(citation: Citation, document: SourceDocument): boolean {
  const paragraph = document.paragraphs.find(value => value.id === citation.paragraphId)
  return citation.documentId === document.id && citation.documentVersion === document.version &&
    Boolean(paragraph && citation.page === paragraph.page && citation.heading === paragraph.heading &&
      citation.quote.trim() && paragraph.text.includes(citation.quote))
}
export function parseFrozenResumeSnapshot(value: unknown): FrozenRealResumeSnapshot {
  bounded(value)
  const snapshot = resumeSnapshotSchema.parse(value) as FrozenRealResumeSnapshot
  assertAnalysis(validateRealResumeDocument(snapshot.document).length === 0, 'Invalid frozen resume document.')
  snapshot.profile = parseRealResumeProfile(snapshot.profile)
  const { profile, resume, document, selection, extraction, source, capture } = snapshot
  assertAnalysis(resume.id === selection.resumeId && resume.documentId === document.id &&
    resume.documentVersion === document.version && selection.documentId === document.id && selection.documentVersion === document.version &&
    extraction.document.documentId === document.id && extraction.document.documentVersion === document.version &&
    extraction.document.sha256 === selection.documentSha256 && profile.workspaceId === snapshot.workspaceId &&
    profile.resumeId === resume.id && profile.documentId === document.id && profile.documentVersion === document.version &&
    profile.documentSha256 === selection.documentSha256 && resume.sourceLabel === source.displayName, 'Frozen resume bindings disagree.')
  assertAnalysis(capture.original.blobName === resumeOriginalBlobName(snapshot.workspaceId, resume.id, capture.original.contentType) &&
    extraction.document.blobName === resumeDocumentBlobName(snapshot.workspaceId, resume.id, document.version),
  'Frozen resume provenance is foreign.')
  if (source.kind !== 'url') {
    assertAnalysis(isSafeResumeFilename(source.fileName, source.kind) && source.displayName === source.fileName &&
      capture.original.contentType === UPLOAD_CONTENT_TYPES[source.kind] &&
      !capture.finalUrl && !capture.redirects.length, 'Invalid uploaded source provenance.')
  } else {
    assertAnalysis(source.displayName === source.url && normalizeResumePublicUrl(source.url) === source.url && capture.finalUrl &&
      normalizeResumePublicUrl(capture.finalUrl) === capture.finalUrl &&
      (capture.original.contentType === 'application/pdf' || capture.original.contentType === 'text/html'),
    'Invalid public source provenance.')
    for (const redirect of capture.redirects) assertAnalysis(normalizeResumePublicUrl(redirect) === redirect, 'Invalid source redirect.')
  }
  const pdf = capture.original.contentType === 'application/pdf'
  const word = isWordContentType(capture.original.contentType)
  const markdown = capture.original.contentType === 'text/markdown'
  assertAnalysis(extraction.pagination === documentPagination(capture.original.contentType) &&
    (pdf ? extraction.method === 'document-intelligence' && extraction.pageCount !== null
      : extraction.pageCount === null && (word
        ? extraction.method === (capture.original.contentType === UPLOAD_CONTENT_TYPES.doc ? 'legacy-word' : 'document-intelligence')
        : markdown ? extraction.method === 'markdown' : ['html', 'browser'].includes(extraction.method))) &&
    (!word || document.paragraphs.every(paragraph => paragraph.page === 1)),
  'Extraction does not match its captured media.')
  assertAnalysis(extraction.normalizedCharacters === document.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + paragraph.heading.length, 0) &&
    (extraction.pageCount === null || document.paragraphs.every(paragraph => paragraph.page <= extraction.pageCount!)) &&
    capture.capturedAt >= resume.createdAt && extraction.extractedAt >= capture.capturedAt &&
    profile.provenance.extractedAt >= extraction.extractedAt && snapshot.frozenAt >= profile.provenance.extractedAt,
  'Extraction provenance differs from the complete saved document.')
  for (const field of ['name', 'role', 'location', 'experience'] as const) {
    const item = profile[field]
    assertAnalysis(resume[field] === item.value && item.citations.every(citation => citationMatchesDocument(citation, document)),
      'Resume metadata is not grounded in its captured document.')
  }
  return snapshot
}

export function analysisRequirementEvidence(
  target: Pick<Extract<FrozenRealAnalysisTargetSnapshot, { kind: 'job' }>, 'kind' | 'rubric'> |
    { kind: 'grade'; version: Pick<GradeRubricVersionRecord, 'rubric' | 'qualifications'> },
): FrozenRequirementEvidence[] {
  return analysisRequirementEvidenceForInput(target.kind === 'job'
    ? { rubric: target.rubric, qualifications: [] }
    : { rubric: target.version.rubric, qualifications: target.version.qualifications })
}

const requirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('criterion'), criterionId: identifier, citations }),
  z.strictObject({ kind: z.literal('qualification'), qualificationId: identifier, citations }),
])
const targetSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...frozenBase, kind: z.literal('job'), selection: analysisTargetSelectionSchema.options[0],
    summary: targetSummarySchema.options[0], requirementEvidence: z.array(requirementSchema).max(70),
    job: z.unknown(), rubric: z.unknown(), document: z.unknown(), source: z.unknown(),
    original: originalReferenceSchema,
  }),
  z.strictObject({
    ...frozenBase, kind: z.literal('grade'), selection: analysisTargetSelectionSchema.options[1],
    summary: targetSummarySchema.options[1], requirementEvidence: z.array(requirementSchema).max(70),
    version: z.unknown(), approval: z.unknown(), review: z.unknown(), sourceSet: z.unknown(), seed: z.unknown(),
    references: z.array(z.strictObject({ source: z.unknown(), document: documentReferenceSchema })).min(1).max(16),
  }),
])
export function parseFrozenTargetSnapshot(value: unknown): FrozenRealAnalysisTargetSnapshot {
  bounded(value)
  const target = targetSnapshotSchema.parse(value) as FrozenRealAnalysisTargetSnapshot
  parseAnalysisTargetSummary(target.summary)
  assertAnalysis(target.summary.workspaceId === target.workspaceId && analysisHash(target.selection) === analysisHash(target.summary.selection),
    'Target summary selection mismatch.')
  if (target.kind === 'job') {
    const { job, rubric, document, source, selection, original } = target
    assertAnalysis(job && source && validateRealJobRecord({
      id: job.id, workspaceId: target.workspaceId, recordType: 'job', job, source,
      inputFingerprint: 'snapshot', createdBy: 'snapshot', updatedAt: target.frozenAt, attempts: 0, warnings: [],
    }) && job.status === 'ready' && validateRealSourceDocument(document, original.contentType).length === 0 &&
      rubric && validateRealRubric(rubric, document, original.contentType).length === 0, 'Invalid frozen job evidence.')
    assertAnalysis(job.id === selection.jobId && job.documentId === selection.documentId && document.id === selection.documentId &&
      document.version === selection.documentVersion && rubric.id === selection.rubricId && rubric.version === selection.rubricVersion &&
      rubric.jobId === job.id && job.rubricId === rubric.id && analysisHash(rubric) === selection.rubricHash &&
      source.sha256 === original.sha256 && source.bytes === original.bytes &&
      source.originalContentType === original.contentType && original.blobName.startsWith(`${target.workspaceId}/`) &&
      isSafeAnalysisBlobName(original.blobName) &&
      original.blobName.endsWith(`/evidence/${original.sha256}.${originalExtension(original.contentType)}`),
    'Frozen job selection or original mismatch.')
    assertAnalysis(source.extractionMethod !== 'legacy-word' || original.contentType === UPLOAD_CONTENT_TYPES.doc,
      'Legacy Word extraction requires a DOC original.')
    assertAnalysis(source.extractionMethod !== 'markdown' || original.contentType === 'text/markdown',
      'Markdown extraction requires a Markdown original.')
    if (isWordContentType(original.contentType) || original.contentType === 'text/markdown') {
      assertAnalysis(source.kind !== 'url' && source.originalContentType === UPLOAD_CONTENT_TYPES[source.kind] &&
        isSafeUploadedFilename(source.displayName, source.kind) && !source.url && !source.finalUrl &&
        source.capturedAt && source.capturedAt >= job.createdAt && source.capturedAt <= target.frozenAt &&
        source.extractionMethod === (original.contentType === 'text/markdown' ? 'markdown'
          : original.contentType === UPLOAD_CONTENT_TYPES.doc ? 'legacy-word' : 'document-intelligence') &&
        (original.contentType === 'text/markdown' || document.paragraphs.every(paragraph => paragraph.page === 1)),
      'Invalid frozen uploaded job provenance or captured sections.')
    }
    assertAnalysis(target.summary.rubricId === rubric.id && target.summary.rubricVersion === rubric.version &&
      target.summary.criterionCount === rubric.criteria.length && target.summary.label === job.title, 'Job summary does not match the saved rubric.')
  } else {
    const { version, approval, review, sourceSet, selection, summary } = target
    for (const [record, kind] of [[version, 'grade-version'], [approval, 'grade-approval'], [review, 'grade-review'], [sourceSet, 'grade-source-set']] as const) {
      const parsed = parseGradeEntity(record)
      assertAnalysis(parsed.recordType === kind && parsed.workspaceId === target.workspaceId &&
        'ladderId' in parsed && parsed.ladderId === selection.ladderId, 'Approved grade ownership mismatch.')
    }
    assertAnalysis(version.id === selection.versionId && version.version === selection.version && version.grade === selection.grade &&
      version.contentHash === selection.versionHash && version.sourceSetId === selection.sourceSetId &&
      sourceSet.id === selection.sourceSetId && sourceSet.contentHash === selection.sourceSetHash &&
      approval.id === selection.approvalId && approval.grade === version.grade && approval.versionId === version.id &&
      approval.versionHash === version.contentHash && approval.sourceSetId === sourceSet.id && approval.reviewId === selection.reviewId &&
      review.id === selection.reviewId && review.grade === version.grade && review.versionId === version.id &&
      review.versionHash === version.contentHash && review.sourceSetId === sourceSet.id && review.outcome === 'supported' &&
      review.createdAt >= version.createdAt && approval.createdAt >= review.createdAt && target.frozenAt >= approval.createdAt &&
      !gradeIssuesFor(review.issues, version.grade).some(issue => issue.severity === 'blocker'), 'Approval does not support this exact version.')
    assertAnalysis(summary.rubricId === version.rubric.id && summary.rubricVersion === version.version &&
      summary.criterionCount === version.rubric.criteria.length && summary.approvedAt === approval.createdAt &&
      summary.label === version.rubric.name && summary.sublabel === `${version.rubric.ladder} · GS-${version.grade} · approved v${version.version}` &&
      analysisHash(summary.context) === analysisHash(sourceSet.context), 'Approved grade summary substituted another context.')
    target.seed = parseGradeSeedSnapshot(target.seed) as typeof target.seed
    const seed = sourceSet.sources.find(source => source.origin === 'seed-job')
    assertAnalysis(seed && seed.documentId === target.seed.document.id && seed.documentVersion === target.seed.document.version &&
      seed.originalBlobName === target.seed.source.originalBlobName && seed.sha256 === target.seed.source.sha256 &&
      seed.originalBlobName.startsWith(`${target.workspaceId}/${selection.ladderId}/`) &&
      (!version.rubric.jobId || version.rubric.jobId === target.seed.job.id), 'Grade seed is not from the approved source set.')
    assertAnalysis(target.references.length === sourceSet.sources.length && unique(target.references.map(item => item.source.sourceId)),
      'Frozen reference captures are missing or duplicated.')
    for (const reference of target.references) {
      assertAnalysis(analysisHash(sourceSet.sources.find(item => item.sourceId === reference.source.sourceId) ?? null) === analysisHash(reference.source) &&
        reference.document.documentId === reference.source.documentId && reference.document.documentVersion === reference.source.documentVersion &&
        isSafeAnalysisBlobName(reference.document.blobName) && reference.document.blobName.startsWith(`${target.workspaceId}/`) &&
        reference.document.blobName.endsWith(`/evidence/${reference.document.sha256}.json`),
      'Frozen reference ownership mismatch.')
    }
  }
  assertAnalysis(analysisHash(target.requirementEvidence) === analysisHash(analysisRequirementEvidence(target)),
    'Requirement evidence must preserve every criterion and unscored qualification.')
  return target
}

const limitationSchema = z.strictObject({
  code: z.enum(['sparse-source', 'not-assessable', 'context-limit', 'source-quality']), message: text(4000),
  criterionId: identifier.optional(), qualificationId: identifier.optional(),
})
const criterionBase = { criterionId: identifier, weight: z.number().finite().min(0).max(100), rationale: text(8000), requirementCitations: citations }
const criterionResultSchema = z.discriminatedUnion('evidenceStatus', [
  z.strictObject({ ...criterionBase, evidenceStatus: z.literal('supported'), score: z.number().int().min(0).max(5), citations: citations.min(1) }),
  z.strictObject({ ...criterionBase, evidenceStatus: z.literal('partial'), score: z.number().int().min(0).max(5), citations: citations.min(1) }),
  z.strictObject({ ...criterionBase, evidenceStatus: z.literal('missing'), score: z.literal(0), citations: z.array(citationSchema).length(0) }),
  z.strictObject({ ...criterionBase, evidenceStatus: z.literal('not-assessed'), score: z.null(), citations, limitation: limitationSchema }),
  z.strictObject({ ...criterionBase, evidenceStatus: z.literal('not-applicable'), weight: z.literal(0), score: z.null(), citations: z.array(citationSchema).length(0) }),
])
export const analysisAssessmentOutputSchema = z.strictObject({
  criteria: z.array(criterionResultSchema).min(1).max(20),
  qualifications: z.array(z.strictObject({
    qualificationId: identifier, evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']),
    rationale: text(8000), citations, requirementCitations: citations, limitation: limitationSchema.optional(),
  })).max(50),
  summary: text(12_000), limitations: z.array(limitationSchema).max(100),
})
const modelProvenanceSchema = z.strictObject({
  model: text(300), deployment: text(300), promptVersion: text(200), schemaVersion: text(200),
  startedAt: timestamp, completedAt: timestamp, inputCharacters: z.number().int().min(1).max(10_000_000),
})
const groundingReviewSchema = z.strictObject({
  id: identifier, outcome: z.enum(['supported', 'needs-correction', 'unsupported']),
  issues: z.array(z.strictObject({
    code: identifier, message: text(8000), criterionId: identifier.optional(), qualificationId: identifier.optional(), citations,
  })).max(100),
  assessmentSha256: hash, resumeSnapshotSha256: hash, targetSnapshotSha256: hash, provenance: modelProvenanceSchema,
})
const diagnosticNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const citationDiagnosticsSchema = z.strictObject({
  findings: z.array(z.strictObject({
    reason: z.enum(ANALYSIS_CITATION_REASONS), scope: z.enum(['criteria', 'qualifications', 'issues', 'citations']),
    rowIndex: diagnosticNumber.optional(), criterionId: identifier.optional(), qualificationId: identifier.optional(),
    citationIndex: diagnosticNumber.optional(), paragraphId: identifier.optional(), matchingParagraphId: identifier.optional(),
    quoteLength: diagnosticNumber.optional(), paragraphLength: diagnosticNumber.optional(),
    passageId: diagnosticNumber.optional(), passageCount: diagnosticNumber.optional(),
    startOffset: diagnosticNumber.optional(), endOffset: diagnosticNumber.optional(),
  })).max(ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings),
  omittedFindings: diagnosticNumber,
})
const schemaDiagnosticsSchema = z.strictObject({
  findings: z.array(z.strictObject({
    code: z.enum(ANALYSIS_SCHEMA_ISSUE_CODES),
    path: z.array(z.union([z.enum(ANALYSIS_DIAGNOSTIC_FIELDS), z.number().int().min(0).max(1_000_000)]))
      .max(ANALYSIS_DIAGNOSTIC_LIMITS.maxPathSegments),
  })).max(ANALYSIS_DIAGNOSTIC_LIMITS.maxFindings),
  omittedFindings: diagnosticNumber,
})
const diagnosticEventSchema = z.strictObject({
  event: z.enum(ANALYSIS_TELEMETRY_EVENTS), timestamp, stage: errorSchema.shape.stage,
  workspaceId: workspace.optional(), runId: runId.optional(), comparisonId: comparisonId.optional(), attemptId: z.string().uuid().optional(),
  modelCallId: z.string().uuid().optional(), pipelineVersion: text(200).optional(),
  deployment: text(300).optional(), model: text(300).optional(), promptVersion: text(200).optional(), schemaVersion: text(200).optional(),
  correctionCount: z.number().int().min(0).max(ANALYSIS_LIMITS.maxOutputCorrections).optional(),
  transportAttempt: diagnosticNumber.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
  requestId: z.string().regex(/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[a-zA-Z0-9]{16,64})$/i).optional(),
  durationMilliseconds: diagnosticNumber.optional(), inputCharacters: diagnosticNumber.optional(),
  contextCharacterLimit: diagnosticNumber.optional(), completionTokenLimit: diagnosticNumber.optional(),
  finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls', 'function_call']).optional(),
  code: errorSchema.shape.code.optional(), reason: z.enum(ANALYSIS_DIAGNOSTIC_REASONS).optional(),
  retryable: z.boolean().optional(), cancelled: z.boolean().optional(),
  citationDiagnostics: citationDiagnosticsSchema.optional(), schemaDiagnostics: schemaDiagnosticsSchema.optional(),
  reviewOutcome: groundingReviewSchema.shape.outcome.optional(),
  reviewIssues: z.array(z.strictObject({
    code: z.enum(ANALYSIS_REVIEW_ISSUE_CODES), criterionId: identifier.optional(), qualificationId: identifier.optional(),
  })).max(64).optional(),
  reviewIssueCount: diagnosticNumber.optional(), citationCount: diagnosticNumber.optional(), catalogVersion: text(200).optional(),
  resumeDocumentSha256: hash.optional(), resumeSnapshotSha256: hash.optional(), targetSnapshotSha256: hash.optional(),
  sourceCharacters: diagnosticNumber.optional(), paragraphCount: diagnosticNumber.optional(), passageCount: diagnosticNumber.optional(),
  outcome: z.enum(['complete', 'failed', 'queued', 'abandoned']).optional(),
})
const failureDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: workspace, runId, comparisonId,
  attemptId: z.string().uuid(), createdAt: timestamp, pipelineVersion: text(200), manifestSha256: hash,
  resumeSnapshot: z.strictObject({ snapshotId, sha256: hash }), targetSnapshot: z.strictObject({ snapshotId, sha256: hash }),
  processingAttempt: z.number().int().min(1).max(ANALYSIS_LIMITS.maxAutomaticAttempts),
  retryCount: z.number().int().min(0).max(1_000_000),
  correctionCount: z.number().int().min(0).max(ANALYSIS_LIMITS.maxOutputCorrections),
  error: errorSchema, reason: z.enum(ANALYSIS_DIAGNOSTIC_REASONS).optional(),
  citationDiagnostics: citationDiagnosticsSchema.optional(), schemaDiagnostics: schemaDiagnosticsSchema.optional(),
  events: z.array(diagnosticEventSchema).max(ANALYSIS_DIAGNOSTIC_LIMITS.maxEvents), omittedEvents: diagnosticNumber,
  assessments: z.array(z.strictObject({
    modelCallId: z.string().uuid(), correctionCount: z.number().int().min(0).max(ANALYSIS_LIMITS.maxOutputCorrections),
    assessmentSha256: hash, assessment: analysisAssessmentOutputSchema, provenance: modelProvenanceSchema,
    review: groundingReviewSchema.extend({
      issues: z.array(groundingReviewSchema.shape.issues.element.extend({ code: z.enum(ANALYSIS_REVIEW_ISSUE_CODES) })).max(64),
    }).optional(),
  })).max(ANALYSIS_LIMITS.maxOutputCorrections + 1),
  previous: analysisFailureDiagnosticReferenceSchema.optional(),
})

export function parseAnalysisFailureDiagnostic(value: unknown): AnalysisFailureDiagnostic {
  bounded(value)
  const diagnostic = failureDiagnosticSchema.parse(value) as AnalysisFailureDiagnostic
  assertAnalysis(unique(diagnostic.assessments.map(item => item.modelCallId)), 'Duplicate diagnostic assessment call.')
  if (diagnostic.previous) {
    assertAnalysisFailureDiagnosticReference(diagnostic.previous, diagnostic.workspaceId, diagnostic.runId, diagnostic.comparisonId)
    assertAnalysis(diagnostic.previous.attemptId !== diagnostic.attemptId && diagnostic.previous.createdAt <= diagnostic.createdAt,
      'Invalid previous failure diagnostic.')
  }
  for (const event of diagnostic.events) {
    assertAnalysis(event.workspaceId === diagnostic.workspaceId && event.runId === diagnostic.runId &&
      event.comparisonId === diagnostic.comparisonId && event.attemptId === diagnostic.attemptId &&
      (event.correctionCount ?? 0) <= diagnostic.correctionCount &&
      (!event.resumeSnapshotSha256 || event.resumeSnapshotSha256 === diagnostic.resumeSnapshot.sha256) &&
      (!event.targetSnapshotSha256 || event.targetSnapshotSha256 === diagnostic.targetSnapshot.sha256),
    'Diagnostic event ownership or snapshot mismatch.')
  }
  for (const item of diagnostic.assessments) {
    assertAnalysis(item.assessmentSha256 === analysisAssessmentHash(item.assessment) &&
      item.correctionCount <= diagnostic.correctionCount && item.provenance.completedAt >= item.provenance.startedAt,
    'Diagnostic assessment hash or provenance mismatch.')
    if (item.review) {
      const review = item.review
      assertAnalysis(review.assessmentSha256 === item.assessmentSha256 &&
        review.resumeSnapshotSha256 === diagnostic.resumeSnapshot.sha256 &&
        review.targetSnapshotSha256 === diagnostic.targetSnapshot.sha256 &&
        review.provenance.completedAt >= review.provenance.startedAt &&
        (review.outcome === 'supported' ? review.issues.length === 0 : review.issues.length > 0),
      'Diagnostic review binding or outcome mismatch.')
    }
  }
  return diagnostic
}

export function assertAnalysisFailureDiagnosticBinding(
  diagnostic: AnalysisFailureDiagnostic, run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord,
  snapshots?: { resumeSnapshot: FrozenRealResumeSnapshot; targetSnapshot: FrozenRealAnalysisTargetSnapshot },
): void {
  assertAnalysis(diagnostic.workspaceId === run.workspaceId && diagnostic.runId === run.id &&
    diagnostic.comparisonId === comparison.id && comparison.workspaceId === run.workspaceId && comparison.runId === run.id &&
    diagnostic.manifestSha256 === run.manifest.sha256 &&
    diagnostic.resumeSnapshot.snapshotId === comparison.resume.snapshotId &&
    diagnostic.resumeSnapshot.sha256 === comparison.resume.blob.sha256 &&
    diagnostic.targetSnapshot.snapshotId === comparison.target.snapshotId &&
    diagnostic.targetSnapshot.sha256 === comparison.target.blob.sha256 &&
    diagnostic.createdAt >= comparison.createdAt && diagnostic.createdAt <= comparison.updatedAt,
  'Failure diagnostic does not belong to these frozen comparison inputs.')
  if (!diagnostic.assessments.length) return
  assertAnalysis(snapshots, 'Diagnostic evidence requires its exact frozen sources.')
  for (const item of diagnostic.assessments) {
    assertAnalysis(validateAnalysisAssessment(item.assessment, snapshots.resumeSnapshot.document, snapshots.targetSnapshot).length === 0,
      'Diagnostic assessment cites foreign evidence or requirements.')
    for (const issue of item.review?.issues ?? []) {
      assertAnalysis(!(issue.criterionId && issue.qualificationId) &&
        (!issue.criterionId || item.assessment.criteria.some(row => row.criterionId === issue.criterionId)) &&
        (!issue.qualificationId || item.assessment.qualifications.some(row => row.qualificationId === issue.qualificationId)) &&
        issue.citations.every(citation => citationMatchesDocument(citation, snapshots.resumeSnapshot.document)),
      'Diagnostic review cites foreign evidence or requirements.')
    }
  }
}

const resultSchema = analysisAssessmentOutputSchema.extend({
  schemaVersion: z.literal(1), dataKind: z.literal('real'), workspaceId: workspace, runId, comparisonId,
  createdAt: timestamp, humanReviewRequired: z.literal(true), ...resultSummarySchema.shape,
  provenance: z.strictObject({
    attemptId: z.string().uuid(), manifestSha256: hash,
    resumeSnapshot: z.strictObject({ snapshotId, sha256: hash }), targetSnapshot: z.strictObject({ snapshotId, sha256: hash }),
    assessmentSha256: hash, assessment: modelProvenanceSchema,
    groundingReviews: z.array(groundingReviewSchema).min(1).max(ANALYSIS_LIMITS.maxOutputCorrections + 1),
    correctionCount: z.number().int().min(0).max(ANALYSIS_LIMITS.maxOutputCorrections),
    calculationVersion: z.literal('weighted-0-100-v1'),
  }),
})

export function parseAnalysisAssessmentOutput(value: unknown): RealAnalysisAssessmentOutput {
  return analysisAssessmentOutputSchema.parse(value) as RealAnalysisAssessmentOutput
}
export function validateAnalysisAssessment(
  value: RealAnalysisAssessmentOutput, resume: RealResumeDocument, target: FrozenRealAnalysisTargetSnapshot,
): string[] {
  const errors: string[] = []
  const parsed = analysisAssessmentOutputSchema.safeParse(value)
  if (!parsed.success) return ['The assessment has an invalid output shape.']
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const qualifications = target.kind === 'grade' ? target.version.qualifications : []
  if (!unique(value.criteria.map(item => item.criterionId)) || value.criteria.length !== rubric.criteria.length ||
    rubric.criteria.some(item => !value.criteria.some(result => result.criterionId === item.id))) errors.push('Assessment criterion coverage differs from the saved rubric.')
  if (!unique(value.qualifications.map(item => item.qualificationId)) || value.qualifications.length !== qualifications.length ||
    qualifications.some(item => !value.qualifications.some(result => result.qualificationId === item.id))) errors.push('Assessment qualification coverage differs from the saved rubric.')
  for (const item of [...value.criteria, ...value.qualifications]) {
    const criterion = 'criterionId' in item ? rubric.criteria.find(row => row.id === item.criterionId) : undefined
    const evidence = target.requirementEvidence.find(row => 'criterionId' in item ?
      row.kind === 'criterion' && row.criterionId === item.criterionId : row.kind === 'qualification' && row.qualificationId === item.qualificationId)
    if (!evidence || !item.requirementCitations.length || item.requirementCitations.length !== evidence.citations.length ||
      !unique(item.requirementCitations.map(analysisHash)) ||
      item.requirementCitations.some(citation => !evidence.citations.some(expected => analysisHash(expected) === analysisHash(citation)))) {
      errors.push('Assessment requirement citations do not match the exact saved requirement.')
    }
    if (item.citations.some(citation => !citationMatchesDocument(citation, resume))) errors.push('Resume evidence does not match the saved resume.')
    if ('criterionId' in item) {
      if (!criterion || item.weight !== criterion.weight ||
        (item.evidenceStatus === 'not-applicable') !== ('support' in criterion && criterion.support === 'not-applicable')) {
        errors.push('Assessment modified a saved criterion weight or exclusion.')
      }
      if (item.evidenceStatus === 'not-assessed' && item.limitation.criterionId !== item.criterionId) errors.push('Unassessed criterion must identify its limitation.')
    } else if ((['supported', 'partial'].includes(item.evidenceStatus) && !item.citations.length) ||
      (item.evidenceStatus === 'missing' && item.citations.length) ||
      (item.evidenceStatus === 'not-assessed' && item.limitation?.qualificationId !== item.qualificationId)) {
      errors.push('Qualification evidence status is inconsistent.')
    }
  }
  for (const limitation of value.limitations) {
    if ((limitation.criterionId && !rubric.criteria.some(item => item.id === limitation.criterionId)) ||
      (limitation.qualificationId && !qualifications.some(item => item.id === limitation.qualificationId))) errors.push('Limitation belongs to a different requirement.')
  }
  return [...new Set(errors)]
}
export function parseAnalysisResult(value: unknown): RealAnalysisResult {
  bounded(value)
  const result = resultSchema.parse(value) as RealAnalysisResult
  const { provenance } = result
  const assessment = { criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }
  assertAnalysis(provenance.assessmentSha256 === analysisAssessmentHash(assessment), 'Result assessment hash mismatch.')
  assertAnalysis(unique(result.criteria.map(item => item.criterionId)) && unique(result.qualifications.map(item => item.qualificationId)),
    'Result contains duplicate requirements.')
  const expected = calculateAnalysisSummary(result.criteria, result.qualifications, result.limitations)
  assertAnalysis(analysisHash(expected.coverage) === analysisHash(result.coverage) && expected.completion === result.completion &&
    expected.overall.status === result.overall.status && expected.overall.score === result.overall.score &&
    (expected.overall.status !== 'withheld' || (result.overall.status === 'withheld' && expected.overall.reason === result.overall.reason)),
  'Result total or coverage was not calculated from the unchanged criteria.')
  const final = provenance.groundingReviews.at(-1)!
  assertAnalysis(final.outcome === 'supported' && final.issues.length === 0 && final.assessmentSha256 === provenance.assessmentSha256 &&
    provenance.groundingReviews.length <= provenance.correctionCount + 1, 'A supported review of this exact assessment is required.')
  for (const review of provenance.groundingReviews) {
    assertAnalysis(review.resumeSnapshotSha256 === provenance.resumeSnapshot.sha256 &&
      review.targetSnapshotSha256 === provenance.targetSnapshot.sha256 &&
      review.provenance.completedAt >= review.provenance.startedAt &&
      (review.outcome === 'supported' ? review.issues.length === 0 : review.issues.length > 0), 'Review provenance mismatch.')
  }
  assertAnalysis(provenance.assessment.completedAt >= provenance.assessment.startedAt, 'Invalid assessment provenance.')
  validateSummary(result)
  return result
}
export function assertAnalysisResultBinding(
  result: RealAnalysisResult, run: RealAnalysisRunRecord, comparison: RealAnalysisComparisonRecord,
  resume: FrozenRealResumeSnapshot, target: FrozenRealAnalysisTargetSnapshot,
): void {
  assertAnalysis(result.workspaceId === run.workspaceId && result.runId === run.id && result.comparisonId === comparison.id &&
    result.provenance.manifestSha256 === run.manifest.sha256 &&
    result.provenance.resumeSnapshot.snapshotId === comparison.resume.snapshotId &&
    result.provenance.resumeSnapshot.sha256 === comparison.resume.blob.sha256 &&
    result.provenance.targetSnapshot.snapshotId === comparison.target.snapshotId &&
    result.provenance.targetSnapshot.sha256 === comparison.target.blob.sha256 &&
    result.provenance.attemptId === comparison.attemptId, 'Result belongs to another comparison or attempt.')
  const assessment = { criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }
  assertAnalysis(validateAnalysisAssessment(assessment, resume.document, target).length === 0, 'Result evidence does not match the frozen inputs.')
  for (const review of result.provenance.groundingReviews) for (const issue of review.issues) {
    assertAnalysis(issue.citations.every(citation => citationMatchesDocument(citation, resume.document)) &&
      (!issue.criterionId || result.criteria.some(item => item.criterionId === issue.criterionId)) &&
      (!issue.qualificationId || result.qualifications.some(item => item.qualificationId === issue.qualificationId)),
    'Grounding review cites foreign evidence or requirements.')
  }
}

export function assertApprovedGradeBindings(version: GradeRubricVersionRecord, sourceSet: GradeSourceSetRecord): void {
  assertAnalysis(version.workspaceId === sourceSet.workspaceId && version.ladderId === sourceSet.ladderId &&
    version.sourceSetId === sourceSet.id && sourceSet.grades.includes(version.grade), 'Grade source-set binding mismatch.')
}
