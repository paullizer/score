import type {
  FrozenRealResumeSnapshot, RealAnalysisAssessmentOutput, RealAnalysisGroundingReview, RealCriterionResult,
} from '../../src/domain/real-analyses'
import type { Citation } from '../../src/domain/types'

export interface AnalysisResumePiiContext {
  name?: string | null
  location?: string | null
  fileName?: string | null
  sourceLabel?: string | null
}

const HONORIFICS_AND_SUFFIXES = new Set([
  'mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'prof', 'professor', 'sir', 'madam',
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
  'phd', 'md', 'jd', 'mba', 'msc', 'bsc', 'ma', 'ba', 'bs', 'ms', 'cpa', 'pe', 'pmp', 'rn', 'esq',
])

const COMMON_NON_NAME_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'had', 'not', 'are', 'was', 'were',
  'will', 'can', 'may', 'work', 'worked', 'working', 'lead', 'led', 'leading', 'data', 'code', 'test',
  'testing', 'plan', 'planning', 'page', 'role', 'user', 'users', 'team', 'teams', 'senior', 'junior',
  'principal', 'staff', 'lead', 'chief', 'head', 'manager', 'director', 'engineer', 'engineering',
  'analyst', 'analysis', 'scientist', 'science', 'developer', 'development', 'consultant', 'consulting',
  'specialist', 'coordinator', 'administrator', 'assistant', 'officer', 'president', 'founder', 'architect',
  'designer', 'design', 'research', 'researcher', 'professor', 'teacher', 'instructor', 'student',
  'resume', 'profile', 'curriculum', 'vitae', 'applicant', 'candidate', 'person', 'professional',
  'experience', 'education', 'skills', 'projects', 'summary', 'contact', 'certifications', 'publications',
  'references', 'awards', 'honors', 'languages', 'interests', 'volunteer', 'volunteering',
  'new', 'old', 'high', 'low', 'good', 'best', 'more', 'most', 'other', 'some', 'such', 'only', 'also',
  'art', 'grant', 'mark', 'bill', 'read', 'long', 'short', 'young', 'brown', 'white', 'black', 'green',
  'gray', 'grey', 'hall', 'hill', 'wood', 'stone', 'fields', 'parks', 'wells', 'banks', 'miles',
  'west', 'east', 'north', 'south', 'spring', 'summer', 'autumn', 'fall', 'winter',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
])

