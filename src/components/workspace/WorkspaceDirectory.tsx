import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, Loader2, Pencil, Plus, RefreshCw, Users } from 'lucide-react'
import type { CloudWorkspaceStatus } from '../../app/workspace-context'
import type { WorkspaceSummary } from '../../domain/cloud'
import { Badge, Button, EmptyState, InlineError, Modal, SearchField } from '../ui'
import { matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchiveStateFilter, LifecycleActions } from '../lifecycle/LifecycleControls'
import { usePublicSettings } from '../../app/public-settings-context'
import { workspaceRoleLabel } from '../../domain/access'
import { ManageWorkspaceAccess } from './ManageWorkspaceAccess'

export type WorkspaceDirectoryActions = Pick<CloudWorkspaceStatus, 'workspaces' | 'currentWorkspaceId' | 'canCreateWorkspaces' | 'switchWorkspace' | 'createWorkspace' | 'renameWorkspace' | 'refreshWorkspaces' | 'getWorkspaceLifecycleImpact' | 'changeWorkspaceLifecycle'>

function useCreationReason(canCreateWorkspaces: boolean) {
  const policy = usePublicSettings()
  return !canCreateWorkspaces ? 'Ask an application administrator for permission to create workspaces. Existing ownership does not grant creation permission.'
    : policy.cloud && policy.phase !== 'ready' ? policy.error ?? 'Checking current application policy before enabling workspace creation.'
      : policy.settings?.workspaces.allowCreation === false ? 'Creating new workspaces is disabled by application policy, including for application administrators.' : null
}

