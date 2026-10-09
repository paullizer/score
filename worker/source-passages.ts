import type { Citation } from '../src/domain/types'
import { analysisHash } from '../server/analyses/deterministic'

export const SOURCE_PASSAGE_CATALOG_VERSION = 'score-source-passages-v1' as const
export const SOURCE_PASSAGE_LIMITS = { maxPassageCharacters: 600, maxPassages: 20_000 } as const

export type SourcePassageErrorCode =
  'binding' | 'duplicate-passage' | 'empty' | 'no-citable-passage' | 'too-many-passages' | 'unknown-passage'

export interface SourcePassage {
  passageId: number
  paragraphId: string
  paragraphIndex: number
  startOffset: number
  endOffset: number
}

export interface SourcePassageCatalog {
  version: typeof SOURCE_PASSAGE_CATALOG_VERSION
  documentId: string
  documentVersion: number
  documentSha256: string
  passages: SourcePassage[]
}

export interface SourcePassageView {
  title?: string
  paragraphs: Array<{
    id: string
    page: number
    heading: string
    passages: Array<{ passageId: number | null; text: string }>
  }>
}

export interface SourcePassageDocument {
  id: string
  version: number
  title?: string
  paragraphs: ReadonlyArray<{ id: string; page: number; heading: string; text: string }>
}

export class SourcePassageBindingError extends Error {
  constructor(public readonly code: SourcePassageErrorCode, message: string) {
    super(message)
    this.name = 'SourcePassageBindingError'
  }
}

const ABBREVIATIONS = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'u.s.', 'ph.d.', 'm.s.', 'b.s.', 'b.a.', 'm.a.', 'dr.', 'mr.', 'ms.', 'mrs.',
  'no.', 'inc.', 'jr.', 'sr.', 'st.', 'dept.', 'approx.', 'fig.',
]

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])
}

function safeOffset(text: string, start: number, offset: number): number {
  let safe = Math.min(text.length, Math.max(start + 1, offset))
  while (safe > start + 1 && (splitsSurrogate(text, safe) || text[safe - 1] === '\r' && text[safe] === '\n')) safe--
  if (splitsSurrogate(text, safe) || text[safe - 1] === '\r' && text[safe] === '\n') {
    while (safe < text.length && (splitsSurrogate(text, safe) || text[safe - 1] === '\r' && text[safe] === '\n')) safe++
  }
  return safe
}

function isAbbreviationPeriod(text: string, periodIndex: number): boolean {
  const prefix = text.slice(0, periodIndex + 1).toLowerCase()
  // An abbreviation must start a word: "analyst." and "systems." end sentences even though they end in "st." and "ms.".
  if (ABBREVIATIONS.some(abbreviation => prefix.endsWith(abbreviation) &&
    !/[\p{L}\p{N}]/u.test(prefix[prefix.length - abbreviation.length - 1] ?? ''))) return true
  return /(?:^|[^\p{L}\p{N}])\p{L}\.$/u.test(text.slice(Math.max(0, periodIndex - 3), periodIndex + 1))
}

function sentenceBoundary(text: string, index: number): number | null {
  if (!/[.!?]/.test(text[index])) return null
  if (text[index] === '.' && isAbbreviationPeriod(text, index)) return null
  let end = index + 1
  while (end < text.length && /["')\]}”’]/.test(text[end])) end++
  if (end >= text.length || !/\s/.test(text[end])) return null
  while (end < text.length && /\s/.test(text[end])) end++
  return end
}

function primaryBoundary(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '\r') return index + (text[index + 1] === '\n' ? 2 : 1)
    if (char === '\n') return index + 1
    const boundary = sentenceBoundary(text, index)
    if (boundary !== null) return boundary
    if (char === ';' && /\s/.test(text[index + 1] ?? '')) {
      let end = index + 1
      while (end < text.length && /\s/.test(text[end])) end++
      return end
    }
  }
  return text.length
}

function preferredLongBoundary(text: string, start: number, end: number): number {
  const minimum = start + Math.floor((end - start) / 2)
  let best = 0
  for (const delimiter of [', ', ': ', ' — ', ' – ']) {
    let index = text.indexOf(delimiter, start)
    while (index >= 0 && index + delimiter.length <= end) {
      const candidate = index + delimiter.length
      if (candidate >= minimum) best = Math.max(best, candidate)
      index = text.indexOf(delimiter, index + 1)
    }
  }
  if (best) return safeOffset(text, start, best)
  for (const match of text.slice(start, end).matchAll(/\s+/g)) {
    const candidate = start + match.index + match[0].length
    if (candidate >= minimum) best = candidate
  }
  return safeOffset(text, start, best || end)
}

function passageEnds(text: string): number[] {
  const ends: number[] = []
  for (let start = 0; start < text.length;) {
    const primaryEnd = primaryBoundary(text, start)
    for (let sliceStart = start; sliceStart < primaryEnd;) {
      const maximumEnd = Math.min(primaryEnd, sliceStart + SOURCE_PASSAGE_LIMITS.maxPassageCharacters)
      const end = maximumEnd === primaryEnd ? primaryEnd : preferredLongBoundary(text, sliceStart, maximumEnd)
      ends.push(end)
      sliceStart = end
    }
    start = primaryEnd
  }
  return ends
}

