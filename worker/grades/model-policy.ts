import type { GradeCompetency, GradeIssue } from '../../src/domain/real-grades'
import type { Citation } from '../../src/domain/types'
import {
  citationErrors, citationParagraph, citationSection, isGradeEvidence, issue, mergeIssues,
  type ModelEvidence,
} from './model-evidence'
import type { ModelDraft, ModelIssue, ModelPlan, ModelQualification } from './model-schema'

export const SCORE_INTERPRETATION =
  'Score weights and 0–5 guidance are proposed reviewer-facing interpretations, not OPM classification points or an official classification or eligibility decision.'
export const QUALIFICATION_INTERPRETATION =
  'This is an unscored source requirement, separate from work-level weights; it is not an eligibility determination. Alternative paths are not cumulative requirements.'

export interface Validation {
  errors: string[]
  issues: GradeIssue[]
}

function meaningful(value: string, minimum = 12): boolean {
  return value.trim().length >= minimum && /\p{L}/u.test(value) &&
    !/^(?:n\/a|none|tbd|todo|unknown|unsupported|gap|not[- ]applicable|placeholder)[.!?\s]*$/i.test(value.trim())
}

function affirmativeSentences(text: string): string[] {
  return text.split(/(?:[.!?]\s+|\n|;|\bbut\b)/).filter(value =>
    !/\b(?:not|never|cannot)\s+(?:score[ds]?|scoring|rank(?:ed|ing)?|reward(?:ed|ing)?|prefer(?:red)?|evaluat(?:e|ed|ing)|assess(?:ed|ing)?|consider(?:ed)?|deriv(?:e|ed|ing)|convert(?:ed)?|certif(?:y|ies|ied)|guarantee[ds]?|OPM[- ]certified)\b/i.test(value))
}

export function authorityClaimErrors(text: string): string[] {
  const invalid = affirmativeSentences(text).filter(value =>
    !/\b(?:not|never)\s+(?:require[ds]?|mandate[ds]?|prescribe[ds]?|approve[ds]?)\b/i.test(value)).some(value =>
    /\b(?:OPM|FES|federal|classification)\b.{0,55}\b(?:requires?|mandates?|prescribes?|certifies|approves?)\b.{0,55}\b(?:hiring scores?|weights?|0[-–]5)\b/i.test(value) ||
    /\b(?:weights?|hiring scores?)\b.{0,45}\b(?:equal|converted from|based on|derived from|proportional to)\b.{0,35}\b(?:FES|classification|factor)\s+points\b/i.test(value) ||
    /\b(?:OPM[- ]certified|officially (?:classified|certified|approved)|(?:certifies?|guarantees?) (?:applicant |candidate )?eligibility)\b/i.test(value))
  return invalid ? ['Score interpretations must not claim official classification/eligibility certification or derive hiring weights from FES classification points.'] : []
}

