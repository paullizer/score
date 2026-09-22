import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Modal } from '../ui'
import { WorkspaceDirectory, type WorkspaceDirectoryActions } from './WorkspaceDirectory'

export type { WorkspaceDirectoryActions } from './WorkspaceDirectory'

export function WorkspaceSwitcher({ cloud, empty = false }: { cloud: WorkspaceDirectoryActions; empty?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  if (empty) return <WorkspaceDirectory cloud={cloud} initialFilter="all" />
  return <>
    <button type="button" className="workspace-label workspace-switcher-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <span className="workspace-monogram">{(current?.name ?? 'W').trim().slice(0, 1).toUpperCase()}</span>
      <div><strong>{current?.name ?? 'My workspace'}</strong><span>{current?.archivedAt ? 'Archived · read only' : 'Personal · cloud'}</span></div>
      <ChevronsUpDown size={14} className="workspace-switcher-caret" aria-hidden="true" />
    </button>
    <Modal open={open} onOpenChange={setOpen} dismissDisabled={busy} title="My workspaces"
      description="Switch between your personal Score workspaces, or start a new one. Each keeps its own jobs, resumes, rubrics, and analyses.">
      {open && <WorkspaceDirectory cloud={cloud} initialFilter={current?.archivedAt ? 'all' : 'default'} onSelected={() => setOpen(false)} onBusyChange={setBusy} />}
    </Modal>
  </>
}