export function WorkspaceDirectory({ cloud, initialFilter = 'default', cards = false, disabled = false, showCreate = true,
  onSelected, onBusyChange, onVisibleChange, renderDetails,
}: {
  cloud: WorkspaceDirectoryActions
  initialFilter?: ArchiveFilter
  cards?: boolean
  disabled?: boolean
  showCreate?: boolean
  onSelected?: () => void
  onBusyChange?: (busy: boolean) => void
  onVisibleChange?: (ids: string[]) => void
  renderDetails?: (workspace: WorkspaceSummary) => ReactNode
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [managingId, setManagingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArchiveFilter>(initialFilter)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const busy = disabled || busyId !== null || creating || managingId !== null
  const creationReason = useCreationReason(cloud.canCreateWorkspaces === true)
  const hasWorkspaces = cloud.workspaces.some(item => !item.deletedAt)
  const visible = useMemo(() => cloud.workspaces.filter((item) => !item.deletedAt &&
    ((item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (matchesArchiveFilter(Boolean(item.archivedAt), query, filter) || (item.lifecycleOperation && item.lifecycleOperation.status !== 'complete'))) ||
      item.id === renamingId)), [cloud.workspaces, filter, query, renamingId])
  useEffect(() => {
    alive.current = true
    if (!cards) void cloud.refreshWorkspaces().catch((caught) => {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The workspace list could not be refreshed.')
    })
    return () => { alive.current = false }
    // The home refreshes through its cloud gate; an opened switcher refreshes once here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { onVisibleChange?.(visible.map((item) => item.id)) }, [onVisibleChange, visible])
  useEffect(() => {
    onBusyChange?.(busyId !== null || creating || managingId !== null)
    return () => onBusyChange?.(false)
  }, [busyId, creating, managingId, onBusyChange])

  async function run(id: string, action: () => Promise<void>) {
    if (inFlight.current || busy) return
    inFlight.current = true; setBusyId(id); setError('')
    try { await action() } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The workspace action could not be completed. Try again.')
    } finally {
      inFlight.current = false
      if (alive.current) setBusyId(null)
    }
  }

  async function handleSwitch(id: string) {
    await run(id, async () => {
      const result = await cloud.switchWorkspace(id)
      if (!result.ok) throw new Error(result.message)
      onSelected?.()
    })
  }

  async function handleRename(id: string) {
    await run(id, async () => {
      const result = await cloud.renameWorkspace(id, renameValue)
      if (!result.ok) throw new Error(result.message)
      if (alive.current) setRenamingId(null)
    })
  }

  return <section className="workspace-directory" aria-label="Workspace directory">
      {error && <div className="mb-4"><InlineError>{error}</InlineError></div>}
      <div className="toolbar mb-4"><SearchField value={query} onChange={setQuery} placeholder="Search workspaces…" label="Search workspaces" /><ArchiveStateFilter value={filter} onChange={setFilter} label="Workspace archive state" />
        {!cards && <Button size="sm" icon={RefreshCw} disabled={busy} onClick={() => void run('__refresh__', cloud.refreshWorkspaces)}>Refresh access</Button>}
      </div>
      <p className="mb-4 text-[11px] text-muted">{cards && 'Counts include active work only. '}Owners and application administrators can rename workspaces and manage access. Search includes archived workspaces; open them read-only. Ask an owner for access to another workspace.</p>
      <ul className={cards ? 'workspace-home-grid' : 'workspace-switcher-list'}>
        {visible.map((item) => {
          const isCurrent = item.id === cloud.currentWorkspaceId
          const isRenaming = renamingId === item.id
          const isBusy = busyId === item.id
          const incomplete = item.lifecycleOperation && item.lifecycleOperation.status !== 'complete'
          return <li key={item.id} className={`${cards ? 'workspace-home-card' : 'workspace-switcher-item'} ${isCurrent ? 'is-current' : ''}`}>
            {cards && <div className="workspace-card-heading"><span className="workspace-monogram" aria-hidden="true">{item.name.trim().slice(0, 1).toUpperCase()}</span><Badge>{workspaceRoleLabel(item.role)}</Badge>
              {item.accessSource === 'application-admin' && <Badge tone="accent">Application administrator</Badge>}</div>}
            {isRenaming ? <form className="workspace-switcher-rename" onSubmit={(event) => { event.preventDefault(); void handleRename(item.id) }}>
              <input className="input" autoFocus value={renameValue} maxLength={80} disabled={busy} onChange={(event) => setRenameValue(event.target.value)} aria-label={`Rename ${item.name}`} />
              <Button size="sm" type="submit" variant="primary" icon={isBusy ? Loader2 : Check} disabled={busy || item.role !== 'owner' || !renameValue.trim() || Boolean(item.archivedAt) || Boolean(incomplete)}>Save</Button>
              <Button size="sm" type="button" onClick={() => setRenamingId(null)} disabled={busy}>Cancel</Button>
            </form> : <>
              <button type="button" className={cards ? 'workspace-card-open' : 'workspace-switcher-name'} onClick={() => void handleSwitch(item.id)} disabled={busy} aria-current={isCurrent ? 'true' : undefined} aria-label={item.name}>
                {isBusy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : isCurrent ? <Check size={14} aria-hidden="true" /> : !cards && <span className="workspace-switcher-name-spacer" aria-hidden="true" />}
                <span>{item.name}</span>{cards && <ArrowUpRight size={18} aria-hidden="true" />}
              </button>
              {item.archivedAt && <Badge tone="warning">Archived{cards && ' · read only'}</Badge>}
              {!cards && <><Badge>{workspaceRoleLabel(item.role)}</Badge>{item.accessSource === 'application-admin' && <Badge tone="accent">Application administrator</Badge>}</>}
              {cards && renderDetails?.(item)}
              <fieldset className={cards ? 'workspace-card-actions' : 'workspace-row-actions'} disabled={busy}>
              {item.role === 'owner' && <Button size="sm" variant="ghost" icon={Users} aria-label={`Manage access to ${item.name}`} disabled={busy || Boolean(incomplete)}
                onClick={() => { setManagingId(item.id); setError('') }}>Manage access</Button>}
              {item.role === 'owner' && <Button size="sm" variant="ghost" className="icon-button" aria-label={`Rename ${item.name}`} icon={Pencil} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); setError('') }} disabled={busy || Boolean(item.archivedAt) || Boolean(incomplete)} />}
              <LifecycleActions target={{ kind: 'workspace', id: item.id }} name={item.name} archived={Boolean(item.archivedAt)} canManage={item.role === 'owner'} compact
                getImpact={() => cloud.getWorkspaceLifecycleImpact(item.id)}
                change={(action) => cloud.changeWorkspaceLifecycle(item.id, action)}
                navigateBlocker={async (href) => {
                  const switched = await cloud.switchWorkspace(item.id)
                  if (!switched.ok) throw new Error(switched.message)
                  window.location.assign(href)
                }} />
              </fieldset>
              {incomplete && <div className="workspace-operation" role="status"><Badge tone={item.lifecycleOperation?.status === 'failed' ? 'danger' : 'warning'}>{item.lifecycleOperation?.action} · {item.lifecycleOperation?.status}</Badge>
                <p>{item.lifecycleOperation?.error ?? 'This operation has not finished. Content remains read-only.'}</p>
                <Button size="sm" disabled={busy} onClick={() => void run(item.id, cloud.refreshWorkspaces)}>Refresh status</Button>
                {item.role === 'owner' && <Button size="sm" disabled={busy} onClick={() => void run(item.id, () => cloud.changeWorkspaceLifecycle(item.id, item.lifecycleOperation!.action))}>Retry operation</Button>}
              </div>}
            </>}
          </li>
        })}
      </ul>
      {!visible.length && <EmptyState title={query ? 'No matching workspaces' : !hasWorkspaces ? creationReason ? 'No workspaces are assigned' : 'Your first workspace starts here' : filter === 'archived' ? 'No archived workspaces' : 'No active workspaces'}
        description={query ? 'Try a different workspace name or change the archive filter.' : hasWorkspaces
          ? 'Change the archive filter or search. Owners and application administrators can restore archived workspaces.'
          : !creationReason ? 'Create a workspace to begin, or ask an owner to share an existing one. Nothing is created automatically.'
            : cloud.canCreateWorkspaces ? 'No workspaces are assigned. You have creation permission, but creation is paused until application policy allows it. Ask an owner to share an existing workspace, then refresh access.'
              : 'No workspaces are assigned to your account. Ask a workspace owner for access, or an application administrator for creation permission, then refresh access. Nothing is created automatically.'} />}
      {showCreate && <div className="mt-4"><WorkspaceCreateButton cloud={cloud} disabled={disabled || busyId !== null || managingId !== null} onBusyChange={setCreating} onCreated={onSelected} /></div>}
      {managingId && <ManageWorkspaceAccess key={managingId} workspaceId={managingId} workspace={cloud.workspaces.find(item => item.id === managingId)}
        onClose={() => setManagingId(null)} onAccessChanged={cloud.refreshWorkspaces} />}
  </section>
}