export function demographicScoringErrors(label: string, text: string): string[] {
  const trait = '(?:age|race|ethnicity|religion|sex|gender|pregnancy|disability(?: status)?|marital status|national origin|citizenship|sexual orientation|veteran status|genetic (?:information|profile|traits|status))'
  const bareTrait = new RegExp(`^(?:(?:applicant|candidate)\\s+)?${trait}(?:\\s+(?:preference|status|score))?[.!]?\\s*$`, 'i')
  const possessiveTrait = new RegExp(`\\b(?:applicants?|candidates?)(?:['’]s?|\\s+(?:demographics?|personal))\\s+${trait}\\b`, 'i')
  const scoreTrait = new RegExp(`\\b(?:score|rank|reward|prefer|evaluate|assess)(?:s|d|ing)?\\s+(?:(?:the|an?|applicant|candidate|their|your)\\s+){0,3}${trait}\\b`, 'i')
  const candidateTrait = /\b(?:applicants?|candidates?)\b.{0,30}\b(?:must|should|shall|need to|preferred to)\s+be\s+(?:male|female|young|unmarried|married|non[- ]?disabled|able[- ]bodied|pregnant|under\s+\d+|over\s+\d+)\b/i
  const explicitPreference = /\b(?:prefer(?:red)?|require[ds]?|only|higher scores? (?:for|to))\s+(?:young|male|female|non[- ]?disabled|able[- ]bodied|married|unmarried|native[- ]born)\s+(?:applicants?|candidates?|employees?|workers?|engineers?)\b|\b(?:young|youthful)\s+(?:applicant|candidate|engineer|worker)\b/i
  const ageRequirement = /\b(?:applicants?|candidates?)\b.{0,30}\b(?:must|shall|required to|should)\s+(?:be|have)\s+(?:an?\s+age\s+)?(?:under|over|below|above|between)\s+(?:age\s+)?\d+\b|\b(?:maximum|minimum)\s+(?:applicant\s+)?age\s*(?:of|:|is)?\s*\d+/i
  const subjectSuffix = /^(?:[-– ]related)?\s+(?:policy|policies|law|laws|regulations?|standards?|rights|research|science|studies|compliance|discrimination|equity|equality|accessibility|accommodations?|barriers|services|programs|knowledge|expertise|counseling|treatment|prevention)\b/i
  const personalTrait = (value: string, pattern: RegExp) => [...value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
    .some(match => !subjectSuffix.test(value.slice(match.index! + match[0].length)))
  const invalid = bareTrait.test(label.trim()) || affirmativeSentences(text).some(value =>
    personalTrait(value, possessiveTrait) || personalTrait(value, scoreTrait) || candidateTrait.test(value) ||
    explicitPreference.test(value) || ageRequirement.test(value))
  return invalid ? ['Do not score applicant protected traits or demographics. Subject expertise in genetics, disability policy, civil rights, or accessibility is different and is allowed when grounded.'] : []
}

function qualificationClaim(text: string): boolean {
  const credential = /\b(?:applicants?|candidates?)\s+(?:(?:must|shall|need to|are required to)\s+)?(?:have|hold|possess|complete)\b.{0,100}?\b(?:degree|education|years? of (?:specialized )?experience|licen[sc]e|certification)\b/i.exec(text)
  return Boolean(credential && !/\b(?:knowledge|expertise|understanding|ability|skills?|analysis)\b/i.test(credential[0])) ||
    /\b(?:minimum(?: of)?|at least|must have)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?)\s+of\s+(?:specialized\s+)?experience\b/i.test(text)
}

function qualificationPassage(citation: Citation, evidence: ModelEvidence): boolean {
  const paragraph = citationParagraph(citation, evidence)
  if (!paragraph) return false
  const headings = [paragraph.heading, ...(paragraph.table?.headers ?? [])].join('\n')
  return /\b(?:minimum qualifications?|qualification (?:requirements?|standards?)|basic (?:education(?:al)? )?requirements?|education(?:al)?\s+(?:and|or)\s+(?:specialized\s+)?experience(?:\s+requirements?)?)\b/i.test(headings) ||
    /^(?:GS[-\s]*\d+\s*[-–:]?\s*)?qualifications?\s*$/i.test(paragraph.heading.trim()) ||
    qualificationClaim(paragraph.text)
}

function guidanceErrors(guidance: string): string[] {
  const matches = [...guidance.matchAll(/(?:^|[\n;|]|[.!?]\s+)\s*(?:score\s+)?([0-5])\s*[:.)=\-–—]\s*/gi)]
  if (matches.length !== 6 || matches.some((value, index) => Number(value[1]) !== index)) {
    return ['Guidance must explicitly label each of scores 0, 1, 2, 3, 4, and 5 once, in order.']
  }
  const anchors = matches.map((value, index) =>
    guidance.slice(value.index! + value[0].length, matches[index + 1]?.index ?? guidance.length).trim())
  if (anchors.some(value => !meaningful(value, 4)) || new Set(anchors.map(value => value.toLowerCase())).size !== 6) {
    return ['Each 0–5 guidance anchor needs meaningful, distinct evidence-based text, not placeholders.']
  }
  return []
}

function validateCitations(
  citations: Citation[], evidence: ModelEvidence, included: ReadonlySet<string>,
  use: Parameters<typeof citationErrors>[2], prefix: string,
): string[] {
  const errors = citations.flatMap(value => citationErrors(value, evidence, use, included).map(error => `${prefix}: ${error}`))
  if (new Set(citations.map(value => JSON.stringify(value))).size !== citations.length) errors.push(`${prefix}: duplicate citations.`)
  return errors
}

