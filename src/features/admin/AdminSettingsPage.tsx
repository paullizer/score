import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, History, Layers3, LoaderCircle, RefreshCw, Save, Search, ShieldCheck, Upload, Users } from 'lucide-react'
import type {
  AdminSettings, AdminSettingsResponse, DeploymentInventory, ModelTaskId, ModelTestResult,
  SettingsChange, SettingsFieldError, SettingsRevision, SettingsSection,
} from '../../domain/admin-settings'
import { MODEL_TASK_IDS } from '../../domain/admin-settings-tasks'
import { parseAdminSettings, SettingsValidationError, upgradeQcAdminSettings } from '../../domain/admin-settings-schema'
import { diffAdminSettings } from '../../domain/admin-settings-resolver'
import * as service from '../../services/adminSettings'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { ThemeControl } from '../../app/ThemeControl'
import { Badge, Button, InlineError, Modal, PageHeader, SearchField } from '../../components/ui'
import { ModelSettingsEditor } from './ModelSettingsEditor'
import { SettingsField } from './SettingsField'
import { describeSettingValue, rebaseSettingsDraft, updateSetting } from './settingsForm'

const sections: { id: SettingsSection; title: string }[] = [
  { id: 'ai', title: 'AI deployments & tasks' }, { id: 'intake', title: 'Features & intake' }, { id: 'grades', title: 'GS ladders & references' },
  { id: 'processing', title: 'Processing & summaries' }, { id: 'presentation', title: 'Appearance & reports' }, { id: 'access', title: 'Access & privacy' },
  { id: 'operations', title: 'Operations' },
]
type Review = { kind: 'save' | 'defaults'; candidate: AdminSettings }
  | { kind: 'restore'; candidate: AdminSettings; revision: string }
  | { kind: 'import'; candidate: AdminSettings; document: unknown; etag: string }

function Changes({ changes, label }: { changes: SettingsChange[]; label: string }) {
  return <div className="settings-diff" aria-label={label}>
    {changes.length ? <table><thead><tr><th scope="col">Setting</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>{changes.map(change => <tr key={change.path}><th scope="row"><code>{change.path}</code></th>
        <td><pre>{describeSettingValue(change.path, change.before)}</pre></td><td><pre>{describeSettingValue(change.path, change.after)}</pre></td></tr>)}</tbody></table>
      : <p>No settings differ.</p>}
  </div>
}