export function WorkspaceCreateButton({ cloud, disabled = false, onBusyChange, onCreated, primary = false }: {
  cloud: Pick<WorkspaceDirectoryActions, 'createWorkspace' | 'canCreateWorkspaces'>
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onCreated?: () => void
  primary?: boolean
}) {
  const reason = useCreationReason(cloud.canCreateWorkspaces === true)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)
  const formId = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])

  async function create() {
    if (inFlight.current || reason || disabled) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const result = await cloud.createWorkspace(name)
      if (!result.ok) throw new Error(result.message)
      if (alive.current) { setOpen(false); setName(''); onCreated?.() }
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The workspace could not be created. Your name has been kept; try again.')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return <>
    <Button ref={trigger} variant={primary ? 'primary' : 'secondary'} icon={Plus} disabled={disabled || busy || Boolean(reason)}
      title={reason ?? undefined} onClick={() => { setName(''); setError(''); setOpen(true) }}>New workspace</Button>
    {reason && <p className="mt-3 text-[11px] text-muted" role="status">{reason}</p>}
    <Modal open={open} onOpenChange={setOpen} dismissDisabled={busy} title="New workspace"
      description="Give this workspace a recognizable name. Its jobs, resumes, rubrics, and analyses stay separate from your other workspaces."
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus() }}
      footer={<><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" icon={busy ? Loader2 : Plus} disabled={busy || Boolean(reason) || !name.trim()}>{busy ? 'Creating…' : 'Create'}</Button></>}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void create() }}>
        <label className="field"><span className="field-label">Workspace name</span>
          <input className="input" autoFocus value={name} maxLength={80} disabled={busy} aria-label="New workspace name" onChange={(event) => setName(event.target.value)} /></label>
        <p className="mt-3 text-[11px] text-muted">Up to 80 characters. You can rename it later.</p>
        {error && <div className="mt-4"><InlineError>{error}</InlineError></div>}
        {reason && <InlineError>{reason}</InlineError>}
      </form>
    </Modal>
  </>
}
