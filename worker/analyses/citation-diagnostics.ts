import type { RealAnalysisAssessmentInput } from '../../src/domain/real-analyses'
import { ANALYSIS_MODEL_LIMITS } from './model-schema'
import { createAnalysisPassageResolver, type AnalysisEvidenceCatalog } from './evidence-passages'

export type AnalysisModelStage = 'assessment' | 'grounding'
export type AnalysisCitationReason =
  | 'invalid-shape' | 'too-many-citations' | 'unknown-paragraph' | 'empty-quote' | 'quote-too-long'
  | 'quote-not-found' | 'whitespace-mismatch' | 'wrong-paragraph' | 'duplicate-citation'
  | 'invalid-selection' | 'unknown-passage'

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
  passageId?: number
  passageCount?: number
  startOffset?: number
  endOffset?: number
}

export interface AnalysisCitationDiagnostics {
  findings: AnalysisCitationFinding[]
  omittedFindings: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findingCollector() {
  const findings: AnalysisCitationFinding[] = []
  let omittedFindings = 0
  function add(finding: AnalysisCitationFinding): void {
    if (findings.length < ANALYSIS_MODEL_LIMITS.maxCitationFindings) findings.push(finding)
    else omittedFindings += 1
  }
  return {
    add,
    result: (): AnalysisCitationDiagnostics | undefined => findings.length ? { findings, omittedFindings } : undefined,
  }
}

function collector(input: RealAnalysisAssessmentInput) {
  const paragraphs = new Map(input.resume.paragraphs.map(paragraph => [paragraph.id, paragraph]))
  const { add, result } = findingCollector()
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
  return { inspect, result }
}

function selectionCollector(input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog) {
  const { add, result } = findingCollector()
  const resolve = createAnalysisPassageResolver(catalog, input.resume)
  function inspect(quotes: unknown, location: AnalysisCitationLocation): void {
    if (!Array.isArray(quotes)) { add({ ...location, reason: 'invalid-selection' }); return }
    if (quotes.length > ANALYSIS_MODEL_LIMITS.maxCitations) {
      add({ ...location, reason: 'too-many-citations' })
      return
    }
    const seen = new Set<string>()
    quotes.forEach((value: unknown, citationIndex) => {
      const at = { ...location, citationIndex, passageCount: catalog.passages.length }
      if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'passageId') ||
        typeof value.passageId !== 'number' || !Number.isSafeInteger(value.passageId)) {
        add({ ...at, reason: 'invalid-selection' })
        return
      }
      const passage = value.passageId > 0 ? catalog.passages[value.passageId - 1] : undefined
      if (!passage) { add({ ...at, reason: 'unknown-passage' }); return }
      const quote = resolve(value.passageId)
      const key = JSON.stringify([quote.paragraphId, quote.quote])
      if (seen.has(key)) add({
        ...at, reason: 'duplicate-citation', passageId: passage.passageId, paragraphId: passage.paragraphId,
        startOffset: passage.startOffset, endOffset: passage.endOffset, quoteLength: quote.quote.length,
        paragraphLength: input.resume.paragraphs[passage.paragraphIndex].text.length,
      })
      seen.add(key)
    })
  }
  return { inspect, result }
}

export function analysisResumeCitationDiagnostics(
  quotes: unknown, input: RealAnalysisAssessmentInput,
): AnalysisCitationDiagnostics | undefined {
  const collected = collector(input)
  collected.inspect(quotes, { scope: 'citations' })
  return collected.result()
}

function outputCitationDiagnostics(
  value: unknown, input: RealAnalysisAssessmentInput, stage: AnalysisModelStage,
  collected: ReturnType<typeof collector>,
): AnalysisCitationDiagnostics | undefined {
  if (!record(value)) return undefined
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

export function analysisOutputCitationDiagnostics(
  value: unknown, input: RealAnalysisAssessmentInput, stage: AnalysisModelStage,
): AnalysisCitationDiagnostics | undefined {
  return outputCitationDiagnostics(value, input, stage, collector(input))
}

export function analysisSelectionCitationDiagnostics(
  value: unknown, input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog, stage: AnalysisModelStage,
): AnalysisCitationDiagnostics | undefined {
  return outputCitationDiagnostics(value, input, stage, selectionCollector(input, catalog))
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
  'invalid-selection': 'a generated citation must contain only an integer source passage ID',
  'unknown-passage': 'the generated citation does not select a passage from this saved resume',
}

export function describeAnalysisCitationFailure(diagnostics: AnalysisCitationDiagnostics, stage: AnalysisModelStage): string {
  const first = diagnostics.findings[0]
  const row = first.rowIndex === undefined ? '' :
    ` ${first.scope === 'criteria' ? 'criterion' : first.scope === 'qualifications' ? 'qualification' : 'issue'} ${first.rowIndex + 1}`
  const citation = first.citationIndex === undefined ? '' : `, citation ${first.citationIndex + 1}`
  const count = diagnostics.findings.length + diagnostics.omittedFindings
  return `${stage === 'assessment' ? 'Assessment' : 'Grounding review'}${row}${citation}: ${reasons[first.reason]}.` +
    (count > 1 ? ` ${count} citation problems require correction.` : '') +
    ' The generated evidence is invalid; this does not mean resume data is missing.'
}

export function analysisCitationRepairSources(
  diagnostics: AnalysisCitationDiagnostics, input: RealAnalysisAssessmentInput, catalog: AnalysisEvidenceCatalog,
) {
  const paragraphIds = new Set(diagnostics.findings.flatMap(finding =>
    [finding.matchingParagraphId, finding.paragraphId].filter((id): id is string => id !== undefined)))
  const passageIds = new Set(diagnostics.findings.map(finding => finding.passageId))
  const resolve = createAnalysisPassageResolver(catalog, input.resume)
  const sourcePassages: Array<{ passageId: number; paragraphId: string; text: string }> = []
  let characters = 0
  let omittedSourcePassages = 0
  const candidates = [
    ...catalog.passages.filter(passage => passageIds.has(passage.passageId)),
    ...catalog.passages.filter(passage => !passageIds.has(passage.passageId) && paragraphIds.has(passage.paragraphId)),
  ]
  for (const passage of candidates) {
    const quote = resolve(passage.passageId)
    if (sourcePassages.length >= ANALYSIS_MODEL_LIMITS.maxCorrectionSources ||
      characters + quote.quote.length > ANALYSIS_MODEL_LIMITS.maxCorrectionSourceCharacters) {
      omittedSourcePassages += 1
      continue
    }
    sourcePassages.push({ passageId: passage.passageId, paragraphId: passage.paragraphId, text: quote.quote })
    characters += quote.quote.length
  }
  return {
    catalogVersion: catalog.version, allowedPassageIds: { minimum: 1, maximum: catalog.passages.length },
    sourcePassages, omittedSourcePassages,
  }
}
