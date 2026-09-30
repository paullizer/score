import { csvCell, type CsvCell } from './csv'
import type { reportLimits } from './policy'
import type { RubricDocumentSource, RubricExportDocument } from './rubric-model'

const numbered = (values: string[]): string | null =>
  values.length ? values.map((value, index) => `[${index + 1}] ${value}`).join('\n') : null

// Quotes and their locations share numbers so a reader can pair them across the two columns.
const quotes = (sources: RubricDocumentSource[]) => numbered(sources.map(source => `“${source.quote}”`))
const locations = (sources: RubricDocumentSource[]) => numbered(sources.map(source => source.location))

/**
 * One row per criterion (C1…) and GS qualification (Q1…). "Job/grade" and the criterion numbers
 * match the analysis CSV, so the two files join on those columns.
 */
export function rubricCsvRows(documents: readonly RubricExportDocument[], notice = ''): CsvCell[][] {
  if (!documents.length) throw new Error('A rubric CSV needs at least one rubric.')
  const grades = documents.some(document => document.kind === 'grade')
  const displayTitles = documents.some(document => document.tableDisplayTitle)
  const footer = notice.trim() ? notice : ''
  const rows: CsvCell[][] = [[
    'Job/grade', 'Organization', 'Rubric', 'Rubric version', 'Criterion #', 'Criterion', 'Requirement type', 'Weight (%)',
    'Scored', 'Description', 'Scoring guidance', 'Source quotes', 'Source locations',
    ...(grades ? ['Source support', 'Interpretation'] : []),
    'Link',
    ...(displayTitles ? ['Job/grade display title'] : []),
    ...(footer ? ['Additional notice'] : []),
  ]]
  for (const document of documents) {
    const identity: CsvCell[] = [document.tableLabel, document.organization || null, document.rubricName, document.version]
    const trailing: CsvCell[] = [
      document.link?.url ?? null,
      ...(displayTitles ? [document.tableDisplayTitle] : []),
      ...(footer ? [footer] : []),
    ]
    for (const criterion of document.criteria) rows.push([
      ...identity, criterion.code, criterion.label, criterion.requirement, Number(criterion.weight.toFixed(6)),
      criterion.scored ? 'Yes' : 'No',
      criterion.description, criterion.guidanceText || null, quotes(criterion.sources), locations(criterion.sources),
      ...(grades ? [criterion.support, criterion.interpretation] : []),
      ...trailing,
    ])
    for (const qualification of document.qualifications) rows.push([
      ...identity, qualification.code, qualification.text, null, null, 'No',
      null, null, quotes(qualification.sources), locations(qualification.sources),
      ...(grades ? [qualification.support, qualification.interpretation || null] : []),
      ...trailing,
    ])
  }
  return rows
}

export function generateRubricCsv(
  documents: readonly RubricExportDocument[],
  options: { notice?: string; limits: ReturnType<typeof reportLimits>; startedAt: number },
): Uint8Array {
  const { limits, startedAt } = options
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = [Uint8Array.of(0xef, 0xbb, 0xbf)]
  let bytes = 3
  const checkTime = () => {
    if (Date.now() - startedAt > limits.maxGenerationMilliseconds) {
      throw new Error('Rubric CSV generation exceeded its time limit. No file was downloaded.')
    }
  }
  for (const row of rubricCsvRows(documents, options.notice)) {
    checkTime()
    const chunk = encoder.encode(`${row.map(csvCell).join(',')}\r\n`)
    bytes += chunk.byteLength
    if (bytes > limits.maxOutputBytes) {
      throw new Error('This rubric CSV exceeds the export size limit. No rows were omitted, and no file was downloaded.')
    }
    chunks.push(chunk)
  }
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  checkTime()
  return result
}
