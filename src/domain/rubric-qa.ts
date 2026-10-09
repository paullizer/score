import { checkCriterionLevels, rubricScaleErrors } from './evidence-scale'
import type { Citation } from './types'

export const RUBRIC_QA_VERSION = 'score-rubric-qa-v1' as const

/** Codes the model-free checks produce. */
export const RUBRIC_QA_CHECK_CODES = [
  'scale-structure', 'unobservable-wording', 'shared-source-text', 'similar-requirement', 'similar-label',
] as const
export type RubricQaCheckCode = typeof RUBRIC_QA_CHECK_CODES[number]

/** Codes the rubric review (one model pass) may report. Review findings are always warnings. */
export const RUBRIC_REVIEW_FINDING_CODES = ['same-capability', 'not-observable', 'scale-mismatch', 'unsupported-by-source'] as const
export type RubricReviewFindingCode = typeof RUBRIC_REVIEW_FINDING_CODES[number]

export type RubricQaFindingCode = RubricQaCheckCode | RubricReviewFindingCode

export interface RubricQaFinding {
  code: RubricQaFindingCode
  /** Blockers prevent approval; warnings are shown to the approver, who decides whether to merge, split or re-weight. */
  severity: 'blocker' | 'warning'
  criterionIds: string[]
  message: string
  match?: string
  similarity?: number
}

interface QaCriterion {
  id: string
  label: string
  description: string
  guidance?: string
  levels?: unknown
  sourceCitations?: readonly Citation[]
  support?: string
}

export interface RubricQaInput {
  scaleVersion?: unknown
  criteria: readonly QaCriterion[]
}

export const RUBRIC_QA_THRESHOLDS = Object.freeze({ similarRequirement: 0.6, similarLabel: 0.6 })

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'within',
  'is', 'are', 'be', 'its', 'their', 'this', 'that', 'such', 'other', 'including', 'related',
])

function words(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !STOP_WORDS.has(word)))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

const scored = (criterion: QaCriterion) => criterion.support !== 'gap' && criterion.support !== 'not-applicable'
const name = (criterion: QaCriterion) => `"${criterion.label}"`

/** Two citations overlap when they quote the same or nested text of one paragraph in one document version. */
function sharedQuote(left: readonly Citation[], right: readonly Citation[]): string | null {
  for (const a of left) {
    for (const b of right) {
      if (a.documentId !== b.documentId || a.documentVersion !== b.documentVersion || a.paragraphId !== b.paragraphId) continue
      if (a.quote.includes(b.quote)) return b.quote
      if (b.quote.includes(a.quote)) return a.quote
    }
  }
  return null
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Deterministic, model-free rubric checks run before approval. They flag likely overlap and wording a resume
 * can't show; conceptual overlap that shares no words needs the separate rubric review.
 */
export function rubricQaChecks(rubric: RubricQaInput): RubricQaFinding[] {
  const findings: RubricQaFinding[] = rubricScaleErrors(rubric).map(message => ({
    code: 'scale-structure' as const, severity: 'blocker' as const, criterionIds: [], message,
  }))
  const criteria = rubric.criteria.filter(scored)
  if (rubric.scaleVersion !== undefined) {
    for (const criterion of criteria) {
      const sourceTexts = (criterion.sourceCitations ?? []).map(citation => citation.quote)
      for (const finding of checkCriterionLevels(criterion.levels, { sourceTexts })) {
        if (finding.severity !== 'warning') continue
        findings.push({
          code: 'unobservable-wording', severity: 'warning', criterionIds: [criterion.id],
          message: `${name(criterion)}: ${finding.message}`, ...(finding.match ? { match: finding.match } : {}),
        })
      }
    }
  }
  for (let left = 0; left < criteria.length; left++) {
    for (let right = left + 1; right < criteria.length; right++) {
      const a = criteria[left], b = criteria[right]
      const ids = [a.id, b.id]
      const quote = sharedQuote(a.sourceCitations ?? [], b.sourceCitations ?? [])
      if (quote !== null) {
        findings.push({
          code: 'shared-source-text', severity: 'warning', criterionIds: ids, match: quote,
          message: `${name(a)} and ${name(b)} cite the same job text, so they may assess the same requirement. Merge them, or make each cite the part it assesses.`,
        })
      }
      const requirement = jaccard(words(a.description), words(b.description))
      if (requirement >= RUBRIC_QA_THRESHOLDS.similarRequirement) {
        findings.push({
          code: 'similar-requirement', severity: 'warning', criterionIds: ids, similarity: rounded(requirement),
          message: `${name(a)} and ${name(b)} describe very similar requirements. Check that a resume detail would not count twice.`,
        })
      }
      const labelA = words(a.label), labelB = words(b.label)
      const label = jaccard(labelA, labelB)
      const nested = labelA.size > 0 && labelB.size > 0 &&
        ([...labelA].every(word => labelB.has(word)) || [...labelB].every(word => labelA.has(word)))
      if (label >= RUBRIC_QA_THRESHOLDS.similarLabel || nested) {
        findings.push({
          code: 'similar-label', severity: 'warning', criterionIds: ids, similarity: rounded(label),
          message: `${name(a)} and ${name(b)} have similar names. Make sure they assess different capabilities.`,
        })
      }
    }
  }
  return findings
}

export function rubricQaBlocks(findings: readonly RubricQaFinding[]): boolean {
  return findings.some(finding => finding.severity === 'blocker')
}
