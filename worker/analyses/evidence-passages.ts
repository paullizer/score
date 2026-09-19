import { analysisHash } from '../../server/analyses/deterministic'
import type { RealAnalysisAssessmentInput } from '../../src/domain/real-analyses'
import { ANALYSIS_MODEL_LIMITS, type ModelResumeQuote } from './model-schema'

export const ANALYSIS_EVIDENCE_CATALOG_VERSION = 'score-analysis-passages-v1'

type Resume = RealAnalysisAssessmentInput['resume']
type ModelParagraph = Omit<Resume['paragraphs'][number], 'text'> & {
  passages: Array<{ passageId: number | null; text: string }>
}

export interface AnalysisEvidencePassage {
  passageId: number
  paragraphId: string
  paragraphIndex: number
  startOffset: number
  endOffset: number
}

export interface AnalysisEvidenceCatalog {
  version: typeof ANALYSIS_EVIDENCE_CATALOG_VERSION
  documentSha256: string
  sourceCharacters: number
  passages: AnalysisEvidencePassage[]
  resume: Omit<Resume, 'paragraphs'> & { paragraphs: ModelParagraph[] }
}

export class AnalysisEvidenceBindingError extends Error {
  constructor() {
    super('The frozen resume and its source-passage catalog could not be bound exactly.')
    this.name = 'AnalysisEvidenceBindingError'
  }
}

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])
}

function passageEnd(text: string, start: number): number {
  let end = Math.min(text.length, start + ANALYSIS_MODEL_LIMITS.maxQuoteCharacters)
  if (end === text.length) return end
  if (splitsSurrogate(text, end) || text[end - 1] === '\r' && text[end] === '\n') end--
  const window = text.slice(start, end)
  const minimum = Math.floor(window.length / 2)
  const newline = window.lastIndexOf('\n')
  if (newline >= minimum) return start + newline + 1
  let sentenceEnd = 0
  for (const match of window.matchAll(/[.!?]["')\]]*\s+/g)) sentenceEnd = match.index + match[0].length
  if (sentenceEnd >= minimum) return start + sentenceEnd
  let whitespaceEnd = 0
  for (const match of window.matchAll(/\s+/g)) whitespaceEnd = match.index + match[0].length
  return whitespaceEnd >= minimum ? start + whitespaceEnd : end
}

export function createAnalysisEvidenceCatalog(resume: Resume): AnalysisEvidenceCatalog {
  const passages: AnalysisEvidencePassage[] = []
  let sourceCharacters = 0
  const paragraphs = resume.paragraphs.map((paragraph, paragraphIndex): ModelParagraph => {
    const { text, ...metadata } = paragraph
    sourceCharacters += text.length
    const view: ModelParagraph = { ...metadata, passages: [] }
    for (let startOffset = 0; startOffset < text.length;) {
      const endOffset = passageEnd(text, startOffset)
      const slice = text.slice(startOffset, endOffset)
      // Whitespace-only slices stay in the lossless view, but cannot become evidence.
      const passageId = slice.trim() ? passages.length + 1 : null
      if (passageId !== null) passages.push({
        passageId, paragraphId: paragraph.id, paragraphIndex, startOffset, endOffset,
      })
      view.passages.push({ passageId, text: slice })
      startOffset = endOffset
    }
    return view
  })
  if (!passages.length) throw new AnalysisEvidenceBindingError()
  return {
    version: ANALYSIS_EVIDENCE_CATALOG_VERSION, documentSha256: analysisHash(resume),
    sourceCharacters, passages, resume: { ...resume, paragraphs },
  }
}

export function createAnalysisPassageResolver(
  catalog: AnalysisEvidenceCatalog, resume: Resume,
): (passageId: number) => ModelResumeQuote {
  if (catalog.version !== ANALYSIS_EVIDENCE_CATALOG_VERSION || catalog.documentSha256 !== analysisHash(resume)) {
    throw new AnalysisEvidenceBindingError()
  }
  return passageId => {
    const passage = Number.isSafeInteger(passageId) && passageId > 0 ? catalog.passages[passageId - 1] : undefined
    const paragraph = passage ? resume.paragraphs[passage.paragraphIndex] : undefined
    if (!passage || passage.passageId !== passageId || !paragraph || paragraph.id !== passage.paragraphId ||
      !Number.isSafeInteger(passage.startOffset) || !Number.isSafeInteger(passage.endOffset) ||
      passage.startOffset < 0 || passage.endOffset <= passage.startOffset || passage.endOffset > paragraph.text.length ||
      passage.endOffset - passage.startOffset > ANALYSIS_MODEL_LIMITS.maxQuoteCharacters ||
      splitsSurrogate(paragraph.text, passage.startOffset) || splitsSurrogate(paragraph.text, passage.endOffset)) {
      throw new AnalysisEvidenceBindingError()
    }
    const quote = paragraph.text.slice(passage.startOffset, passage.endOffset)
    if (!quote.trim()) throw new AnalysisEvidenceBindingError()
    return { paragraphId: paragraph.id, quote }
  }
}
