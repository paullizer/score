import { Unzip, UnzipInflate, zipSync } from 'fflate'
import { SaxesParser } from 'saxes'
import readXlsxFile from 'read-excel-file/universal'
import { MAPPING_LIMITS, MappingInputError, type MappingCell, type MappingWorkbook } from './applicant-mapping'

function limit(condition: boolean, message: string): void {
  if (!condition) throw new MappingInputError(message)
}

function cell(value: string): string {
  limit(value.length <= MAPPING_LIMITS.cellCharacters, 'The mapping contains a cell longer than 4,096 characters.')
  return value
}

export function parseMappingCsv(text: string): MappingWorkbook {
  const rows: string[][] = []
  let row: string[] = [], value = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start', cells = 0
  function append() {
    limit(row.length < MAPPING_LIMITS.columns && ++cells <= MAPPING_LIMITS.cells, 'The mapping exceeds 50 columns or 200,000 cells.')
    row.push(cell(value)); value = ''; state = 'start'
  }
  function finish() {
    append()
    limit(rows.length < MAPPING_LIMITS.rows, 'The mapping exceeds 10,000 rows.')
    rows.push(row); row = []
  }
  text = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (state === 'quoted') {
      if (character === '"') state = 'closed'
      else value += character
    } else if (state === 'closed' && character === '"') { value += '"'; state = 'quoted' }
    else if (character === ',') append()
    else if (character === '\r' || character === '\n') {
      finish()
      if (character === '\r' && text[index + 1] === '\n') index++
    } else if (character === '"' && state === 'start') state = 'quoted'
    else {
      limit(state !== 'closed' && character !== '"', 'The CSV has invalid quoting. Save a UTF-8 comma-separated CSV and retry.')
      state = 'plain'; value += character
    }
    limit(value.length <= MAPPING_LIMITS.cellCharacters, 'The mapping contains a cell longer than 4,096 characters.')
  }
  limit(state !== 'quoted', 'The CSV contains an unclosed quoted field.')
  if (value || row.length || state !== 'start') finish()
  limit(rows.length > 0, 'The mapping file is empty.')
  return { sheets: [{ name: 'CSV', rows }] }
}

function inspectXml(name: string, bytes: Uint8Array): number {
  const parser = new SaxesParser({ xmlns: true })
  let depth = 0, rows = 0, columns = 0, cells = 0, rowNumber = 0, maxRow = 0, maxColumn = 0, strings = 0
  const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name)
  parser.on('doctype', () => { throw new MappingInputError('Mapping workbooks cannot contain XML document types.') })
  parser.on('opentag', node => {
    limit(++depth <= 64, 'The mapping workbook XML is too deeply nested.')
    if (node.local === 'f') throw new MappingInputError('Mapping workbooks must use plain values, not formulas. Paste formulas as values and retry.')
    if (node.local === 'si') limit(++strings <= MAPPING_LIMITS.cells, 'The workbook contains too many shared strings.')
    if (name === '[Content_Types].xml') {
      limit(!Object.values(node.attributes).some(attribute => typeof attribute === 'object' && /macroEnabled|vbaProject/i.test(attribute.value)),
        'Macro-enabled workbooks are not supported.')
    }
    if (!worksheet) return
    const attribute = (key: string) => {
      const value = node.attributes[key]
      return typeof value === 'object' ? value.value : ''
    }
    if (node.local === 'row') {
      rows++; columns = 0
      rowNumber = attribute('r') ? Number(attribute('r')) : rowNumber + 1
      maxRow = Math.max(maxRow, rowNumber)
      limit(Number.isInteger(rowNumber) && rowNumber > 0 && rowNumber <= MAPPING_LIMITS.rows && rows <= MAPPING_LIMITS.rows, 'The mapping exceeds 10,000 worksheet rows.')
    }
    if (node.local === 'c') {
      columns++; cells++
      maxColumn = Math.max(maxColumn, columns)
      const address = attribute('r')
      if (address) {
        const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address)
        limit(Boolean(match), 'The mapping contains an invalid cell address.')
        if (match) {
          let column = 0
          for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
          maxColumn = Math.max(maxColumn, column)
          maxRow = Math.max(maxRow, Number(match[2]))
          limit(column <= MAPPING_LIMITS.columns && Number(match[2]) <= MAPPING_LIMITS.rows, 'The mapping exceeds 50 columns or 10,000 rows.')
        }
      }
      limit(columns <= MAPPING_LIMITS.columns && cells <= MAPPING_LIMITS.cells, 'The mapping exceeds 50 columns or 200,000 cells.')
    }
  })
  parser.on('closetag', () => { depth-- })
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close()
  return maxRow * maxColumn
}