export function createSourcePassageCatalog(document: SourcePassageDocument): {
  catalog: SourcePassageCatalog
  view: SourcePassageView
} {
  const passages: SourcePassage[] = []
  const paragraphs = document.paragraphs.map((paragraph, paragraphIndex) => {
    const viewPassages: Array<{ passageId: number | null; text: string }> = []
    let startOffset = 0
    for (const endOffset of passageEnds(paragraph.text)) {
      const text = paragraph.text.slice(startOffset, endOffset)
      const passageId = text.trim() ? passages.length + 1 : null
      if (passageId !== null) {
        passages.push({ passageId, paragraphId: paragraph.id, paragraphIndex, startOffset, endOffset })
        if (passages.length > SOURCE_PASSAGE_LIMITS.maxPassages) {
          throw new SourcePassageBindingError(
            'too-many-passages',
            `The source document produced more than ${SOURCE_PASSAGE_LIMITS.maxPassages} citable passages.`,
          )
        }
      }
      viewPassages.push({ passageId, text })
      startOffset = endOffset
    }
    return { id: paragraph.id, page: paragraph.page, heading: paragraph.heading, passages: viewPassages }
  })
  if (!passages.length) {
    throw new SourcePassageBindingError('no-citable-passage', 'The source document did not contain any citable text.')
  }
  return {
    catalog: {
      version: SOURCE_PASSAGE_CATALOG_VERSION,
      documentId: document.id,
      documentVersion: document.version,
      documentSha256: analysisHash(document),
      passages,
    },
    view: { ...(document.title === undefined ? {} : { title: document.title }), paragraphs },
  }
}

function validateBinding(catalog: SourcePassageCatalog, document: SourcePassageDocument): void {
  if (catalog.version !== SOURCE_PASSAGE_CATALOG_VERSION || catalog.documentId !== document.id ||
    catalog.documentVersion !== document.version || catalog.documentSha256 !== analysisHash(document)) {
    throw new SourcePassageBindingError(
      'binding',
      'The source document and its passage catalog no longer match. Rebuild the catalog from the current document.',
    )
  }
}

function passageForId(catalog: SourcePassageCatalog, document: SourcePassageDocument, passageId: number): SourcePassage {
  const passage = Number.isSafeInteger(passageId) && passageId > 0 ? catalog.passages[passageId - 1] : undefined
  const paragraph = passage ? document.paragraphs[passage.paragraphIndex] : undefined
  if (!passage || passage.passageId !== passageId || !paragraph || paragraph.id !== passage.paragraphId ||
    passage.startOffset < 0 || passage.endOffset <= passage.startOffset || passage.endOffset > paragraph.text.length ||
    passage.endOffset - passage.startOffset > SOURCE_PASSAGE_LIMITS.maxPassageCharacters ||
    splitsSurrogate(paragraph.text, passage.startOffset) || splitsSurrogate(paragraph.text, passage.endOffset) ||
    !paragraph.text.slice(passage.startOffset, passage.endOffset).trim()) {
    throw new SourcePassageBindingError(
      'unknown-passage',
      `Passage ${passageId} does not exist in this document. Choose passage IDs from the supplied catalog.`,
    )
  }
  return passage
}

export function sourcePassageText(
  catalog: SourcePassageCatalog, document: SourcePassageDocument, passageId: number,
): string {
  validateBinding(catalog, document)
  const passage = passageForId(catalog, document, passageId)
  return document.paragraphs[passage.paragraphIndex].text.slice(passage.startOffset, passage.endOffset)
}

export function resolveSourceCitations(
  catalog: SourcePassageCatalog, document: SourcePassageDocument, passageIds: readonly number[],
): Citation[] {
  validateBinding(catalog, document)
  if (!passageIds.length) {
    throw new SourcePassageBindingError('empty', 'Select at least one source passage ID for the citation.')
  }
  const seen = new Set<number>()
  const passages = passageIds.map(passageId => {
    if (seen.has(passageId)) {
      throw new SourcePassageBindingError(
        'duplicate-passage',
        `Passage ${passageId} was selected more than once. Use each passage ID at most once.`,
      )
    }
    seen.add(passageId)
    return passageForId(catalog, document, passageId)
  }).sort((left, right) => left.passageId - right.passageId)

  const citations: Citation[] = []
  let runStart = passages[0]
  let runEnd = passages[0]
  const flush = () => {
    const paragraph = document.paragraphs[runStart.paragraphIndex]
    citations.push({
      documentId: document.id,
      documentVersion: document.version,
      paragraphId: paragraph.id,
      page: paragraph.page,
      heading: paragraph.heading,
      quote: paragraph.text.slice(runStart.startOffset, runEnd.endOffset).trim(),
    })
  }
  for (const passage of passages.slice(1)) {
    const paragraph = document.paragraphs[passage.paragraphIndex]
    const sameRun = passage.passageId === runEnd.passageId + 1 && passage.paragraphIndex === runEnd.paragraphIndex &&
      paragraph.text.slice(runEnd.endOffset, passage.startOffset).trim() === ''
    if (sameRun) runEnd = passage
    else {
      flush()
      runStart = passage
      runEnd = passage
    }
  }
  flush()
  return citations
}

export function describeSourcePassageError(error: unknown): { code: SourcePassageErrorCode; message: string } | null {
  if (error instanceof SourcePassageBindingError) return { code: error.code, message: error.message }
  if (!error || typeof error !== 'object' || !('name' in error) || !('code' in error) || !('message' in error)) {
    return null
  }
  if (error.name !== 'SourcePassageBindingError' || typeof error.code !== 'string' ||
    typeof error.message !== 'string') {
    return null
  }
  return { code: error.code as SourcePassageErrorCode, message: error.message }
}
