import { z } from 'zod'
import { validateAnalysisAssessmentInput } from '../analyses/validation'
import { createAnalysisEvidenceCatalog } from '../analyses/evidence-passages'
import { evaluationHash } from './statistics'

const extractionTrialSchema = z.strictObject({
  id: z.string().min(1).max(160),
  familyId: z.string().min(1).max(160),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.unknown(),
  facts: z.array(z.strictObject({
    id: z.string().min(1).max(160),
    text: z.string().min(1).max(20_000),
    critical: z.boolean(),
  })).max(100),
})

export function measureExtractionPreservation(raw: unknown) {
  const trials = extractionTrialSchema.array().min(1).max(500).parse(raw)
  if (new Set(trials.map(row => row.id)).size !== trials.length) throw new Error('Extraction trial IDs must be unique.')
  const items = trials.map(trial => {
    if (new Set(trial.facts.map(row => row.id)).size !== trial.facts.length) throw new Error('Extraction fact IDs must be unique within a source.')
    const input = validateAnalysisAssessmentInput(trial.input)
    if (evaluationHash(input) !== trial.inputSha256) throw new Error('Extraction trial does not match its exact frozen input.')
    const catalog = createAnalysisEvidenceCatalog(input.resume)
    const losslessCatalog = catalog.resume.paragraphs.every((paragraph, index) =>
      paragraph.passages.map(passage => passage.text).join('') === input.resume.paragraphs[index].text)
    const source = input.resume.paragraphs.map(paragraph => paragraph.text).join('\n')
    const facts = trial.facts.map(fact => ({
      id: fact.id, critical: fact.critical,
      exactPresent: source.includes(fact.text),
      whitespaceEquivalentPresent: source.replace(/\s+/g, ' ').includes(fact.text.replace(/\s+/g, ' ')),
      paragraphIds: input.resume.paragraphs.filter(paragraph => paragraph.text.includes(fact.text)).map(paragraph => paragraph.id),
    }))
    return { id: trial.id, familyId: trial.familyId, inputSha256: trial.inputSha256, losslessCatalog, facts }
  })
  const facts = items.flatMap(item => item.facts)
  return {
    schemaVersion: 1 as const, items,
    expectedFacts: facts.length,
    exactPreservedFacts: facts.filter(fact => fact.exactPresent).length,
    whitespaceEquivalentFacts: facts.filter(fact => fact.whitespaceEquivalentPresent).length,
    exactRecall: facts.length ? facts.filter(fact => fact.exactPresent).length / facts.length : null,
    criticalMissing: facts.filter(fact => fact.critical && !fact.exactPresent).length,
    catalogLossless: items.every(item => item.losslessCatalog),
    limitations: [
      'Only explicitly supplied planted facts are measured; no ordinal score or semantic accuracy is inferred.',
      'Whitespace equivalence is reported separately and does not change immutable source text or citation binding.',
      'Markdown-derived trials do not establish PDF/OCR/Word extraction fidelity.',
    ],
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface SelectionAnnotation {
  page: number | null
  state: string | null
  confidence: number | null
  offset: number | null
  length: number | null
  range: [number, number] | null
  binding: 'bound' | 'invalid-mark' | 'unverified-index' | 'token-mismatch' | 'overlapping-span'
}

/** Lexical diagnostics only: removing service annotations here never changes saved evidence or model inputs. */
export function diagnoseLayoutFactPreservation(raw: unknown, rawFacts: unknown) {
  if (record(raw) && raw.status !== undefined && raw.status !== 'succeeded') {
    throw new Error('Layout diagnostics cannot treat an unfinished or failed service operation as complete.')
  }
  const result = record(raw) && raw.analyzeResult !== undefined ? raw.analyzeResult : raw
  if (!record(result) || typeof result.content !== 'string' || result.content.length > 2_000_000 ||
    !Array.isArray(result.pages) || result.pages.length > 2000) {
    throw new Error('Layout diagnostics require bounded complete service content and pages.')
  }
  const content = result.content, facts = extractionTrialSchema.shape.facts.parse(rawFacts)
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new Error('Layout fact IDs must be unique.')
  const ascii = /^[\t\n\r -~]*$/.test(content) && !content.includes('\r\n')
  const knownIndex = result.stringIndexType === undefined || typeof result.stringIndexType === 'string' &&
    ['utf16CodeUnit', 'unicodeCodePoint', 'textElements'].includes(result.stringIndexType)
  const indexVerified = knownIndex && (ascii || result.stringIndexType === 'utf16CodeUnit' ||
    result.stringIndexType === 'unicodeCodePoint')
  const units = result.stringIndexType === 'unicodeCodePoint' ? Array.from(content) : null
  const unitOffsets = [0]
  for (const unit of units ?? []) unitOffsets.push(unitOffsets.at(-1)! + unit.length)
  const selections: SelectionAnnotation[] = []
  for (const page of result.pages) {
    if (!record(page) || page.selectionMarks !== undefined && !Array.isArray(page.selectionMarks)) {
      throw new Error('Layout pages and selection-mark collections must be valid service objects.')
    }
    for (const value of page.selectionMarks ?? []) {
      if (selections.length >= 10_000) throw new Error('Layout selection annotations exceed the diagnostic bound.')
      const mark = record(value) ? value : {}
      const span = record(mark.span) ? mark.span : {}
      const pageNumber = Number.isSafeInteger(page.pageNumber) && Number(page.pageNumber) >= 1 ? Number(page.pageNumber) : null
      const offset = Number.isSafeInteger(span.offset) && Number(span.offset) >= 0 ? Number(span.offset) : null
      const length = Number.isSafeInteger(span.length) && Number(span.length) > 0 ? Number(span.length) : null
      const state = typeof mark.state === 'string' ? mark.state : null
      const confidence = typeof mark.confidence === 'number' && Number.isFinite(mark.confidence) &&
        mark.confidence >= 0 && mark.confidence <= 1 ? mark.confidence : null
      const annotation: SelectionAnnotation = {
        page: pageNumber, state, confidence, offset, length, range: null, binding: 'invalid-mark',
      }
      selections.push(annotation)
      if (pageNumber === null || offset === null || length === null || !['selected', 'unselected'].includes(state ?? '') ||
        !Number.isSafeInteger(offset + length)) continue
      if (!indexVerified) { annotation.binding = 'unverified-index'; continue }
      const start = units ? unitOffsets[offset] : offset
      const end = units ? unitOffsets[offset + length] : offset + length
      if (start === undefined || end === undefined || end > content.length) continue
      const token = content.slice(start, end)
      const tokens = state === 'selected' ? [':selected:', '\u2611', '\u2612'] : [':unselected:', '\u2610']
      if (!tokens.includes(token)) { annotation.binding = 'token-mismatch'; continue }
      annotation.range = [start, end]
      annotation.binding = 'bound'
    }
  }
  const bound = selections.filter(row => row.binding === 'bound').sort((a, b) => a.range![0] - b.range![0])
  let group: SelectionAnnotation[] = [], groupEnd = -1
  const closeGroup = () => {
    if (group.length > 1) for (const row of group) row.binding = 'overlapping-span'
  }
  for (const annotation of bound) {
    if (annotation.range![0] >= groupEnd) { closeGroup(); group = []; groupEnd = -1 }
    group.push(annotation)
    groupEnd = Math.max(groupEnd, annotation.range![1])
  }
  closeGroup()
  let inspection = '', previous = 0
  for (const annotation of bound.filter(row => row.binding === 'bound')) {
    inspection += `${content.slice(previous, annotation.range![0])} `
    previous = annotation.range![1]
  }
  inspection += content.slice(previous)
  const wordSequence = (value: string) => (value.match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')
  const words = ` ${wordSequence(inspection)} `
  return {
    schemaVersion: 1 as const, responseSha256: evaluationHash(raw), contentSha256: evaluationHash(content),
    factsSha256: evaluationHash(facts), inspectionViewSha256: evaluationHash(inspection),
    stringIndexType: typeof result.stringIndexType === 'string' ? result.stringIndexType : null,
    selectionAnnotations: selections, boundSelectionAnnotations: selections.filter(row => row.binding === 'bound').length,
    unboundSelectionAnnotations: selections.filter(row => row.binding !== 'bound').length,
    facts: facts.map(fact => {
      const tokens = wordSequence(fact.text)
      return {
        id: fact.id, critical: fact.critical, literalPresent: content.includes(fact.text),
        whitespaceEquivalentPresent: content.replace(/\s+/g, ' ').includes(fact.text.replace(/\s+/g, ' ')),
        wordSequencePresentIgnoringBoundSelectionMarks: tokens ? words.includes(` ${tokens} `) : null,
      }
    }),
    eligibleForRelease: false,
    limitations: [
      'This is a private lexical diagnostic, not corrected extraction, semantic fact recall or source-image validation.',
      'Only state-consistent, exact nonoverlapping service spans are omitted in the temporary inspection view; unbound markers remain unknown.',
      'Non-ASCII or CRLF text-element indexing is unverified; no grapheme-version compatibility with the service is assumed.',
      'Punctuation can change meaning. Word-sequence preservation cannot establish a correct fact, anchor, citation or score.',
      'Selection confidence is raw service metadata, not a calibrated quality threshold or evidence that a checkbox exists in the image.',
    ],
  }
}
