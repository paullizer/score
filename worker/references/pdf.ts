import { createHash } from 'node:crypto'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import type { ReferenceLink, ReferenceParagraph, ReferenceSourceRecord } from '../../src/domain/real-grades'
import type { GradeBlob } from '../../server/grades/store'
import {
  normalizeText, pollPdfLayout, submitPdfLayout, WorkerError,
} from '../runtime'
import type { DocumentIntelligenceResult } from '../runtime'
import type { ReferenceExtractionOptions } from './contracts'
import { enforceReferenceCharacters, referenceRelation } from './html'
import { checkCancellation, pdfSignature, referenceUrl } from './transport'
import { referenceTableRows } from './tables'

export const REFERENCE_EXTRACTION_VERSION = 'score-reference-layout-v1'
const MAX_CACHE_BYTES = 32 * 1024 * 1024

export function referenceHash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function pdfString(value: unknown): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined
}

export async function inspectReferencePdf(bytes: Uint8Array, baseUrl?: string) {
  if (bytes.byteLength > GRADE_LADDER_LIMITS.maxPdfBytes) {
    throw new WorkerError('reference-pdf-too-large', 'Reference PDFs cannot exceed 20 MiB.', false, 'parsing')
  }
  if (!pdfSignature(bytes)) throw new WorkerError('invalid-pdf', 'The reference has no PDF signature.', false, 'parsing')
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    const encrypted = error instanceof Error && /encrypt|password/i.test(error.message)
    throw new WorkerError(encrypted ? 'password-protected-pdf' : 'invalid-pdf',
      encrypted ? 'Password-protected reference PDFs are not supported.' : 'Reference PDF metadata could not be read.', false, 'parsing', { cause: error })
  }
  const pageCount = pdf.getPageCount()
  if (pageCount < 1 || pageCount > 10_000) {
    throw new WorkerError('reference-pdf-metadata-budget', 'The reference PDF must contain 1–10,000 original pages; select a smaller manual if necessary.', false, 'parsing')
  }
  const links: ReferenceLink[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  pdf.getPages().forEach((page, index) => {
    const annotations = page.node.Annots()
    if (!(annotations instanceof PDFArray)) return
    for (let i = 0; i < annotations.size(); i += 1) {
      try {
        const annotation = annotations.lookup(i)
        if (!(annotation instanceof PDFDict)) continue
        const action = annotation.lookup(PDFName.of('A'))
        if (!(action instanceof PDFDict) || action.get(PDFName.of('S'))?.toString() !== '/URI') continue
        const uri = pdfString(action.lookup(PDFName.of('URI')))
        if (!uri) continue
        const url = referenceUrl(uri, baseUrl).href
        const key = `${index + 1}:${url}`
        if (seen.has(key)) continue
        if (links.length >= 2_000) throw new WorkerError('reference-link-budget', 'The PDF contains more than 2,000 URI links; select a narrower source.', false, 'parsing')
        seen.add(key)
        const label = normalizeText(pdfString(annotation.lookup(PDFName.of('Contents'))) ?? '') || url
        links.push({ url, label, relation: referenceRelation(label, url), page: index + 1 })
      } catch (error) {
        if (error instanceof WorkerError && error.code === 'reference-link-budget') throw error
        warnings.push(`An invalid or unsupported PDF link on original page ${index + 1} was not followed.`)
      }
    }
  })
  return { pdf, pageCount, links, warnings: [...new Set(warnings)], title: pdf.getTitle() }
}

export function selectedReferencePages(selection: number[], pageCount: number): number[] {
  if (selection.length > GRADE_LADDER_LIMITS.maxPdfPages) {
    throw new WorkerError('reference-too-many-selected-pages', 'Select at most 250 pages per reference PDF.', false, 'parsing')
  }
  if (selection.length === 0) {
    if (pageCount > GRADE_LADDER_LIMITS.maxPdfPages) {
      throw new WorkerError('reference-page-selection-required', `This PDF has ${pageCount} pages. Explicitly select at most 250; no pages were sent for extraction.`, false, 'parsing')
    }
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }
  if (selection.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount) || new Set(selection).size !== selection.length) {
    throw new WorkerError('reference-invalid-pages', 'Selected pages must be distinct, valid original PDF page numbers.', false, 'parsing')
  }
  return [...selection].sort((a, b) => a - b)
}

interface ChunkIdentity {
  version: string
  workspaceId: string
  ladderId: string
  sourceId: string
  documentId: string
  documentVersion: number
  originalHash: string
  pages: number[]
  endpoint: string
}