export function validateModelIssues(
  values: ModelIssue[], evidence: ModelEvidence, included: ReadonlySet<string>, criterionIds: ReadonlySet<string>,
): Validation {
  const errors: string[] = []
  const issues: GradeIssue[] = []
  for (const value of values) {
    if (!meaningful(value.message)) errors.push(`Issue ${value.code} needs a meaningful explanation.`)
    if (value.sourceId && ![...evidence.bindings.values()].some(binding => binding.selected && binding.source.sourceId === value.sourceId)) {
      errors.push(`Issue ${value.code} references a foreign or unselected source ID.`)
    }
    if (value.grade !== null && (!evidence.sourceSet.grades.includes(value.grade) ||
      (evidence.grade !== undefined && value.grade !== evidence.grade))) {
      errors.push(`Issue ${value.code} references a grade outside this operation.`)
    }
    if (value.criterionId && !criterionIds.has(value.criterionId)) errors.push(`Issue ${value.code} references an unknown competency ID.`)
    if (value.scope === 'criterion' && !value.criterionId) errors.push(`Issue ${value.code} needs its criterion ID.`)
    errors.push(...validateCitations(value.citations, evidence, included, 'issue', `Issue ${value.code}`))
    issues.push(issue(value.code, value.message, {
      severity: value.severity, scope: value.scope,
      ...(value.sourceId ? { sourceId: value.sourceId } : {}),
      ...(value.criterionId ? { criterionId: value.criterionId } : {}),
      ...(value.grade !== null ? { grade: value.grade } :
        evidence.grade !== undefined && ['grade', 'criterion', 'qualification'].includes(value.scope) ? { grade: evidence.grade } : {}),
      ...(value.citations.length ? { citations: value.citations } : {}),
    }))
  }
  return { errors, issues }
}

export function validatePlan(
  value: ModelPlan, seedCriterionIds: ReadonlySet<string>, evidence: ModelEvidence, included: ReadonlySet<string>,
): Validation {
  const ids = new Set(value.competencies.map(competency => competency.id))
  const result = validateModelIssues(value.issues, evidence, included, ids)
  if (ids.size !== value.competencies.length) result.errors.push('Competency IDs must be unique and stable for all requested grades.')
  for (const competency of value.competencies) {
    if (!meaningful(competency.label, 2) || !meaningful(competency.description)) result.errors.push(`Competency ${competency.id} needs meaningful role-specific text.`)
    if (new Set(competency.seedCriterionIds).size !== competency.seedCriterionIds.length ||
      competency.seedCriterionIds.some(id => !seedCriterionIds.has(id))) {
      result.errors.push(`Competency ${competency.id} references duplicate or nonexistent seed criterion IDs.`)
    }
    result.errors.push(...demographicScoringErrors(competency.label, `${competency.label}. ${competency.description}`))
    result.errors.push(...authorityClaimErrors(competency.description))
    result.errors.push(...validateCitations(competency.citations, evidence, included, 'context', `Competency ${competency.id}`))
    if (competency.seedCriterionIds.length === 0 && competency.citations.length === 0) {
      result.issues.push(issue('competency-context-missing', `Competency ${competency.id} is not mapped to the selected seed criteria or captured source passages. Add source context before using it.`, {
        scope: 'criterion', criterionId: competency.id,
      }))
    }
  }
  return result
}

