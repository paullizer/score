import { useMemo, useState, useId, type ReactNode } from 'react'
import { PenLine, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '../../components/ui'
import type { ChangeAuthor } from './types'

type ChangedFieldChildren = ReactNode | ((describedBy: string | undefined) => ReactNode)

export interface ChangedFieldProps {
  highlight: ChangeAuthor | null
  fieldLabel: string
  previous?: string
  onRevert?: () => void
  revertDisabled?: boolean
  /** The field belongs to a newly added item: there is no previous value to show or revert to. */
  isNew?: boolean
  children: ChangedFieldChildren
}

function authorText(author: ChangeAuthor): string {
  return author === 'ai' ? 'AI assist' : 'Edited'
}

function byline(author: ChangeAuthor): string {
  return author === 'ai' ? 'by AI assist' : 'by you'
}

function displayPrevious(previous: string | undefined): string {
  const value = previous?.trim() ?? ''
  return value.length > 0 ? value : 'Empty'
}

function renderChildren(children: ChangedFieldChildren, describedBy: string | undefined) {
  return typeof children === 'function' ? children(describedBy) : children
}

export function ChangedField({ highlight, fieldLabel, previous, onRevert, revertDisabled = false, isNew = false, children }: ChangedFieldProps) {
  const id = useId()
  if (!highlight) return <>{renderChildren(children, undefined)}</>
  const previousText = displayPrevious(previous)
  const showRevert = Boolean(onRevert) && !isNew
  return <div className={`changed-field is-${highlight}`}>
    <div className="changed-field-topline">
      <span className="change-author-badge">
        {highlight === 'ai' ? <Sparkles size={13} aria-hidden="true" /> : <PenLine size={13} aria-hidden="true" />}
        {authorText(highlight)}
      </span>
      {showRevert && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onRevert} disabled={revertDisabled} aria-label={`Revert ${fieldLabel}`}>Revert</Button>}
    </div>
    {renderChildren(children, id)}
    {!isNew && <details className="changed-previous">
      <summary>Previously: <span>{previousText}</span></summary>
      <p>{previousText}</p>
    </details>}
    <p id={id} className="assist-visually-hidden">{isNew ? `Added ${byline(highlight)}.` : `Changed ${byline(highlight)}. Previously: ${previousText}.`}</p>
  </div>
}

export interface RemovedItemRowProps {
  label: string
  detail?: string
  author: ChangeAuthor
  onRestore: () => void
  disabled?: boolean
}

export function RemovedItemRow({ label, detail, author, onRestore, disabled = false }: RemovedItemRowProps) {
  return <div className={`removed-item-row is-${author}`}>
    <div>
      <strong>Removed · {label} · {author === 'ai' ? 'by AI assist' : 'by you'}</strong>
      {detail && <p>{detail}</p>}
    </div>
    <Button size="sm" variant="ghost" onClick={onRestore} disabled={disabled} aria-label={`Restore ${label}`}>Restore</Button>
  </div>
}

export interface RemovedItemsGroupItem {
  id: string
  label: string
  detail?: string
  author: ChangeAuthor
}

export interface RemovedItemsGroupProps {
  items: RemovedItemsGroupItem[]
  onRestore: (id: string) => void
  onRestoreAll?: () => void
  disabled?: boolean
}

export function RemovedItemsGroup({ items, onRestore, onRestoreAll, disabled = false }: RemovedItemsGroupProps) {
  const [open, setOpen] = useState(items.length < 4)
  const aiCount = useMemo(() => items.filter(item => item.author === 'ai').length, [items])
  if (items.length === 0) return null
  return <div className="removed-items-group">
    <div className="removed-items-summary">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        {items.length.toLocaleString('en-US')} {items.length === 1 ? 'criterion' : 'criteria'} removed · {open ? 'Hide' : 'Show'}
      </button>
      <span>{aiCount.toLocaleString('en-US')} by AI assist</span>
      {onRestoreAll && <Button size="sm" variant="ghost" onClick={onRestoreAll} disabled={disabled}>Restore all</Button>}
    </div>
    {open && <div className="removed-items-list">
      {items.map(item => <RemovedItemRow key={item.id} label={item.label} detail={item.detail} author={item.author}
        onRestore={() => onRestore(item.id)} disabled={disabled} />)}
    </div>}
  </div>
}