interface ChunkArtifact {
  identity: ChunkIdentity
  kind: 'operation' | 'result' | 'expired'
  operationUrl?: string
  result?: DocumentIntelligenceResult
}

function readArtifact(blob: GradeBlob, identity: ChunkIdentity, kind: ChunkArtifact['kind']): ChunkArtifact {
  try {
    if (blob.bytes.byteLength > MAX_CACHE_BYTES || blob.contentType.split(';')[0] !== 'application/json' || referenceHash(blob.bytes) !== blob.sha256) {
      throw new Error('Invalid cache bytes.')
    }
    const artifact = JSON.parse(Buffer.from(blob.bytes).toString('utf8')) as ChunkArtifact
    if (JSON.stringify(artifact.identity) !== JSON.stringify(identity) || artifact.kind !== kind ||
      (kind === 'operation' && typeof artifact.operationUrl !== 'string') ||
      (kind === 'result' && (artifact.result?.status !== 'succeeded' || !artifact.result.analyzeResult))) {
      throw new Error('Mismatched extraction cache.')
    }
    return artifact
  } catch (error) {
    throw new WorkerError('reference-cache-invalid', 'The immutable reference chunk does not match this source, version, page selection, or extraction service.', false, 'parsing', { cause: error })
  }
}

async function cachedArtifact(key: string, identity: ChunkIdentity, kind: ChunkArtifact['kind'], options: ReferenceExtractionOptions) {
  const blob = await options.readChunk?.(key)
  return blob ? readArtifact(blob, identity, kind) : undefined
}

async function saveArtifact(key: string, artifact: ChunkArtifact, options: ReferenceExtractionOptions): Promise<ChunkArtifact> {
  const bytes = Buffer.from(JSON.stringify(artifact), 'utf8')
  if (bytes.byteLength > MAX_CACHE_BYTES) throw new WorkerError('reference-cache-too-large', 'The extraction chunk exceeds its durable cache budget.', false, 'parsing')
  if (options.writeChunk) {
    await options.writeChunk(key, bytes, 'application/json')
    if (options.readChunk) {
      const saved = await cachedArtifact(key, artifact.identity, artifact.kind, options)
      if (!saved) throw new WorkerError('reference-cache-missing', 'A completed reference chunk could not be read after its immutable write.', true, 'parsing')
      return saved
    }
  }
  return artifact
}

async function chunkAnalysis(
  pdf: PDFDocument,
  source: ReferenceSourceRecord,
  originalHash: string,
  pages: number[],
  options: ReferenceExtractionOptions,
): Promise<DocumentIntelligenceResult> {
  checkCancellation(options.signal)
  const identity: ChunkIdentity = {
    version: REFERENCE_EXTRACTION_VERSION,
    workspaceId: source.workspaceId,
    ladderId: source.ladderId,
    sourceId: source.id,
    documentId: source.documentId,
    documentVersion: source.documentVersion,
    originalHash,
    pages,
    endpoint: options.documentIntelligence.endpoint.replace(/\/+$/, ''),
  }
  const key = `ref-${referenceHash(JSON.stringify(identity))}`
  const cached = await cachedArtifact(`${key}-result`, identity, 'result', options)
  if (cached?.result) return cached.result
  const client = { ...options.documentIntelligence, signal: options.signal }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    checkCancellation(options.signal)
    const operationKey = `${key}-operation-${attempt}`
    if (await cachedArtifact(`${operationKey}-expired`, identity, 'expired', options)) continue
    let operation = await cachedArtifact(operationKey, identity, 'operation', options)
    if (!operation) {
      const copy = await PDFDocument.create()
      const copied = await copy.copyPages(pdf, pages.map(page => page - 1))
      for (const page of copied) copy.addPage(page)
      const bytes = await copy.save()
      if (bytes.byteLength > GRADE_LADDER_LIMITS.maxPdfBytes) {
        throw new WorkerError('reference-chunk-too-large', 'A reference page-copy chunk exceeds 20 MiB; explicitly select a smaller page range.', false, 'parsing')
      }
      checkCancellation(options.signal)
      const operationUrl = await submitPdfLayout(bytes, client)
      operation = await saveArtifact(operationKey, { identity, kind: 'operation', operationUrl }, options)
    }
    checkCancellation(options.signal)
    try {
      const result = await pollPdfLayout(operation.operationUrl!, client, true)
      const artifact = await saveArtifact(`${key}-result`, { identity, kind: 'result', result }, options)
      checkCancellation(options.signal)
      return artifact.result!
    } catch (error) {
      if (!(error instanceof WorkerError) || error.code !== 'ocr-operation-expired') throw error
      await saveArtifact(`${operationKey}-expired`, { identity, kind: 'expired' }, options)
    }
  }
  throw new WorkerError('reference-ocr-recovery-exhausted', 'Three saved OCR operations expired. Retry extraction as a new document version.', false, 'parsing')
}

