import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { Archive, ArchiveRestore, LoaderCircle, LockKeyhole, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { getEntityLifecycle, isEntityArchived, type ArchiveFilter, type LifecycleAction, type LifecycleImpact, type LifecycleTarget } from '../../domain/lifecycle'
import { LifecycleOperationError } from '../../services/cloudWorkspace'
import { Badge, Button, InlineError, Modal } from '../ui'
import { useLifecycleAccess } from './useLifecycleAccess'

export function ArchiveStateFilter({ value, onChange, label = 'Archive state' }: {
  value: ArchiveFilter; onChange: (value: ArchiveFilter) => void; label?: string
}) {
  return <select className="filter-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as ArchiveFilter)}>
    <option value="default">Active · search includes archived</option>
    <option value="active">Active only</option>
    <option value="archived">Archived only</option>
    <option value="all">Active and archived</option>
  </select>
}

export function ArchivedBadge({ target }: { target: LifecycleTarget }) {
  const { workspace } = useWorkspace()
  return isEntityArchived(workspace, target) ? <Badge tone="warning">Archived</Badge> : null
}

export function LifecycleOperationBanner() {
  const { lifecycleOperations = [], changeLifecycle, cloud } = useWorkspace()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const canManage = !cloud || cloud.workspaces.some((item) => item.id === cloud.currentWorkspaceId && item.role !== 'viewer' && !item.deletedAt)
  if (!lifecycleOperations.length) return null
  return <section className="lifecycle-operation-list" aria-label="Incomplete lifecycle operations">
    {lifecycleOperations.map((item) => <div className="lifecycle-banner" role="status" key={`${item.target.kind}:${item.target.id}`}>
      <div className="min-w-0 flex-1"><strong>{item.name} · {item.operation.action} {item.operation.status}</strong><p>{item.operation.error ?? 'The last response reports incomplete cleanup. Retry to check current state and resume. The item stays locked until completion.'}</p></div>
      {canManage && <Button size="sm" disabled={busy !== null} onClick={() => {
        setBusy(item.operation.id); setError('')
        void Promise.resolve().then(() => changeLifecycle(item.target, item.operation.action)).catch((caught) => setError(caught instanceof Error ? caught.message : 'Cleanup is still incomplete.')).finally(() => setBusy(null))
      }}>{busy === item.operation.id ? 'Awaiting acknowledgement…' : 'Retry lifecycle operation'}</Button>}
    </div>)}
    {error && <InlineError>{error}</InlineError>}
  </section>
}

export function LifecycleBanner({ target }: { target?: LifecycleTarget }) {
  const { cloud } = useWorkspace()
  const actual = target ?? { kind: 'workspace', id: cloud?.currentWorkspaceId ?? 'workspace' } as LifecycleTarget
  const { archived, inherited, deleting, removed, syncing, canEdit, transitioning } = useLifecycleAccess(actual)
  if (canEdit) return null
  return <div className="lifecycle-banner" role="status"><LockKeyhole size={17} aria-hidden="true" /><div>
    <strong>{transitioning ? 'Lifecycle operation incomplete · read only' : deleting ? 'Deletion pending · read only' : removed ? 'Removed · read only' : archived ? 'Archived · read only' : syncing ? 'Refreshing saved content · read only' : 'Viewer access · read only'}</strong>
    <p>{transitioning ? 'Changes and new processing are paused until the lifecycle operation finishes. Use the recovery controls above, or My workspaces for a workspace operation, to check status or retry.'
      : deleting ? 'Cleanup has not completed. Retry the lifecycle operation above; ordinary changes and unarchive remain locked until it finishes.'
        : removed ? 'This item was removed or is no longer available. Any unsaved draft remains in this tab, but cannot restore a deleted record.'
      : archived ? `${inherited ? 'This item inherits its parent’s archive state. ' : ''}You can read retained content and manage its lifecycle, but cannot edit or start new processing. Unarchiving does not restart cancelled work.`
        : syncing ? 'Fetching the authoritative sample state and save version. Unsaved real-grade drafts remain in this tab.'
        : 'You can search and inspect active and archived content. An owner or editor must make changes.'}</p>
  </div></div>
}

interface LifecycleActionsProps {
  target: LifecycleTarget
  name: string
  archived: boolean
  ownArchived?: boolean
  inherited?: boolean
  canManage: boolean
  compact?: boolean
  restoreOnly?: boolean
  getImpact: () => LifecycleImpact | Promise<LifecycleImpact>
  change: (action: LifecycleAction) => void | Promise<void>
  onComplete?: (action: LifecycleAction) => void
  navigateBlocker?: (href: string) => Promise<void>
}

type LifecycleRequest = LifecycleActionsProps & { action: LifecycleAction; requestId: string }
const LifecycleDialogContext = createContext<((request: LifecycleRequest) => void) | null>(null)

export function LifecycleDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<LifecycleRequest | null>(null)
  return <LifecycleDialogContext.Provider value={setRequest}>{children}
    {request && <LifecycleConfirmation key={request.requestId} {...request} initialAction={request.action} onDismiss={() => setRequest(null)} />}
  </LifecycleDialogContext.Provider>
}

