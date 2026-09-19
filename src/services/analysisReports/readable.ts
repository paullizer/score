import type {
  AnalysisReport, ReportCandidate, ReportComparison, ReportEvidenceStatus, ReportGroup,
  ReportStatusCounts, ReportTarget,
} from '../../domain/analysis-reports'
import { criterionScoreLabel, formatReportWeight } from './presentation'

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
const NO_EXPLANATION = 'A specific explanation was not recorded. View the analysis for context.'
const plain = (value: string): string => value.replace(/\s+/gu, ' ').trim()
const characters = (value: string): string[] => Array.from(graphemeSegmenter.segment(value), part => part.segment)

function textBudget(value: number, minimum = 16): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`Report text needs a budget of at least ${minimum} characters.`)
}

export function compactReportText(value: string, maxCharacters: number): string {
  textBudget(maxCharacters)
  const normalized = plain(value)
  const parts = characters(normalized)
  if (parts.length <= maxCharacters) return normalized
  let shortened = parts.slice(0, maxCharacters - 3).join('')
  const boundary = shortened.lastIndexOf(' ')
  if (boundary >= shortened.length / 2) shortened = shortened.slice(0, boundary)
  return `${shortened.trimEnd().replace(/[.,;:]$/u, '')}...`
}

// Real saved summaries describe processing totals; the candidate evidence lives in criterion rationales.
const BOILERPLATE = [
  /^(?:(?:full|saved|overall)\s+)*(?:assessment|summary)(?:\s+excerpt)?[.!:]?$/iu,
  /^exact saved rationale for\b/iu,
  /^(?:summary excerpt|saved assessment excerpt)\s*[:.-]/iu,
  /^this is evidence,? not a hiring recommendation[.!]?$/iu,
  /^(?:a qualified reviewer must|human review is required|review the (?:quoted|full|saved) evidence and limitations before)\b/iu,
  /^(?:run ID|comparison ID|rubric ID|manifest SHA-256|assessment model|capture interval)\s*:/iu,
  /^the submitted document was compared only with this exact saved rubric[.!]?$/iu,
  /^criterion evidence:\s*\d+ supported\b/iu,
  /^the document evidence-match total is\b/iu,
  /^the \d+ qualification notes are separate, unscored, and require human review[.!]?$/iu,
  /^missing evidence does not establish that a person lacks ability[.!]?$/iu,
  /^this is a human-review aid, not a hiring recommendation or an official GS eligibility decision[.!]?$/iu,
]

function genericSentence(value: string): boolean {
  return BOILERPLATE.some(pattern => pattern.test(value))
}

function evidenceSentences(value: string): string[] {
  return Array.from(sentenceSegmenter.segment(plain(value)), part => part.segment.trim())
    .filter(sentence => sentence && !genericSentence(sentence))
}

function shortClause(sentence: string, maxCharacters: number): string | undefined {
  const parts = sentence.split(/;\s*|,\s+(?=(?:but|however)\b)/iu)
  if (parts.length < 2) return undefined
  const clauses = parts.map(part => part.trim()).filter(Boolean)
    .map(part => /[.!?]$/u.test(part) ? part : `${part}.`)
    .filter(part => characters(part).length <= maxCharacters)
  return clauses.find(part => /\b(?:not (?:clearly )?(?:documented|established|shown|provided|verified|assessed|demonstrated)|no (?:supporting )?(?:evidence|examples|details|documentation)|limited (?:evidence|examples)|less clear|insufficient|however|but)\b/iu.test(part))
    ?? clauses[0]
}

function conciseEvidence(value: string, maxCharacters: number, maxSentences = 2): string {
  const sentences = evidenceSentences(value)
  if (!sentences.length) return ''
  const selected: string[] = []
  for (const sentence of sentences) {
    if (selected.length >= maxSentences) break
    if (characters([...selected, sentence].join(' ')).length > maxCharacters) {
      if (!selected.length) selected.push(shortClause(sentence, maxCharacters) ?? compactReportText(sentence, maxCharacters))
      break
    }
    selected.push(sentence)
  }
  return selected.join(' ')
}