export function AdminSettingsPage({ onLeave, onOpenUsers }: { onLeave: () => void; onOpenUsers?: () => Promise<void> }) {
  const policy = usePublicSettings()
  const [base, setBase] = useState<AdminSettingsResponse | null>(null)
  const [draft, setDraft] = useState<AdminSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<SettingsFieldError[]>([])
  const [status, setStatus] = useState('')
  const [section, setSection] = useState<SettingsSection | 'history' | 'environment'>('ai')
  const [search, setSearch] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [conflict, setConflict] = useState<AdminSettingsResponse | null>(null)
  const [conflictPending, setConflictPending] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [history, setHistory] = useState<Omit<SettingsRevision, 'settings'>[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | undefined>()
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyDetail, setHistoryDetail] = useState<SettingsRevision | null>(null)
  const historyCursors = useRef(new Set<string>())
  const [inventory, setInventory] = useState<DeploymentInventory | null>(null)
  const [probeOpen, setProbeOpen] = useState(false)
  const [probeKind, setProbeKind] = useState<ModelTestResult['kind']>('task')
  const [probeTask, setProbeTask] = useState<ModelTaskId>('jobRubric')
  const [probeDeployment, setProbeDeployment] = useState('')
  const [costAcknowledged, setCostAcknowledged] = useState(false)
  const [probe, setProbe] = useState<ModelTestResult | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const live = useRef(true)
  const inFlight = useRef(false)
  const changes = base && draft ? diffAdminSettings(base.settings, draft) : []
  const guard = useGradeLeaveGuard(changes.length > 0 || review !== null || importText.length > 0, pending, 'Application settings')

  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    void service.readAdminSettings(controller.signal).then(response => {
      if (controller.signal.aborted) return
      setBase(response); setDraft(structuredClone(response.settings)); setLoading(false)
      setProbeDeployment(response.settings.ai.defaultDeploymentId)
    }).catch(caught => {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : 'Application settings could not be loaded.')
      setLoading(false)
    })
    return () => { live.current = false; controller.abort() }
  }, [])

  function update(path: string, value: unknown) {
    if (!draft || pending) return
    setDraft(updateSetting(draft, path, value))
    setStatus('')
  }

  function validate(candidate: AdminSettings): AdminSettings | null {
    try {
      const normalized = parseAdminSettings(candidate)
      setErrors([]); setError('')
      return normalized
    } catch (caught) {
      if (caught instanceof SettingsValidationError) {
        setErrors(caught.fields)
        setError('Correct the validation errors below. Your draft has been retained.')
      } else setError(caught instanceof Error ? caught.message : 'Settings could not be validated.')
      return null
    }
  }

  async function fail(caught: unknown) {
    if (!live.current) return
    if (caught instanceof SettingsValidationError) setErrors(caught.fields)
    if (caught instanceof service.SettingsRequestError) {
      setErrors(caught.fields)
      if (caught.status === 409 || caught.status === 412) {
        setConflictPending(true)
        setError('Another administrator changed these settings. Your draft is retained. Reload or compare and explicitly review it against the current revision; nothing was overwritten.')
        try { const current = await service.readAdminSettings(); if (live.current) setConflict(current) }
        catch (readError) { if (live.current) setError(`The save conflicted and the latest revision could not be loaded: ${readError instanceof Error ? readError.message : 'Service unavailable'}. Your draft is retained.`) }
        return
      }
    }
    setError(caught instanceof Error ? caught.message : 'The request did not complete. Your draft is retained; no successful save is assumed.')
  }

  async function action(operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setPending(true); setError(''); setStatus(''); guard.hold()
    try { await operation() } catch (caught) { await fail(caught) }
    finally { inFlight.current = false; if (live.current) { setPending(false); guard.settle() } }
  }

  async function applyReview() {
    if (!review || !base || conflictPending) return
    const chosen = review
    const normalized = validate(chosen.candidate)
    if (!normalized) return
    await action(async () => {
      const result = chosen.kind === 'restore' ? await service.restoreAdminSettings(chosen.revision, base.etag)
        : chosen.kind === 'import' ? await service.importAdminSettings(chosen.document, chosen.etag)
        : await service.saveAdminSettings(normalized, base.etag)
      if (!live.current) return
      setBase(result); setDraft(structuredClone(result.settings)); setReview(null); setErrors([]); setConflict(null); setConflictPending(false)
      setImportText(''); setHistoryLoaded(false); setHistory([]); setHistoryCursor(undefined); historyCursors.current.clear()
      setStatus(`Saved application settings revision ${result.revision}. Accepted operations retain their captured policy; deployment changes still require operator rollout.`)
      guard.release()
      await policy.refresh()
    })
  }

  async function loadHistory(cursor?: string) {
    await action(async () => {
      if (cursor && historyCursors.current.has(cursor)) throw new Error('The history service repeated a continuation token. Refresh history rather than showing duplicate revisions.')
      const result = await service.readSettingsHistory(cursor)
      if (!live.current) return
      if (result.nextBefore && (result.nextBefore === cursor || historyCursors.current.has(result.nextBefore))) throw new Error('The history service repeated a continuation token.')
      if (new Set(result.revisions.map(item => item.revision)).size !== result.revisions.length || (cursor && result.revisions.some(item => history.some(previous => previous.revision === item.revision)))) throw new Error('The history service repeated a revision. Refresh history rather than appending duplicates.')
      if (!cursor) historyCursors.current.clear()
      else historyCursors.current.add(cursor)
      setHistory(current => cursor ? [...current, ...result.revisions] : result.revisions)
      setHistoryCursor(result.nextBefore); setHistoryLoaded(true)
    })
  }

  async function exportSettings() {
    await action(async () => {
      const exported = await service.exportAdminSettings()
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `score-settings-${exported.sourceRevision}.json`
      document.body.append(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatus('Exported the saved nonsecret configuration, not unsaved edits. Bootstrap identity, endpoints, credentials, and deployment trust metadata are excluded.')
    })
  }

  if (loading) return <main className="recovery-page"><p role="status">Loading application settings…</p></main>
  if (!base || !draft) return <main className="recovery-page"><div className="panel recovery-card">
    <h1>Application settings unavailable</h1><InlineError>{error || 'The server did not return settings. No local substitute was created.'}</InlineError>
    <Button onClick={onLeave}>Back to workspaces</Button><Button onClick={() => window.location.reload()}>Retry settings</Button>
  </div></main>
  const availableFields = base.fields.filter(field => draft.schemaVersion !== 1 || !/^(?:ai\.tasks\.qcPlan|processing\.qc|workers\.qc)(?:\.|$)/.test(field.path))
  const fields = availableFields.filter(field => field.control !== 'deployments' && (!search ? field.section === section : `${field.path} ${field.label} ${field.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    && (advanced || Boolean(search) || field.classification !== 'advanced'))
  const reviewChanges = review ? diffAdminSettings(base.settings, review.candidate) : []
  const appearance = policy.settings?.appearance ?? base.settings.appearance
  const workerVerification = base.environment.workerVerification
  const runtimeReadiness = base.environment.runtimeReadiness
  const paidProbe = probeKind !== 'connection'
  const probeTaskAvailable = draft.ai.tasks[probeTask] !== undefined

  return <div className="settings-app">
    <a className="skip-link" href="#admin-settings-content">Skip to settings</a>
    <header className="settings-header">
      <span className="cloud-gate-brand"><Layers3 size={20} />{appearance.applicationTitle}</span>
      <div className="flex flex-wrap items-center gap-3"><Badge tone="accent"><ShieldCheck size={13} />Application administrator</Badge><ThemeControl />
        {onOpenUsers && <Button icon={Users} onClick={() => void onOpenUsers()}>Users / user access</Button>}
        <Button icon={ArrowLeft} onClick={() => { void guard.leave(onLeave) }}>Back to workspaces</Button></div>
    </header>
    <main id="admin-settings-content" className="settings-main">
      <PageHeader eyebrow="APPLICATION-WIDE · NOT A WORKSPACE ROLE" title="Application settings"
        description="Versioned policies for new work. Saved evidence, approvals, and historical results are never rewritten by changing these settings."
        actions={<><Button icon={Download} disabled={pending} onClick={() => void exportSettings()}>Export saved settings</Button><Button icon={Upload} disabled={pending} onClick={() => setImportOpen(true)}>Import settings</Button></>} />
      <div className="settings-savebar">
        <p><strong>{changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}</strong> · Saved revision <code>{base.revision}</code> · {base.createdAt}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={pending || !changes.length} onClick={() => setDiscard(true)}>Discard</Button>
          <Button disabled={pending} onClick={() => { setDraft(structuredClone(base.defaults)); setReview({ kind: 'defaults', candidate: structuredClone(base.defaults) }) }}>Review reset to defaults</Button>
          <Button variant="primary" icon={pending ? LoaderCircle : Save} disabled={pending || !changes.length || conflictPending} onClick={() => {
            const candidate = validate(draft); if (candidate) { setDraft(candidate); setReview({ kind: 'save', candidate }) }
          }}>Review and save</Button></div>
      </div>
      {draft.schemaVersion === 1 && <section className="panel settings-section" aria-label="QC settings upgrade">
        <h2>Add QC settings to a new configuration revision</h2>
        <p>This version 1 configuration remains unchanged. Add the QC model and worker policy to your draft without resetting existing settings, then explicitly review and publish a new revision. Accepted work keeps its original captured policy.</p>
        <Button disabled={pending || conflictPending} onClick={() => void action(async () => {
          const upgraded = upgradeQcAdminSettings(draft)
          setDraft(upgraded); setErrors([])
          setStatus('QC settings were added only to this draft. Review and save to publish; no model work has started.')
        })}>Add QC settings to draft</Button>
      </section>}
      {error && <div className="my-4"><InlineError>{error}</InlineError></div>}
      {errors.length > 0 && <section className="settings-error-list" aria-label="Settings validation errors"><h2>Validation errors — draft retained</h2><ul>
        {errors.map((item, index) => <li key={index}><button type="button" className="text-link" onClick={() => { setSearch(item.path); setAdvanced(true) }}>{item.path || 'settings'}</button>: {item.message}</li>)}
      </ul></section>}
      {status && <p className="settings-status" role="status">{status}</p>}
      {conflictPending && <section className="panel settings-section" aria-label="Settings conflict">
        <h2>Review concurrent changes</h2>
        {conflict ? <><p>Current server revision: <code>{conflict.revision}</code>. Choose explicitly; no automatic overwrite or retry.</p>
          <details open><summary>What changed on the server</summary><Changes changes={diffAdminSettings(base.settings, conflict.settings)} label="Server changes" /></details>
          <details><summary>Your draft compared with current settings</summary><Changes changes={diffAdminSettings(conflict.settings, review?.candidate ?? draft)} label="Draft versus current" /></details>
          <div className="flex flex-wrap gap-2"><Button disabled={pending} onClick={() => {
            setBase(conflict); setDraft(structuredClone(conflict.settings)); setConflict(null); setConflictPending(false); setReview(null); setErrors([]); setError(''); setImportText('')
          }}>Reload current and discard my draft</Button><Button disabled={pending} onClick={() => {
            const rebased = rebaseSettingsDraft(conflict.settings, diffAdminSettings(base.settings, review?.candidate ?? draft))
            setBase(conflict); setDraft(rebased); setConflict(null); setConflictPending(false); setReview(null); setError('')
            setStatus('Your changed fields have been placed on the current revision for review. Nothing has been saved. Review overlapping changes carefully.')
          }}>Rebase my changes for review</Button></div></>
          : <Button disabled={pending} onClick={() => void action(async () => { const current = await service.readAdminSettings(); setConflict(current) })}>Load current revision for comparison</Button>}
      </section>}
      <div className="settings-toolbar"><SearchField value={search} onChange={setSearch} placeholder="Search settings, descriptions, or paths" label="Search application settings" />
        <label className="check-label"><input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />Show advanced controls</label></div>
      <nav className="settings-tabs" aria-label="Settings sections">{sections.map(item => <button key={item.id} aria-current={section === item.id && !search ? 'page' : undefined}
        onClick={() => { setSection(item.id); setSearch('') }}>{item.title}</button>)}
        <button aria-current={section === 'history' && !search ? 'page' : undefined} onClick={() => { setSection('history'); setSearch(''); if (!historyLoaded) void loadHistory() }}><History size={14} />History & restore</button>
        <button aria-current={section === 'environment' && !search ? 'page' : undefined} onClick={() => { setSection('environment'); setSearch('') }}>Environment & readiness</button>
      </nav>
      {(section === 'ai' || search) && <ModelSettingsEditor settings={draft} saved={base.settings} defaults={base.defaults} fields={availableFields.filter(field => advanced || search || field.classification !== 'advanced')}
        errors={errors} onChange={update} inventory={inventory} disabled={pending} search={search} />}
      {fields.some(field => !field.path.startsWith('ai.tasks.') && field.path !== 'ai.defaultDeploymentId') && <section className="panel settings-section">
        <h2>{search ? 'Matching settings' : sections.find(item => item.id === section)?.title}</h2>
        <div className="settings-grid">{fields.filter(field => !field.path.startsWith('ai.tasks.') && field.path !== 'ai.defaultDeploymentId').map(field =>
          <SettingsField key={field.path} field={field} settings={draft} saved={base.settings} defaults={base.defaults} errors={errors} onChange={update} disabled={pending} />)}</div>
      </section>}
      {(section === 'ai' || section === 'environment') && !search && <section className="panel settings-section" aria-label="Deployment discovery and synthetic tests">
        <h2>Inventory and explicit synthetic tests</h2><p>Inventory refresh reads existing deployments; it does not create deployments, save settings, or run inference. Tests are separate, use only synthetic nonprivate content, and never save the draft.</p>
        <div className="flex flex-wrap gap-2"><Button icon={RefreshCw} disabled={pending || !base.environment.model.inventoryAvailable} onClick={() => void action(async () => {
          const result = await service.refreshDeploymentInventory(); setInventory(result); setStatus(`Deployment inventory checked at ${result.checkedAt}. Review additions in the catalog; nothing was saved.`)
        })}>Refresh deployment inventory</Button>
          <Button disabled={pending} onClick={() => { setCostAcknowledged(false); setProbeOpen(true) }}>Configure synthetic test</Button></div>
        {!base.environment.model.inventoryAvailable && <p className="field-hint">Inventory discovery is not configured or the API identity lacks scoped deployment-read permission. Ask an operator; a catalog dropdown does not grant permission.</p>}
        {probe && <div role="status" className="settings-status"><strong>{probe.kind}: {probe.status}</strong><p>{probe.checkedAt} · {probe.identity} · deployment {probe.deploymentId}</p>
          <ul>{probe.checks.map((check, index) => <li key={index}>{check.passed ? 'Passed' : 'Failed'}: {check.name} — {check.message}</li>)}</ul>
          <p>Worker identities are not verified by this API-side result. A passing probe is not proof of worker readiness or rollout.</p></div>}
      </section>}
      {section === 'history' && !search && <section className="panel settings-section" aria-label="Settings revision history">
        <h2>Immutable revision history</h2><p>Restore validates an old configuration and publishes a new revision. It does not delete history or rewrite accepted work.</p>
        <Button size="sm" disabled={pending} onClick={() => void loadHistory()}>Refresh history</Button>
        {history.map(item => <article key={item.revision} className="settings-history-entry">
          <strong>{item.revision}</strong><span>{item.createdAt} · {item.reason} · {'system' in item.actor ? item.actor.system : item.actor.oid}</span>
          <Button size="sm" disabled={pending} onClick={() => void action(async () => { setHistoryDetail(await service.readSettingsRevision(item.revision)) })}>Inspect revision {item.revision}</Button>
        </article>)}
        {!history.length && historyLoaded && <p>No revisions were returned.</p>}
        {historyCursor && <Button disabled={pending} onClick={() => void loadHistory(historyCursor)}>Load older revisions</Button>}
        {historyDetail && <div className="mt-4"><h3>Revision {historyDetail.revision}</h3>
          <Changes changes={historyDetail.changes} label="Historical revision changes" />
          <Button disabled={pending} onClick={() => setReview({ kind: 'restore', revision: historyDetail.revision, candidate: historyDetail.settings })}>Review restore as new revision</Button>
        </div>}
      </section>}
      {section === 'environment' && !search && <section className="panel settings-section" aria-label="Read-only environment and administrator roster">
        <h2>Read-only environment & bootstrap administrators</h2>
        <p>Application administrator access is explicitly granted by tenant-scoped object ID at deployment. Workspace owners are not automatically application administrators; this role does not grant private workspace access.</p>
        <dl className="settings-facts"><dt>New-processing rollout flag</dt><dd>{base.environment.runtimeEnabled ? 'Enabled' : 'Disabled'}</dd>
          <dt>New-processing admission</dt><dd>{runtimeReadiness ? runtimeReadiness.newProcessingAllowed ? 'Allowed' : 'Paused' : 'Not reported'}</dd>
          <dt>Policy source</dt><dd>{runtimeReadiness?.configured
            ? 'Saved policy remains enforced for access, exports, limits, and appearance even while new processing is paused.'
            : runtimeReadiness ? 'Legacy defaults — no settings service is configured.' : 'Not reported'}</dd>
          <dt>API reader contract</dt><dd><code>{base.environment.runtimeSettingsVersion ?? 'Not reported'}</code></dd>
          <dt>Settings store</dt><dd>{base.environment.storeConfigured ? 'Configured' : 'Not configured'}</dd><dt>Tenant ID</dt><dd>{base.environment.tenantId}</dd>
          <dt>Administrator object IDs</dt><dd>{base.environment.administratorUserIds.join(', ') || 'No bootstrap administrator IDs configured'}</dd>
          <dt>Azure model endpoint</dt><dd>{base.environment.model.endpoint ?? 'Not configured'}</dd><dt>Azure resource ID</dt><dd>{base.environment.model.resourceId ?? 'Not configured'}</dd>
          <dt>Authentication</dt><dd>{base.environment.model.authentication}</dd><dt>Probe identity</dt><dd>{base.environment.model.probeIdentity}</dd>
          <dt>Worker rollout evidence</dt><dd>{workerVerification
            ? 'Recorded verification-time evidence only — not live worker health.'
            : 'No verification-time worker rollout evidence recorded.'}</dd>
          {workerVerification && <>
            <dt>Worker reader contract at verification</dt><dd><code>{workerVerification.workerVersion}</code></dd>
            <dt>Worker image at verification</dt><dd><code className="break-all">{workerVerification.image}</code></dd>
            <dt>Verified at</dt><dd><time dateTime={workerVerification.verifiedAt}>{workerVerification.verifiedAt}</time></dd>
          </>}
          <dt>Worker identity and inference health</dt><dd>Not verified by API-side synthetic tests. A recorded rollout check does not monitor current worker identity, inference health, or deployment drift.</dd></dl>
        {runtimeReadiness?.message && <p role="status">{runtimeReadiness.message}</p>}
        <p>No credentials, secret values, arbitrary endpoints, or administrator promotion controls are editable here.</p>
      </section>}
      <footer className="workspace-footer"><ShieldCheck size={14} /><span>Application policy cannot disable evidence integrity, grounding review, privacy boundaries, or required human approval.</span></footer>
    </main>
    <Modal open={discard} onOpenChange={setDiscard} title="Discard settings draft?" description="Saved settings and accepted work are unchanged."
      footer={<><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={() => { setDraft(structuredClone(base.settings)); setErrors([]); setError(''); setReview(null); setDiscard(false); setImportText('') }}>Discard settings draft</Button></>}>
      <p>Discard {changes.length} unsaved changes in this tab?</p>
    </Modal>
    <Modal open={review !== null && !conflictPending} onOpenChange={open => { if (!open && !pending) setReview(null) }}
      title={review?.kind === 'restore' ? 'Review settings restore' : review?.kind === 'import' ? 'Review settings import' : review?.kind === 'defaults' ? 'Review reset to defaults' : 'Review application changes'}
      description="Publishing creates a new revision. Only reviewed configuration changes are saved; no data is deleted or historical operation rewritten." wide dismissDisabled={pending}
      footer={<><Button disabled={pending} onClick={() => setReview(null)}>Keep editing</Button><Button variant="primary" disabled={pending || !reviewChanges.length} onClick={() => void applyReview()}>Publish new revision</Button></>}>
      <p>Base revision: {base.revision}. {reviewChanges.length} changes. {review?.kind === 'restore' && `Restoring ${review.revision} as a new revision.`}</p>
      {error && <InlineError>{error}</InlineError>}<Changes changes={reviewChanges} label="Changes to publish" />
      <p>Activation is per field: next public refresh, new operation, or next worker execution. A save does not provision Azure deployments or verify worker readiness.</p>
    </Modal>
    <Modal open={importOpen} onOpenChange={setImportOpen} title="Preview nonsecret settings import" description="Only the versioned Score settings export format is accepted. Unknown fields, credentials, bootstrap roster, and trust claims are rejected." wide dismissDisabled={pending}
      footer={<><Button disabled={pending} onClick={() => setImportOpen(false)}>Close</Button><Button icon={Search} disabled={pending || !importText.trim()} onClick={() => void action(async () => {
        let document: unknown
        try { document = JSON.parse(importText) } catch { throw new Error('The import is not valid JSON. Your draft and import text are retained.') }
        const preview = await service.previewSettingsImport(document, base.etag)
        setReview({ kind: 'import', candidate: preview.settings, document, etag: preview.etag }); setImportOpen(false)
        if (preview.baseRevision !== base.revision || preview.etag !== base.etag) {
          setConflictPending(true); setConflict(await service.readAdminSettings())
          setError('The import preview uses a newer server revision. Review the current settings before applying any changes.')
        }
      })}>Validate and preview import</Button></>}>
      <label className="field"><span className="field-label">Settings JSON file</span><input type="file" accept=".json,application/json" disabled={pending}
        onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
          if (!file) return
          if (file.size > 2 * 1024 * 1024) { setError('Choose a settings JSON file no larger than 2 MiB.'); return }
          void file.text().then(text => { if (live.current) setImportText(text) }).catch(() => setError('The settings file could not be read.'))
        }} /></label>
      <label className="field mt-4"><span className="field-label">Import JSON</span><textarea className="input settings-json" rows={10} maxLength={2 * 1024 * 1024} value={importText} disabled={pending} onChange={event => setImportText(event.target.value)} /></label>
      {error && <InlineError>{error}</InlineError>}<p>Preview does not save anything. Applying an import replaces the reviewed settings, including any local unsaved edits, only after explicit publication.</p>
    </Modal>
    <Modal open={probeOpen} onOpenChange={setProbeOpen} title="Explicit synthetic model test" description="Tests never use private resumes, jobs, source documents, or workspace data. They do not save your settings draft." dismissDisabled={pending}
      footer={<><Button disabled={pending} onClick={() => setProbeOpen(false)}>Cancel</Button><Button disabled={pending || (paidProbe && !costAcknowledged) || (probeKind === 'task' && !probeTaskAvailable)} onClick={() => {
        const candidate = validate(draft); if (!candidate) return
        void action(async () => {
          let deploymentId = probeDeployment
          if (probeKind === 'task') {
            const binding = candidate.ai.tasks[probeTask]
            if (!binding) throw new Error(`The settings draft does not configure ${probeTask}. Choose an available task before running a synthetic test.`)
            deploymentId = binding.deploymentId ?? candidate.ai.defaultDeploymentId
          }
          const result = await service.testModelConfiguration({ kind: probeKind, deploymentId, ...(probeKind === 'task' ? { taskId: probeTask } : {}), settings: candidate, acknowledgeCost: paidProbe && costAcknowledged })
          setProbe(result); setProbeOpen(false)
        })
      }}>Run explicit test</Button></>}>
      <div className="space-y-4"><label className="field"><span className="field-label">Test kind</span><select className="input" disabled={pending} value={probeKind} onChange={event => { setProbeKind(event.target.value as ModelTestResult['kind']); setCostAcknowledged(false) }}>
        <option value="connection">Connection only</option><option value="structured-output">Minimal structured output</option><option value="task">Task configuration compatibility</option>
      </select></label>
        {probeKind === 'task' ? <label className="field"><span className="field-label">Synthetic task</span><select className="input" value={probeTask} disabled={pending} onChange={event => { setProbeTask(event.target.value as ModelTaskId); setCostAcknowledged(false) }}>
          {!probeTaskAvailable && <option value={probeTask} disabled>Unavailable in this settings version: {probeTask}</option>}
          {MODEL_TASK_IDS.filter(task => draft.ai.tasks[task] !== undefined).map(task => <option key={task}>{task}</option>)}
        </select></label>
          : <label className="field"><span className="field-label">Test deployment</span><select className="input" value={probeDeployment} disabled={pending} onChange={event => { setProbeDeployment(event.target.value); setCostAcknowledged(false) }}>{draft.ai.deployments.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        {probeKind === 'task' && !probeTaskAvailable && <InlineError>The selected task is not configured in this settings version. Choose an available task; no test will run.</InlineError>}
        {paidProbe ? <><p><strong>Paid-call notice:</strong> synthetic inference can consume Azure quota and incur charges. No paid call runs until you explicitly confirm.</p>
          <label className="check-label"><input type="checkbox" checked={costAcknowledged} disabled={pending} onChange={event => setCostAcknowledged(event.target.checked)} />I authorize this synthetic test and acknowledge possible charges.</label></>
          : <p>Connection-only checks are a free scoped management read. They do not run model inference.</p>}
        <p>A connection check, structured-output probe, and task test are different checks. Any success verifies the API test identity only, not worker identities, their adoption, or complete production readiness.</p>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  </div>
}