export function LifecycleActions(props: LifecycleActionsProps) {
  const launch = useContext(LifecycleDialogContext)
  const [local, setLocal] = useState<LifecycleAction | null>(null)
  const { name, compact, archived, ownArchived = archived, canManage, restoreOnly = false } = props
  if (!canManage || (restoreOnly && !ownArchived)) return null
  const open = (action: LifecycleAction) => {
    if (launch) launch({ ...props, action, requestId: crypto.randomUUID() })
    else setLocal(action)
  }
  return <div className="lifecycle-actions" aria-label={`Lifecycle actions for ${name}`}>
    <Button size="sm" variant="ghost" className={compact ? 'icon-button' : undefined} icon={ownArchived ? ArchiveRestore : Archive}
      aria-label={`${ownArchived ? 'Unarchive' : 'Archive'} ${name}`} title={!ownArchived && archived ? 'Archive separately; restoring the parent will leave this item archived.' : undefined}
      onClick={() => open(ownArchived ? 'unarchive' : 'archive')}>{!compact && (ownArchived ? 'Unarchive' : 'Archive')}</Button>
    {!restoreOnly && <Button size="sm" variant="ghost" className={compact ? 'icon-button' : undefined} icon={Trash2} aria-label={`Permanently delete ${name}`} onClick={() => open('delete')}>{!compact && 'Delete'}</Button>}
    {local && <LifecycleConfirmation {...props} initialAction={local} onDismiss={() => setLocal(null)} />}
  </div>
}