function validateQualification(
  qualification: ModelQualification, evidence: ModelEvidence, included: ReadonlySet<string>,
): Validation {
  const errors: string[] = []
  const issues: GradeIssue[] = []
  const prefix = `Qualification ${qualification.id}`
  if (!meaningful(qualification.text) || !meaningful(qualification.interpretation)) errors.push(`${prefix} needs meaningful text and an explicit interpretation.`)
  errors.push(...authorityClaimErrors(`${qualification.text}. ${qualification.interpretation}`))
  errors.push(...validateCitations(qualification.citations, evidence, included, qualification.support === 'gap' ? 'context' : 'qualification', prefix))
  if (qualification.support === 'gap') {
    issues.push(issue('qualification-support-gap', `${prefix}: ${qualification.text} Add applicable qualification evidence; a weighted work score cannot fill this gap.`, {
      scope: 'qualification', grade: evidence.grade, citations: qualification.citations,
    }))
    return { errors, issues }
  }
  if (qualification.citations.length === 0) errors.push(`${prefix} requires exact qualification source citations.`)
  for (const citation of qualification.citations) {
    const paragraph = citationParagraph(citation, evidence)
    if (!paragraph) continue
    const alternativePassages = citationSection(citation, evidence).filter(value =>
      /\b(?:or|either|alternatives?|substitut(?:e|ion)|combination)\b/i.test(value.text))
    for (const alternative of alternativePassages) {
      if (!qualification.text.includes(alternative.text) ||
        !qualification.citations.some(value => value.documentId === citation.documentId &&
          value.paragraphId === alternative.id && value.quote === alternative.text)) {
        errors.push(`${prefix} must preserve the complete quoted alternative-path passage ${alternative.id} in its text and citations; alternatives cannot become cumulative requirements.`)
      }
    }
    const binding = evidence.bindings.get(citation.documentId)!
    if (binding.source.purpose === 'job-context' &&
      /\b(?:GS[-\s]*\d+|federal minimum|grade[- ](?:specific )?eligibility)\b/i.test(qualification.text)) {
      errors.push(`${prefix} cannot establish federal grade qualifications from a single seed job.`)
    }
  }
  if (qualification.support === 'derived') {
    issues.push(issue('qualification-interpretation', `${prefix} includes an interpretation that needs human review without combining alternative paths.`, {
      severity: 'warning', scope: 'qualification', grade: evidence.grade, citations: qualification.citations,
    }))
  }
  return { errors, issues }
}

