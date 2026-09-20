export const PPTX_LAYOUT = {
  width: 40 / 3,
  height: 7.5,
  margin: 0.6,
  bodyY: 2.08,
  bodyBottom: 6.3,
  bodyFontSize: 16,
  tableFontSize: 14,
  headingFontSize: 22,
  lineHeight: 1.25,
  textSafety: 0.08,
} as const

export interface PptxBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PptxTextLine {
  start: number
  end: number
  width: number
}

export interface PptxFlowBlock {
  key: string
  text: string
  kind?: 'heading' | 'paragraph' | 'citation'
  fontSize?: number
  context?: string
  section?: string
}

export interface PptxFlowFragment extends PptxFlowBlock {
  kind: NonNullable<PptxFlowBlock['kind']>
  fontSize: number
  y: number
  height: number
  contextHeight: number
  continued: boolean
}

export interface PptxFlowPage {
  fragments: PptxFlowFragment[]
  height: number
  width: number
  capacity: number
}

export interface PptxFlowOptions {
  continuationWidth?: number
  continuationHeight?: number
}

function validTextDimensions(width: number, fontSize: number): void {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error('PowerPoint text requires positive, finite dimensions.')
  }
}

// Maxima from the bundled Noto Sans regular/bold advances, plus 6% and a few
// common sans-serif fallback maxima. The line wrapper reserves another 6%.
const LATIN_ADVANCES: Readonly<Record<string, number>> = Object.fromEntries((
  [
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', [732, 713, 770, 785, 594, 650, 772, 811, 413, 560, 704, 599, 1000, 862, 844, 666, 844, 700, 720, 614, 802, 689, 1026, 708, 662, 614]],
    ['abcdefghijklmnopqrstuvwxyz', [641, 671, 545, 671, 627, 411, 671, 697, 324, 324, 658, 324, 1041, 697, 657, 671, 671, 482, 527, 461, 697, 604, 908, 613, 604, 518]],
    ['0123456789', [607, 607, 607, 607, 607, 607, 607, 607, 607, 607]],
    [' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', [276, 304, 501, 685, 607, 956, 795, 282, 360, 360, 585, 607, 303, 342, 303, 438, 303, 303, 607, 607, 607, 506, 953, 351, 438, 351, 607, 471, 384, 418, 585, 418, 607]],
  ] as [string, number[]][]
).flatMap(([characters, advances]) => Array.from(characters, (character, index) => [character, advances[index] / 1000])))

export function pptxGlyphWidth(character: string, fontSize: number): number {
  if (/[\r\n\u2028\u2029]/u.test(character)) return 0
  if (character === '\t') return Math.max(72, fontSize * 4)
  if (character === '\u00a0') return fontSize * LATIN_ADVANCES[' ']
  if (/\p{Mark}/u.test(character)) return fontSize * 0.15
  if (LATIN_ADVANCES[character] !== undefined) return fontSize * LATIN_ADVANCES[character]
  if (character === '–') return fontSize * 0.65
  return fontSize * 1.15
}

export function measurePptxLines(text: string, width: number, fontSize: number): PptxTextLine[] {
  validTextDimensions(width, fontSize)
  const available = width * 72 * 0.94
  const lines: PptxTextLine[] = []
  let start = 0
  let cursor = 0
  let lineWidth = 0
  let breakAt = -1
  let breakWidth = 0
  while (cursor < text.length) {
    const code = text.codePointAt(cursor)!
    const character = String.fromCodePoint(code)
    if (/[\r\n\u2028\u2029]/u.test(character)) {
      cursor += character === '\r' && text[cursor + 1] === '\n' ? 2 : character.length
      lines.push({ start, end: cursor, width: lineWidth })
      start = cursor
      lineWidth = 0
      breakAt = -1
      continue
    }
    const advance = pptxGlyphWidth(character, fontSize)
    if (advance > available) throw new Error('PowerPoint text column is too narrow to preserve a source character.')
    if (lineWidth + advance > available && cursor > start) {
      const end = breakAt > start ? breakAt : cursor
      lines.push({ start, end, width: breakAt > start ? breakWidth : lineWidth })
      start = end
      cursor = end
      lineWidth = 0
      breakAt = -1
      continue
    }
    lineWidth += advance
    cursor += character.length
    if ((character !== '\u00a0' && /\s/u.test(character)) || /[-/]/u.test(character)) {
      breakAt = cursor
      breakWidth = lineWidth
    }
  }
  lines.push({ start, end: cursor, width: lineWidth })
  return lines
}