export function readableCandidateName(candidate: ReportCandidate): string {
  return candidate.name?.trim() ? plain(candidate.name) : plain(candidate.sourceLabel) || 'Name not recorded'
}

export function readableTargetLabel(report: AnalysisReport, group: ReportGroup): string {
  const label = plain(group.target.label)
  const matches = report.groups.filter(item => plain(item.target.label).toLocaleLowerCase('en') === label.toLocaleLowerCase('en'))
  if (matches.length < 2) return label
  const sublabel = plain(group.target.sublabel)
  if (sublabel && matches.filter(item => plain(item.target.sublabel) === sublabel).length === 1) return `${label} - ${sublabel}`
  return `${label} (${group.target.kind === 'grade' ? 'Grade' : 'Job'} ${matches.findIndex(item => item.target.id === group.target.id) + 1})`
}

export function readableJobFacts(target: ReportTarget, maxFacts = 4): string[] {
  if (!Number.isInteger(maxFacts) || maxFacts < 0) throw new Error('The report job-fact limit must be a nonnegative integer.')
  const labels = ['Organization', 'Agency', 'Location', 'Work arrangement', 'Employment type', 'GS grade', 'Grade', 'Series', 'Specialty', 'Functions', 'Supervision']
  const facts = labels.flatMap(label => {
    const fact = target.facts.find(item => item.label === label)
    return fact ? [`${label}: ${compactReportText(fact.value, 160)}`] : []
  })
  if (!facts.length && target.sublabel.trim()) facts.push(compactReportText(target.sublabel, 180))
  const description = target.facts.find(fact => fact.label === 'Rubric description')?.value
  const focus = description ? conciseEvidence(description, 180, 1) : ''
  if (focus) facts.push(focus)
  return [...new Set(facts)].slice(0, maxFacts)
}

export function readableCompletionNotice(counts: ReportStatusCounts, multiTarget = false): string {
  const noun = multiTarget ? 'candidate-job reviews' : counts.total === 1 ? 'candidate' : 'candidates'
  const remaining = [
    counts.queued + counts.running ? `${counts.queued + counts.running} still processing` : '',
    counts.failed ? `${counts.failed} could not be assessed` : '',
    counts.cancelled ? `${counts.cancelled} cancelled` : '',
  ].filter(Boolean)
  return `Reporting on ${counts.complete} of ${counts.total} ${noun}.${remaining.length ? ` ${remaining.join('; ')}.` : ''}`
}

export function readableAnalysisDate(value: string | null): string {
  if (value === null) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('The report contains an invalid analysis date.')
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
}

export interface ReadableCriterion {
  id: string
  number: number
  label: string
  weight: number
  weightLabel: string
  score: number | null
  scoreLabel: string
  evidenceStatus: ReportEvidenceStatus
  explanation: string
  sourceLabel: string | null
  required: boolean
  limitation: string | null
}

