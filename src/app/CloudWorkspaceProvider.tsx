import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, ShieldCheck } from 'lucide-react'
import type { CloudWorkspaceStatus, RenameEntityTarget, WorkspaceContextValue } from './workspace-context'
import type { Workspace } from '../domain/types'
import type { CloudUser, WorkspaceSummary } from '../domain/cloud'
import type { LifecycleTarget } from '../domain/lifecycle'
import { Button, InlineError, Modal } from '../components/ui'
import type { GradeLeaveProtectionApi } from './grade-navigation-context'
import { workspaceCanEdit } from '../domain/workspace-permissions'
import { AccessSuspendedContext } from './access-suspended-context'

const NOTICE_MS = 5500

type Result = { ok: true } | { ok: false; message: string; reason?: 'grade-protection' }
type CloudWorkspaceContent = (
  value: Omit<WorkspaceContextValue, 'cloud'>,
  cloud: Omit<CloudWorkspaceStatus, 'realJobs'>,
) => ReactNode

export interface CloudWorkspaceProviderApi {
  /** Confirms grade and real-workflow leave protection before switching workspaces, entering admin, or signing out. */
  prepareToLeave: () => Promise<Result>
}

function unavailableItem(kind: string): Error {
  return new Error(`This ${kind} is no longer available in this workspace. Refresh the page to load its current content.`)
}

/**
 * Real-only workspace provider. It exposes an empty in-memory workspace projection that the real
 * feature bridges fill from server records, shared notices, and the workspace-level lifecycle
 * controls. Nothing is loaded from or saved to a workspace state document.
 *
 * Mounted keyed by workspaceId by CloudApplication, so switching workspaces always starts a fresh
 * instance: no in-flight request from a previous workspace can leak into the new one.
 */