function LifecycleConfirmation({ target, name, inherited, restoreOnly, getImpact, change, onComplete, navigateBlocker, initialAction, onDismiss }: LifecycleActionsProps & { initialAction: LifecycleAction; onDismiss: () => void }) {
  const [action, setAction] = useState<LifecycleAction | null>(null)
  const [impact, setImpact] = useState<LifecycleImpact | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [incomplete, setIncomplete] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const live = useRef(true)
  const request = useRef(0)
  const inFlight = useRef(false)
  const inRouter = useInRouterContext()
  useEffect(() => {
    live.current = true
    void preview(initialAction)
    return () => { live.current = false }
    // A request holds its exact target and callbacks until acknowledged or dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function preview(next: LifecycleAction) {
    const sequence = ++request.current
    setAction(next); setImpact(null); setError(''); setConfirmed(false); setIncomplete(false); setLoading(true)
    try {
      const result = await getImpact()
      if (live.current && sequence === request.current) setImpact(result)
    } catch (caught) {
      if (live.current && sequence === request.current) setError(caught instanceof Error ? caught.message : 'The deletion impact could not be checked.')
    } finally { if (live.current && sequence === request.current) setLoading(false) }
  }

  async function submit() {
    if (!action || inFlight.current || (!incomplete && (!impact || (action === 'delete' && (!confirmed || impact.blockers.length))))) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      await change(action)
      if (!live.current) return
      setAction(null)
      onComplete?.(action)
      onDismiss()
    } catch (caught) {
      if (!live.current) return
      setError(caught instanceof Error ? caught.message : 'The lifecycle change was not acknowledged. Retry without leaving this tab.')
      setIncomplete(caught instanceof LifecycleOperationError)
      if (!(caught instanceof LifecycleOperationError)) {
        try { const fresh = await getImpact(); if (live.current) setImpact(fresh) } catch (refreshError) {
          console.warn('Score could not refresh lifecycle impact after a failed change.', {
            kind: target.kind, error: refreshError instanceof Error ? refreshError.name : 'UnknownError',
          })
          if (live.current) setImpact(null)
        }
      }
    } finally { inFlight.current = false; if (live.current) setBusy(false) }
  }

  const verb = action === 'delete' ? 'Permanently delete' : action === 'archive' ? 'Archive' : 'Unarchive'
  return <Modal open={action !== null} onOpenChange={(open) => { if (!open && !busy) { request.current++; setAction(null); onDismiss() } }}
      title={`${verb} ${name}?`}
      description={action === 'delete' ? 'Permanent deletion cannot be undone. Retained analyses and seed ladders, including archived records, are never deleted implicitly.'
        : action === 'archive' ? 'Hide this item from normal browsing and stop unfinished work it owns. Completed results and independent snapshots are preserved.'
          : restoreOnly ? 'Unarchive only the empty grade slot. Its rubric and history stay permanently deleted. Nothing restarts; explicitly generate a fresh revision after its parents are active.'
          : 'Make this item available again. Separately archived children stay archived. Cancelled work does not restart automatically.'}
      footer={<><Button disabled={busy} onClick={() => { request.current++; setAction(null); onDismiss() }}>{incomplete ? 'Close — operation remains pending' : 'Cancel'}</Button>
        <Button variant={action === 'delete' ? 'danger' : 'primary'} icon={busy ? LoaderCircle : action === 'delete' ? Trash2 : action === 'archive' ? Archive : ArchiveRestore}
          disabled={busy || loading || (!incomplete && (!impact || (action === 'delete' && (!confirmed || impact.blockers.length > 0))))} onClick={() => void submit()}>
          {busy ? 'Awaiting acknowledgement…' : incomplete ? 'Retry operation' : verb}
        </Button></>}>
      {loading && <p role="status">Checking owned content and all retained dependencies…</p>}
      {impact && <>
        <p><strong>{impact.name}</strong> · {target.kind}</p>
        <dl className="lifecycle-counts">{Object.entries(impact.counts).filter(([, count]) => count > 0).map(([label, count]) => <div key={label}><dt>{label.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</dt><dd>{count}</dd></div>)}</dl>
        {action === 'delete' && impact.blockers.length > 0 && <div className="lifecycle-blockers">
          <InlineError>Delete is blocked by {impact.blockers.length} retained {impact.blockers.length === 1 ? 'dependency' : 'dependencies'}. Delete these records explicitly first, including any archived records.</InlineError>
          <ul>{impact.blockers.map((blocker) => <li key={`${blocker.kind}:${blocker.id}`}>{navigateBlocker
            ? <a className="text-link" href={blocker.href} aria-disabled={busy} onClick={(event) => {
              event.preventDefault()
              if (busy) return
              setBusy(true); setError('')
              void navigateBlocker(blocker.href).then(onDismiss).catch((caught) => { if (live.current) setError(caught instanceof Error ? caught.message : 'Opening the related record was stopped to preserve your changes.') }).finally(() => { if (live.current) setBusy(false) })
            }}>{blocker.name}</a>
            : inRouter && !blocker.href.startsWith('/workspaces/')
            ? <Link className="text-link" to={blocker.href} onClick={() => { setAction(null); onDismiss() }}>{blocker.name}</Link>
            : <a className="text-link" href={blocker.href} onClick={() => { setAction(null); onDismiss() }}>{blocker.name}</a>} <Badge>{blocker.kind}</Badge></li>)}</ul>
        </div>}
        {action === 'delete' && !impact.blockers.length && <label className="check-label lifecycle-confirmation"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I understand that {impact.name} and its owned content will be permanently deleted.</label>}
        {action === 'unarchive' && inherited && <p>This changes only the item’s own archive flag. Its parent is still archived, so this content remains read-only until that parent is restored.</p>}
      </>}
      {error && <InlineError>{error}{!impact && !loading && action && <Button size="sm" onClick={() => void preview(action)}>Retry impact check</Button>}</InlineError>}
      {busy && <p role="status" className="text-muted">Keep this dialog open until the service acknowledges the change.</p>}
    </Modal>
}

export function EntityLifecycleActions({ target, name, compact, onComplete, restoreOnly = false }: Pick<LifecycleActionsProps, 'target' | 'name' | 'compact' | 'onComplete' | 'restoreOnly'>) {
  const { workspace, getLifecycleImpact, changeLifecycle } = useWorkspace()
  const { canManage, archived, inherited, canRestoreEmptyGrade } = useLifecycleAccess(target)
  const ownArchived = target.kind === 'workspace' ? Boolean(workspace.lifecycle?.archivedAt) : Boolean(getEntityLifecycle(workspace, target)?.archivedAt)
  return <LifecycleActions target={target} name={name} archived={archived} ownArchived={ownArchived} inherited={inherited}
    canManage={restoreOnly ? canRestoreEmptyGrade : canManage} compact={compact} restoreOnly={restoreOnly}
    getImpact={() => getLifecycleImpact(target)} change={(action) => changeLifecycle(target, action)} onComplete={onComplete} />
}