export function criterionReviews(target: ReportTarget, comparison: ReportComparison, maxCharacters = 220): ReadableCriterion[] {
  textBudget(maxCharacters, 48)
  if (comparison.status !== 'complete') throw new Error('Criterion reviews require a completed assessment.')
  const assessments = new Map(comparison.criteria.map(assessment => [assessment.criterionId, assessment]))
  return target.criteria.map((definition, index) => {
    const assessment = assessments.get(definition.id)
    if (!assessment) throw new Error('A completed assessment is missing a saved criterion. No incomplete report was generated.')
    const limitation = assessment.limitation ? conciseEvidence(assessment.limitation.message, maxCharacters, 1) : null
    let explanation = conciseEvidence(assessment.rationale, maxCharacters)
    if (limitation && !plain(assessment.rationale).includes(plain(assessment.limitation!.message))) {
      const reserve = Math.min(Math.floor(maxCharacters / 2), characters(limitation).length)
      explanation = `${conciseEvidence(assessment.rationale, Math.max(16, maxCharacters - reserve - 1), 1)} ${compactReportText(limitation, Math.max(16, reserve))}`.trim()
    }
    if (!explanation) {
      switch (assessment.evidenceStatus) {
        case 'missing': explanation = 'No supporting evidence was found in the resume.'; break
        case 'not-assessed': explanation = 'This criterion could not be assessed from the available evidence.'; break
        case 'not-applicable': explanation = 'Not used in this assessment.'; break
        case 'partial': explanation = 'The evidence only partly supports this criterion. A specific explanation was not recorded.'; break
        case 'supported': explanation = NO_EXPLANATION
      }
    }
    const citation = assessment.citations[0]
    const sourceLabel = citation
      ? `${compactReportText(comparison.candidate.sourceLabel, 140)}, ${citation.pagination === 'pdf-pages' ? 'page' : 'section'} ${citation.page}`
      : null
    return {
      id: definition.id, number: index + 1, label: plain(definition.label),
      weight: assessment.weight, weightLabel: formatReportWeight(assessment.weight),
      score: assessment.score, scoreLabel: assessment.evidenceStatus === 'not-applicable' ? 'N/A' : criterionScoreLabel(assessment),
      evidenceStatus: assessment.evidenceStatus,
      explanation: compactReportText(explanation, maxCharacters),
      sourceLabel, required: definition.requirementType === 'required', limitation,
    }
  })
}

function strength(criterion: ReadableCriterion): number {
  return criterion.weight * (criterion.score ?? 0) / 5
}

function gap(criterion: ReadableCriterion): number {
  return criterion.evidenceStatus === 'not-applicable' ? 0 : criterion.weight * (5 - (criterion.score ?? 0)) / 5
}

export function selectKeyCriteria(criteria: readonly ReadableCriterion[], maxCount: number): ReadableCriterion[] {
  if (!Number.isInteger(maxCount) || maxCount < 0) throw new Error('The report criterion limit must be a nonnegative integer.')
  if (criteria.length <= maxCount) return [...criteria]
  const ordered = (importance: (criterion: ReadableCriterion) => number) => [...criteria].sort((left, right) =>
    importance(right) - importance(left) || Number(right.required) - Number(left.required) || left.number - right.number)
  const gaps = ordered(gap).filter(criterion => gap(criterion) > 0)
  const strengths = ordered(strength).filter(criterion => strength(criterion) > 0)
  const priority = gaps.flatMap((criterion, index) => [criterion, ...(strengths[index] ? [strengths[index]] : [])])
  priority.push(...strengths, ...ordered(criterion => criterion.weight))
  const chosen = new Set<string>()
  for (const criterion of priority) {
    if (chosen.size >= maxCount) break
    chosen.add(criterion.id)
  }
  return criteria.filter(criterion => chosen.has(criterion.id))
}

export function qualificationNotes(comparison: ReportComparison, maxNotes = 3, maxCharacters = 200): string[] {
  textBudget(maxCharacters, 48)
  if (!Number.isInteger(maxNotes) || maxNotes < 0) throw new Error('The report qualification-note limit must be a nonnegative integer.')
  const severity = { 'not-assessed': 3, missing: 2, partial: 1, supported: 0 }
  const concerns = comparison.qualifications.filter(qualification => qualification.evidenceStatus !== 'supported' || qualification.limitation)
    .map((qualification, index) => ({ qualification, index }))
    .sort((left, right) => severity[right.qualification.evidenceStatus] - severity[left.qualification.evidenceStatus] || left.index - right.index)
  return concerns.slice(0, maxNotes).map(({ qualification }, index) => {
    const more = index === maxNotes - 1 && concerns.length > maxNotes ? ' More in the full analysis.' : ''
    const label = compactReportText(qualification.text, Math.max(16, Math.min(75, Math.floor(maxCharacters / 3))))
    const budget = Math.max(16, maxCharacters - characters(label).length - 2 - more.length)
    const reason = conciseEvidence(qualification.limitation?.message ?? qualification.rationale, budget, 1) || 'Needs human review.'
    return compactReportText(`${label}: ${reason}${more}`, maxCharacters)
  })
}

