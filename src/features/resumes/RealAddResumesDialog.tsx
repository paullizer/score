import { useId, useRef, useState } from 'react'
import { Check, FileText, Link2, LoaderCircle, Plus, RotateCcw, UploadCloud, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useRealResumes } from '../../app/real-resumes-context'
import { clientAdmissionReason, usePublicSettings } from '../../app/public-settings-context'
import { effectiveFormats } from '../../services/publicSettings'
import { Badge, Button, EmptyState, InlineError, Modal, SegmentedControl } from '../../components/ui'
import { RESUME_IMPORT_LIMITS } from '../../domain/real-resumes'
import { supportedUploadFormats, uploadAccept } from '../../domain/document-formats'
import { uploadFileByteLimit, uploadFormatNames, uploadPickerLabel } from '../../services/documentUploads'
import { resumeErrorMessage, resumeFileInput, resumeUrlLines, type RealResumeImportSource } from './resumeImportUi'

export function RealAddResumesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useRealResumes()
  const policy = usePublicSettings()
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [urls, setUrls] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const batch = api?.batches.find((item) => item.id === api.currentBatchId)
  const items = batch?.items ?? []
  const uploading = items.some((item) => item.state === 'uploading')
  const accepted = items.filter((item) => item.state === 'accepted').length
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

  return <Modal open={open} onOpenChange={onOpenChange} title="Add real resumes"
    description={`Upload actual ${uploadPickerLabel(formats, ' or ')} files or import publicly accessible resume/profile URLs. Each input is processed independently.`}
    footer={<>
      <span className="mr-auto text-[11px] text-muted" role="status">{accepted} accepted / {items.length} inputs{uploading ? ' · Uploading — not yet accepted' : ''}</span>
      <Button onClick={() => onOpenChange(false)}>{uploading ? 'Close — keep uploading' : 'Close'}</Button>
      <Button variant="primary" icon={uploading ? LoaderCircle : UploadCloud} disabled={unavailable || uploading || !valid}
        onClick={() => submit()}>{uploading ? 'Awaiting acceptance…' : locked ? `Retry ${valid} unacknowledged` : `Import ${valid} valid ${valid === 1 ? 'input' : 'inputs'}`}</Button>
    </>}>
    {!api ? <EmptyState title="A cloud workspace is required" description="Real imports are never sent through the sample workflow or stored in your browser." /> : <>
      {api.phase !== 'ready' && <div className="mb-4"><InlineError>{api.error ?? 'Checking private import availability…'} <Button size="sm" onClick={() => void api.refresh()}>Check service</Button></InlineError></div>}
      {!api.canWrite && <div className="mb-4"><InlineError>This workspace is read-only. An owner or editor can import resumes.</InlineError></div>}
      {policyReason && <InlineError>{policyReason}</InlineError>}
      {!formats.length && <p className="field-hint" role="status">New resume file uploads are disabled by application policy. Existing resumes remain readable.</p>}
      {!urlsAllowed && <p className="field-hint" role="status">New public resume URL imports are disabled by application policy.</p>}
      {error && <div className="mb-4"><InlineError>{error}</InlineError></div>}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl value={mode} onChange={setMode} label="Resume source type" options={[{ value: 'file', label: `${uploadPickerLabel(formats)} files` }, { value: 'url', label: 'Public URLs' }]} />
        <Badge>{items.length} / {limits.maxBatchItems} total inputs</Badge>
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
        <h3 className="mb-3 text-[12px] font-semibold">{locked ? 'Submitted batch — input identities are locked' : 'Review each input before importing'}</h3>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-xl border">
          {items.map((item, index) => {
            const summary = api.summaries.find((entry) => entry.resume.id === item.resumeId)
            return <li key={item.key} className="flex items-start gap-3 bg-surface p-3">
              {item.source.kind === 'url' ? <Link2 size={17} className="mt-1 shrink-0 text-muted" aria-hidden="true" /> : <FileText size={17} className="mt-1 shrink-0 text-muted" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="break-all text-[11px] font-semibold">{index + 1}. {item.label}</p>
                <p className="mt-1 text-[10px] text-muted">{item.source.kind !== 'url' && `${item.source.kind.toUpperCase()} · `}{item.state === 'pending' ? 'Ready to send — not accepted yet' : item.state === 'uploading' ? 'Sending source — server acceptance not confirmed yet'
                  : item.state === 'accepted' ? `Accepted by the server · ${summary?.resume.status ?? 'processing status in library'}` : item.state === 'invalid' ? 'Invalid input — not sent' : 'Acceptance not confirmed — check the library or retry the unchanged request'}</p>
                {item.error && <p className="mt-2 text-[11px] text-[var(--cp-danger)]" role="alert">{item.error}</p>}
                {summary?.error && <p className="mt-2 text-[11px] text-[var(--cp-danger)]" role="alert">{resumeErrorMessage(summary)}</p>}
                {item.warning && <p className="mt-2 text-[11px] text-muted">{item.warning}</p>}
                {summary?.duplicates.map((duplicate, duplicateIndex) => <p key={duplicateIndex} className="mt-2 text-[11px] text-muted">{duplicate.message} No records were merged.</p>)}
                {summary?.warnings.map((warning, warningIndex) => <p key={warningIndex} className="mt-2 text-[11px] text-muted">{warning}</p>)}
                {item.resumeId && <Link to={`/resumes/${encodeURIComponent(item.resumeId)}?data=real`} onClick={() => onOpenChange(false)} className="text-link mt-2 text-[11px]">Inspect accepted resume</Link>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Badge>{item.source.kind === 'url' ? 'URL' : item.source.kind === 'unsupported' ? 'Unsupported file' : uploadFormatNames([item.source.kind])}</Badge>
                <Badge tone={item.state === 'accepted' ? 'success' : ['invalid', 'unconfirmed'].includes(item.state) ? 'warning' : 'neutral'}>{item.state === 'accepted' ? <><Check size={11} />Accepted</> : item.state === 'unconfirmed' ? 'Not acknowledged' : item.state}</Badge>
                {!locked && <Button size="sm" variant="ghost" icon={X} className="icon-button" aria-label={`Remove input ${index + 1}: ${item.label}`} onClick={() => api.removeItem(item.key)} />}
                {item.state === 'unconfirmed' && <Button size="sm" icon={RotateCcw} disabled={unavailable || uploading} aria-label={`Retry input ${index + 1}: ${item.label}`} onClick={() => submit([item.key])}>Retry import</Button>}
              </div>
            </li>
          })}
        </ul>
      </section>}
      <div className="info-callout mt-5"><FileText size={18} aria-hidden="true" /><div><strong>Acceptance and processing are different.</strong>
        <p>Accepted inputs are private, durable server records. Processing continues after this dialog or browser closes. Uploading or unacknowledged inputs are not claimed as queued; keep this workspace open or retry with the same keys. This session keeps pending files only in memory, never browser storage.</p></div></div>
      {locked && <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-muted">Retries keep the original input and batch keys. To correct an invalid input, start a separate batch.</p>
        <Button disabled={unavailable || uploading} icon={Plus} onClick={() => {
          try { api.newBatch(); setUrls(''); setError('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'The current batch is still active.') }
        }}>Start another batch</Button>
      </div>}
      {api.batches.length > 1 && <label className="field mt-4"><span className="field-label">Batches in this session</span>
        <select className="input" value={api.currentBatchId ?? ''} disabled={uploading} onChange={(event) => {
          try { api.selectBatch(event.target.value); setError('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'This batch is still active.') }
        }}>{api.batches.map((entry, index) => <option key={entry.id} value={entry.id}>Batch {index + 1} · {entry.items.filter((item) => item.state === 'accepted').length} accepted / {entry.items.length} inputs</option>)}</select>
      </label>}
    </>}
  </Modal>
}

export function RealResumeImportActivity() {
  const api = useRealResumes()
  const items = api?.batches.flatMap((batch) => batch.items) ?? []
  if (!items.length) return null
  const uploading = items.filter((item) => item.state === 'uploading').length
  const accepted = items.filter((item) => item.state === 'accepted').length
  const attention = items.filter((item) => item.state === 'unconfirmed' || item.state === 'invalid'
    || api?.summaries.some((summary) => summary.resume.id === item.resumeId && summary.resume.status === 'error')).length
  return <div className="info-callout mb-5" role="status" aria-live="polite">
    {uploading ? <LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
    <div><strong>Resume imports: {accepted} accepted{uploading > 0 ? ` · ${uploading} uploading (not yet acknowledged)` : ''}{attention > 0 ? ` · ${attention} need attention` : ''}</strong>
      <p>Only accepted inputs are durable. <Link className="text-link" to="/resumes?data=real&imports=open">Review batches and server progress</Link></p></div>
  </div>
}
