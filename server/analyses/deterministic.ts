import { createHash } from 'node:crypto'
import type {
  AnalysisLimitation, FrozenRequirementEvidence, RealAnalysisAssessmentInput, RealAnalysisAssessmentOutput,
  RealAnalysisResultSummary, RealCriterionResult, RealQualificationAssessment,
} from '../../src/domain/real-analyses'
import type { Citation } from '../../src/domain/types'

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
  if (result === undefined) throw new Error('Analysis hashes require JSON-serializable content.')
  return result
}

/** Semantic JSON hash; Blob references must instead hash their actual stored bytes. */
export function analysisHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function analysisAssessmentHash(
  { criteria, qualifications, summary, limitations }: RealAnalysisAssessmentOutput,
): string {
  return analysisHash({ criteria, qualifications, summary, limitations })
}

export function analysisRequirementEvidenceForInput(
  { rubric, qualifications }: Pick<RealAnalysisAssessmentInput, 'rubric' | 'qualifications'>,
): FrozenRequirementEvidence[] {
  const deduplicate = (values: Citation[]) => {
    const citations = new Map<string, Citation>()
    for (const citation of values) {
      const key = analysisHash(citation)
      if (!citations.has(key)) citations.set(key, citation)
    }
    return [...citations.values()]
  }
  const rows: FrozenRequirementEvidence[] = rubric.criteria.map(criterion => ({
    kind: 'criterion', criterionId: criterion.id,
    citations: deduplicate([
      ...(criterion.sourceCitations ?? []),
      ...('gradeBasis' in criterion ? criterion.gradeBasis as Citation[] : []),
    ]),
  }))
  if (rubric.kind === 'grade') rows.push(...qualifications.map(item => ({
    kind: 'qualification' as const, qualificationId: item.id, citations: deduplicate(item.citations),
  })))
  return rows
}

/** Both model normalization and API publication validation use this unchanged-weight calculation. */
export function calculateAnalysisSummary(
  criteria: readonly RealCriterionResult[],
  qualifications: readonly RealQualificationAssessment[] = [],
  limitations: readonly AnalysisLimitation[] = [],
): RealAnalysisResultSummary {
  const coverage = {
    totalCriteria: criteria.length, supported: 0, partial: 0, missing: 0, notAssessed: 0, notApplicable: 0,
    assessedWeight: 0, totalWeight: 0,
  }
  let weighted = 0
  for (const criterion of criteria) {
    coverage.totalWeight += criterion.weight
    if (criterion.evidenceStatus === 'not-assessed') coverage.notAssessed++
    else if (criterion.evidenceStatus === 'not-applicable') coverage.notApplicable++
    else {
      coverage[criterion.evidenceStatus]++
      coverage.assessedWeight += criterion.weight
      weighted += criterion.score * criterion.weight / 5
    }
  }
  const unassessed = criteria.some(item => item.evidenceStatus === 'not-assessed' && item.weight > 0)
  const overall: RealAnalysisResultSummary['overall'] = coverage.assessedWeight === 0 ? {
    status: 'withheld', score: null, reason: 'no-assessable-weight',
    message: 'No positively weighted criterion could be assessed from the submitted document; no total was fabricated.',
  } : unassessed ? {
    status: 'withheld', score: null, reason: 'unassessed-weighted-criteria',
    message: 'A positively weighted criterion is not assessed; the remaining weights were not normalized into a total.',
  } : { status: 'available', score: Math.round((weighted + Number.EPSILON) * 10) / 10 }
  return {
    completion: coverage.notAssessed || qualifications.some(item => item.evidenceStatus === 'not-assessed') ||
      limitations.length || overall.status === 'withheld' ? 'limited' : 'assessed',
    overall, coverage,
  }
}
