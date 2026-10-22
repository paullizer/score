import { useId, useRef, useState } from 'react'
import { FileText, Link2, LoaderCircle, Plus, RotateCcw, UploadCloud, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useRealResumes } from '../../app/real-resumes-context'
import { clientAdmissionReason, usePublicSettings } from '../../app/public-settings-context'
import { effectiveFormats } from '../../services/publicSettings'
import { Badge, Button, EmptyState, InlineError, Modal, SegmentedControl } from '../../components/ui'
import { RESUME_IMPORT_LIMITS } from '../../domain/real-resumes'
import { supportedUploadFormats, uploadAccept } from '../../domain/document-formats'
import { uploadFileByteLimit, uploadFormatNames, uploadPickerLabel } from '../../services/documentUploads'
import { resumeFileInput, resumeUrlLines, type RealResumeImportSource } from './resumeImportUi'

export function RealAddResumesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useRealResumes()
  const policy = usePublicSettings()
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [urls, setUrls] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const batch = api?.batches.find((item) => item.id === api.currentBatchId)
  const items = batch?.items.filter(item => item.state !== 'accepted') ?? []
  const batches = api?.batches.filter(entry => entry.inputCount === null || entry.items.some(item => item.state !== 'accepted')) ?? []
  const uploading = items.some((item) => item.state === 'waiting' || item.state === 'uploading')
  const valid = items.filter((item) => item.state === 'pending' || item.state === 'unconfirmed').length
  const limits = api?.features?.resumeLimits ?? RESUME_IMPORT_LIMITS
  const formats = effectiveFormats(supportedUploadFormats({
    markdownResumeImports: api?.features?.markdownResumeImports, wordDocumentImports: api?.features?.wordDocumentImports,
  }), policy.settings, 'resumes')
  const urlsAllowed = policy.settings?.imports.resumes.allowUrls !== false
  const wordEnabled = formats.includes('docx')
  const policyReason = clientAdmissionReason(policy, 'resumeImports')
  const unavailable = !api || api.phase !== 'ready' || !api.canWrite || !api.features?.realResumeImports || Boolean(policyReason)
  const locked = batch?.inputCount !== null && batch?.inputCount !== undefined
  const markdownEnabled = api?.features?.markdownResumeImports === true

  function stage(inputs: RealResumeImportSource[]) {
    setError('')
    try {
      if (!api) throw new Error('Real resume imports require a cloud workspace.')
      api.stage(inputs)
      if (inputs[0]?.kind === 'url') setUrls('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'These inputs could not be added to the batch.') }
  }

  function submit(keys?: string[]) {
    if (!api || !batch) return
    setError('')
    void api.submitBatch(batch.id, keys).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The batch could not be submitted.'))
  }

  return <Modal open={open} onOpenChange={onOpenChange} title="Add resumes"
    description={`Upload ${uploadPickerLabel(formats, ' or ')} files or import public resume URLs.`}
    footer={<>
      <span className="mr-auto text-[11px] text-muted" role="status">{items.length ? `${items.length} ${items.length === 1 ? 'upload' : 'uploads'} remaining` : api?.uploadNotice ?? 'Choose files or add URLs to upload.'}</span>
      <Button onClick={() => onOpenChange(false)}>{uploading ? 'Close — keep uploading' : 'Close'}</Button>
      {(uploading || valid > 0) && <Button variant="primary" icon={uploading ? LoaderCircle : UploadCloud} disabled={unavailable || uploading}
        onClick={() => submit()}>{uploading ? 'Uploading…' : locked ? `Retry ${valid} ${valid === 1 ? 'upload' : 'uploads'}` : `Upload ${valid} ${valid === 1 ? 'resume' : 'resumes'}`}</Button>}
    </>}>
    {!api ? <EmptyState title="A cloud workspace is required" description="Open this dialog from an authenticated workspace. Imports are never stored in your browser." /> : <>
      {api.phase !== 'ready' && <div className="mb-4"><InlineError>{api.error ?? 'Checking private import availability…'} <Button size="sm" onClick={() => void api.refresh()}>Check service</Button></InlineError></div>}
      {!api.canWrite && <div className="mb-4"><InlineError>This workspace is read-only. An owner or editor can import resumes.</InlineError></div>}
      {policyReason && <InlineError>{policyReason}</InlineError>}
      {!formats.length && <p className="field-hint" role="status">New resume file uploads are disabled by application policy. Existing resumes remain readable.</p>}
      {!urlsAllowed && <p className="field-hint" role="status">New public resume URL imports are disabled by application policy.</p>}
      {error && <div className="mb-4"><InlineError>{error}</InlineError></div>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl value={mode} onChange={setMode} label="Resume source type" options={[{ value: 'file', label: `${uploadPickerLabel(formats)} files` }, { value: 'url', label: 'Public URLs' }]} />
        <Badge>{locked ? `${items.length} remaining` : `${items.length} / ${limits.maxBatchItems} inputs`}</Badge>
      </div>
      <p className="mb-4 text-[11px] text-muted">Files and URLs share one batch limit. Changing this tab keeps the entire batch. Importing does not start an analysis.</p>
      {!unavailable && !markdownEnabled && <p className="mb-4 text-[11px] text-muted" role="status">Markdown imports are not enabled in this deployment. Advertised file formats and public HTML/PDF URLs remain available; Markdown inputs will be marked invalid and will not be sent.</p>}
      {mode === 'file' ? <div className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault()
        if (!unavailable && !locked && !uploading) stage(Array.from(event.dataTransfer.files, resumeFileInput))
      }}>
        <UploadCloud size={30} className="text-accent" aria-hidden="true" /><strong>Choose resume {uploadPickerLabel(formats, ' or ')} files</strong>
        <p id={hintId} className="text-[11px] text-muted">{formats.map((format) => `${uploadFormatNames([format])}: ${uploadFileByteLimit(format, limits) / 1024 / 1024} MiB`).join(' · ')}. PDFs only: {limits.maxPdfPages} printed pages. The server validates actual bytes, readability and the {(limits.maxSourceCharacters ?? RESUME_IMPORT_LIMITS.maxSourceCharacters).toLocaleString()} normalized-character limit. Different files may have the same filename.</p>
        {wordEnabled && <p className="text-[11px] text-muted">DOC means Word 97–2003, not DOCM, RTF or templates. Word citations use captured sections, not printed pages. Embedded images are not extracted as evidence; use PDF/OCR for image-only resumes. Up to {limits.maxSourceCharacters.toLocaleString()} normalized characters per source.</p>}
        <input ref={fileInput} type="file" accept={uploadAccept(formats)} multiple className="sr-only" tabIndex={-1}
          aria-label={`Choose resume ${uploadPickerLabel(formats, ' or ')} files`} aria-describedby={hintId} disabled={unavailable || locked || uploading || !formats.length}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) stage(files.map(resumeFileInput))
          }} />
        <Button icon={Plus} disabled={unavailable || locked || uploading || !formats.length} onClick={() => fileInput.current?.click()}>{formats.length > 1 ? 'Choose files' : formats[0] === 'pdf' ? 'Choose PDFs' : `Choose ${uploadPickerLabel(formats) || 'files'}`}</Button>
        {markdownEnabled && <p className="text-[11px] text-muted">Markdown (.md / .markdown) has no printed-page limit. Files are uploaded locally. Links and images in them are not fetched; evidence is shown as normalized text, not a rendered Markdown preview.</p>}
      </div> : <div className="space-y-3">
        <label className="field"><span className="field-label">Public resume or profile URLs</span>
          <textarea className="input" rows={5} value={urls} disabled={unavailable || locked || uploading || !urlsAllowed}
            onChange={(event) => setUrls(event.target.value)}
            placeholder={'https://example.org/resume.pdf\nhttps://www.linkedin.com/in/public-profile'} />
          <span className="field-hint">One public HTML or PDF {policy.settings?.imports.requireHttps ? 'HTTPS ' : ''}URL per line, at most {limits.maxUrlLength} characters each. Markdown and Word URLs are not supported. Public LinkedIn profiles are supported only when accessible without sign-in.</span>
        </label>
        <Button icon={Plus} disabled={unavailable || locked || uploading || !urlsAllowed || !urls.trim()}
          onClick={() => stage(resumeUrlLines(urls).map((url) => ({ kind: 'url', url })))}>Add URLs to batch</Button>
        <p className="text-[11px] text-muted">A public profile can be sparse compared with a full resume. Missing evidence is not invented. Nonpublic or blocked URLs cannot be processed; there is no sign-in or access-control workaround.</p>
      </div>}
      {items.length > 0 && <section className="mt-5" aria-label="Real resume import batch">
        <h3 className="mb-3 text-[12px] font-semibold">{uploading ? 'Uploading resumes' : locked ? 'Uploads needing attention' : 'Ready to upload'}</h3>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-xl border">
          {items.map((item, index) => {
            return <li key={item.key} className="flex items-start gap-3 bg-surface p-3">
              {item.source.kind === 'url' ? <Link2 size={17} className="mt-1 shrink-0 text-muted" aria-hidden="true" /> : <FileText size={17} className="mt-1 shrink-0 text-muted" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="break-all text-[11px] font-semibold">{index + 1}. {item.label}</p>
                <p className="mt-1 text-[10px] text-muted">{item.source.kind !== 'url' && `${item.source.kind.toUpperCase()} · `}{item.state === 'pending' ? 'Ready to upload' : item.state === 'waiting' ? 'Waiting to upload — not sent yet' : item.state === 'uploading' ? 'Uploading resume…'
                  : item.state === 'invalid' ? 'Invalid input — not sent' : 'Upload not confirmed. Retry to check or finish this upload without creating a duplicate.'}</p>
                {item.error && <p className="mt-2 text-[11px] text-[var(--cp-danger)]" role="alert">{item.error}</p>}
                {item.warning && <p className="mt-2 text-[11px] text-muted">{item.warning}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Badge>{item.source.kind === 'url' ? 'URL' : item.source.kind === 'unsupported' ? 'Unsupported file' : uploadFormatNames([item.source.kind])}</Badge>
                <Badge tone={['invalid', 'unconfirmed'].includes(item.state) ? 'warning' : 'neutral'}>{item.state === 'unconfirmed' ? 'Not confirmed' : item.state === 'waiting' ? 'Waiting' : item.state === 'pending' ? 'Not sent' : item.state === 'uploading' ? 'Uploading' : 'Invalid'}</Badge>
                {!locked && <Button size="sm" variant="ghost" icon={X} className="icon-button" aria-label={`Remove input ${index + 1}: ${item.label}`} onClick={() => api.removeItem(item.key)} />}
                {item.state === 'unconfirmed' && <Button size="sm" icon={RotateCcw} disabled={unavailable || uploading} aria-label={`Retry input ${index + 1}: ${item.label}`} onClick={() => submit([item.key])}>Retry import</Button>}
              </div>
            </li>
          })}
        </ul>
      </section>}
      {locked && <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-muted">Retry only the uploads that remain. To replace an invalid input, start another upload.</p>
        <Button disabled={unavailable || uploading} icon={Plus} onClick={() => {
          try { api.newBatch(); setUrls(''); setError('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'The current batch is still active.') }
        }}>Add more resumes</Button>
      </div>}
      {(batches.length > 1 || (!batch && batches.length > 0)) && <label className="field mt-4"><span className="field-label">Unfinished uploads</span>
        <select className="input" value={api.currentBatchId ?? ''} disabled={uploading} onChange={(event) => {
          try { api.selectBatch(event.target.value); setError('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'This batch is still active.') }
        }}>{!batch && <option value="">New upload</option>}{batches.map((entry, index) => <option key={entry.id} value={entry.id}>Upload {index + 1} · {entry.items.filter((item) => item.state !== 'accepted').length} remaining</option>)}</select>
      </label>}
    </>}
  </Modal>
}

export function RealResumeImportActivity() {
  const api = useRealResumes()
  const items = api?.batches.flatMap((batch) => batch.items).filter(item => item.state !== 'accepted') ?? []
  if (!items.length) return api?.uploadNotice ? <span className="sr-only" role="status">{api.uploadNotice}</span> : null
  const uploading = items.filter((item) => item.state === 'uploading').length
  const waiting = items.filter((item) => item.state === 'waiting').length
  const pending = items.filter(item => item.state === 'pending').length
  const attention = items.filter((item) => item.state === 'unconfirmed' || item.state === 'invalid').length
  return <div className="info-callout mb-5" role="status" aria-live="polite">
    {uploading || waiting ? <LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
    <div><strong>Resume uploads: {items.length} remaining{uploading > 0 ? ` · ${uploading} uploading` : ''}{waiting > 0 ? ` · ${waiting} waiting to upload` : ''}{pending > 0 ? ` · ${pending} not sent` : ''}{attention > 0 ? ` · ${attention} need attention` : ''}</strong>
      <p><Link className="text-link" to="/resumes?imports=open">Review unfinished uploads</Link>. Saved resumes and processing progress are in your library.</p></div>
  </div>
}