interface LayoutBlock {
  page: number
  offset: number
  order: number
  text: string
  heading?: boolean
  table?: ReferenceParagraph['table']
  sectionId?: string
  caption?: string
}

function layoutBlocks(result: DocumentIntelligenceResult, pages: number[], chunk: number) {
  const analyze = result.analyzeResult
  if (!analyze) throw new WorkerError('ocr-invalid-response', 'The reference chunk contains no layout result.', true, 'parsing')
  const blocks: LayoutBlock[] = []
  const warnings: string[] = []
  const reported = new Set<number>()
  const originalPage = (page: number | undefined): number => {
    if (!Number.isSafeInteger(page) || page! < 1 || page! > pages.length) {
      throw new WorkerError('reference-ocr-page-mismatch', 'The OCR result cannot be mapped to the selected original PDF pages.', false, 'parsing')
    }
    return pages[page! - 1]
  }
  for (const page of analyze.pages ?? []) reported.add(originalPage(page.pageNumber))
  const tableCells = (analyze.tables ?? []).flatMap(table => table.cells ?? [])
  const insideTable = (paragraph: NonNullable<typeof analyze.paragraphs>[number]) => {
    const span = paragraph.spans?.[0]
    return tableCells.some(cell => {
      if (span?.offset !== undefined && span.length !== undefined) {
        return cell.spans?.some(other => other.offset !== undefined && other.length !== undefined &&
          span.offset! >= other.offset && span.offset! + span.length! <= other.offset + other.length)
      }
      return normalizeText(cell.content ?? '') === normalizeText(paragraph.content ?? '') &&
        cell.boundingRegions?.[0]?.pageNumber === paragraph.boundingRegions?.[0]?.pageNumber
    })
  }
  for (const paragraph of analyze.paragraphs ?? []) {
    const text = normalizeText(paragraph.content ?? '')
    if (!text || insideTable(paragraph)) continue
    const regions = paragraph.boundingRegions ?? []
    const page = originalPage(regions[0]?.pageNumber)
    if (new Set(regions.map(region => region.pageNumber)).size > 1) {
      warnings.push(`A paragraph spanning multiple pages begins on original page ${page}; its complete page-level locator needs review.`)
    }
    blocks.push({
      page, offset: paragraph.spans?.[0]?.offset ?? Number.MAX_SAFE_INTEGER, order: blocks.length, text,
      heading: paragraph.role === 'title' || paragraph.role === 'sectionHeading',
    })
  }
  for (const [tableIndex, table] of (analyze.tables ?? []).entries()) {
    const page = originalPage(table.boundingRegions?.[0]?.pageNumber ?? table.cells?.[0]?.boundingRegions?.[0]?.pageNumber)
    const tablePages = new Set(table.boundingRegions?.map(region => region.pageNumber) ?? [])
    if ((tablePages.size > 1 && table.cells?.some(cell => !cell.boundingRegions?.length)) ||
      table.cells?.some(cell => new Set(cell.boundingRegions?.map(region => region.pageNumber) ?? []).size > 1)) {
      warnings.push(`A table spanning multiple pages begins on original page ${page}; incomplete cell-level page locators require review.`)
    }
    if (chunk > 1 && table.boundingRegions?.[0]?.pageNumber === 1 && (table.columnCount ?? 0) > 1 &&
      !table.cells?.some(cell => cell.kind === 'columnHeader')) {
      warnings.push(`A table on original page ${page} begins at an OCR chunk boundary without column headers. Select its preceding header pages together or review the missing table context.`)
    }
    const sectionId = `ref-p${String(page).padStart(4, '0')}-chunk${chunk}-table${tableIndex + 1}`
    const offset = table.spans?.[0]?.offset ?? Number.MAX_SAFE_INTEGER
    const caption = normalizeText(table.caption?.content ?? '')
    if (caption) blocks.push({ page, offset, order: blocks.length, text: caption, sectionId })
    const rows = referenceTableRows((table.cells ?? []).map(cell => ({
      row: cell.rowIndex ?? 0,
      column: cell.columnIndex ?? 0,
      rowSpan: cell.rowSpan ?? 1,
      columnSpan: cell.columnSpan ?? 1,
      text: normalizeText(cell.content ?? ''),
      columnHeader: cell.kind === 'columnHeader',
      page: cell.boundingRegions?.[0]?.pageNumber ? originalPage(cell.boundingRegions[0].pageNumber) : page,
    })), table.rowCount ?? Math.max(0, ...(table.cells ?? []).map(cell => (cell.rowIndex ?? 0) + (cell.rowSpan ?? 1))),
    table.columnCount ?? Math.max(0, ...(table.cells ?? []).map(cell => (cell.columnIndex ?? 0) + (cell.columnSpan ?? 1))))
    for (const row of rows) blocks.push({
      page: row.page ?? page, offset, order: blocks.length, text: row.text, sectionId, caption,
      table: { headers: row.headers, row: row.row },
    })
    for (const footnote of table.footnotes ?? []) {
      const footnotePage = footnote.boundingRegions?.[0]?.pageNumber
      blocks.push({
        page: footnotePage ? originalPage(footnotePage) : rows.at(-1)?.page ?? page,
        offset, order: blocks.length, text: normalizeText(footnote.content ?? ''), sectionId, caption,
      })
    }
  }
  return { blocks, warnings, reported }
}

