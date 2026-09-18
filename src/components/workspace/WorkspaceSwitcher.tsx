import { useState } from 'react'
import { Check, ChevronsUpDown, Loader2, Pencil, Plus, X } from 'lucide-react'
import type { CloudWorkspaceStatus } from '../../app/workspace-context'
import { Badge, Button, InlineError, Modal } from '../ui'

/**
 * The sidebar's "current workspace" label becomes this functional control: it opens a modal to
 * list, switch between, rename, and create the signed-in user's personal Score workspaces. Group
 * workspaces are not offered yet (the API reserves `kind: 'group'`, but there is no group UI).
 * Used both from the desktop sidebar and from the mobile navigation drawer.
 */
export function WorkspaceSwitcher({ cloud }: { cloud: CloudWorkspaceStatus }) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [createValue, setCreateValue] = useState('')
  const current = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)

  function changeOpen(next: boolean) {
    if (!next && busyId !== null) return
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

  return <>
    <button type="button" className="workspace-label workspace-switcher-trigger" onClick={() => changeOpen(true)} aria-haspopup="dialog">
      <span className="workspace-monogram">{(current?.name ?? 'W').trim().slice(0, 1).toUpperCase()}</span>
      <div><strong>{current?.name ?? 'My workspace'}</strong><span>Personal &middot; cloud</span></div>
      <ChevronsUpDown size={14} className="workspace-switcher-caret" aria-hidden="true" />
    </button>
    <Modal open={open} onOpenChange={changeOpen} title="My workspaces" description="Switch between your personal Score workspaces, or start a new one. Each keeps its own jobs, resumes, rubrics, and analyses.">
      {error && <div className="mb-4"><InlineError>{error}</InlineError></div>}
      <ul className="workspace-switcher-list">
        {cloud.workspaces.map((item) => {
          const isCurrent = item.id === cloud.currentWorkspaceId
          const isRenaming = renamingId === item.id
          const isBusy = busyId === item.id
          return <li key={item.id} className={`workspace-switcher-item ${isCurrent ? 'is-current' : ''}`}>
            {isRenaming ? <form className="workspace-switcher-rename" onSubmit={(event) => { event.preventDefault(); void handleRename(item.id) }}>
              <input className="input" autoFocus value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} aria-label={`Rename ${item.name}`} />
              <Button size="sm" type="submit" variant="primary" icon={isBusy ? Loader2 : Check} disabled={isBusy || !renameValue.trim()}>Save</Button>
              <Button size="sm" type="button" onClick={() => setRenamingId(null)}               disabled={busyId !== null}>Cancel</Button>
            </form> : <>
              <button type="button" className="workspace-switcher-name" onClick={() => void handleSwitch(item.id)} disabled={busyId !== null} aria-current={isCurrent ? 'true' : undefined}>
                {isBusy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : isCurrent ? <Check size={14} aria-hidden="true" /> : <span className="workspace-switcher-name-spacer" aria-hidden="true" />}
                <span>{item.name}</span>
              </button>
              <Badge>Personal</Badge>
              <Button size="sm" variant="ghost" className="icon-button" aria-label={`Rename ${item.name}`} icon={Pencil} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); setError('') }} disabled={busyId !== null} />
            </>}
          </li>
        })}
      </ul>
      {creating ? <form className="workspace-switcher-create" onSubmit={(event) => { event.preventDefault(); void handleCreate() }}>
        <input className="input" autoFocus placeholder="Workspace name" value={createValue} maxLength={80} onChange={(event) => setCreateValue(event.target.value)} aria-label="New workspace name" />
        <Button size="sm" type="submit" variant="primary" icon={busyId === '__create__' ? Loader2 : Plus} disabled={busyId === '__create__' || !createValue.trim()}>Create</Button>
        <Button size="sm" type="button" variant="ghost" className="icon-button" aria-label="Cancel new workspace" icon={X} onClick={() => { setCreating(false); setCreateValue('') }} />
      </form> : <Button className="mt-4" icon={Plus} disabled={busyId !== null} onClick={() => { setCreating(true); setCreateValue(''); setError('') }}>New workspace</Button>}
    </Modal>
  </>
}
