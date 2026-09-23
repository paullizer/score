import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  QC_LIMITS, qcBatchInputSchema, qcComparisonRefSchema, qcFeedbackDraftSchema, qcFeedbackSchema, qcHash, qcIdentifier,
  type QcBlobReference, type QcComparisonRef,
} from '../../src/domain/quality-control'
import {
  QC_PROMPT_FAMILIES, qcCaseSelectionSchema, qcPlanInputSchema, qcPlanProposalSchema,
  type QcCasePack, type QcEvaluation, type QcPlanRecord, type QcPromptSet,
} from '../../src/domain/quality-improvement'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { conflict, invalidRequest, preconditionRequired } from '../errors'
import {
  analysisAssessmentOutputSchema, analysisResultSummarySchema, analysisHash,
  parseAnalysisEntity, parseAnalysisResult, parseFrozenResumeSnapshot, parseFrozenTargetSnapshot,
} from '../analyses/validation'
import { citationSchema, gradeQualificationSchema, validateReferenceDocument } from '../grades/validation'
import type { QcListOptions, QcRecord } from './store'

export const QC_RECORD_BYTES = 1024 * 1024
export const QC_TRANSACTION_BYTES = 1_800_000
export const QC_TRANSACTION_OPERATIONS = 95
export const QC_LEASE_MILLISECONDS = 90_000
export const QC_BLOB_WRITE_MILLISECONDS = 30_000
export const qcUuidSchema = z.uuid()
const date = z.iso.datetime()
const actor = z.strictObject({ principalId: z.string().min(1).max(200), name: z.string().max(300) })
const base = {
  id: qcIdentifier, workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  createdAt: date, updatedAt: date,
}
const requestFields = { lastRequestId: qcUuidSchema, lastRequestHash: qcHash }
export const qcBlobReferenceSchema = z.strictObject({
  name: z.string().min(1).max(500), sha256: qcHash, bytes: z.number().int().min(1).max(QC_LIMITS.artifactBytes),
})
export const qcPromptSetSchema = z.strictObject({
  revision: qcIdentifier, etag: z.string().min(1).max(1024),
  guidance: z.strictObject({
    jobRubric: z.string().max(QC_LIMITS.guidanceCharacters),
    gradeCompetencies: z.string().max(QC_LIMITS.guidanceCharacters),
    gradeDraft: z.string().max(QC_LIMITS.guidanceCharacters),
    assessment: z.string().max(QC_LIMITS.guidanceCharacters),
  }),
})
const review = z.strictObject({
  ...base, recordType: z.literal('qc-review'), scope: qcComparisonRefSchema, author: actor,
  feedback: z.array(qcFeedbackDraftSchema).max(QC_LIMITS.criteria), submittedId: qcIdentifier.nullable(),
  submissionNumber: z.number().int().min(0), peerExposedAt: date.nullable(), ...requestFields,
})
const submission = z.strictObject({
  ...base, recordType: z.literal('qc-submission'), headId: qcIdentifier, scope: qcComparisonRefSchema, author: actor,
  feedback: z.array(qcFeedbackSchema).min(1).max(QC_LIMITS.criteria),
  submissionNumber: z.number().int().min(1), peerIndependent: z.boolean(), peerExposedAt: date.nullable(),
  requestId: qcUuidSchema, requestHash: qcHash,
})
const batch = z.strictObject({
  ...base, recordType: z.literal('qc-batch'), name: qcBatchInputSchema.shape.name,
  createdBy: actor, comparisons: qcBatchInputSchema.shape.comparisons,
})
const control = z.strictObject({
  ...base, recordType: z.literal('qc-control'), runId: qcIdentifier.optional(),
  state: z.enum(['active', 'archived', 'deleting', 'deleted']),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanupPending: z.boolean().optional(), cancellationPending: z.boolean().optional(),
})
const plan = z.strictObject({
  ...base, recordType: z.literal('qc-plan'), name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(4000), createdBy: actor, revision: z.number().int().min(1),
  cases: z.array(qcCaseSelectionSchema).min(1).max(QC_LIMITS.planCases),
  excludedFeedback: z.array(z.strictObject({ reviewId: qcIdentifier, reason: z.string().trim().min(1).max(QC_LIMITS.reasonCharacters) }))
    .max(QC_LIMITS.selectedReviews),
  casePack: qcBlobReferenceSchema, baseline: qcPromptSetSchema, processingSettings: processingSettingsSnapshotSchema,
  proposal: qcPlanProposalSchema.nullable(),
  status: z.enum(['draft', 'planning', 'evaluating', 'ready', 'failed', 'cancelled', 'activated', 'invalidated']),
  workId: qcIdentifier.nullable(), evaluation: qcBlobReferenceSchema.nullable(), activatedRevision: qcIdentifier.nullable(),
  error: z.string().max(500).nullable(), ...requestFields,
})
const revision = z.strictObject({
  ...base, recordType: z.literal('qc-plan-revision'), planId: qcIdentifier,
  revision: z.number().int().min(1), value: plan,
})
const work = z.strictObject({
  ...base, recordType: z.literal('qc-work'), planId: qcIdentifier, planRevision: z.number().int().min(1),
  kind: z.enum(['plan', 'evaluation']), status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
  requestedBy: actor, requestId: qcUuidSchema, requestHash: qcHash, attempts: z.number().int().min(0).max(100),
  lease: z.strictObject({ id: qcIdentifier, expiresAt: date }).nullable(),
  nextAttemptAt: date.nullable(), checkpoint: qcBlobReferenceSchema.nullable(), error: z.string().max(500).nullable(),
})
const receipt = z.strictObject({
  ...base, recordType: z.literal('qc-request'), actorId: z.string().min(1).max(200),
  requestId: qcUuidSchema, requestHash: qcHash, action: qcIdentifier, targetId: qcIdentifier,
  runIds: z.array(qcIdentifier).max(QC_LIMITS.batchComparisons),
  controlFences: z.array(z.strictObject({
    controlId: qcIdentifier, generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })).min(1).max(QC_LIMITS.planCases + 1).optional(),
})
const writer = z.strictObject({
  ...base, recordType: z.literal('qc-writer'), ownerId: qcIdentifier,
  runIds: z.array(qcIdentifier).min(1).max(QC_LIMITS.planCases), expiresAt: date,
})
const artifactOwner = z.strictObject({
  ...base, recordType: z.literal('qc-artifacts'), ownerId: qcIdentifier,
  runIds: z.array(qcIdentifier).min(1).max(QC_LIMITS.planCases),
})
const recordSchema = z.discriminatedUnion('recordType', [review, submission, batch, control, plan, revision, work, receipt, writer, artifactOwner])

