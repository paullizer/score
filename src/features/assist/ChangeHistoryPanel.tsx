import { Badge, Button } from '../../components/ui'
import type { DraftChange, HistoryEntry } from './types'

export interface SavedAssistVersion {
  id: string
  label: string
  detail: string
  note: string
  opened: boolean
  latest: boolean
}

export interface ChangeHistoryPanelProps {
  changes: DraftChange[]
  onJump: (key: string) => void
  onRevert: (key: string) => void
  entries: readonly HistoryEntry<unknown>[]
  cursor: number
  evictedEntries: number
  onRestore: (entryId: string | 'baseline') => void
  savedVersions?: SavedAssistVersion[]
  previewingVersionId?: string | null
  onPreviewVersion?: (id: string) => void
  onUseVersion?: (id: string) => void
  disabled?: boolean
}

function authorLabel(author: 'ai' | 'user') {
  return author === 'ai' ? 'AI assist' : 'You'
}

function originLabel(origin: 'ai' | 'user' | 'restore') {
  if (origin === 'ai') return 'AI assist'
  if (origin === 'restore') return 'Restored'
  return 'You'
}

function groupedChanges(changes: DraftChange[]): [string, DraftChange[]][] {
  const groups = new Map<string, DraftChange[]>()
  for (const change of changes) {
    const group = groups.get(change.groupLabel) ?? []
    group.push(change)
    groups.set(change.groupLabel, group)
  }
  return [...groups.entries()]
}

function changeText(change: DraftChange) {
  if (change.kind === 'added') return <p><span>Added</span> → <strong>{change.after ?? change.label}</strong></p>
  if (change.kind === 'removed') return <p><span>{change.before ?? change.label}</span> → <strong>Removed</strong></p>
  return <p><span>{change.before?.trim() || 'Empty'}</span> → <strong>{change.after?.trim() || 'Empty'}</strong></p>
}

export function ChangeHistoryPanel({
  changes,
  onJump,
  onRevert,
  entries,
  cursor,
  evictedEntries,
  onRestore,
  savedVersions,
  previewingVersionId,
  onPreviewVersion,
  onUseVersion,
  disabled = false,
}: ChangeHistoryPanelProps) {
  const newestEntries = [...entries].reverse()
  return <div className="change-history-panel">
    <section>
      <h3>Unsaved changes ({changes.length})</h3>
      {changes.length === 0 ? <p className="assist-muted">No unsaved changes.</p> : groupedChanges(changes).map(([group, groupChanges]) => <div className="history-change-group" key={group}>
        <h4>{group}</h4>
        <ul>{groupChanges.map(change => <li key={change.key}>
          <div className="history-change-main">
            <Badge tone="neutral">{authorLabel(change.author)}</Badge>
            <strong>{change.label}</strong>
            {changeText(change)}
          </div>
          <div className="history-row-actions">
            <Button size="sm" variant="ghost" onClick={() => onJump(change.key)} aria-label={`Jump to ${change.label} · ${change.groupLabel}`}>Jump</Button>
            <Button size="sm" variant="ghost" onClick={() => onRevert(change.key)} disabled={disabled} aria-label={`Revert ${change.label} · ${change.groupLabel}`}>Revert</Button>
          </div>
        </li>)}</ul>
      </div>)}
    </section>
    <section>
      <h3>This session</h3>
      {evictedEntries > 0 && <p className="history-eviction">Older steps were removed to stay within 100 steps. Your current draft is unchanged.</p>}
      <p className="assist-muted">Restore to here is non-destructive: it moves the draft to that point and records a new session step.</p>
      <ol className="session-history-list">
        {newestEntries.map((entry, reverseIndex) => {
          const entryIndex = entries.length - 1 - reverseIndex
          const current = entryIndex === cursor
          return <li key={entry.id} className={current ? 'is-current' : ''}>
            <div>
              <Badge tone="neutral">{originLabel(entry.origin)}</Badge>
              {current && <Badge tone="accent">Current</Badge>}
              <strong>{entry.note}</strong>
              <time>{new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onRestore(entry.id)} disabled={disabled || current} aria-label={`Restore to here: ${entry.note}`}>Restore to here</Button>
          </li>
        })}
        <li className={cursor === -1 ? 'is-current' : ''}>
          <div><Badge tone="neutral">Opened version</Badge>{cursor === -1 && <Badge tone="accent">Current</Badge>}<strong>Opened version</strong></div>
          <Button size="sm" variant="ghost" onClick={() => onRestore('baseline')} disabled={disabled || cursor === -1} aria-label="Restore to here: opened version">Restore to here</Button>
        </li>
      </ol>
    </section>
    {savedVersions && <section>
      <h3>Saved versions</h3>
      <ul className="saved-version-list">{savedVersions.map(version => <li key={version.id} className={previewingVersionId === version.id ? 'is-previewing' : ''}>
        <div>
          <strong>{version.label}</strong>
          <p>{version.detail}</p>
          <p>{version.note}</p>
          <div className="saved-version-badges">{version.opened && <Badge tone="neutral">Opened</Badge>}{version.latest && <Badge tone="accent">Latest</Badge>}{previewingVersionId === version.id && <Badge tone="success">Previewing</Badge>}</div>
        </div>
        <div className="history-row-actions">
          {onPreviewVersion && <Button size="sm" variant="ghost" onClick={() => onPreviewVersion(version.id)} disabled={disabled} aria-label={`Preview ${version.label}`}>Preview</Button>}
          {onUseVersion && <Button size="sm" variant="ghost" onClick={() => onUseVersion(version.id)} disabled={disabled} aria-label={`Use ${version.label} as starting point`}>Use as starting point</Button>}
        </div>
      </li>)}</ul>
    </section>}
  </div>
}