export function pptxTextHeight(lineCount: number, fontSize: number): number {
  return Math.max(1, lineCount) * fontSize * PPTX_LAYOUT.lineHeight / 72 + PPTX_LAYOUT.textSafety
}

export function measurePptxText(text: string, width: number, fontSize: number): { lines: PptxTextLine[]; height: number } {
  const lines = measurePptxLines(text, width, fontSize)
  return { lines, height: pptxTextHeight(lines.length, fontSize) }
}

export function keepPptxParagraphEndWordsTogether(text: string, width: number, fontSize: number): string {
  validTextDimensions(width, fontSize)
  return text.replace(/(\S+)( +)(\S+)([\t ]*)(?=\r\n?|\n|\u2028|\u2029|$)/gu,
    (original, first: string, spaces: string, last: string, trailing: string) => {
      if (/[.!?\u3002\uff01\uff1f]["'\u2019\u201d)\]]*$/u.test(first)) return original
      const pair = `${first}${spaces.replace(/ /g, '\u00a0')}${last}`
      return measurePptxLines(pair, width, fontSize).length === 1 ? pair + trailing : original
    })
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })

function firstSentence(text: string): string {
  return sentenceSegmenter.segment(text)[Symbol.iterator]().next().value?.segment ?? ''
}

export function takePptxText(text: string, width: number, maxHeight: number, fontSize: number): {
  text: string
  rest: string
  height: number
} {
  const measured = measurePptxText(text, width, fontSize)
  if (measured.height <= maxHeight + 0.000001) return { text, rest: '', height: measured.height }
  const capacity = Math.floor((maxHeight - PPTX_LAYOUT.textSafety + 0.000001) * 72 / (fontSize * PPTX_LAYOUT.lineHeight))
  if (capacity < 1) throw new Error('PowerPoint text has no room for a readable line.')
  const sentenceEnds = Array.from(sentenceSegmenter.segment(text), sentence => sentence.index + sentence.segment.length)
  let count = Math.min(capacity, measured.lines.length)
  while (count > 0) {
    let end = measured.lines[count - 1].end
    const paragraphBreaks = [...text.slice(0, end).matchAll(/(?:\r?\n[\t ]*){2,}/g)]
    const boundary = paragraphBreaks.at(-1)
    const paragraphEnd = boundary ? boundary.index! + boundary[0].length : 0
    let sentenceEnd = 0
    for (const position of sentenceEnds) {
      if (position > end) break
      sentenceEnd = position
    }
    let semanticBoundary = false
    if (paragraphEnd > 0 && paragraphEnd < end &&
      measurePptxText(text.slice(0, paragraphEnd), width, fontSize).height >= maxHeight * 0.6) {
      end = paragraphEnd
      semanticBoundary = true
    } else if (sentenceEnd > 0) {
      end = sentenceEnd
      semanticBoundary = true
    }
    // Only genuinely oversized sentences need line-level splitting and widow protection.
    if (!semanticBoundary && count > 2 && text.slice(end).trim() &&
      measurePptxText(text.slice(end).trimEnd(), width, fontSize).lines.length < 2) {
      count--
      continue
    }
    const fragment = text.slice(0, end)
    const height = measurePptxText(fragment, width, fontSize).height
    if (end > 0 && height <= maxHeight + 0.000001) return { text: fragment, rest: text.slice(end), height }
    count--
  }
  throw new Error('PowerPoint text has no room for a preserved paragraph break.')
}

export function paginatePptxBlocks(
  blocks: readonly PptxFlowBlock[], width: number, height: number, options: PptxFlowOptions = {},
): PptxFlowPage[] {
  validTextDimensions(width, PPTX_LAYOUT.bodyFontSize)
  if (!Number.isFinite(height) || height < 1) throw new Error('PowerPoint content area is too short.')
  const continuedWidth = options.continuationWidth ?? width
  const continuedHeight = options.continuationHeight ?? height
  validTextDimensions(continuedWidth, PPTX_LAYOUT.bodyFontSize)
  if (!Number.isFinite(continuedHeight) || continuedHeight < 1) throw new Error('PowerPoint continuation area is too short.')
  const pages: PptxFlowPage[] = []
  let page: PptxFlowPage = { fragments: [], height: 0, width, capacity: height }
  const nextPage = () => {
    if (page.fragments.length) pages.push(page)
    page = { fragments: [], height: 0, width: continuedWidth, capacity: continuedHeight }
  }
  blocks.forEach((block, blockIndex) => {
    const kind = block.kind ?? 'paragraph'
    const fontSize = block.fontSize ?? (kind === 'heading' ? PPTX_LAYOUT.headingFontSize : PPTX_LAYOUT.bodyFontSize)
    const padding = kind === 'citation' ? 0.16 : 0
    let remaining = block.text
    let continued = false
    do {
      const gap = page.fragments.length ? (kind === 'heading' && !continued ? 0.2 : 0.1) : 0
      const available = page.capacity - page.height - gap
      const textWidth = page.width - padding * 2
      const measured = measurePptxText(remaining, textWidth, fontSize)
      const contextHeight = block.context && (continued || measured.height + padding * 2 > page.capacity) ?
        measurePptxText(block.context, textWidth, 12).height + 0.08 : 0
      const minimum = pptxTextHeight(2, fontSize) + padding * 2 + contextHeight
      const following = blocks[blockIndex + 1]
      const followingFont = following?.fontSize ?? PPTX_LAYOUT.bodyFontSize
      const headingReserve = kind === 'heading' && following ?
        Math.max(
          Math.min(measurePptxText(following.text, textWidth, followingFont).height, pptxTextHeight(3, followingFont)),
          Math.min(measurePptxText(firstSentence(following.text), textWidth, followingFont).height, continuedHeight - measured.height - 0.1),
        ) + 0.1 : 0
      const wholeHeight = measured.height + padding * 2 + contextHeight
      const firstSentenceHeight = measurePptxText(firstSentence(remaining), textWidth, fontSize).height + padding * 2 + contextHeight
      const canMoveParagraph = kind !== 'heading' && page.fragments.at(-1)?.kind !== 'heading' &&
        ((wholeHeight <= continuedHeight && available < wholeHeight) ||
          (firstSentenceHeight <= continuedHeight && available < firstSentenceHeight))
      if (kind === 'heading' && !page.fragments.length && page.capacity < continuedHeight &&
        available < wholeHeight + headingReserve && wholeHeight + headingReserve <= continuedHeight + 0.000001) {
        nextPage()
        continue
      }
      if (page.fragments.length && (available < Math.min(wholeHeight, minimum) ||
        canMoveParagraph ||
        (kind === 'citation' && wholeHeight <= page.capacity && available < wholeHeight) ||
        (measured.lines.length <= 3 && wholeHeight <= page.capacity && available < wholeHeight) ||
        (kind === 'heading' && wholeHeight <= page.capacity && available < wholeHeight + headingReserve))) {
        nextPage()
        continue
      }
      const fragment = takePptxText(remaining, textWidth, available - padding * 2 - contextHeight, fontSize)
      const y = page.height + gap
      const fragmentHeight = fragment.height + padding * 2 + contextHeight
      page.fragments.push({ ...block, kind, fontSize, text: fragment.text, y, height: fragmentHeight, contextHeight, continued })
      page.height = y + fragmentHeight
      remaining = fragment.rest
      continued = true
      if (remaining.length) nextPage()
    } while (remaining.length)
  })
  nextPage()
  return pages
}

export function assertPptxBox(box: PptxBox): void {
  const minimumMargin = 0.5
  const tolerance = 0.000001
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0 ||
    box.x < minimumMargin - tolerance || box.y < minimumMargin - tolerance ||
    box.x + box.w > PPTX_LAYOUT.width - minimumMargin + tolerance ||
    box.y + box.h > PPTX_LAYOUT.height - minimumMargin + tolerance) {
    throw new Error('PowerPoint layout exceeds the safe slide bounds; no evidence has been omitted.')
  }
}