export function qcAssert(condition: unknown, message = 'QC data failed its integrity check.'): asserts condition {
  if (!condition) throw new Error(message)
}
export function qcBytesHash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export const qcValueHash = analysisHash
export function qcId(kind: string, ...values: unknown[]): string { return `qc-${kind}-${qcValueHash(values)}` }
export function qcControlId(runId?: string): string { return runId ? qcId('control', runId) : 'qc-control-workspace' }
export function qcHeadId(scope: QcComparisonRef, actorId: string): string { return qcId('review', scope, actorId) }
export function qcOwnerPrefix(workspaceId: string, ownerId?: string): string {
  qcAssert(WORKSPACE_ID_PATTERN.test(workspaceId) && (ownerId === undefined || qcIdentifier.safeParse(ownerId).success))
  return `${workspaceId}/${ownerId ? `${ownerId}/` : ''}`
}
export function qcBlobScope(reference: QcBlobReference, workspaceId: string, ownerId?: string): void {
  qcBlobReferenceSchema.parse(reference)
  const prefix = qcOwnerPrefix(workspaceId, ownerId)
  qcAssert(reference.name.startsWith(prefix) &&
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9:._-]+\/[a-f0-9]{64}\.json$/.test(reference.name) &&
    reference.name.endsWith(`/${reference.sha256}.json`) && !reference.name.includes('..'),
  'QC artifact is outside its immutable owner scope.')
}
export function qcInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest('QC request contains invalid values, duplicate selections, or unsupported fields.')
  return result.data
}
export function qcRequestKey(value: unknown): string {
  const parsed = qcUuidSchema.safeParse(value)
  if (!parsed.success) throw invalidRequest('Idempotency-Key must be a UUID.')
  return parsed.data.toLowerCase()
}
export function qcEtag(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value === '*' || value.startsWith('W/') ||
    value.length > 1024 || /[,\r\n]/.test(value) || !/^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value)) {
    throw invalidRequest('If-Match must contain one exact strong quoted ETag.')
  }
}
export function qcMatch(actual: string, expected?: string): void {
  if (expected === undefined) throw preconditionRequired('Supply the exact QC record ETag in If-Match.')
  qcEtag(expected)
  if (actual !== expected) throw conflict('This QC record changed. Reload before saving; your unsaved feedback was not applied.')
}
export function parseQcRecord(value: unknown): QcRecord {
  qcAssert(Buffer.byteLength(JSON.stringify(value)) <= QC_RECORD_BYTES, 'QC record exceeds its bounded size.')
  const parsed = recordSchema.safeParse(value)
  qcAssert(parsed.success, 'QC record has an invalid schema.')
  const record = parsed.data as QcRecord
  qcAssert(record.updatedAt >= record.createdAt, 'QC timestamps are inconsistent.')
  if (record.recordType === 'qc-review' || record.recordType === 'qc-submission') {
    qcAssert(new Set(record.feedback.map(item => item.criterionId)).size === record.feedback.length &&
      (record.recordType === 'qc-review' ? record.id : record.headId) === qcHeadId(record.scope, record.author.principalId),
    'QC review ownership or criterion identity is invalid.')
    if (record.recordType === 'qc-review') qcAssert(Boolean(record.submittedId) === (record.submissionNumber > 0))
    if (record.recordType === 'qc-submission') qcAssert(!record.peerIndependent || !record.peerExposedAt)
  }
  if (record.recordType === 'qc-control') qcAssert(record.id === qcControlId(record.runId))
  if (record.recordType === 'qc-request' && record.controlFences) {
    const expected = [qcControlId(), ...[...new Set(record.runIds)].map(qcControlId)].sort()
    qcAssert(['draft-plan', 'evaluate-plan', 'retry-plan'].includes(record.action) &&
      qcValueHash(record.controlFences.map(fence => fence.controlId).sort()) === qcValueHash(expected),
    'QC acceptance fences must cover the exact workspace and selected runs.')
  }
  if (record.recordType === 'qc-plan') {
    qcPlanInputSchema.parse({ name: record.name, objective: record.objective, cases: record.cases, excludedFeedback: record.excludedFeedback })
    qcBlobScope(record.casePack, record.workspaceId, record.id)
    if (record.evaluation) qcBlobScope(record.evaluation, record.workspaceId, record.id)
    qcEtag(record.baseline.etag)
    const snapshot = record.processingSettings.promptBundle
    qcAssert(snapshot && snapshot.bundle.bundleId === record.baseline.revision &&
      QC_PROMPT_FAMILIES.every(family => snapshot.revisions[family].guidance === record.baseline.guidance[family]),
    'The displayed QC baseline must match its immutable accepted prompt snapshot.')
    qcAssert(record.status !== 'ready' || Boolean(record.proposal && record.evaluation))
    qcAssert(record.status !== 'activated' || Boolean(record.proposal && record.evaluation && record.activatedRevision))
    if (record.proposal) validateQcProposal(record.proposal, record)
  }
  if (record.recordType === 'qc-plan-revision') {
    parseQcRecord(record.value)
    qcAssert(record.value.id === record.planId && record.value.revision === record.revision &&
      record.value.workspaceId === record.workspaceId, 'QC plan revision is foreign.')
  }
  if (record.recordType === 'qc-work') {
    qcAssert((record.status === 'running') === Boolean(record.lease), 'QC work lease does not match its state.')
    if (record.checkpoint) qcBlobScope(record.checkpoint, record.workspaceId, record.planId)
  }
  return record
}
export function qcRunIds(record: QcRecord): string[] {
  switch (record.recordType) {
    case 'qc-review': case 'qc-submission': return [record.scope.runId]
    case 'qc-batch': return [...new Set(record.comparisons.map(item => item.runId))]
    case 'qc-plan': return [...new Set(record.cases.map(item => item.scope.runId))]
    case 'qc-plan-revision': return qcRunIds(record.value)
    case 'qc-control': return record.runId ? [record.runId] : []
    case 'qc-request': case 'qc-writer': case 'qc-artifacts': return record.runIds
    default: return []
  }
}
export function assertQcReplacement(previous: QcRecord, next: QcRecord, lifecycle = false): void {
  qcAssert(previous.id === next.id && previous.workspaceId === next.workspaceId && previous.recordType === next.recordType &&
    previous.createdAt === next.createdAt && next.updatedAt >= previous.updatedAt, 'QC record identity is immutable.')
  qcAssert(!['qc-submission', 'qc-plan-revision', 'qc-request', 'qc-batch', 'qc-writer', 'qc-artifacts'].includes(previous.recordType) ||
    qcValueHash(previous) === qcValueHash(next), 'QC history is immutable.')
  if (previous.recordType === 'qc-review' && next.recordType === 'qc-review') {
    qcAssert(qcValueHash(previous.scope) === qcValueHash(next.scope) &&
      previous.author.principalId === next.author.principalId &&
      (previous.peerExposedAt === null || previous.peerExposedAt === next.peerExposedAt) &&
      next.submissionNumber >= previous.submissionNumber && next.submissionNumber <= previous.submissionNumber + 1,
    'QC review scope, attribution, and exposure cannot change.')
  }
  if (previous.recordType === 'qc-plan' && next.recordType === 'qc-plan') {
    for (const field of ['createdBy', 'name', 'objective', 'cases', 'excludedFeedback', 'casePack', 'baseline', 'processingSettings'] as const) {
      qcAssert(qcValueHash(previous[field]) === qcValueHash(next[field]), 'A frozen QC selection cannot be changed.')
    }
    qcAssert(next.revision >= previous.revision && next.revision <= previous.revision + 1, 'QC revision cannot skip or regress.')
    qcAssert(previous.status !== 'activated' || (lifecycle && next.status === 'invalidated') ||
      qcValueHash(previous) === qcValueHash(next), 'Activated candidates cannot be edited.')
    qcAssert(previous.status !== 'invalidated' || next.status === 'invalidated', 'Invalidated evidence cannot be reused.')
    if (qcValueHash(previous.proposal) !== qcValueHash(next.proposal)) {
      qcAssert(next.revision === previous.revision + 1 && !next.evaluation && next.status === 'draft',
        'Proposal edits require a new unevaluated revision.')
    }
  }
  if (previous.recordType === 'qc-work' && next.recordType === 'qc-work') {
    for (const field of ['planId', 'planRevision', 'kind', 'requestedBy', 'requestId', 'requestHash'] as const) {
      qcAssert(qcValueHash(previous[field]) === qcValueHash(next[field]), 'Accepted QC work is immutable.')
    }
    qcAssert(next.attempts >= previous.attempts, 'QC attempts cannot reset.')
    qcAssert(!['complete', 'cancelled'].includes(previous.status) || next.status === previous.status ||
      lifecycle && next.status === 'cancelled', 'Stopped QC work cannot restart.')
  }
  if (previous.recordType === 'qc-control' && next.recordType === 'qc-control') {
    qcAssert(lifecycle || qcValueHash(previous) === qcValueHash(next), 'Only lifecycle operations change lifecycle controls.')
    qcAssert(!['deleting', 'deleted'].includes(previous.state) || ['deleting', 'deleted'].includes(next.state),
      'Deleted QC evidence cannot be resurrected.')
    qcAssert((next.generation ?? 0) === (previous.generation ?? 0) + Number(previous.state !== next.state),
      'QC lifecycle generations advance exactly once per state transition.')
  }
}

