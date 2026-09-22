import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Layers3, RefreshCw, Settings, ShieldCheck } from 'lucide-react'
import type { CreationAccess, EligibleUser } from '../../domain/access'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { ThemeControl } from '../../app/ThemeControl'
import { Badge, Button, InlineError, Modal, PageHeader } from '../../components/ui'
import { EligiblePeoplePicker } from '../../components/workspace/EligiblePeoplePicker'
import { accessChangeFailure, getCreationAccess, listEligibleUsers, setCreationAccess } from '../../services/workspaceAccess'

export function AdminUsersPage({ onLeave, onOpenSettings, onAccessChanged }: {
  onLeave: () => void
  onOpenSettings: () => Promise<void>
  onAccessChanged: () => Promise<void>
}) {
  const policy = usePublicSettings()
  const [person, setPerson] = useState<EligibleUser | null>(null)
  const [base, setBase] = useState<CreationAccess | null>(null)
  const [draft, setDraft] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [review, setReview] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const dirty = Boolean(base && base.canCreateWorkspaces !== draft)
  const guard = useGradeLeaveGuard(dirty || review, pending, 'Workspace-creation permission')
  const applicationAdmin = person?.applicationRoles.includes('Score.Admin') === true

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    setBase(null); setError(''); setStatus(''); setRecovery(false); setReview(false)
    if (!person) return
    const controller = new AbortController()
    setLoading(true)
    void getCreationAccess(person.id, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setBase(value); setDraft(value.canCreateWorkspaces)
    }).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Creation permission could not be read. No permission has been assumed.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [person, revision])

  async function save() {
    if (!person || !base || !dirty || applicationAdmin || recovery || inFlight.current) return
    inFlight.current = true; setPending(true); setError(''); setStatus(''); guard.hold()
    let saved = false
    try {
      const result = await setCreationAccess(person.id, draft, base.etag)
      if (!alive.current) return
      setBase(result); setDraft(result.canCreateWorkspaces); setReview(false); guard.release()
      setStatus(result.canCreateWorkspaces
        ? 'Workspace-creation permission granted. Existing workspace access is unchanged.'
        : 'Workspace-creation permission revoked for future creation. Existing ownership and membership are unchanged.')
      saved = true
    } catch (caught) {
      if (!alive.current) return
      setError(accessChangeFailure(caught)); setRecovery(true); setReview(false)
    } finally {
      inFlight.current = false
      if (alive.current) { setPending(false); guard.settle() }
    }
    try { await onAccessChanged() } catch (caught) {
      if (alive.current) setError(previous => `${previous ? `${previous} ` : ''}${saved ? 'The change was saved, but' : 'Also,'} refreshing your session failed: ${caught instanceof Error ? caught.message : 'Service unavailable'}. Use Refresh access before another action.`)
    }
  }

  return <div className="settings-app">
    <a className="skip-link" href="#admin-users-content">Skip to user access</a>
    <header className="settings-header">
      <span className="cloud-gate-brand"><Layers3 size={20} />{policy.settings?.appearance.applicationTitle ?? 'Score'}</span>
      <div className="flex flex-wrap items-center gap-3"><Badge tone="accent"><ShieldCheck size={13} />Application administrator</Badge><ThemeControl />
        <Button icon={Settings} onClick={() => void onOpenSettings()}>Application settings</Button>
        <Button icon={ArrowLeft} onClick={() => void guard.leave(onLeave)}>Back to workspaces</Button>
      </div>
    </header>
    <main id="admin-users-content" className="settings-main">
      <PageHeader eyebrow="APPLICATION ADMINISTRATION" title="Users / user access"
        description="Grant individuals permission to create workspaces. Score admission is managed in Microsoft Entra ID; workspace membership is managed separately by workspace owners." />
      <div className="settings-grid">
        <section className="panel settings-section"><h2>Find an eligible person</h2>
          <EligiblePeoplePicker load={listEligibleUsers} selectedId={person?.id} disabled={pending}
            onChoose={chosen => { if (chosen.id !== person?.id) void guard.close(() => setPerson(chosen)) }} />
        </section>
        <section className="panel settings-section" aria-label="Workspace-creation permission">
          <h2>Workspace-creation permission</h2>
          {!person ? <p>Select a person to view their explicit creation grant. Owning an existing workspace does not grant permission to create another.</p> : <>
            <div className="access-person"><strong>{person.name || person.email || person.id}</strong><span>{person.email || 'Email unavailable'}</span></div>
            {loading && <p role="status">Loading current permission…</p>}
            {error && <InlineError>{error}</InlineError>}
            {status && <p role="status" className="settings-status">{status}</p>}
            {applicationAdmin && <p className="access-notice">This person is an application administrator and can create workspaces without an individual grant. Removing a grant cannot restrict that role. Entra administrators manage application roles.</p>}
            {base && <label className="check-label my-4"><input type="checkbox" checked={applicationAdmin || draft}
              disabled={applicationAdmin || pending || recovery} onChange={event => { setDraft(event.target.checked); setStatus('') }} />Can create workspaces</label>}
            {policy.settings?.workspaces.allowCreation === false && <p className="access-notice">Creation is currently disabled by application policy for everyone, including administrators. A saved grant takes effect only when that global policy is enabled.</p>}
            <p>Revocation stops future workspace creation only. It does not remove existing workspaces or change membership. No automatic grant is given to existing owners.</p>
            <div className="flex flex-wrap gap-3">
              <Button icon={RefreshCw} disabled={pending || loading} onClick={() => void guard.close(() => { guard.release(); setRevision(value => value + 1) })}>Refresh current access</Button>
              {!applicationAdmin && <Button variant="primary" disabled={!dirty || pending || loading || recovery} onClick={() => setReview(true)}>Review permission change</Button>}
            </div>
            {recovery && <p className="access-hint">Your proposed choice is retained. Refresh current access to discard that proposal and inspect the authoritative result before choosing a new change. No request will be replayed.</p>}
          </>}
        </section>
      </div>
      <p className="access-hint">Owners and editors cannot grant workspace-creation permission. This permission is not included in application settings imports or exports.</p>
    </main>
    <Modal open={review} onOpenChange={setReview} dismissDisabled={pending} title={draft ? 'Grant workspace creation?' : 'Revoke workspace creation?'}
      description={`${draft ? 'Allow' : 'Stop'} future workspace creation for ${person?.name || person?.email || 'this person'}.`}
      footer={<><Button disabled={pending} onClick={() => setReview(false)}>Cancel</Button><Button variant={draft ? 'primary' : 'danger'} disabled={pending || recovery} onClick={() => void save()}>{pending ? 'Saving permission…' : draft ? 'Grant permission' : 'Revoke permission'}</Button></>}>
      <p>Existing ownership, membership, content, and accepted background work are not changed. The global creation policy still applies.</p>
    </Modal>
  </div>
}
