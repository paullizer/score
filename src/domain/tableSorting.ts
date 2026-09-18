export type SortDirection = 'asc' | 'desc'

export interface TableSort<Key extends string> {
  key: Key
  direction: SortDirection
}

export type SortValue = string | number | null | undefined

const textCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function toggleTableSort<Key extends string>(
  sort: TableSort<Key> | null, key: Key, initialDirection: SortDirection = 'asc',
): TableSort<Key> {
  return { key, direction: sort?.key === key ? (sort.direction === 'asc' ? 'desc' : 'asc') : initialDirection }
}

function isMissing(value: SortValue): boolean {
  return value == null || (typeof value === 'string' ? value.trim() === '' : !Number.isFinite(value))
}

export function sortTableRows<Row, Key extends string>(
  rows: readonly Row[], sort: TableSort<Key> | null, getValue: (row: Row, key: Key) => SortValue,
): Row[] {
  if (sort === null) return [...rows]
  const direction = sort.direction === 'asc' ? 1 : -1
  return rows.map((row, index) => ({ row, index, value: getValue(row, sort.key) }))
    .sort((left, right) => {
      const leftMissing = isMissing(left.value)
      const rightMissing = isMissing(right.value)
      if (leftMissing || rightMissing) return leftMissing === rightMissing ? left.index - right.index : leftMissing ? 1 : -1
      const comparison = typeof left.value === 'number' && typeof right.value === 'number'
        ? left.value - right.value
        : textCollator.compare(String(left.value), String(right.value))
      return comparison * direction || left.index - right.index
    })
    .map(({ row }) => row)
}

export function matchesTableSearch(query: string, values: readonly (string | null | undefined)[]): boolean {
  const search = query.trim().toLowerCase()
  return search === '' || values.some((value) => value?.toLowerCase().includes(search))
}
