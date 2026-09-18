import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { toggleTableSort, type SortDirection, type TableSort } from '../../domain/tableSorting'

export interface TableSortOption<Key extends string> {
  key: Key
  label: string
  ascendingLabel: string
  descendingLabel: string
  initialDirection?: SortDirection
  disabled?: boolean
  title?: string
}

export interface SortableHeaderProps<Key extends string> {
  option: TableSortOption<Key>
  sort: TableSort<Key> | null
  onChange: (sort: TableSort<Key> | null) => void
  children?: ReactNode
  className?: string
  disabled?: boolean
  title?: string
}

export interface TableSortSelectProps<Key extends string> {
  options: readonly TableSortOption<Key>[]
  sort: TableSort<Key> | null
  onChange: (sort: TableSort<Key> | null) => void
  label?: string
  defaultLabel?: string
  className?: string
  disabled?: boolean
  title?: string
}

function directionLabel<Key extends string>(option: TableSortOption<Key>, direction: SortDirection): string {
  return direction === 'asc' ? option.ascendingLabel : option.descendingLabel
}

export function SortableHeader<Key extends string>({
  option, sort, onChange, children, className, disabled = false, title,
}: SortableHeaderProps<Key>) {
  const active = sort?.key === option.key
  const nextSort = toggleTableSort(sort, option.key, option.initialDirection)
  const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return <th scope="col" className={className} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
    <button type="button" className="table-sort-button" disabled={disabled || option.disabled} title={title ?? option.title}
      aria-label={`Sort ${option.label}: ${directionLabel(option, nextSort.direction)}`} onClick={() => onChange(nextSort)}>
      {children ?? option.label}<Icon size={12} aria-hidden="true" focusable="false" />
    </button>
  </th>
}

export function TableSortSelect<Key extends string>({
  options, sort, onChange, label = 'Sort by', defaultLabel = 'Default order', className = '', disabled = false, title,
}: TableSortSelectProps<Key>) {
  const choices = options.flatMap((option, index) => (['asc', 'desc'] as const).map((direction) => ({
    option, direction, value: `${index}:${direction}`,
  })))
  const selected = choices.find(({ option, direction }) => option.key === sort?.key && direction === sort.direction)
  return <label className={`table-sort-select ${className}`}>
    <span>{label}</span>
    <select className="filter-select" aria-label={label} value={selected?.value ?? ''} disabled={disabled} title={title}
      onChange={(event) => {
        const choice = choices.find(({ value }) => value === event.target.value)
        if (!choice?.option.disabled) onChange(choice ? { key: choice.option.key, direction: choice.direction } : null)
      }}>
      <option value="">{defaultLabel}</option>
      {choices.map(({ option, direction, value }) => <option key={value} value={value} disabled={option.disabled} title={option.title}>
        {option.label}: {directionLabel(option, direction)}
      </option>)}
    </select>
  </label>
}
