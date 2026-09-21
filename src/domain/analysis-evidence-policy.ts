export { ANALYSIS_CORRECTION_POLICY_VERSION as ANALYSIS_EVIDENCE_POLICY_VERSION } from './analysis-corrections'

// An obvious-trait guard, not a substitute for independent semantic review.
export function isPersonalTraitCriterion(label: string, description: string): boolean {
  const traits = 'age|race|racial background|ethnicity|religion|sex|gender|pregnancy|disability status|genetic information|marital status|national origin|sexual orientation|citizenship|veteran status'
  return new RegExp(`^(?:(?:applicant|candidate|personal)\\s+)?(?:${traits})(?:\\s+(?:preference|score|matching))?[.!]?\\s*$`, 'i').test(label.trim()) ||
    new RegExp(`\\b(?:score|rank|reward|prefer|evaluate|assess)(?:s|d|ing)?\\s+(?:(?:the|an?)\\s+)?(?:applicants?|candidates?)(?:['’]s?)?\\s+(?:${traits})\\b`, 'i').test(description)
}
