import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { workspaceRoleLabel } from '../../domain/access'
import { Modal } from '../ui'
import { WorkspaceDirectory, type WorkspaceDirectoryActions } from './WorkspaceDirectory'

export type { WorkspaceDirectoryActions } from './WorkspaceDirectory'

export function WorkspaceSwitcher({ cloud, empty = false, compact = false }: { cloud: WorkspaceDirectoryActions; empty?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  if (empty) return <WorkspaceDirectory cloud={cloud} initialFilter="all" />
  const name = current?.name ?? 'Workspace'
  const detail = current?.archivedAt ? 'Archived · read only' : current?.accessSource === 'application-admin' ? 'Application administrator · cloud' : current ? `${workspaceRoleLabel(current.role)} · cloud` : 'Cloud workspace'
  return <>
    <button type="button" className="workspace-label workspace-switcher-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" title={compact ? `${name}\n${detail}` : undefined}>
      <span className="workspace-monogram">{(current?.name ?? 'W').trim().slice(0, 1).toUpperCase()}</span>
      <div><strong>{name}</strong><span>{detail}</span></div>
      <ChevronsUpDown size={14} className="workspace-switcher-caret" aria-hidden="true" />
    </button>
    <Modal open={open} onOpenChange={setOpen} dismissDisabled={busy} title="My workspaces"
      description="Switch between accessible Score workspaces. Each keeps its own jobs, resumes, rubrics, analyses, and members.">
      {open && <WorkspaceDirectory cloud={cloud} initialFilter={current?.archivedAt ? 'all' : 'default'} onSelected={() => setOpen(false)} onBusyChange={setBusy} />}
    </Modal>
  </>
}
