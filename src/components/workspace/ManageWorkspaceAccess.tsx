import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, UserPlus } from 'lucide-react'
import type { EligibleUser, WorkspaceMember, WorkspaceMembers } from '../../domain/access'
import { workspaceRoleLabel } from '../../domain/access'
import type { WorkspaceRole, WorkspaceSummary } from '../../domain/cloud'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { accessChangeFailure, getWorkspaceMembers, listShareCandidates, removeWorkspaceMember, setWorkspaceMember } from '../../services/workspaceAccess'
import { Badge, Button, InlineError, Modal } from '../ui'
import { EligiblePeoplePicker } from './EligiblePeoplePicker'

type Change = { person: WorkspaceMember | EligibleUser; role?: WorkspaceRole; kind: 'add' | 'change' | 'remove'; etag: string }
const roles: WorkspaceRole[] = ['viewer', 'editor', 'owner']

export function ManageWorkspaceAccess({ workspaceId, workspace, onClose, onAccessChanged }: {
  workspaceId: string
  workspace?: WorkspaceSummary
  onClose: () => void
  onAccessChanged: () => Promise<void>
}) {
  const [members, setMembers] = useState<WorkspaceMembers | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [person, setPerson] = useState<EligibleUser | null>(null)
  const [role, setRole] = useState<WorkspaceRole>('viewer')
  const [review, setReview] = useState<Change | null>(null)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const read = useRef<AbortController | null>(null)
  const editable = Boolean(workspace && !workspace.deletedAt && workspace.role === 'owner' &&
    (!workspace.lifecycleOperation || workspace.lifecycleOperation.status === 'complete'))
  const canRead = Boolean(workspace && !workspace.deletedAt && workspace.role === 'owner')
  const allowed = useRef(editable)
  allowed.current = editable
  const guard = useGradeLeaveGuard(Boolean(review || person), pending, 'Workspace membership change')
  const loadPeople = useCallback((query: string, continuation?: string, signal?: AbortSignal) =>
    listShareCandidates(workspaceId, query, continuation, signal), [workspaceId])

  const refresh = useCallback(async () => {
    if (!canRead) return
    const controller = new AbortController()
    read.current?.abort(); read.current = controller
    setLoading(true)
    try {
      const result = await getWorkspaceMembers(workspaceId, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      setMembers(result); setRecovery(false)
      setStatus('Current membership loaded. Review these saved roles before choosing a change.')
    } catch (caught) {
      if (!controller.signal.aborted && alive.current) setError(caught instanceof Error ? caught.message : 'Members could not be loaded. No empty membership list has been assumed.')
    } finally {
      if (!controller.signal.aborted && alive.current) setLoading(false)
    }
  }, [canRead, workspaceId])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; read.current?.abort() }
  }, [refresh])

  async function applyChange() {
    if (!review || !allowed.current || recovery || inFlight.current) return
    const change = review
    inFlight.current = true; setPending(true); setError(''); setStatus(''); guard.hold()
    let saved = false
    try {
      const result = change.kind === 'remove'
        ? await removeWorkspaceMember(workspaceId, change.person.id, change.etag)
        : await setWorkspaceMember(workspaceId, change.person.id, change.role!, change.etag)
      if (!alive.current) return
      setMembers(result); setReview(null); setPerson(null); setRole('viewer'); guard.release()
      setStatus(change.kind === 'remove' ? 'Individual membership removed. Independent application-admin access is not removed.' : 'Workspace membership saved. Access is available without an invitation or first sign-in.')
      saved = true
    } catch (caught) {
      if (!alive.current) return
      setError(accessChangeFailure(caught)); setRecovery(true); setReview(null)
    } finally {
      inFlight.current = false
      if (alive.current) { setPending(false); guard.settle() }
    }
    try { await onAccessChanged() } catch (caught) {
      if (alive.current) setError(previous => `${previous ? `${previous} ` : ''}${saved ? 'Membership was saved, but' : 'Also,'} session refresh failed: ${caught instanceof Error ? caught.message : 'Service unavailable'}. Refresh access before continuing.`)
    }
  }

  const disabled = !editable || loading || pending || recovery || !members
  return <>
    <Modal open onOpenChange={open => { if (!open) void guard.close(onClose) }} dismissDisabled={pending}
      title="Manage access" description={`Individual access to ${workspace?.name ?? 'this workspace'}. Owners are equal peers; the original creator has no extra privileges.`} wide>
      {!canRead ? <InlineError>Your account no longer has permission to manage this workspace. Membership controls are closed; refresh workspaces or contact an owner or application administrator.</InlineError> : <>
        <div className="access-notice">
          <p>Every workspace must keep at least one explicit Owner. Add another Owner before removing or demoting the last one. Application administrators have independent Owner-equivalent access to all workspaces, even with a Reader membership or no membership.</p>
          <p>Removing or downgrading membership cannot remove application-admin privileges. Accepted background work continues; previously downloaded content cannot be recalled.</p>
          {workspace?.accessSource === 'application-admin' && <Badge tone="accent">Your access: Application administrator</Badge>}
          {workspace?.archivedAt && <p>This workspace is archived. Access can still be managed; content remains read-only.</p>}
          {!editable && <p>Finish the pending workspace lifecycle operation before changing membership.</p>}
        </div>
        {error && <InlineError>{error}</InlineError>}
        {status && <p role="status" className="access-hint">{status}</p>}
        <div className="access-section-heading"><h3>Current members</h3><Button size="sm" icon={RefreshCw} disabled={loading || pending}
          onClick={() => { setError(''); void refresh() }}>Refresh members</Button></div>
        {loading && <p role="status">Loading members…</p>}
        <ul className="access-members">
          {members?.members.map(member => <li key={member.id}>
            <div className="access-person"><strong>{member.name || member.email || member.id}</strong><span>{member.email || 'Email unavailable'}</span></div>
            <label className="access-role"><span className="sr-only">Role for {member.name || member.id}</span>
              <select className="input" aria-label={`Role for ${member.name || member.id}`} value={member.role} disabled={disabled}
                onChange={event => setReview({ person: member, role: event.target.value as WorkspaceRole, kind: 'change', etag: members!.etag })}>
                {roles.map(value => <option key={value} value={value}>{workspaceRoleLabel(value)}</option>)}
              </select>
            </label>
            <Button size="sm" variant="danger" disabled={disabled} aria-label={`Remove ${member.name || member.id}`}
              onClick={() => setReview({ person: member, kind: 'remove', etag: members!.etag })}>Remove</Button>
          </li>)}
        </ul>
        {!loading && members && !members.members.length && <p>No individual memberships were returned. Application administrators can repair explicit ownership.</p>}
        {recovery && <p className="access-hint">Changes are paused. Refresh members to inspect the authoritative result, then explicitly choose another action. No access request is automatically replayed.</p>}
        <section className="access-add"><h3>Add a person</h3>
          <EligiblePeoplePicker load={loadPeople} onChoose={chosen => { setPerson(chosen); setRole('viewer') }} disabled={disabled}
            memberIds={members?.members.map(member => member.id)} selectedId={person?.id} />
          {person && <div className="access-add-selection">
            <div className="access-person"><strong>{person.name || person.email}</strong><span>{person.email}</span></div>
            <label className="access-role">New member role<select className="input" aria-label="New member role" value={role} disabled={disabled} onChange={event => setRole(event.target.value as WorkspaceRole)}>
              {roles.map(value => <option key={value} value={value}>{workspaceRoleLabel(value)}</option>)}
            </select></label>
            <Button icon={UserPlus} variant="primary" disabled={disabled || members?.members.some(member => member.id === person.id)}
              onClick={() => setReview({ person, role, kind: 'add', etag: members!.etag })}>Review adding member</Button>
            <Button size="sm" disabled={pending} onClick={() => { setPerson(null); guard.release() }}>Cancel selection</Button>
          </div>}
        </section>
      </>}
    </Modal>
    <Modal open={review !== null} onOpenChange={open => { if (!open) setReview(null) }} dismissDisabled={pending}
      title={review?.kind === 'remove' ? 'Remove workspace member?' : review?.kind === 'add' ? 'Add workspace member?' : 'Change workspace role?'}
      description={review ? `${review.person.name || review.person.email || review.person.id}${review.person.email ? ` · ${review.person.email}` : ''}` : 'Review this membership change.'}
      footer={<><Button disabled={pending} onClick={() => setReview(null)}>Cancel</Button><Button variant={review?.kind === 'remove' ? 'danger' : 'primary'} disabled={pending || !editable || recovery}
        onClick={() => void applyChange()}>{pending ? 'Saving access…' : review?.kind === 'remove' ? 'Remove membership' : 'Save membership'}</Button></>}>
      <p>{review?.kind === 'remove' ? 'Remove this individual membership? Independent application-admin access, other workspaces, and accepted work are not affected.' : `Grant ${workspaceRoleLabel(review?.role ?? 'viewer')} access to this workspace. ${review?.role === 'owner' ? 'Owners can manage members, demote other owners, and permanently delete the workspace.' : review?.role === 'editor' ? 'Editors can edit, process, archive, and delete individual content, but cannot manage members or delete the workspace.' : 'Readers can view saved content and use downloads and reports only when application policy allows.'}`}</p>
      <p className="mt-3 text-muted">The last explicit Owner cannot be removed or demoted, even by an application administrator. The server checks this safeguard and current permissions before saving.</p>
    </Modal>
  </>
}