const EMAIL_PATTERN = /\b(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const PAREN_PHONE_PATTERN = /(?:(?:\+|00)\d{1,3}[\s.-]?)?\(\d{2,4}\)[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g
const NA_PHONE_PATTERN = /(?<![\d./-])(?:\+?1[\s.-])?\d{3}[\s.-]\d{3}[\s.-]\d{4}\b(?![\d./-])/g
const INTL_PHONE_PATTERN = /(?<![\w+])\+\d{1,3}[\s.-]\d{1,4}[\s.-]\d{2,4}[\s.-]\d{3,4}\b(?![\d./-])/g
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+(?:[A-Z0-9][A-Za-z0-9.'-]*\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Place|Pl\.?|Parkway|Pkwy\.?|Circle|Cir\.?|Terrace|Ter\.?|Highway|Hwy\.?)(?:\s*,?\s*(?:Apt\.?|Apartment|Suite|Ste\.?|Unit|#)\s*[A-Za-z0-9-]+)?(?:\s*,\s*[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)?(?=$|[\s,.;:!?)\]])/gm
const PO_BOX_PATTERN = /\bP\.?\s*O\.?\s*Box\s+\d+(?:\s*,\s*[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)?\b/gi
const FILE_EXTENSION_TITLE_PATTERN = /\.(?:pdf|docx?|md|markdown|html?|txt)$/i

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanHonorificToken(token: string): string {
  return token.replace(/^[.,;:()[\]"'`]+|[.,;:()[\]"'`]+$/g, '').replace(/\./g, '').toLowerCase()
}

interface NamePattern {
  pattern: string
  flags: string
}

function candidateNamePatterns(rawName: string | null | undefined): NamePattern[] {
  if (typeof rawName !== 'string') return []
  const trimmed = rawName.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 2) return []

  const rawTokens = trimmed
    .split(/[\s,]+/)
    .map(token => token.replace(/^[()[\]"'`]+|[()[\]"'`]+$/g, ''))
    .filter(Boolean)
  const coreTokens = rawTokens.filter(token => !HONORIFICS_AND_SUFFIXES.has(cleanHonorificToken(token)))
  const patterns: NamePattern[] = []
  const seen = new Set<string>()
  const add = (pattern: string, flags: string) => {
    const key = `${flags}:${pattern}`
    if (!seen.has(key)) {
      seen.add(key)
      patterns.push({ pattern, flags })
    }
  }

  const fullCandidates = [
    trimmed,
    coreTokens.join(' '),
  ].filter(value => value.length >= 2)

  for (const candidate of fullCandidates) {
    const flexibleWhitespace = candidate.split(/\s+/).map(escapeRegex).join('\\s+')
    add(flexibleWhitespace, 'giu')
  }

  for (const token of coreTokens) {
    const normalized = token.replace(/^[.,;:]+|[.,;:]+$/g, '')
    if (normalized.length < 2) continue
    if (COMMON_NON_NAME_WORDS.has(normalized.toLowerCase())) continue
    add(escapeRegex(normalized), 'gu')
  }

  return patterns
}

function isSentenceStart(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset)
  if (!prefix.trim()) return true
  if (/[\r\n]\s*$/.test(prefix)) return true
  if (/[.!?]["')\]]*\s+$/.test(prefix)) return true
  if (/(?:^|[\r\n])\s*[-*•]\s+$/.test(prefix)) return true
  return false
}

function applyCandidateNameRedaction(text: string, rawName: string | null | undefined): string {
  const patterns = candidateNamePatterns(rawName)
  if (!patterns.length) return text
  let current = text
  for (const { pattern, flags } of patterns) {
    const regex = new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}_-])(?:${pattern})(?:(?:'s|’s)|(\\s+)(is|was|has|does))?(?![\\p{L}\\p{M}\\p{N}_-])`,
      flags,
    )
    current = current.replace(regex, (match, space: string | undefined, verb: string | undefined, offset: number, source: string) => {
      const capitalize = isSentenceStart(source, offset)
      if (/(?:'s|’s)$/iu.test(match)) {
        return capitalize ? 'Their' : 'their'
      }
      if (verb) {
        const lowerVerb = verb.toLowerCase()
        const mappedVerb = lowerVerb === 'is' ? 'are'
          : lowerVerb === 'was' ? 'were'
            : lowerVerb === 'has' ? 'have'
              : 'do'
        return `${capitalize ? 'They' : 'they'}${space ?? ' '}${mappedVerb}`
      }
      return capitalize ? 'They' : 'they'
    })
  }
  return current
}

function applyLocationRedaction(text: string, rawLocation: string | null | undefined): string {
  if (typeof rawLocation !== 'string') return text
  const trimmed = rawLocation.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 2) return text
  const pattern = trimmed.split(/\s+/).map(escapeRegex).join('\\s+')
  const regex = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${pattern}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu')
  return text.replace(regex, '[redacted location]')
}

export function resumePiiFromSnapshot(
  snapshot?: Pick<FrozenRealResumeSnapshot, 'resume' | 'profile' | 'source' | 'displayName'> | null,
): AnalysisResumePiiContext | undefined {
  if (!snapshot) return undefined
  const name = snapshot.profile?.name?.status === 'available'
    ? snapshot.profile.name.value
    : snapshot.resume?.name ?? null
  const location = snapshot.profile?.location?.status === 'available'
    ? snapshot.profile.location.value
    : snapshot.resume?.location ?? null
  const fileName = snapshot.source && 'fileName' in snapshot.source ? snapshot.source.fileName : null
  const sourceLabel = snapshot.resume?.sourceLabel ?? null
  if (!name && !location && !fileName && !sourceLabel) return undefined
  return { name, location, fileName, sourceLabel }
}

/**
 * Redacts candidate PII (emails, phone numbers, street addresses, extracted location, and candidate name)
 * from model-facing text while preserving whitespace-only slices and surrounding evidence text.
 */
export function redactModelResumeText(text: string, pii?: AnalysisResumePiiContext): string {
  if (!text || !text.trim()) return text
  let redacted = text
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(PAREN_PHONE_PATTERN, '[redacted phone]')
    .replace(NA_PHONE_PATTERN, '[redacted phone]')
    .replace(INTL_PHONE_PATTERN, '[redacted phone]')
    .replace(STREET_ADDRESS_PATTERN, '[redacted address]')
    .replace(PO_BOX_PATTERN, '[redacted address]')
  if (pii?.location) {
    redacted = applyLocationRedaction(redacted, pii.location)
  }
  if (pii?.name) {
    redacted = applyCandidateNameRedaction(redacted, pii.name)
  }
  return redacted
}

export function redactModelResumeTitle(title: string, pii?: AnalysisResumePiiContext): string {
  const trimmed = title.trim()
  if (!trimmed) return 'Resume'
  if (pii?.fileName && trimmed.toLowerCase() === pii.fileName.trim().toLowerCase()) return 'Resume'
  if (pii?.sourceLabel && trimmed.toLowerCase() === pii.sourceLabel.trim().toLowerCase()) return 'Resume'
  if (FILE_EXTENSION_TITLE_PATTERN.test(trimmed)) return 'Resume'
  const redacted = redactModelResumeText(title, pii)
  if (redacted !== title) return 'Resume'
  return title
}

export function redactModelResumeHeading(heading: string, pii?: AnalysisResumePiiContext): string {
  if (!heading || !heading.trim()) return heading
  const redacted = redactModelResumeText(heading, pii)
  if (redacted !== heading && /^(?:they|their|\[redacted (?:email|phone|address|location)\])$/iu.test(redacted.trim())) {
    return 'Resume'
  }
  return redacted
}

function redactCitation(citation: Citation, pii?: AnalysisResumePiiContext): Citation {
  return {
    ...citation,
    heading: redactModelResumeHeading(citation.heading, pii),
    quote: redactModelResumeText(citation.quote, pii),
  }
}

function redactCriterionResult(row: RealCriterionResult, pii?: AnalysisResumePiiContext): RealCriterionResult {
  const rationale = redactModelResumeText(row.rationale, pii)
  if (row.evidenceStatus === 'not-assessed') {
    return {
      ...row,
      rationale,
      citations: row.citations.map(citation => redactCitation(citation, pii)),
      limitation: { ...row.limitation, message: redactModelResumeText(row.limitation.message, pii) },
    }
  }
  if (row.evidenceStatus === 'missing' || row.evidenceStatus === 'not-applicable') {
    return { ...row, rationale }
  }
  return {
    ...row,
    rationale,
    citations: row.citations.map(citation => redactCitation(citation, pii)) as [Citation, ...Citation[]],
  }
}

export function redactModelAssessmentOutput(
  assessment: RealAnalysisAssessmentOutput, pii?: AnalysisResumePiiContext,
): RealAnalysisAssessmentOutput {
  return {
    ...assessment,
    criteria: assessment.criteria.map(row => redactCriterionResult(row, pii)),
    qualifications: assessment.qualifications.map(row => ({
      ...row,
      rationale: redactModelResumeText(row.rationale, pii),
      citations: row.citations.map(citation => redactCitation(citation, pii)),
      ...(row.limitation
        ? { limitation: { ...row.limitation, message: redactModelResumeText(row.limitation.message, pii) } }
        : {}),
    })),
    limitations: assessment.limitations.map(limitation => ({
      ...limitation,
      message: redactModelResumeText(limitation.message, pii),
    })),
  }
}

export function redactModelGroundingReview<T extends Pick<RealAnalysisGroundingReview, 'outcome' | 'issues'>>(
  review: T, pii?: AnalysisResumePiiContext,
): T {
  return {
    ...review,
    issues: review.issues.map(issue => ({
      ...issue,
      message: redactModelResumeText(issue.message, pii),
      citations: issue.citations.map(citation => redactCitation(citation, pii)),
    })),
  }
}
