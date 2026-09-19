import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, Loader2, Pencil, Plus, X } from 'lucide-react'
import type { CloudWorkspaceStatus } from '../../app/workspace-context'
import { Badge, Button, EmptyState, InlineError, Modal, SearchField } from '../ui'
import { matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchiveStateFilter, LifecycleActions } from '../lifecycle/LifecycleControls'

export type WorkspaceDirectoryActions = Pick<CloudWorkspaceStatus, 'workspaces' | 'currentWorkspaceId' | 'switchWorkspace' | 'createWorkspace' | 'renameWorkspace' | 'refreshWorkspaces' | 'getWorkspaceLifecycleImpact' | 'changeWorkspaceLifecycle'>

/**
 * The sidebar's "current workspace" label becomes this functional control: it opens a modal to
 * search, switch between, rename, create, and manage the signed-in user's workspaces. Group
 * workspaces are not offered yet (the API reserves `kind: 'group'`, but there is no group UI).
 * Used both from the desktop sidebar and from the mobile navigation drawer.
 */
export function WorkspaceSwitcher({ cloud, empty = false }: { cloud: WorkspaceDirectoryActions; empty?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [createValue, setCreateValue] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ArchiveFilter>(empty ? 'all' : 'default')
  const current = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  const visible = cloud.workspaces.filter((item) => !item.deletedAt && item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (matchesArchiveFilter(Boolean(item.archivedAt), query, filter) || (item.lifecycleOperation && item.lifecycleOperation.status !== 'complete')))
  useEffect(() => {
    if (!open && !empty) return
    void cloud.refreshWorkspaces().catch((caught) => setError(caught instanceof Error ? caught.message : 'The workspace list could not be refreshed.'))
    // Refresh only on opening; cloud updates after each mutation and on window focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, empty])

  function changeOpen(next: boolean) {
    if (!next && busyId !== null) return
    if (next && current?.archivedAt && filter === 'default') setFilter('all')
    setOpen(next)
    if (!next) { setError(''); setRenamingId(null); setCreating(false); setCreateValue('') }
  }

  async function handleSwitch(id: string) {
    if (id === cloud.currentWorkspaceId) { changeOpen(false); return }
    setBusyId(id); setError('')
    const result = await cloud.switchWorkspace(id)
    setBusyId(null)
    if (result.ok) changeOpen(false)
    else setError(result.message)
  }

  async function handleCreate() {
    setBusyId('__create__'); setError('')
    const result = await cloud.createWorkspace(createValue)
    setBusyId(null)
    if (result.ok) changeOpen(false)
    else setError(result.message)
  }

  async function handleRename(id: string) {
    setBusyId(id); setError('')
    const result = await cloud.renameWorkspace(id, renameValue)
    setBusyId(null)
    if (result.ok) setRenamingId(null)
    else setError(result.message)
  }

  const contents = <>
      {error && <div className="mb-4"><InlineError>{error}</InlineError></div>}
      <div className="toolbar mb-4"><SearchField value={query} onChange={setQuery} placeholder="Search workspaces…" label="Search workspaces" /><ArchiveStateFilter value={filter} onChange={setFilter} label="Workspace archive state" /></div>
      <p className="mb-4 text-[11px] text-muted">Owners can use the pencil beside a workspace to rename it. Search includes archived workspaces. Open one to read its content; unarchive to resume editing. Cancelled work does not restart.</p>
      <ul className="workspace-switcher-list">
        {visible.map((item) => {
          const isCurrent = item.id === cloud.currentWorkspaceId
          const isRenaming = renamingId === item.id
          const isBusy = busyId === item.id
          const incomplete = item.lifecycleOperation && item.lifecycleOperation.status !== 'complete'
          return <li key={item.id} className={`workspace-switcher-item ${isCurrent ? 'is-current' : ''}`}>
            {isRenaming ? <form className="workspace-switcher-rename" onSubmit={(event) => { event.preventDefault(); void handleRename(item.id) }}>
              <input className="input" autoFocus value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} aria-label={`Rename ${item.name}`} />
              <Button size="sm" type="submit" variant="primary" icon={isBusy ? Loader2 : Check} disabled={isBusy || !renameValue.trim() || Boolean(item.archivedAt) || Boolean(incomplete)}>Save</Button>
              <Button size="sm" type="button" onClick={() => setRenamingId(null)} disabled={busyId !== null}>Cancel</Button>
            </form> : <>
              <button type="button" className="workspace-switcher-name" onClick={() => void handleSwitch(item.id)} disabled={busyId !== null} aria-current={isCurrent ? 'true' : undefined}>
                {isBusy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : isCurrent ? <Check size={14} aria-hidden="true" /> : <span className="workspace-switcher-name-spacer" aria-hidden="true" />}
                <span>{item.name}</span>
              </button>
              {item.archivedAt && <Badge tone="warning">Archived</Badge>}
              <Badge>{item.role}</Badge>
              {item.role === 'owner' && <Button size="sm" variant="ghost" className="icon-button" aria-label={`Rename ${item.name}`} icon={Pencil} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); setError('') }} disabled={busyId !== null || Boolean(item.archivedAt) || Boolean(incomplete)} />}
              <LifecycleActions target={{ kind: 'workspace', id: item.id }} name={item.name} archived={Boolean(item.archivedAt)} canManage={item.role === 'owner'} compact
                getImpact={() => cloud.getWorkspaceLifecycleImpact(item.id)}
                change={(action) => cloud.changeWorkspaceLifecycle(item.id, action)}
                navigateBlocker={async (href) => {
                  const switched = await cloud.switchWorkspace(item.id)
                  if (!switched.ok) throw new Error(switched.message)
                  window.location.assign(href)
                }} />
              {incomplete && <div className="workspace-operation" role="status"><Badge tone={item.lifecycleOperation?.status === 'failed' ? 'danger' : 'warning'}>{item.lifecycleOperation?.action} · {item.lifecycleOperation?.status}</Badge>
                <p>{item.lifecycleOperation?.error ?? 'This operation has not finished. Content remains read-only.'}</p>
                <Button size="sm" disabled={busyId !== null} onClick={() => {
                  setBusyId(item.id); setError('')
                  void cloud.refreshWorkspaces().catch((caught) => setError(caught instanceof Error ? caught.message : 'Status refresh failed.')).finally(() => setBusyId(null))
                }}>Refresh status</Button>
                {item.role === 'owner' && <Button size="sm" disabled={busyId !== null} onClick={() => {
                  setBusyId(item.id); setError('')
                  void cloud.changeWorkspaceLifecycle(item.id, item.lifecycleOperation!.action).catch((caught) => setError(caught instanceof Error ? caught.message : 'The lifecycle operation is still incomplete.')).finally(() => setBusyId(null))
                }}>Retry operation</Button>}
              </div>}
            </>}
          </li>
        })}
      </ul>
      {!visible.length && <EmptyState title={query ? 'No matching workspaces' : 'No active workspaces'} description="Create a workspace, search archived workspaces, or choose Archived only to unarchive an existing one." />}
      {creating ? <form className="workspace-switcher-create" onSubmit={(event) => { event.preventDefault(); void handleCreate() }}>
        <input className="input" autoFocus placeholder="Workspace name" value={createValue} maxLength={80} onChange={(event) => setCreateValue(event.target.value)} aria-label="New workspace name" />
        <Button size="sm" type="submit" variant="primary" icon={busyId === '__create__' ? Loader2 : Plus} disabled={busyId === '__create__' || !createValue.trim()}>Create</Button>
        <Button size="sm" type="button" variant="ghost" className="icon-button" aria-label="Cancel new workspace" icon={X} disabled={busyId !== null} onClick={() => { setCreating(false); setCreateValue('') }} />
      </form> : <Button className="mt-4" icon={Plus} disabled={busyId !== null} onClick={() => { setCreating(true); setCreateValue(''); setError('') }}>New workspace</Button>}
  </>

  if (empty) return <section className="workspace-directory" aria-label="My workspaces">{contents}</section>
  return <>
    <button type="button" className="workspace-label workspace-switcher-trigger" onClick={() => changeOpen(true)} aria-haspopup="dialog">
      <span className="workspace-monogram">{(current?.name ?? 'W').trim().slice(0, 1).toUpperCase()}</span>
      <div><strong>{current?.name ?? 'My workspace'}</strong><span>{current?.archivedAt ? 'Archived · read only' : 'Personal · cloud'}</span></div>
      <ChevronsUpDown size={14} className="workspace-switcher-caret" aria-hidden="true" />
    </button>
    <Modal open={open} onOpenChange={changeOpen} title="My workspaces" description="Switch between your personal Score workspaces, or start a new one. Each keeps its own jobs, resumes, rubrics, and analyses.">
      {contents}
    </Modal>
  </>
}