export function validateDraft(
  value: ModelDraft, competencies: GradeCompetency[], evidence: ModelEvidence, included: ReadonlySet<string>,
): Validation {
  const ids = new Set(competencies.map(competency => competency.id))
  const result = validateModelIssues(value.issues, evidence, included, ids)
  if (!meaningful(value.description)) result.errors.push('The draft description needs meaningful source-grounded text.')
  result.errors.push(...authorityClaimErrors(value.description))
  const returnedIds = new Set(value.criteria.map(criterion => criterion.competencyId))
  if (returnedIds.size !== value.criteria.length || returnedIds.size !== ids.size || [...ids].some(id => !returnedIds.has(id))) {
    result.errors.push('Return exactly one criterion for every supplied competency ID; do not rename, duplicate, add, or omit a row.')
  }
  let supported = 0
  for (const criterion of value.criteria) {
    const competency = competencies.find(value => value.id === criterion.competencyId)
    const prefix = `Criterion ${criterion.competencyId}`
    const fields = { scope: 'criterion' as const, grade: evidence.grade, criterionId: criterion.competencyId }
    if (!meaningful(criterion.description) || !meaningful(criterion.interpretation) || !meaningful(criterion.guidance)) {
      result.errors.push(`${prefix} needs meaningful expectations, guidance, and interpretation, including explicit missing-source explanations for gaps.`)
    }
    result.errors.push(...authorityClaimErrors(`${criterion.description}. ${criterion.guidance}. ${criterion.interpretation}`))
    const isSupported = criterion.support === 'direct' || criterion.support === 'derived'
    result.errors.push(...validateCitations(criterion.sourceCitations, evidence, included, isSupported ? 'work' : 'context', prefix))
    result.errors.push(...validateCitations(criterion.gradeBasis, evidence, included, 'basis', `${prefix} gradeBasis`))
    for (const citation of criterion.gradeBasis) {
      if (!isGradeEvidence(citation, evidence, evidence.grade!) || qualificationPassage(citation, evidence)) {
        const source = evidence.bindings.get(citation.documentId)?.source
        result.errors.push(`${prefix} gradeBasis citation ${citation.documentId}/${citation.paragraphId} uses ${source?.purpose ?? 'unknown'} evidence and is not valid work-level proof for GS-${evidence.grade}. Do not put seed-job or qualification citations in gradeBasis, even alongside a valid reference. Use an applicable grading/classification/agency work passage, or mark this competency as a gap with weight 0 and empty gradeBasis.`)
      }
    }
    if (!isSupported) {
      if (criterion.weight !== 0 || criterion.gradeBasis.length > 0 ||
        /(?:^|\n)\s*(?:score\s*)?[0-5]\s*[:.)=\-–—]/i.test(criterion.guidance)) {
        result.errors.push(`${prefix} is unscored: gaps/not-applicable rows need weight 0, no asserted gradeBasis, and explanatory guidance rather than a zero score or numeric score anchors.`)
      }
      if (criterion.support === 'not-applicable') {
        if (criterion.sourceCitations.length === 0 ||
          criterion.sourceCitations.some(citation => !isGradeEvidence(citation, evidence, evidence.grade!) || qualificationPassage(citation, evidence))) {
          result.errors.push(`${prefix} needs applicable work-level exclusion evidence for not-applicable; missing evidence must stay a gap.`)
        }
        result.issues.push(issue('criterion-not-applicable', `${prefix} is unscored and marked not applicable: ${criterion.interpretation}`, {
          ...fields, severity: 'warning', citations: criterion.sourceCitations,
        }))
      } else {
        result.issues.push(issue('criterion-support-gap', `${prefix} remains unsupported: ${criterion.description} Add applicable sources; this is not an applicant score of zero and there is no custom-expectation bypass.`, {
          ...fields, citations: criterion.sourceCitations,
        }))
      }
      continue
    }
    supported += 1
    if (criterion.weight <= 0 || criterion.sourceCitations.length === 0 || criterion.gradeBasis.length === 0) {
      result.errors.push(`${prefix} requires a positive proposed weight, sourceCitations, and gradeBasis.`)
    }
    result.errors.push(...guidanceErrors(criterion.guidance).map(error => `${prefix}: ${error}`))
    result.errors.push(...demographicScoringErrors(competency?.label ?? '', `${competency?.label ?? ''}. ${criterion.description}. ${criterion.guidance}. ${criterion.interpretation}`))
    if (qualificationClaim(criterion.description) || /^(?:minimum qualifications?|basic eligibility|education requirements?)$/i.test(competency?.label ?? '') ||
      criterion.sourceCitations.some(citation => qualificationPassage(citation, evidence))) {
      result.errors.push(`${prefix} cannot score minimum qualifications; keep requirements and alternative eligibility paths in the unscored qualifications array.`)
    }
    if (criterion.support === 'derived') {
      if (criterion.interpretation.trim().length < 30) result.errors.push(`${prefix} needs an explicit explanation of how the cited work-level evidence was derived into this expectation.`)
      result.issues.push(issue('criterion-derived', `${prefix} is a proposed interpretation, not a verbatim federal scoring rule: ${criterion.interpretation}`, {
        ...fields, severity: 'warning', citations: criterion.gradeBasis,
      }))
    }
  }
  const weight = value.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (weight > 100 + 0.000001 || (supported > 0 && !value.criteria.some(value => value.support === 'gap') && Math.abs(weight - 100) > 0.000001)) {
    result.errors.push(`Complete work-level weights must total 100, not ${weight}; incomplete drafts cannot exceed 100.`)
  }
  if (supported === 0) result.issues.push(issue('grade-expectations-missing', 'This grade has no supported work-level criteria. Add applicable grading evidence before review can find it supported.', { scope: 'grade', grade: evidence.grade }))
  if (new Set(value.qualifications.map(qualification => qualification.id)).size !== value.qualifications.length) result.errors.push('Qualification IDs must be unique.')
  for (const qualification of value.qualifications) {
    const checked = validateQualification(qualification, evidence, included)
    result.errors.push(...checked.errors)
    result.issues.push(...checked.issues)
  }
  if (value.qualifications.length === 0 && [...evidence.bindings.values()].some(binding =>
    binding.selected && binding.applicable && binding.source.purpose === 'qualification' &&
    (binding.source.coverage.grades.length === 0 || binding.source.coverage.grades.includes(evidence.grade!)) &&
    binding.document?.paragraphs.length)) {
    result.issues.push(issue('qualification-evidence-unmapped', 'Selected qualification evidence has not been mapped to separate unscored requirements or explicit gaps. Its requirements and alternative paths cannot be silently omitted.', {
      scope: 'qualification', grade: evidence.grade,
    }))
  }
  result.issues = mergeIssues(result.issues)
  return result
}
