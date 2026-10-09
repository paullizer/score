import { z } from 'zod'
import { EVIDENCE_SCALE_VERSIONS } from '../../src/domain/evidence-scale'
import { RUBRIC_QA_CHECK_CODES, RUBRIC_QA_VERSION, RUBRIC_REVIEW_FINDING_CODES } from '../../src/domain/rubric-qa'
import {
  RUBRIC_REVIEW_LIMITS, RUBRIC_REVIEW_PROMPT_VERSION, rubricQaRecordId,
  type RubricApprovalRecord, type RubricQaRecord,
} from '../../src/domain/rubric-approval'
import { isValidWorkspaceId } from '../ids'
import { isRubricApprovalId, isValidDocumentId, isValidJobId } from './validation'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp.')
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Text must not be blank.')
const workspaceId = z.string().refine(isValidWorkspaceId)
const jobId = z.string().refine(isValidJobId)
const rubricId = text(1024)
const version = z.number().int().min(1).max(1_000_000_000)
const approvalId = z.string().refine(isRubricApprovalId)

const findingSchema = z.strictObject({
  code: z.enum([...RUBRIC_QA_CHECK_CODES, ...RUBRIC_REVIEW_FINDING_CODES]),
  severity: z.enum(['blocker', 'warning']),
  criterionIds: z.array(text(200)).max(20),
  message: text(8000),
  match: z.string().max(20_000).optional(),
  similarity: z.number().min(0).max(1).optional(),
})
const reviewFindingSchema = findingSchema.refine(
  finding => finding.severity === 'warning' && (RUBRIC_REVIEW_FINDING_CODES as readonly string[]).includes(finding.code),
  'Rubric review findings are warnings with a review code.',
)

export const rubricQaRecordSchema = z.strictObject({
  id: z.string().max(1024),
  workspaceId,
  recordType: z.literal('rubric-qa'),
  jobId,
  rubricId,
  version,
  rubricHash: hash,
  qaVersion: z.literal(RUBRIC_QA_VERSION),
  checks: z.array(findingSchema).max(1000),
  review: z.strictObject({
    promptVersion: z.literal(RUBRIC_REVIEW_PROMPT_VERSION),
    model: text(300),
    summary: text(RUBRIC_REVIEW_LIMITS.maxSummaryCharacters),
    findings: z.array(reviewFindingSchema).max(RUBRIC_REVIEW_LIMITS.maxFindings),
  }),
  createdBy: text(200),
  createdAt: timestamp,
}).refine(value => value.id === rubricQaRecordId(value.rubricId, value.version), 'The QA record id must match its rubric version.')

export const rubricApprovalRecordSchema = z.strictObject({
  id: approvalId,
  workspaceId,
  recordType: z.literal('rubric-approval'),
  jobId,
  rubricId,
  version,
  rubricHash: hash,
  scaleVersion: z.enum(EVIDENCE_SCALE_VERSIONS),
  qa: z.strictObject({ id: z.string().max(1024), sha256: hash }),
  document: z.strictObject({ id: z.string().refine(isValidDocumentId), version, sha256: hash }),
  approvedBy: text(200),
  approvedAt: timestamp,
  supersedes: approvalId.optional(),
}).refine(value => value.qa.id === rubricQaRecordId(value.rubricId, value.version), 'The approval must cite the QA record of its version.')
  .refine(value => value.supersedes !== value.id, 'An approval cannot supersede itself.')

/** Stored rubric checks are re-validated on every read; a record that fails is treated as corrupt, never as missing. */
export function parseRubricQaRecord(value: unknown, expected: { workspaceId: string; jobId?: string }): RubricQaRecord {
  const parsed = rubricQaRecordSchema.safeParse(value)
  if (!parsed.success || parsed.data.workspaceId !== expected.workspaceId ||
    (expected.jobId !== undefined && parsed.data.jobId !== expected.jobId)) {
    throw new Error('Stored rubric check results have an invalid ownership or data shape.')
  }
  return parsed.data
}

export function parseRubricApprovalRecord(value: unknown, expected: { workspaceId: string; jobId?: string }): RubricApprovalRecord {
  const parsed = rubricApprovalRecordSchema.safeParse(value)
  if (!parsed.success || parsed.data.workspaceId !== expected.workspaceId ||
    (expected.jobId !== undefined && parsed.data.jobId !== expected.jobId)) {
    throw new Error('Stored rubric approval has an invalid ownership or data shape.')
  }
  return parsed.data
}
