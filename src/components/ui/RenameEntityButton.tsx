import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { useRealResumes } from '../../app/real-resumes-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { DISPLAY_NAME_MAX_LENGTH, getDisplayName, normalizeDisplayName } from '../../domain/displayNames'
import { useLifecycleAccess } from '../lifecycle/useLifecycleAccess'
import { Button, InlineError, Modal } from './index'

type RenameTarget = { kind: 'analysis' | 'job' | 'resume'; id: string }
interface RenameRequest {
  target: RenameTarget
  name: string
  etag?: string
  trigger: HTMLElement
}
const RenameContext = createContext<((request: RenameRequest) => void) | null>(null)
const fieldNames = { analysis: 'Analysis name', job: 'Job display title', resume: 'Resume label' }
const descriptions = {
  analysis: 'Change the display name, not the saved inputs, evidence, or scores. Newly generated reports use this name.',
  job: 'Use a recognizable display title. The source-stated job title, original file, and rubric stay unchanged.',
  resume: 'Use a recognizable label, not a correction to the person’s identity. The source-stated name and original filename stay unchanged.',
}

// Keep the editor outside filtered rows so a refresh or successful rename cannot discard its draft.
export function RenameEntityProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<RenameRequest | null>(null)
  return <RenameContext.Provider value={setRequest}>
    {children}
    {request && <RenameEntityDialog request={request} onClose={() => setRequest(null)} />}
  </RenameContext.Provider>
}

export function RenameEntityButton({ target, name, etag, disabled = false, compact = false }: {
  target: RenameTarget; name: string; etag?: string; disabled?: boolean; compact?: boolean
}) {
  const open = useContext(RenameContext)
  const { canEdit } = useLifecycleAccess(target)
  return <Button size={compact ? 'sm' : 'md'} variant={compact ? 'ghost' : 'secondary'} icon={Pencil}
    className={compact ? 'icon-button' : undefined} disabled={disabled || !canEdit || !open}
    aria-label={`Rename ${target.kind}: ${name}`}
    title={!canEdit ? 'Unarchive this item and use an editable workspace to rename it.' : `Edit ${fieldNames[target.kind].toLowerCase()}`}
    onClick={(event) => open?.({ target: { ...target }, name, etag, trigger: event.currentTarget })}>
    {!compact && (target.kind === 'resume' ? 'Edit label' : 'Rename')}
  </Button>
}