function criterionHighlight(criterion: ReadableCriterion, budget: number): string {
  const label = compactReportText(criterion.label, Math.max(16, Math.min(52, Math.floor(budget / 3))))
  const prefix = `${label} (${criterion.scoreLabel}): `
  const explanation = conciseEvidence(criterion.explanation, Math.max(16, budget - characters(prefix).length))
  return compactReportText(`${prefix}${explanation}`, budget)
}

function assessmentCaution(comparison: ReportComparison, maxCharacters: number): string {
  const qualification = qualificationNotes(comparison, 1, Math.max(48, Math.min(140, Math.floor(maxCharacters / 3))))[0]
  const limitation = comparison.limitations.find(item => evidenceSentences(item.message).length)?.message
  return qualification ? `Qualification needs review (unscored): ${qualification}` : limitation ? `Needs review: ${limitation}` : ''
}

export function assessmentIntroduction(comparison: ReportComparison, maxCharacters = 320): string | null {
  textBudget(maxCharacters, 80)
  if (comparison.status !== 'complete') throw new Error('Assessment introductions require a completed assessment.')
  const caution = assessmentCaution(comparison, maxCharacters)
  const cautionBudget = caution ? Math.max(48, Math.floor(maxCharacters / 3)) : 0
  const budget = maxCharacters - cautionBudget - (caution ? 1 : 0)
  const introduction = comparison.overall.status === 'available'
    ? conciseEvidence(comparison.summary ?? '', budget)
    : compactReportText(`No overall score: ${comparison.overall.message}`, budget)
  const text = [introduction, caution ? compactReportText(caution, cautionBudget) : ''].filter(Boolean).join(' ')
  return text || null
}

function assessmentText(target: ReportTarget, comparison: ReportComparison, maxCharacters: number, includeOverall: boolean): string {
  textBudget(maxCharacters, 80)
  if (comparison.status !== 'complete') throw new Error('Assessment highlights require a completed assessment.')
  const clauses: string[] = []
  const reviews = criterionReviews(target, comparison)
  const meaningful = reviews.filter(criterion => criterion.explanation !== NO_EXPLANATION && criterion.evidenceStatus !== 'not-applicable')
  const chosen = selectKeyCriteria(meaningful, 2)
  const overall = conciseEvidence(comparison.summary ?? '', Math.min(180, Math.floor(maxCharacters / 2)), 1)
  const scoreReason = comparison.overall.status === 'available' ? '' : `No overall score: ${comparison.overall.message}`
  const caution = assessmentCaution(comparison, maxCharacters)
  const includeSummary = overall && (includeOverall || !chosen.length) &&
    !chosen.some(criterion => criterion.explanation.includes(overall) || overall.includes(criterion.explanation))
  if (scoreReason) clauses.push(compactReportText(scoreReason, Math.max(48, Math.floor(maxCharacters / 2))))
  else if (includeSummary) clauses.push(overall)
  const cautionBudget = caution ? Math.max(48, Math.floor(maxCharacters / 3)) : 0
  const available = maxCharacters - characters(clauses.join(' ')).length - cautionBudget - (clauses.length ? 1 : 0) - (caution ? 1 : 0)
  const count = Math.min(chosen.length, Math.floor(available / 65))
  if (count) {
    const selected = selectKeyCriteria(chosen, count)
    const budget = Math.floor((available - (count - 1)) / count)
    clauses.push(...selected.map(criterion => criterionHighlight(criterion, budget)))
  }
  if (caution) clauses.push(compactReportText(caution, cautionBudget))
  if (!clauses.length) clauses.push(NO_EXPLANATION)
  return compactReportText(clauses.join(' '), maxCharacters)
}

export function assessmentSummary(target: ReportTarget, comparison: ReportComparison, maxCharacters = 460): string {
  return assessmentText(target, comparison, maxCharacters, true)
}

export function assessmentHighlights(target: ReportTarget, comparison: ReportComparison, maxCharacters = 240): string {
  return assessmentText(target, comparison, maxCharacters, false)
}