export async function extractReferencePdf(bytes: Uint8Array, source: ReferenceSourceRecord, options: ReferenceExtractionOptions) {
  checkCancellation(options.signal)
  const metadata = await inspectReferencePdf(bytes, source.finalUrl ?? source.requestedUrl)
  checkCancellation(options.signal)
  const selectedPages = selectedReferencePages(source.selectedPages, metadata.pageCount)
  const originalHash = referenceHash(bytes)
  const blocks: LayoutBlock[] = []
  const warnings = [...metadata.warnings]
  const reported = new Set<number>()
  if (!options.readChunk || !options.writeChunk) warnings.push('Durable chunk recovery is unavailable because both immutable readChunk and writeChunk callbacks were not provided.')
  for (let index = 0; index < selectedPages.length; index += GRADE_LADDER_LIMITS.pdfChunkPages) {
    const pages = selectedPages.slice(index, index + GRADE_LADDER_LIMITS.pdfChunkPages)
    const result = await chunkAnalysis(metadata.pdf, source, originalHash, pages, options)
    const layout = layoutBlocks(result, pages, index / GRADE_LADDER_LIMITS.pdfChunkPages + 1)
    blocks.push(...layout.blocks)
    warnings.push(...layout.warnings)
    for (const page of layout.reported) reported.add(page)
    if (blocks.reduce((sum, block) => sum + block.text.length, 0) > GRADE_LADDER_LIMITS.maxSourceCharacters) {
      throw new WorkerError('reference-too-long', 'The reference exceeds 2,000,000 extracted characters. No content was silently truncated; select fewer pages.', false, 'parsing')
    }
  }
  blocks.sort((left, right) => left.page - right.page || left.offset - right.offset || left.order - right.order)
  const perPage = new Map<number, number>()
  let heading = source.title
  let priorPage: number | undefined
  const paragraphs: ReferenceParagraph[] = []
  for (const block of blocks) {
    if (!/[\p{L}\p{N}]/u.test(block.text)) continue
    if (priorPage !== undefined && block.page > priorPage + 1) heading = `${source.title} / Selected original page ${block.page}`
    if (block.heading) heading = block.text
    priorPage = block.page
    const number = (perPage.get(block.page) ?? 0) + 1
    perPage.set(block.page, number)
    paragraphs.push({
      id: `ref-p${String(block.page).padStart(4, '0')}-b${String(number).padStart(5, '0')}`,
      page: block.page, text: block.text, heading: block.caption ? `${heading} / ${block.caption}` : heading,
      ...(block.table ? { table: block.table } : {}),
      ...(block.sectionId ? { sectionId: block.sectionId } : {}),
    })
  }
  enforceReferenceCharacters(paragraphs)
  if (paragraphs.length === 0) throw new WorkerError('reference-empty', 'The selected reference pages contain no readable text. No grading evidence was extracted.', false, 'parsing')
  const missing = selectedPages.filter(page => !reported.has(page) || !perPage.has(page))
  if (missing.length) warnings.push(`Extraction is incomplete: no attributable readable layout was returned for original pages ${missing.join(', ')}. These pages may be blank or require another extraction.`)
  const ambiguous = warnings.some(warning => /spanning multiple pages|chunk boundary without column headers/.test(warning))
  checkCancellation(options.signal)
  return {
    paragraphs,
    pageCount: metadata.pageCount,
    selectedPages,
    completeness: missing.length || ambiguous ? 'incomplete' as const : selectedPages.length < metadata.pageCount ? 'selected-pages' as const : 'complete' as const,
    links: metadata.links.filter(link => link.page !== undefined && selectedPages.includes(link.page)),
    warnings,
  }
}