const listSchema = z.strictObject({
  recordType: z.enum(['qc-review', 'qc-submission', 'qc-batch', 'qc-control', 'qc-plan', 'qc-plan-revision', 'qc-work', 'qc-request', 'qc-writer', 'qc-artifacts']).optional(),
  runId: qcIdentifier.optional(), comparisonId: qcIdentifier.optional(), resultSha256: qcHash.optional(),
  resultRevision: qcIdentifier.optional(), planId: qcIdentifier.optional(), ownerId: qcIdentifier.optional(),
  authorId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(QC_LIMITS.pageSize).optional(),
  continuationToken: z.string().min(1).max(24 * 1024).optional(),
})
export function qcListOptions(value: QcListOptions): QcListOptions { return qcInput(listSchema, value) }
export function qcPageCursor(workspaceId: string, options: QcListOptions): string | undefined {
  qcListOptions(options)
  if (!options.continuationToken) return undefined
  try {
    const raw = Buffer.from(options.continuationToken, 'base64url')
    if (raw.toString('base64url') !== options.continuationToken) throw new Error()
    const parsed = z.strictObject({ scope: qcHash, cursor: z.string().min(1).max(16 * 1024) }).parse(JSON.parse(raw.toString('utf8')))
    if (parsed.scope !== qcPageScope(workspaceId, options)) throw new Error()
    return parsed.cursor
  } catch { throw invalidRequest('The QC continuation token does not belong to this exact query.') }
}
function qcPageScope(workspaceId: string, options: QcListOptions): string {
  const { continuationToken: _token, ...scope } = options
  void _token
  return qcValueHash({ workspaceId, ...scope, limit: scope.limit ?? QC_LIMITS.pageSize })
}
export function qcPageToken(workspaceId: string, options: QcListOptions, cursor?: string): string | undefined {
  return cursor ? Buffer.from(JSON.stringify({ scope: qcPageScope(workspaceId, options), cursor })).toString('base64url') : undefined
}
export function qcRecordMatches(record: QcRecord, workspaceId: string, options: QcListOptions): boolean {
  return record.workspaceId === workspaceId && (!options.recordType || record.recordType === options.recordType) &&
    (!options.runId || qcRunIds(record).includes(options.runId)) &&
    (!options.comparisonId || 'scope' in record && record.scope.comparisonId === options.comparisonId) &&
    (!options.resultSha256 || 'scope' in record && record.scope.resultSha256 === options.resultSha256) &&
    (!options.resultRevision || 'scope' in record && record.scope.resultRevision === options.resultRevision) &&
    (!options.planId || 'planId' in record && record.planId === options.planId) &&
    (!options.ownerId || 'ownerId' in record && record.ownerId === options.ownerId) &&
    (!options.authorId || 'author' in record && record.author.principalId === options.authorId ||
      Boolean(options.authorId && 'createdBy' in record && record.createdBy.principalId === options.authorId))
}
export function qcCandidateGuidance(planRecord: QcPlanRecord): QcPromptSet['guidance'] {
  const result = { ...planRecord.baseline.guidance }
  for (const change of planRecord.proposal?.changes ?? []) result[change.familyId] = change.guidance
  return result
}
export function qcPlanHash(planRecord: QcPlanRecord): string {
  return qcValueHash({
    id: planRecord.id, workspaceId: planRecord.workspaceId, revision: planRecord.revision,
    name: planRecord.name, objective: planRecord.objective, createdBy: planRecord.createdBy, cases: planRecord.cases,
    casePack: planRecord.casePack, excludedFeedback: planRecord.excludedFeedback, proposal: planRecord.proposal,
    baseline: planRecord.baseline, settings: planRecord.processingSettings,
  })
}
export function qcSettingsHash(settings: QcPlanRecord['processingSettings']): string {
  return qcValueHash({ revision: settings.revision, settings: settings.settings, tasks: settings.tasks })
}
export function validateQcProposal(proposal: unknown, planRecord: Pick<QcPlanRecord, 'cases'>): void {
  const parsed = qcPlanProposalSchema.parse(proposal)
  const allowed = new Set(planRecord.cases.filter(item => item.purpose === 'drafting').flatMap(item => item.reviewIds))
  qcAssert(parsed.findings.every(finding => finding.reviewIds.every(id => allowed.has(id))),
    'The proposal cites feedback outside its authorized drafting selection.')
  qcAssert(parsed.changes.every(change => !/\{\{|\}\}|\$\{|\{%|%\}/.test(change.guidance)),
    'Candidate guidance cannot contain unresolved template placeholders.')
}

export function parseQcCasePack(value: unknown, workspaceId: string, planId: string): QcCasePack {
  const parsed = z.strictObject({
    schemaVersion: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN), planId: qcIdentifier,
    createdBy: actor, createdAt: date,
    cases: z.array(z.strictObject({
      selection: qcCaseSelectionSchema, analysis: z.unknown(), reviews: z.array(submission).max(QC_LIMITS.selectedReviews),
      references: z.array(z.unknown()).max(30),
    })).min(1).max(QC_LIMITS.planCases),
  }).parse(value)
  qcAssert(parsed.workspaceId === workspaceId && parsed.planId === planId, 'QC case pack ownership changed.')
  for (const entry of parsed.cases) {
    const detail = entry.analysis as QcCasePack['cases'][number]['analysis']
    qcAssert(detail && Object.keys(detail).every(key => ['comparison', 'etag', 'resumeSnapshot', 'targetSnapshot', 'result'].includes(key)))
    const comparison = parseAnalysisEntity(detail.comparison)
    const resume = parseFrozenResumeSnapshot(detail.resumeSnapshot)
    const target = parseFrozenTargetSnapshot(detail.targetSnapshot)
    const result = parseAnalysisResult(detail.result)
    qcAssert(comparison.recordType === 'analysis-comparison' && comparison.workspaceId === workspaceId &&
      comparison.status === 'complete' && comparison.id === entry.selection.scope.comparisonId &&
      comparison.runId === entry.selection.scope.runId && comparison.result?.sha256 === entry.selection.scope.resultSha256 &&
      (comparison.resultRevision?.id ?? 'original') === entry.selection.scope.resultRevision &&
      result.workspaceId === workspaceId && result.comparisonId === comparison.id && result.runId === comparison.runId &&
      resume.workspaceId === workspaceId && target.workspaceId === workspaceId &&
      result.provenance.resumeSnapshot.snapshotId === resume.snapshotId &&
      result.provenance.targetSnapshot.snapshotId === target.snapshotId &&
      result.provenance.resumeSnapshot.sha256 === comparison.resume.blob.sha256 &&
      result.provenance.targetSnapshot.sha256 === comparison.target.blob.sha256,
    'QC frozen evidence does not match its exact result selection.')
    qcAssert(entry.reviews.length === entry.selection.reviewIds.length &&
      new Set(entry.reviews.map(item => item.author.principalId)).size === entry.reviews.length &&
      entry.reviews.every(item => {
        parseQcRecord(item)
        return item.workspaceId === workspaceId && entry.selection.reviewIds.includes(item.id) &&
          qcValueHash(item.scope) === qcValueHash(entry.selection.scope)
      }), 'QC selected submissions do not match the frozen feedback.')
    for (const reference of entry.references) qcAssert(validateReferenceDocument(reference as never).length === 0)
    if (target.kind === 'grade') {
      qcAssert(entry.references.length === target.references.length &&
        target.references.every(binding => entry.references.some(document => {
          const reference = document as QcCasePack['cases'][number]['references'][number]
          return reference.id === binding.source.documentId && reference.version === binding.source.documentVersion
        })), 'QC reference evidence is incomplete.')
    } else qcAssert(entry.references.length === 0)
  }
  return parsed as QcCasePack
}
export const qcTrialResultSchema = z.strictObject({
  status: z.enum(['complete', 'failed']), error: z.string().max(500).nullable(),
  assessment: analysisAssessmentOutputSchema.optional(), summary: analysisResultSummarySchema.optional(),
  rubric: z.strictObject({
    criteria: z.array(z.strictObject({
      id: qcIdentifier, label: z.string().max(1000), description: z.string().max(8000),
      weight: z.number().min(0).max(100), guidance: z.string().max(16_000),
      sourceCitations: z.array(citationSchema).max(30).optional(),
      gradeBasis: z.array(citationSchema).max(30).optional(),
      competencyId: qcIdentifier.optional(), support: z.enum(['direct', 'derived', 'gap', 'not-applicable']).optional(),
      interpretation: z.string().max(12_000).optional(),
    })).min(1).max(QC_LIMITS.criteria), description: z.string().max(12_000),
    qualifications: z.array(gradeQualificationSchema).max(50).optional(),
    issues: z.array(z.strictObject({
      id: qcIdentifier, code: qcIdentifier, severity: z.enum(['blocker', 'warning']),
      scope: z.enum(['context', 'source', 'grade', 'criterion', 'qualification']), message: z.string().min(1).max(8000),
      sourceId: qcIdentifier.optional(), grade: z.number().int().min(1).max(15).optional(), criterionId: qcIdentifier.optional(),
      citations: z.array(citationSchema).max(30).optional(),
    })).max(300).optional(),
    warnings: z.array(z.string().max(16_000)).max(150).optional(),
  }).optional(),
  findings: z.array(z.string().max(2000)).max(100), reviewedCriteria: z.number().int().min(0).max(QC_LIMITS.criteria),
  exactAgreements: z.number().int().min(0).max(QC_LIMITS.criteria), absoluteDifference: z.number().min(0).max(100),
})
export const qcEvaluationCaseSchema = z.strictObject({
  scope: qcComparisonRefSchema, purpose: z.enum(['drafting', 'holdout']),
  familyId: z.enum(QC_PROMPT_FAMILIES), baseline: qcTrialResultSchema, candidate: qcTrialResultSchema,
})
export function parseQcEvaluation(value: unknown, record: QcPlanRecord): QcEvaluation {
  const result = z.strictObject({
    schemaVersion: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN), planId: qcIdentifier,
    planRevision: z.number().int().min(1), planHash: qcHash, baselineRevision: qcIdentifier,
    settingsHash: qcHash, candidateHash: qcHash, createdAt: date, completedAt: date,
    cases: z.array(qcEvaluationCaseSchema).min(1).max(QC_LIMITS.planCases * QC_PROMPT_FAMILIES.length),
    eligible: z.boolean(), limitations: z.array(z.string().max(2000)).max(100),
  }).parse(value) as QcEvaluation
  qcAssert(result.workspaceId === record.workspaceId && result.planId === record.id &&
    result.planRevision === record.revision && result.planHash === qcPlanHash(record) &&
    result.baselineRevision === record.baseline.revision && result.settingsHash === qcSettingsHash(record.processingSettings) &&
    result.candidateHash === qcValueHash(qcCandidateGuidance(record)), 'QC evaluation does not bind this exact candidate.')
  qcAssert(result.cases.every(item => record.cases.some(selection =>
    qcValueHash(selection.scope) === qcValueHash(item.scope) && selection.purpose === item.purpose)) &&
    new Set(result.cases.map(item => qcValueHash([item.scope, item.familyId]))).size === result.cases.length,
  'QC evaluation contains foreign or duplicate cases.')
  if (result.eligible) qcAssert(result.cases.every(item => item.baseline.status === 'complete' && item.candidate.status === 'complete') &&
    record.proposal?.changes.every(change => result.cases.some(item => item.familyId === change.familyId)),
  'Failed or incomplete trials cannot activate prompts.')
  return result
}
