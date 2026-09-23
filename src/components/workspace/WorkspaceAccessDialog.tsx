import { useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { CloudUser, WorkspaceReviewerAccess, WorkspaceSummary } from '../../domain/cloud'
import { workspaceQcRole } from '../../domain/workspace-permissions'
import { addWorkspaceReviewer, CloudApiError, listWorkspaceReviewers, removeWorkspaceReviewer } from '../../services/cloudWorkspace'
import { Badge, Button, InlineError, Modal } from '../ui'

export function WorkspaceAccessDialog({ workspace, user, refreshWorkspaces, onClose }: {
  workspace: WorkspaceSummary
  user: CloudUser
  refreshWorkspaces: () => Promise<void>
  onClose: () => void
}) {
  const [access, setAccess] = useState<WorkspaceReviewerAccess | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [objectId, setObjectId] = useState('')
  const [label, setLabel] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const owner = workspaceQcRole(workspace) === 'owner' && !workspace.deletedAt
  const mutable = owner && (!workspace.lifecycleOperation || workspace.lifecycleOperation.status === 'complete')
  const current = useRef({ owner, mutable, refreshWorkspaces })
  current.current = { owner, mutable, refreshWorkspaces }

  async function refresh() {
    if (inFlight.current || !current.current.owner) return
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setLoading(true); setError(''); setAccess(null); setRemoving(null)
    try {
      const result = await listWorkspaceReviewers(workspace.id, request.signal)
      if (!request.signal.aborted && current.current.owner) setAccess(result)
    } catch (caught) {
      if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : 'Reviewer access could not be loaded.')
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    if (owner) void refresh()
    else { setAccess(null); setLoading(false); setPending(false); setRemoving(null) }
    return () => { controller.current?.abort() }
    // Each mounted dialog is keyed to one workspace; role loss invalidates all private membership state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, owner])

  async function change(action: 'add' | 'remove', targetId: string) {
    if (inFlight.current || !current.current.mutable || !access) return
    inFlight.current = true
    setPending(true); setError('')
    const request = new AbortController()
    controller.current?.abort()
    controller.current = request
    try {
      const result = action === 'add'
        ? await addWorkspaceReviewer(workspace.id, { objectId: targetId.trim(), ...(label.trim() ? { label: label.trim() } : {}) }, access.etag, request.signal)
        : await removeWorkspaceReviewer(workspace.id, targetId, access.etag, request.signal)
      if (request.signal.aborted || !current.current.owner) return
      setAccess(result); setRemoving(null)
      if (action === 'add') { setObjectId(''); setLabel('') }
      try { await current.current.refreshWorkspaces() } catch (caught) {
        if (!request.signal.aborted) setError(`Reviewer access was saved, but the workspace list could not be refreshed: ${caught instanceof Error ? caught.message : 'Try refreshing again.'}`)
      }
    } catch (caught) {
      if (request.signal.aborted) return
      setAccess(null); setRemoving(null)
      setError(`${caught instanceof Error ? caught.message : 'The access change was not acknowledged.'} Refresh access before explicitly trying again.`)
      if (caught instanceof CloudApiError && [401, 403, 404].includes(caught.status)) {
        try { await current.current.refreshWorkspaces() } catch { /* The access error remains visible; no private list is retained. */ }
      }
    } finally {
      inFlight.current = false
      if (!request.signal.aborted) setPending(false)
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open && !inFlight.current) onClose() }} dismissDisabled={pending}
    title={`Reviewer access · ${workspace.name}`}
    description="Reviewers can read this workspace's saved content and participate in QC. They cannot import, score, edit, or manage ordinary content.">
    <div className="space-y-4">
      <div className="rounded-xl border bg-soft p-3">
        <p className="text-[12px] font-medium">Your account ID to share</p>
        <code className="break-all text-[12px]">{user.id}</code>
        <p className="mt-1 break-all text-[11px] text-muted">Tenant: {user.tenantId}</p>
      </div>
      <p className="text-[12px] text-muted">Any explicit workspace Owner can grant or revoke reviewer access. Use an exact same-tenant Entra object ID assigned Score.User or Score.Admin. This does not invite accounts or grant application-administrator access. Original downloads and exports have separate policies.</p>
      {!owner ? <InlineError>Only a current explicit workspace Owner can inspect or manage reviewer memberships.</InlineError> : <>
        {!mutable && <p role="status" className="text-[12px] text-muted">Finish or retry the workspace lifecycle operation before changing access.</p>}
        {error && <InlineError>{error}</InlineError>}
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[13px] font-semibold">Reviewers</h3>
          <Button size="sm" icon={RotateCcw} disabled={pending || loading} onClick={() => void refresh()}>Refresh access</Button>
        </div>
        {loading && <p role="status">Loading reviewer access…</p>}
        {access && !access.reviewers.length && <p className="text-[12px] text-muted">No reviewer memberships. Existing Owner memberships are unchanged.</p>}
        {access && <ul className="space-y-3" aria-label="Workspace reviewers">
          {access.reviewers.map(reviewer => <li key={reviewer.objectId} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                {reviewer.label && <p className="text-[12px] font-medium">{reviewer.label} <span className="text-muted">(display label)</span></p>}
                <code className="break-all text-[11px]">{reviewer.objectId}</code>
              </div>
              <Badge>reviewer</Badge>
              <Button size="sm" variant="ghost" icon={Trash2} disabled={pending || !mutable} aria-label={`Remove reviewer ${reviewer.objectId}`} onClick={() => setRemoving(reviewer.objectId)}>Remove</Button>
            </div>
            {removing === reviewer.objectId && <div className="mt-3 space-y-2" role="alert">
              <p className="text-[12px]">Revoke this account's workspace access? Subsequent reads and QC requests will require membership again. Submitted reviews remain attributable history.</p>
              <div className="flex gap-2"><Button size="sm" disabled={pending || !mutable} onClick={() => void change('remove', reviewer.objectId)}>Confirm removal</Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRemoving(null)}>Cancel removal</Button></div>
            </div>}
          </li>)}
        </ul>}
        <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); void change('add', objectId) }}>
          <label className="block text-[12px]">Reviewer account ID
            <input className="input mt-1" value={objectId} onChange={event => setObjectId(event.target.value)} maxLength={80} autoComplete="off"
              spellCheck={false} placeholder="Entra object ID (GUID)" disabled={pending || !mutable} />
          </label>
          <label className="block text-[12px]">Display label (optional)
            <input className="input mt-1" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} autoComplete="off" disabled={pending || !mutable} />
          </label>
          <p className="text-[11px] text-muted">Labels are for display only. Check the exact account ID with the person before granting access.</p>
          <Button type="submit" icon={Plus} disabled={pending || loading || !mutable || !access || !objectId.trim()}>{pending ? 'Saving access…' : 'Add reviewer'}</Button>
        </form>
      </>}
    </div>
  </Modal>
}