function boundedWorkbook(bytes: Uint8Array): Uint8Array {
  const files: Record<string, Uint8Array> = Object.create(null)
  let count = 0, expanded = 0, completed = 0, worksheets = 0, denseCells = 0
  let failure: Error | undefined
  const unzip = new Unzip(file => {
    limit(++count <= MAPPING_LIMITS.entries, 'The workbook contains too many ZIP entries.')
    limit(file.name.length <= 256 && !/(?:^\/|\\|(?:^|\/)\.\.(?:\/|$)|[\p{Cc}])/u.test(file.name) && !Object.hasOwn(files, file.name),
      'The workbook contains invalid or duplicate ZIP entries.')
    limit(file.compression === 0 || file.compression === 8, 'The workbook uses unsupported ZIP compression or encryption.')
    limit(file.originalSize === undefined || file.originalSize <= MAPPING_LIMITS.expandedBytes, 'The expanded workbook exceeds 16 MiB.')
    limit(!/(?:vbaProject|externalLinks\/|activeX\/|embeddings\/)/i.test(file.name), 'Macro-enabled workbooks, embedded objects and external workbook links are not supported.')
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(file.name)) {
      limit(++worksheets <= MAPPING_LIMITS.sheets, 'The workbook exceeds 20 worksheets.')
    }
    files[file.name] = new Uint8Array()
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (failure) return
      try {
        if (error) throw new MappingInputError('The mapping workbook ZIP data is invalid or encrypted.')
        expanded += chunk.byteLength; size += chunk.byteLength
        limit(expanded <= MAPPING_LIMITS.expandedBytes, 'The expanded workbook exceeds 16 MiB.')
        chunks.push(chunk)
        if (!final) return
        const output = new Uint8Array(size)
        let offset = 0
        for (const part of chunks) { output.set(part, offset); offset += part.byteLength }
        if (file.name.endsWith('.xml') || file.name.endsWith('.rels')) {
          denseCells += inspectXml(file.name, output)
          limit(denseCells <= MAPPING_LIMITS.cells, 'The workbook exceeds 200,000 cells, including gaps between populated cells.')
        }
        files[file.name] = output
        completed++
      } catch (caught) {
        // fflate catches exceptions from data callbacks as inflate errors; rethrow outside it.
        failure = caught instanceof Error ? caught : new MappingInputError('The mapping workbook is invalid.')
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // Small compressed chunks bound each inflater allocation before the expanded-byte check.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
    if (failure) throw failure
  }
  limit(count > 0 && completed === count && worksheets > 0 && Object.hasOwn(files, 'xl/workbook.xml'), 'The file is not a complete, supported XLSX workbook.')
  // The spreadsheet reader receives only the already bounded, uncompressed archive.
  return zipSync(files, { level: 0 })
}

export async function parseMappingFile(name: string, buffer: ArrayBuffer): Promise<MappingWorkbook> {
  limit(buffer.byteLength > 0 && buffer.byteLength <= MAPPING_LIMITS.fileBytes, 'Choose a nonempty mapping file no larger than 5 MiB.')
  if (/\.csv$/i.test(name)) return parseMappingCsv(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  limit(/\.xlsx$/i.test(name), 'Choose an Excel .xlsx workbook or UTF-8 .csv file. Legacy .xls files are not supported.')
  const safe = boundedWorkbook(new Uint8Array(buffer))
  const sheets = await readXlsxFile(Uint8Array.from(safe).buffer, { trim: false })
  let totalCells = 0
  limit(sheets.length > 0 && sheets.length <= MAPPING_LIMITS.sheets, 'Choose a workbook with 1 to 20 worksheets.')
  return { sheets: sheets.map(sheet => {
    limit(sheet.data.length <= MAPPING_LIMITS.rows, 'The mapping exceeds 10,000 rows.')
    return { name: cell(sheet.sheet), rows: sheet.data.map(row => {
      totalCells += row.length
      limit(row.length <= MAPPING_LIMITS.columns && totalCells <= MAPPING_LIMITS.cells, 'The workbook exceeds 50 columns or 200,000 cells.')
      return row.map((value): MappingCell => value === null ? null : typeof value === 'string' ? cell(value) : { unsupported: true })
    }) }
  }) }
}
