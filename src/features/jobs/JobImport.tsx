import { useRef, useState } from 'react'
import { FileText, Link2, LoaderCircle, RotateCcw, ShieldCheck, UploadCloud } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { clientAdmissionReason, usePublicSettings } from '../../app/public-settings-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { effectiveFormats, requireImportBatch, requireImportFile, requireImportUrl } from '../../services/publicSettings'
import { supportedUploadFormats, uploadAccept, type UploadFormat } from '../../domain/document-formats'
import { selectedUploadFormat, uploadFileByteLimit, uploadFormatNames, uploadPickerLabel, validateUploadFile } from '../../services/documentUploads'
import { JOB_IMPORT_LIMITS } from '../../domain/real-jobs'
import { Badge, Button, InlineError, Modal, SegmentedControl } from '../../components/ui'
import { LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function JobImport({ onClose }: { onClose: () => void }) {
  const { cloud } = useWorkspace()
  const { canEdit } = useLifecycleAccess()
  if (!canEdit) return <Modal open onOpenChange={(open) => { if (!open) onClose() }} title="Imports are read-only" description="An active workspace and owner or editor access are required to import jobs." footer={<Button onClick={onClose}>Close</Button>}><LifecycleBanner /></Modal>
  return <RealJobImport key={cloud.currentWorkspaceId} onClose={onClose} />
}

type RealImportItem = {
  key: string
  label: string
  idempotencyKey: string
  kind: UploadFormat | 'url' | 'unsupported'
  file?: File
  url?: string
  state: 'pending' | 'invalid' | 'uploading' | 'queued' | 'error'
  error?: string
}

function RealJobImport({ onClose }: { onClose: () => void }) {
  const { cloud } = useWorkspace()
  const policy = usePublicSettings()
  const realJobs = cloud.realJobs
  const limits = realJobs.features?.limits
  const formats = effectiveFormats(supportedUploadFormats({
    markdownJobImports: realJobs.features?.markdownJobImports, wordDocumentImports: realJobs.features?.wordDocumentImports,
  }), policy.settings, 'jobs')
  const urlsAllowed = policy.settings?.imports.jobs.allowUrls !== false
  const wordEnabled = formats.includes('docx')
  const markdownEnabled = formats.includes('markdown')
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [items, setItems] = useState<RealImportItem[]>([])
  const [urls, setUrls] = useState('')
  const [error, setError] = useState('')
  const [batchId, setBatchId] = useState(() => crypto.randomUUID())
  const [locked, setLocked] = useState(false)
  const submitting = useRef(false)
  const active = items.some((item) => item.state === 'uploading')
  const queued = items.filter((item) => item.state === 'queued').length
  const failed = items.filter((item) => item.state === 'error').length
  const invalid = items.filter((item) => item.state === 'invalid').length
  const pending = items.filter((item) => item.state === 'pending').length
  const policyReason = clientAdmissionReason(policy, 'jobImports')
  const unavailable = realJobs.phase !== 'ready' || !realJobs.features?.realJobImports || Boolean(policyReason)
  const guard = useGradeLeaveGuard(items.some(item => item.state !== 'queued') || Boolean(urls.trim() && !locked), active, 'Unsubmitted job import sources')
  const close = () => { void guard.close(onClose) }

  function chooseFiles(list: FileList | File[]) {
    if (submitting.current || locked || unavailable) return
    const files = Array.from(list)
    if (!limits) { setError('Import limits are still loading. Try again in a moment.'); return }
    if (!files.length) return
    if (files.length > limits.maxBatchFiles) { setError(`Choose no more than ${limits.maxBatchFiles} files in one batch. Your previous selection is unchanged.`); return }
    setItems(files.map((file, index) => {
      const format = selectedUploadFormat(file)
      const validationError = validateUploadFile(file, formats, format ? uploadFileByteLimit(format, limits) : limits.maxFileBytes)
      const existing = realJobs.summaries.some((summary) => summary.source.kind === format && summary.source.displayName.toLocaleLowerCase() === file.name.toLocaleLowerCase())
      const duplicate = files.findIndex((candidate) => candidate.name.toLocaleLowerCase() === file.name.toLocaleLowerCase() && candidate.size === file.size) !== index
      const itemError = validationError ?? (existing ? 'This filename is already represented by a real job in this workspace.'
        : duplicate ? 'This file is repeated in the selection. Only its first occurrence will be sent.' : undefined)
      return {
        key: crypto.randomUUID(), label: file.name, file, kind: format ?? 'unsupported',
        idempotencyKey: crypto.randomUUID(), state: itemError ? 'invalid' : 'pending', error: itemError,
      }
    }))
    setError('')
  }

  function prepareUrls() {
    if (submitting.current || locked || unavailable) return
    if (!limits) { setError('Import limits are still loading. Try again in a moment.'); return }
    const lines = urls.split(/\n/).map((line) => line.trim()).filter(Boolean)
    try { lines.forEach(url => requireImportUrl(url, 'jobs', policy.settings)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'This URL is not allowed.'); return }
    if (!lines.length) { setItems([]); setError('Enter at least one direct job posting URL.'); return }
    if (lines.length > limits.maxBatchFiles) { setItems([]); setError(`Enter no more than ${limits.maxBatchFiles} direct URLs in one batch.`); return }
    const invalid = lines.find((line) => line.length > limits.maxUrlLength || !URL.canParse(line) || !['http:', 'https:'].includes(new URL(line).protocol))
    if (invalid) {
      setItems([])
      setError(invalid.length > limits.maxUrlLength ? `Each URL must be ${limits.maxUrlLength} characters or fewer.` : `Use a complete http or https URL: ${invalid}`)
      return
    }
    const credentialed = lines.find((line) => new URL(line).username || new URL(line).password)
    if (credentialed) { setItems([]); setError('Use URLs without embedded usernames or passwords.'); return }
    if (lines.some((line) => /\.(docx?|docm|dotx?)$/i.test(new URL(line).pathname))) {
      setError('Word URLs cannot be imported. Download the document and upload a supported file instead.')
      return
    }
    if (lines.some((line) => /\.(md|markdown)$/i.test(new URL(line).pathname))) {
      setError('Markdown URLs cannot be imported. Download the document and upload a Markdown file instead.')
      return
    }
    const normalized = lines.map((line) => new URL(line).href)
    const existing = normalized.find((url) => realJobs.summaries.some((summary) => summary.source.kind === 'url' && (summary.source.url === url || summary.source.finalUrl === url)))
    if (existing) { setItems([]); setError(`${existing} is already represented by a real job in this workspace.`); return }
    const duplicate = normalized.find((url, index) => normalized.indexOf(url) !== index)
    if (duplicate) { setItems([]); setError(`Remove the duplicate URL ${duplicate} before importing.`); return }
    setItems(normalized.map((url) => ({
      key: url,
      label: url,
      kind: 'url',
      url,
      idempotencyKey: crypto.randomUUID(),
      state: 'pending',
    })))
    setError('')
  }

  async function upload(item: RealImportItem) {
    setItems((current) => current.map((candidate) => candidate.key === item.key ? { ...candidate, state: 'uploading', error: undefined } : candidate))
    try {
      if (item.file) await realJobs.importFile(item.file, item.idempotencyKey, batchId)
      else if (item.url) await realJobs.importUrl(item.url, item.idempotencyKey, batchId)
      else throw new Error('This import source is missing.')
      setItems((current) => current.map((candidate) => candidate.key === item.key ? { ...candidate, state: 'queued', file: undefined, error: undefined } : candidate))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The source could not be queued.'
      setItems((current) => current.map((candidate) => candidate.key === item.key ? { ...candidate, state: 'error', error: message } : candidate))
    }
  }

  async function submit(selected = items.filter((item) => item.state === 'pending' || item.state === 'error')) {
    if (submitting.current || !selected.length || unavailable) return
    try {
      requireImportBatch(items.length, 'jobs', policy.settings)
      for (const item of selected) {
        if (item.file) requireImportFile(item.file, 'jobs', policy.settings)
        if (item.url) requireImportUrl(item.url, 'jobs', policy.settings)
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Current policy does not allow this batch. Your selection is retained.'); return }
    submitting.current = true
    setLocked(true)
    setError('')
    try {
      await Promise.all(selected.map(upload))
    } finally {
      submitting.current = false
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Import real job descriptions" description="Score privately reads each source and prepares a source-grounded rubric." drawer
    footer={<>
      <span className="mr-auto text-[11px] text-muted">{active ? 'Uploading sources…' : queued || failed ? `${queued} queued / ${failed} unacknowledged` : `${pending} ready`}{invalid > 0 && ` / ${invalid} invalid`}</span>
      {queued > 0 && failed === 0 && <Button onClick={close}>Done</Button>}
      {failed > 0 && <Button icon={RotateCcw} disabled={active || unavailable} onClick={() => void submit(items.filter((item) => item.state === 'error'))}>Retry failed</Button>}
      {queued === 0 && <Button variant="primary" icon={active ? LoaderCircle : UploadCloud} disabled={active || unavailable || !pending} onClick={() => void submit()}>
        {active ? 'Uploading…' : `Import ${pending || ''} ${pending === 1 ? 'job' : 'jobs'}`}
      </Button>}
    </>}>
    {realJobs.phase === 'loading' && <div className="info-callout mb-5"><LoaderCircle size={18} className="animate-spin" /><div><strong>Checking import availability</strong><p>Score is loading this deployment's limits.</p></div></div>}
    {unavailable && realJobs.phase !== 'loading' && <div className="mb-5"><InlineError>{policyReason ?? realJobs.error ?? 'Real job imports are unavailable in this deployment.'}</InlineError></div>}
    {!formats.length && <p role="status" className="field-hint">New job file uploads are disabled by application policy. Existing jobs and captured evidence remain available.</p>}
    {!urlsAllowed && <p role="status" className="field-hint">New public job URL imports are disabled by application policy.</p>}
    {!unavailable && !markdownEnabled && <p className="mb-4 text-[11px] text-muted" role="status">Markdown imports are not enabled in this deployment. Advertised file formats and direct HTML/PDF URL imports remain available.</p>}
    <SegmentedControl value={mode} onChange={(value) => {
      if (locked || submitting.current) { setError('Submitted inputs are locked so retries keep their original keys and bytes. Close this panel to start a separate batch.'); return }
      setMode(value); setItems([]); setError('')
    }} label="Real job source" options={[{ value: 'file', label: `${uploadPickerLabel(formats)} files` }, { value: 'url', label: 'Direct URLs' }]} />
    <div className="my-6">
      {mode === 'file' ? <>
        <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFiles(event.dataTransfer.files) }}>
          <UploadCloud size={32} strokeWidth={1.4} /><strong>Drop job description {uploadPickerLabel(formats, ' or ')} files here</strong>
          <span>Up to {limits?.maxBatchFiles ?? 10} files. {formats.map((format) => `${uploadFormatNames([format])}: ${uploadFileByteLimit(format, limits) / 1024 / 1024} MiB`).join(' · ')}. PDFs only: {limits?.maxPdfPages ?? 50} printed pages.</span>
          <span>Each source may contain up to {(limits?.maxSourceCharacters ?? JOB_IMPORT_LIMITS.maxSourceCharacters).toLocaleString()} normalized characters.</span>
          <input type="file" multiple accept={uploadAccept(formats)} className="sr-only" aria-label={`Choose real job ${uploadPickerLabel(formats, ' or ')} files`} disabled={active || locked || unavailable || !formats.length} onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) chooseFiles(files)
          }} />
        </label>
        {markdownEnabled && <p className="field-hint mt-3">Markdown (.md / .markdown) is uploaded locally, with no printed-page limit. Links and images are not fetched; evidence is shown as normalized text, not a rendered Markdown preview.</p>}
        {wordEnabled && <p className="field-hint mt-3">Word 97–2003 DOC and DOCX only, not DOCM, RTF or templates. Word citations use captured sections, not printed pages. Embedded images are not extracted as evidence; use PDF/OCR for image-only documents. All sources are limited to {limits?.maxSourceCharacters.toLocaleString() ?? '180,000'} normalized characters.</p>}
      </> : <label className="field">
        <span className="field-label flex items-center gap-2"><Link2 size={15} />Direct job posting URLs</span>
        <textarea className="input" rows={6} value={urls} disabled={active || locked || unavailable || !urlsAllowed} maxLength={(limits?.maxUrlLength ?? 4096) * (limits?.maxBatchFiles ?? 10)}
          onChange={(event) => { setUrls(event.target.value); setItems([]); setError('') }}
          placeholder={'https://agency.example/jobs/program-manager\nhttps://agency.example/jobs/data-analyst'} />
        <span className="field-hint">One public HTML or PDF {policy.settings?.imports.requireHttps ? 'HTTPS' : 'HTTP(S)'} posting per line. Markdown and Word URLs are not supported. Whole-site discovery is not supported.</span>
        <Button size="sm" className="mt-3" disabled={active || locked || unavailable || !urlsAllowed} onClick={prepareUrls}>Review URLs</Button>
      </label>}
    </div>
    {items.length > 0 && <div className="import-items" aria-live="polite">{items.map((item) => <div className="import-item items-start" key={item.key}>
      {item.kind === 'url' ? <Link2 size={17} className="mt-0.5 text-muted" /> : <FileText size={17} className="mt-0.5 text-muted" />}
      <div><strong title={item.label}>{item.label}</strong>
        <p role={['error', 'invalid'].includes(item.state) ? 'alert' : undefined} className={['error', 'invalid'].includes(item.state) ? 'import-error-message' : ''}>{item.state === 'pending' ? 'Ready to upload' : item.state === 'uploading' ? 'Uploading actual source bytes…' : item.state === 'queued' ? 'Queued for private extraction and rubric generation' : item.error}</p>
      </div>
      <Badge>{item.kind === 'url' ? 'URL' : item.kind === 'unsupported' ? 'Unsupported file' : uploadFormatNames([item.kind])}</Badge>
      <Badge tone={['error', 'invalid'].includes(item.state) ? 'danger' : item.state === 'queued' ? 'success' : 'neutral'} dot={item.state !== 'pending'}>{item.state === 'error' ? 'Unacknowledged' : item.state}</Badge>
      {item.state === 'error' && <Button size="sm" variant="ghost" icon={RotateCcw} disabled={active || unavailable} aria-label={`Retry ${item.label}`} onClick={() => void submit([item])}>Retry</Button>}
    </div>)}</div>}
    {locked && !active && failed === 0 && <div className="mt-4"><Button size="sm" onClick={() => {
      if (submitting.current) return
      setBatchId(crypto.randomUUID()); setItems([]); setUrls(''); setError(''); setLocked(false)
    }}>Start another batch</Button></div>}
    <div className="info-callout mt-5"><FileText size={18} /><div><strong>Processing continues on the server</strong><p>Only acknowledged uploads are durable queued records. Invalid files do not prevent valid files from importing. Keep this panel open until uploads are acknowledged, or retry unchanged inputs with their original keys. Extraction and rubric generation may take a minute to start; closing this panel does not cancel acknowledged work.</p></div></div>
    <p className="library-note-text mt-5"><ShieldCheck size={16} aria-hidden="true" /><span>Job sources are read and stored privately. Import resumes separately, then manually choose ready inputs for an analysis.</span></p>
    {error && <div className="mt-5"><InlineError>{error}</InlineError></div>}
  </Modal>
}