function RenameEntityDialog({ request, onClose }: { request: RenameRequest; onClose: () => void }) {
  const { cloud, renameEntity } = useWorkspace()
  const analyses = useRealAnalyses()
  const resumes = useRealResumes()
  const access = useLifecycleAccess(request.target)
  const [base, setBase] = useState({ name: request.name, etag: request.etag })
  const [draft, setDraft] = useState(request.name)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [reviewLatest, setReviewLatest] = useState(false)
  const busy = useRef(false)
  const alive = useRef(true)
  const input = useRef<HTMLInputElement>(null)
  const formId = useId()
  const errorId = useId()
  const pending = saving || reloading
  const dirty = draft !== base.name
  const real = request.etag !== undefined
  const serviceWritable = request.target.kind === 'job' ? cloud?.realJobs.phase === 'ready'
    : request.target.kind === 'resume' ? resumes?.canWrite && resumes.phase === 'ready' : analyses?.canWrite && analyses.phase === 'ready'
  const canEdit = access.canEdit && (!real || serviceWritable)
  const guard = useGradeLeaveGuard(dirty, pending, `${fieldNames[request.target.kind]}: ${request.name}`)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  function latest() {
    const { kind, id } = request.target
    if (kind === 'job') {
      const summary = cloud?.realJobs.summaries.find((item) => item.job.id === id)
      return summary && cloud?.realJobs.phase === 'ready' && !cloud.realJobs.error
        ? { name: getDisplayName(summary, summary.job.title), etag: summary.etag } : null
    }
    if (kind === 'resume') {
      const summary = resumes?.summaries.find((item) => item.resume.id === id)
      return summary && resumes?.phase === 'ready' && !resumes.error
        ? { name: getDisplayName(summary, summary.resume.name?.trim() || 'Name not stated'), etag: summary.etag } : null
    }
    const summary = analyses?.summaries.find((item) => item.run.id === id)
    return summary && analyses?.phase === 'ready' && !analyses.error
      ? { name: getDisplayName(summary.run, summary.run.name), etag: summary.etag } : null
  }
  const loaded = reviewLatest ? latest() : null
  function draftMatches(name: string) {
    try { return normalizeDisplayName(draft) === name }
    catch { return false }
  }
  const matchesLoaded = loaded && draftMatches(loaded.name)
  const loadError = request.target.kind === 'job' ? cloud?.realJobs.error
    : request.target.kind === 'resume' ? resumes?.error : analyses?.error

  function close() {
    if (!busy.current) void guard.close(onClose)
  }
  async function save() {
    if (busy.current || !canEdit || reviewLatest) return
    let name: string
    try { name = normalizeDisplayName(draft) }
    catch (caught) {
      setFieldError(caught instanceof Error ? caught.message : 'Enter a valid display name.')
      input.current?.focus()
      return
    }
    busy.current = true
    guard.hold()
    setSaving(true)
    setError('')
    setFieldError('')
    try {
      await renameEntity(request.target, name, base.etag)
      if (!alive.current) return
      guard.release()
      onClose()
    } catch (caught) {
      if (alive.current) {
        guard.settle()
        setError(caught instanceof Error ? caught.message : 'The name change could not be acknowledged. Your draft has been kept.')
      }
    } finally {
      busy.current = false
      if (alive.current) setSaving(false)
    }
  }
  async function reload() {
    if (busy.current || !real) return
    busy.current = true
    guard.hold()
    setReloading(true)
    setReviewLatest(false)
    try {
      if (request.target.kind === 'job') await cloud?.realJobs.refresh()
      else if (request.target.kind === 'resume') await resumes?.refresh()
      else await analyses?.refresh()
      if (alive.current) setReviewLatest(true)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'The latest name could not be loaded. Your draft has been kept.')
    } finally {
      busy.current = false
      if (alive.current) {
        guard.settle()
        setReloading(false)
      }
    }
  }
  function restoreFocus(event: Event) {
    event.preventDefault()
    if (request.trigger.isConnected && !(request.trigger as HTMLButtonElement).disabled) request.trigger.focus()
    else {
      const scope = document.querySelector('main') ?? document
      const fallback = scope.querySelector<HTMLElement>('input[type="search"]') ?? scope.querySelector<HTMLElement>('h1')
      fallback?.focus()
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open) close() }} title={`Edit ${fieldNames[request.target.kind].toLowerCase()}`}
    description={descriptions[request.target.kind]} dismissDisabled={pending}
    onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select() }} onCloseAutoFocus={restoreFocus}
    footer={<><Button disabled={pending} onClick={close}>Cancel</Button><Button type="submit" form={formId} variant="primary"
      disabled={pending || !canEdit || !dirty || reviewLatest}>{saving ? 'Saving…' : 'Save name'}</Button></>}>
    <form id={formId} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label className="field"><span className="field-label">{fieldNames[request.target.kind]}</span>
        <input ref={input} className="input" value={draft} maxLength={DISPLAY_NAME_MAX_LENGTH} disabled={pending || !canEdit}
          aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? errorId : undefined}
          onChange={(event) => { setDraft(event.target.value); setFieldError('') }} /></label>
      <p className="text-[11px] text-muted">Required · up to {DISPLAY_NAME_MAX_LENGTH} characters. Duplicate labels are allowed.</p>
      {fieldError && <InlineError><span id={errorId}>{fieldError}</span></InlineError>}
      {!canEdit && <InlineError>This item or workspace is now read-only or unavailable. Your draft has been kept; restore write access before saving.</InlineError>}
      {error && <InlineError>{error}<p className="mt-2">Your draft is still here. {real ? 'Reload the latest saved name before explicitly retrying with its version.' : 'Refresh the page to load its current version before trying again.'}</p></InlineError>}
      {real && (error || reviewLatest) && <div className="space-y-3 rounded-lg border p-3">
        <Button size="sm" disabled={pending} onClick={() => void reload()}>{reloading ? 'Reloading…' : 'Reload latest name'}</Button>
        {reviewLatest && (loaded ? <><p className="break-words text-[12px]">Latest saved name: <strong>{loaded.name}</strong></p>
          <p className="text-[11px] text-muted">{matchesLoaded ? 'The loaded saved name matches your draft. No additional save is needed.' : 'Your draft above has not changed. Choose this version as the new base, then Save name to retry.'}</p>
          <Button size="sm" disabled={pending || (!canEdit && !matchesLoaded)} onClick={() => {
            if (matchesLoaded) { guard.release(); onClose() }
            else { setBase(loaded); setReviewLatest(false); setError(''); input.current?.focus() }
          }}>{matchesLoaded ? 'Use saved name' : 'Keep my draft and use this version'}</Button></>
          : <InlineError>{loadError ?? 'The current item is unavailable. No new save version has been accepted; your draft is unchanged.'}</InlineError>)}
      </div>}
      {pending && <p role="status" className="text-[11px] text-muted">{saving ? 'Waiting for the name change to be acknowledged. Keep this dialog open.' : 'Loading the latest version without replacing your draft.'}</p>}
    </form>
  </Modal>
}
