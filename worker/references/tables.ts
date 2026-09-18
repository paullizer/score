import { normalizeText, WorkerError } from '../runtime'

export interface ReferenceCell {
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  text: string
  columnHeader: boolean
  page?: number
}

export interface ReferenceTableRow {
  text: string
  headers: string[]
  row: number
  page?: number
}

export function referenceTableRows(cells: ReferenceCell[], rowCount: number, columnCount: number): ReferenceTableRow[] {
  if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(columnCount) || rowCount < 1 || rowCount > 20_000 ||
    columnCount < 1 || columnCount > 200 || rowCount * columnCount > 100_000) {
    throw new WorkerError('reference-table-budget', 'The reference table exceeds the supported structural budget; select a smaller section.', false, 'parsing')
  }
  const grid: Array<Array<ReferenceCell | undefined>> = Array.from({ length: rowCount }, () => Array(columnCount))
  for (const cell of cells) {
    if (![cell.row, cell.column, cell.rowSpan, cell.columnSpan].every(Number.isSafeInteger) || cell.row < 0 || cell.column < 0 ||
      cell.rowSpan < 1 || cell.columnSpan < 1 || cell.row + cell.rowSpan > rowCount || cell.column + cell.columnSpan > columnCount) {
      throw new WorkerError('reference-table-invalid', 'The reference table contains invalid row or column spans.', false, 'parsing')
    }
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
        if (grid[row][column]) throw new WorkerError('reference-table-invalid', 'The reference table contains overlapping cells.', false, 'parsing')
        grid[row][column] = cell
      }
    }
  }
  const headers: string[][] = Array.from({ length: columnCount }, () => [])
  return grid.map((values, row) => {
    const unique = [...new Set(values.filter((cell): cell is ReferenceCell => !!cell))]
    const isHeader = unique.length > 0 && unique.every(cell => cell.columnHeader)
    if (isHeader) {
      values.forEach((cell, column) => {
        if (cell?.text && !headers[column].includes(cell.text)) headers[column].push(cell.text)
      })
    }
    const labels = headers.map(values => values.join(' / '))
    const text = unique.map(cell => {
      const label = !isHeader ? [...new Set(labels.slice(cell.column, cell.column + cell.columnSpan).filter(Boolean))].join(' / ') : ''
      const span = [
        cell.columnSpan > 1 ? `columns ${cell.column + 1}-${cell.column + cell.columnSpan}` : '',
        cell.rowSpan > 1 ? `rows ${cell.row + 1}-${cell.row + cell.rowSpan}` : '',
      ].filter(Boolean).join(', ')
      return `${label ? `${label}: ` : ''}${normalizeText(cell.text)}${span ? ` [${span}]` : ''}`
    }).join(' | ')
    return { text, headers: [...labels], row: row + 1, page: (unique.find(cell => cell.row === row && cell.page !== undefined) ?? unique.find(cell => cell.page !== undefined))?.page }
  }).filter(row => /[\p{L}\p{N}]/u.test(row.text))
}