export function CloudWorkspaceProvider({
  workspaceId, user, workspaces, apiRef,
  switchWorkspace, createWorkspace, renameWorkspace, onSignedOut, children,
  leaveProtectionRef,
  refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle,
  leaveUnavailableWorkspace,
  canCreateWorkspaces = false,
}: {
  workspaceId: string
  user: CloudUser
  workspaces: WorkspaceSummary[]
  canCreateWorkspaces?: boolean
  apiRef: { current: CloudWorkspaceProviderApi | null }
  leaveProtectionRef?: { current: GradeLeaveProtectionApi | null }
  switchWorkspace: (id: string) => Promise<Result>
  createWorkspace: (name: string) => Promise<Result>
  renameWorkspace: (id: string, name: string) => Promise<Result>
  /** Called once leave protection allows it; redirects to /.auth/logout. */
  onSignedOut: () => void
  children: CloudWorkspaceContent
  refreshWorkspaces: CloudWorkspaceStatus['refreshWorkspaces']
  getWorkspaceLifecycleImpact: CloudWorkspaceStatus['getWorkspaceLifecycleImpact']
  changeWorkspaceLifecycle: CloudWorkspaceStatus['changeWorkspaceLifecycle']
  leaveUnavailableWorkspace: CloudWorkspaceStatus['leaveUnavailableWorkspace']
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [accessError, setAccessError] = useState('')
  const metadata = workspaces.find((item) => item.id === workspaceId)
  const metadataRef = useRef(metadata)
  metadataRef.current = metadata
  const unavailable = !metadata || Boolean(metadata.deletedAt)
  const archivedAt = metadata?.archivedAt

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function prepareToLeave(): Promise<Result> {
    if (leaveProtectionRef?.current && !await leaveProtectionRef.current.confirmLeave(undefined, true)) {
      return { ok: false, reason: 'grade-protection', message: 'Leaving was stopped to preserve unsaved changes or an in-flight request.' }
    }
    return { ok: true }
  }

  useEffect(() => {
    apiRef.current = { prepareToLeave }
    return () => { apiRef.current = null }
  })

  async function signOut() {
    const result = await prepareToLeave()
    if (!result.ok) {
      setNotice('Sign-out cancelled. Unsaved edits and pending requests are kept in this workspace.')
      return
    }
    onSignedOut()
  }

  function assertWorkspaceOwner() {
    const current = metadataRef.current
    if (!current || current.deletedAt || !workspaceCanEdit(current.role) || current.role !== 'owner') {
      throw new Error('Your role does not allow this lifecycle change.')
    }
  }

  const workspace = useMemo<Workspace>(() => ({
    jobs: [], documents: [], rubrics: [], lifecycle: { entities: {}, archivedAt },
  }), [archivedAt])

  const cloud: Omit<CloudWorkspaceStatus, 'realJobs'> = {
    user, workspaces, currentWorkspaceId: workspaceId, canCreateWorkspaces,
    switchWorkspace, createWorkspace, renameWorkspace, signOut,
    refreshWorkspaces, getWorkspaceLifecycleImpact, changeWorkspaceLifecycle,
    leaveUnavailableWorkspace,
  }
  // Real bridges claim their own records; anything left unclaimed is stale for this tab.
  const value: Omit<WorkspaceContextValue, 'cloud'> = {
    workspace, notice, clearNotice: () => setNotice(null), notify: setNotice,
    renameEntity: (target: RenameEntityTarget) => { throw unavailableItem(target.kind) },
    cancelJob: () => { throw unavailableItem('job') },
    retryJob: () => { throw unavailableItem('job') },
    saveRubric: () => { throw unavailableItem('rubric') },
    getLifecycleImpact: (target: LifecycleTarget) => {
      if (target.kind === 'workspace') return getWorkspaceLifecycleImpact(workspaceId)
      throw unavailableItem(target.kind)
    },
    changeLifecycle: async (target, action) => {
      if (target.kind !== 'workspace') throw unavailableItem(target.kind)
      assertWorkspaceOwner()
      return changeWorkspaceLifecycle(workspaceId, action)
    },
    lifecycleOperations: [],
  }
  return <>
    {unavailable && <main className="recovery-page"><div className="panel recovery-card">
      <ShieldCheck size={30} /><h1>Workspace access is no longer available</h1>
      <p>This workspace was removed or your membership changed. Workspace content is hidden and new requests and writes are stopped. Ask an Owner or application administrator for access.</p>
      <p>Unsaved drafts remain in memory in this tab. They do not grant continued access and will not be uploaded automatically. Refresh access to check for a restored grant, or explicitly discard them before leaving.</p>
      {accessError && <InlineError>{accessError}</InlineError>}
      <div className="flex flex-wrap gap-3"><Button icon={RotateCcw} onClick={() => {
        setAccessError('')
        void refreshWorkspaces().catch(caught => setAccessError(caught instanceof Error ? caught.message : 'Current access could not be refreshed.'))
      }}>Refresh access</Button><Button onClick={() => setConfirmLeave(true)}>Choose another workspace</Button></div>
    </div></main>}
    <AccessSuspendedContext.Provider value={unavailable}><div className="access-suspended" hidden={unavailable}>{children(value, cloud)}</div></AccessSuspendedContext.Provider>
    <Modal open={confirmLeave} onOpenChange={setConfirmLeave} dismissDisabled={leaving} title="Discard unsaved changes and leave?"
      description="Access has changed. This explicitly discards unsaved drafts kept only in this tab. Drafts with their own leave protection still ask for confirmation."
      footer={<><Button disabled={leaving} onClick={() => setConfirmLeave(false)}>Keep this tab</Button><Button variant="danger" disabled={leaving} onClick={() => {
        setLeaving(true); setAccessError('')
        void leaveUnavailableWorkspace().then(result => { if (!result.ok) { setConfirmLeave(false); setAccessError(result.message) } })
          .catch(caught => setAccessError(caught instanceof Error ? caught.message : 'The workspace could not be left.'))
          .finally(() => setLeaving(false))
      }}>Discard local changes and leave</Button></>}>
      <p>Other workspaces and already accepted server work are not changed. Nothing is sent to the unavailable workspace.</p>
      {accessError && <InlineError>{accessError}</InlineError>}
    </Modal>
  </>
}