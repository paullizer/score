import type { RealAnalysisAssessmentInput } from '../../src/domain/real-analyses'
import { ANALYSIS_MODEL_LIMITS } from './model-schema'

export type AnalysisModelStage = 'assessment' | 'grounding'
export type AnalysisCitationReason =
  | 'invalid-shape' | 'too-many-citations' | 'unknown-paragraph' | 'empty-quote' | 'quote-too-long'
  | 'quote-not-found' | 'whitespace-mismatch' | 'wrong-paragraph' | 'duplicate-citation'

export interface AnalysisCitationLocation {
  scope: 'criteria' | 'qualifications' | 'issues' | 'citations'
  rowIndex?: number
  criterionId?: string
  qualificationId?: string
}

export interface AnalysisCitationFinding extends AnalysisCitationLocation {
  reason: AnalysisCitationReason
  citationIndex?: number
  paragraphId?: string
  matchingParagraphId?: string
  quoteLength?: number
  paragraphLength?: number
}

export interface AnalysisCitationDiagnostics {
  findings: AnalysisCitationFinding[]
  omittedFindings: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function collector(input: RealAnalysisAssessmentInput) {
  const paragraphs = new Map(input.resume.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const findings: AnalysisCitationFinding[] = []
  let omittedFindings = 0
  function add(finding: AnalysisCitationFinding): void {
    if (findings.length < ANALYSIS_MODEL_LIMITS.maxCitationFindings) findings.push(finding)
    else omittedFindings += 1
  }
  function inspect(quotes: unknown, location: AnalysisCitationLocation): void {
    if (!Array.isArray(quotes)) { add({ ...location, reason: 'invalid-shape' }); return }
    if (quotes.length > ANALYSIS_MODEL_LIMITS.maxCitations) {
      add({ ...location, reason: 'too-many-citations' })
      return
    }
    const seen = new Set<string>()
    quotes.forEach((value: unknown, citationIndex) => {
      const at = { ...location, citationIndex }
      if (!record(value) || Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, 'paragraphId') || !Object.hasOwn(value, 'quote') ||
        typeof value.paragraphId !== 'string' || typeof value.quote !== 'string') {
        add({ ...at, reason: 'invalid-shape' })
        return
      }
      const paragraph = paragraphs.get(value.paragraphId)
      const detail = {
        ...at, quoteLength: value.quote.length,
        ...(paragraph ? { paragraphId: paragraph.id, paragraphLength: paragraph.text.length } : {}),
      }
      if (!paragraph) { add({ ...detail, reason: 'unknown-paragraph' }); return }
      if (!value.quote.trim()) { add({ ...detail, reason: 'empty-quote' }); return }
      if (value.quote.length > ANALYSIS_MODEL_LIMITS.maxQuoteCharacters) {
        add({ ...detail, reason: 'quote-too-long' })
        return
      }
      if (!paragraph.text.includes(value.quote)) {
        if (paragraph.text.replace(/\s+/g, ' ').trim().includes(value.quote.replace(/\s+/g, ' ').trim())) {
          add({ ...detail, reason: 'whitespace-mismatch' })
          return
        }
        let match: string | undefined
        for (const candidate of paragraphs.values()) {
          if (!candidate.text.includes(value.quote)) continue
          if (match !== undefined) { match = undefined; break }
          match = candidate.id
        }
        add({ ...detail, reason: match ? 'wrong-paragraph' : 'quote-not-found', ...(match ? { matchingParagraphId: match } : {}) })
        return
      }
      const key = JSON.stringify([paragraph.id, value.quote])
      if (seen.has(key)) add({ ...detail, reason: 'duplicate-citation' })
      seen.add(key)
    })
  }
  return {
    inspect,
    result: (): AnalysisCitationDiagnostics | undefined => findings.length ? { findings, omittedFindings } : undefined,
  }
}

export function analysisResumeCitationDiagnostics(
  quotes: unknown, input: RealAnalysisAssessmentInput,
): AnalysisCitationDiagnostics | undefined {
  const collected = collector(input)
  collected.inspect(quotes, { scope: 'citations' })
  return collected.result()
}

export function analysisOutputCitationDiagnostics(
  value: unknown, input: RealAnalysisAssessmentInput, stage: AnalysisModelStage,
): AnalysisCitationDiagnostics | undefined {
  if (!record(value)) return undefined
  const collected = collector(input)
  const criteria = new Set(input.rubric.criteria.map(row => row.id))
  const qualifications = new Set(input.qualifications.map(row => row.id))
  const scopes: AnalysisCitationLocation['scope'][] = stage === 'assessment' ? ['criteria', 'qualifications'] : ['issues']
  for (const scope of scopes) {
    const rows = value[scope]
    if (!Array.isArray(rows)) continue
    const limit = scope === 'criteria' ? ANALYSIS_MODEL_LIMITS.maxCriteria :
      scope === 'qualifications' ? ANALYSIS_MODEL_LIMITS.maxQualifications : ANALYSIS_MODEL_LIMITS.maxReviewIssues
    rows.slice(0, limit).forEach((row: unknown, rowIndex) => {
      if (!record(row)) return
      collected.inspect(row.citations, {
        scope, rowIndex,
        ...(typeof row.criterionId === 'string' && criteria.has(row.criterionId) ? { criterionId: row.criterionId } : {}),
        ...(typeof row.qualificationId === 'string' && qualifications.has(row.qualificationId) ? { qualificationId: row.qualificationId } : {}),
      })
    })
  }
  return collected.result()
}

const reasons: Record<AnalysisCitationReason, string> = {
  'invalid-shape': 'a citation must contain only a paragraph ID and a literal quotation',
  'too-many-citations': `the citation list exceeds the limit of ${ANALYSIS_MODEL_LIMITS.maxCitations}`,
  'unknown-paragraph': 'the cited paragraph is not in the saved resume',
  'empty-quote': 'the quotation is empty',
  'quote-too-long': `the quotation exceeds ${ANALYSIS_MODEL_LIMITS.maxQuoteCharacters} characters`,
  'quote-not-found': 'the quotation is not an exact substring of its cited resume paragraph',
  'whitespace-mismatch': 'the quotation changes whitespace in the saved resume paragraph',
  'wrong-paragraph': 'the literal quotation occurs in a different saved resume paragraph',
  'duplicate-citation': 'the same quotation and paragraph are cited more than once in this list',
}

export function describeAnalysisCitationFailure(diagnostics: AnalysisCitationDiagnostics, stage: AnalysisModelStage): string {
  const first = diagnostics.findings[0]
  const row = first.rowIndex === undefined ? '' :
    ` ${first.scope === 'criteria' ? 'criterion' : first.scope === 'qualifications' ? 'qualification' : 'issue'} ${first.rowIndex + 1}`
  const citation = first.citationIndex === undefined ? '' : `, citation ${first.citationIndex + 1}`
  const count = diagnostics.findings.length + diagnostics.omittedFindings
  return `${stage === 'assessment' ? 'Assessment' : 'Grounding review'}${row}${citation}: ${reasons[first.reason]}.` +
    (count > 1 ? ` ${count} citation problems require correction.` : '')
}

export function analysisCitationRepairSources(diagnostics: AnalysisCitationDiagnostics, input: RealAnalysisAssessmentInput) {
  const ids = new Set(diagnostics.findings.flatMap(finding =>
    [finding.matchingParagraphId, finding.paragraphId].filter((id): id is string => id !== undefined)))
  const paragraphs = new Map(input.resume.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const sourceParagraphs: Array<{ paragraphId: string; text: string }> = []
  let characters = 0
  let omittedSourceParagraphs = 0
  for (const id of ids) {
    const paragraph = paragraphs.get(id)
    if (!paragraph) throw new Error('Citation repair context must refer only to the frozen resume.')
    if (sourceParagraphs.length >= ANALYSIS_MODEL_LIMITS.maxCorrectionSources ||
      characters + paragraph.text.length > ANALYSIS_MODEL_LIMITS.maxCorrectionSourceCharacters) {
      omittedSourceParagraphs += 1
      continue
    }
    sourceParagraphs.push({ paragraphId: paragraph.id, text: paragraph.text })
    characters += paragraph.text.length
  }
  return { sourceParagraphs, omittedSourceParagraphs }
}
