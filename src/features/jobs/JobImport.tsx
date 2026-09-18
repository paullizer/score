import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, FileText, Globe2, Link2, LoaderCircle, RotateCcw, ScanSearch, UploadCloud } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import type { ImportCandidate, SourceKind } from '../../domain/types'
import { JOB_IMPORT_LIMITS } from '../../domain/real-jobs'
import { isSafeUploadedFilename, uploadedFileKind } from '../../domain/source-files'
import { JOB_FIXTURE_COUNT } from '../../data/fixtures'
import { discoverJobs } from '../../services/mockWorkspace'
import { Badge, Button, DemoNote, InlineError, Modal, SegmentedControl, StepLabel } from '../../components/ui'

export function JobImport({ onClose }: { onClose: () => void }) {
  const { cloud } = useWorkspace()
  return cloud ? <RealJobImport onClose={onClose} /> : <SampleJobImport onClose={onClose} />
}

type RealImportItem = {
  key: string
  label: string
  idempotencyKey: string
  kind: 'pdf' | 'markdown' | 'url'
  file?: File
  url?: string
  state: 'pending' | 'uploading' | 'queued' | 'error'
  error?: string
}

function RealJobImport({ onClose }: { onClose: () => void }) {
  const { cloud } = useWorkspace()
  if (!cloud) throw new Error('Real job imports require a cloud workspace.')
  const realJobs = cloud.realJobs
  const limits = realJobs.features?.limits
  const [mode, setMode] = useState<'files' | 'url'>('files')
  const [items, setItems] = useState<RealImportItem[]>([])
  const [urls, setUrls] = useState('')
  const [error, setError] = useState('')
  const [batchId] = useState(() => crypto.randomUUID())
  const submitting = useRef(false)
  const active = items.some((item) => item.state === 'uploading')
  const queued = items.filter((item) => item.state === 'queued').length
  const failed = items.filter((item) => item.state === 'error').length
  const unavailable = realJobs.phase !== 'ready' || !realJobs.features?.realJobImports
  const markdownEnabled = realJobs.features?.markdownJobImports === true

  function chooseFiles(list: FileList | File[]) {
    const files = Array.from(list)
    if (!limits) { setError('Import limits are still loading. Try again in a moment.'); return }
    if (!files.length) { setItems([]); setError('Choose at least one PDF or Markdown file.'); return }
    if (files.length > limits.maxBatchFiles) { setItems([]); setError(`Choose no more than ${limits.maxBatchFiles} PDF or Markdown files in one batch.`); return }
    for (const file of files) {
      const kind = uploadedFileKind(file)
      if (!kind) { setItems([]); setError(`${file.name} is not supported. Choose PDF (.pdf) or Markdown (.md or .markdown) files.`); return }
      if (kind === 'markdown' && !isSafeUploadedFilename(file.name, kind)) { setItems([]); setError(`${file.name} does not have a safe filename. Avoid reserved names, path separators, and control characters.`); return }
      if (kind === 'markdown' && !markdownEnabled) { setItems([]); setError('Markdown job imports are not enabled in this deployment. You can still import PDFs and direct URLs.'); return }
      if (!file.size) { setItems([]); setError(`${file.name} is empty. Choose a readable source file.`); return }
      const maxBytes = kind === 'markdown' ? limits.maxMarkdownBytes ?? JOB_IMPORT_LIMITS.maxMarkdownBytes : limits.maxPdfBytes
      if (file.size > maxBytes) { setItems([]); setError(`${file.name} exceeds the ${maxBytes / 1024 / 1024} MiB ${kind === 'markdown' ? 'Markdown' : 'PDF'} limit.`); return }
    }
    const existing = files.find((file) => realJobs.summaries.some((summary) => summary.source.kind === uploadedFileKind(file) && summary.source.displayName.toLocaleLowerCase() === file.name.toLocaleLowerCase()))
    if (existing) { setItems([]); setError(`${existing.name} is already represented by a real job in this workspace.`); return }
    const duplicate = files.find((file, index) => files.findIndex((candidate) => candidate.name.toLocaleLowerCase() === file.name.toLocaleLowerCase() && candidate.size === file.size) !== index)
    if (duplicate) { setItems([]); setError(`Remove the duplicate file ${duplicate.name} before importing.`); return }
    setItems(files.map((file) => ({
      key: `${file.name}:${file.size}:${file.lastModified}`,
      label: file.name,
      kind: uploadedFileKind(file)!,
      file,
      idempotencyKey: crypto.randomUUID(),
      state: 'pending',
    })))
    setError('')
  }

  function prepareUrls() {
    if (!limits) { setError('Import limits are still loading. Try again in a moment.'); return }
    const lines = urls.split(/\n/).map((line) => line.trim()).filter(Boolean)
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
    if (submitting.current || !selected.length) return
    submitting.current = true
    setError('')
    try {
      await Promise.all(selected.map(upload))
    } finally {
      submitting.current = false
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open) onClose() }} title="Import real job descriptions" description="Score privately reads each source and prepares a source-grounded rubric." drawer
    footer={<>
      <span className="mr-auto text-[11px] text-muted">{active ? 'Uploading sources…' : queued || failed ? `${queued} queued / ${failed} failed` : `${items.length} source${items.length === 1 ? '' : 's'} ready`}</span>
      {queued > 0 && failed === 0 && <Button onClick={onClose}>Done</Button>}
      {failed > 0 && <Button icon={RotateCcw} disabled={active || unavailable} onClick={() => void submit(items.filter((item) => item.state === 'error'))}>Retry failed</Button>}
      {queued === 0 && <Button variant="primary" icon={active ? LoaderCircle : UploadCloud} disabled={active || unavailable || !items.length} onClick={() => void submit()}>
        {active ? 'Uploading…' : `Import ${items.length || ''} ${items.length === 1 ? 'job' : 'jobs'}`}
      </Button>}
    </>}>
    {realJobs.phase === 'loading' && <div className="info-callout mb-5"><LoaderCircle size={18} className="animate-spin" /><div><strong>Checking import availability</strong><p>Score is loading this deployment's limits.</p></div></div>}
    {unavailable && realJobs.phase !== 'loading' && <div className="mb-5"><InlineError>{realJobs.error ?? 'Real job imports are unavailable in this deployment.'}</InlineError></div>}
    {!unavailable && !markdownEnabled && <p className="mb-4 text-[11px] text-muted" role="status">Markdown imports are not enabled in this deployment. PDF and direct URL imports are available.</p>}
    <SegmentedControl value={mode} onChange={(value) => { if (!active) { setMode(value); setItems([]); setError('') } }} label="Real job source" options={[{ value: 'files', label: 'PDF / Markdown files' }, { value: 'url', label: 'Direct URLs' }]} />
    <div className="my-6">
      {mode === 'files' ? <>
        <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!active && !unavailable) chooseFiles(event.dataTransfer.files) }}>
          <UploadCloud size={32} strokeWidth={1.4} /><strong>Drop job description PDFs or Markdown files here</strong>
          <span>or browse files / up to {limits?.maxBatchFiles ?? 10} files. PDFs: {(limits?.maxPdfBytes ?? JOB_IMPORT_LIMITS.maxPdfBytes) / 1024 / 1024} MiB and {limits?.maxPdfPages ?? 50} pages each. Markdown (.md / .markdown): {(limits?.maxMarkdownBytes ?? JOB_IMPORT_LIMITS.maxMarkdownBytes) / 1024 / 1024} MiB each, no page limit.</span>
          <span>Each source may contain up to {(limits?.maxSourceCharacters ?? JOB_IMPORT_LIMITS.maxSourceCharacters).toLocaleString()} normalized characters. Markdown is uploaded locally; links and images are not fetched.</span>
          <input type="file" multiple accept=".pdf,.md,.markdown,application/pdf,text/markdown" className="sr-only" aria-label="Choose real job PDF or Markdown files" disabled={active || unavailable} onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) chooseFiles(files)
          }} />
        </label>
      </> : <label className="field">
        <span className="field-label flex items-center gap-2"><Link2 size={15} />Direct job posting URLs</span>
        <textarea className="input" rows={6} value={urls} disabled={active || unavailable} maxLength={(limits?.maxUrlLength ?? 4096) * (limits?.maxBatchFiles ?? 10)}
          onChange={(event) => { setUrls(event.target.value); setItems([]); setError('') }}
          placeholder={'https://agency.example/jobs/program-manager\nhttps://agency.example/jobs/data-analyst'} />
        <span className="field-hint">One public http or https posting per line. Whole-site discovery is deferred in real import mode.</span>
        <Button size="sm" className="mt-3" disabled={active || unavailable} onClick={prepareUrls}>Review URLs</Button>
      </label>}
    </div>
    {items.length > 0 && <div className="import-items" aria-live="polite">{items.map((item) => <div className="import-item items-start" key={item.key}>
      {item.kind === 'url' ? <Link2 size={17} className="mt-0.5 text-muted" /> : <FileText size={17} className="mt-0.5 text-muted" />}
      <div><strong title={item.label}>{item.label}</strong>
        <p className={item.state === 'error' ? 'import-error-message' : ''}>{item.state === 'pending' ? 'Ready to upload' : item.state === 'uploading' ? 'Uploading actual source bytes…' : item.state === 'queued' ? 'Queued for private extraction and rubric generation' : item.error}</p>
      </div>
      <Badge>{item.kind === 'markdown' ? 'Markdown' : item.kind === 'pdf' ? 'PDF' : 'URL'}</Badge>
      <Badge tone={item.state === 'error' ? 'danger' : item.state === 'queued' ? 'success' : 'neutral'} dot={item.state !== 'pending'}>{item.state}</Badge>
      {item.state === 'error' && <Button size="sm" variant="ghost" icon={RotateCcw} disabled={active || unavailable} aria-label={`Retry ${item.label}`} onClick={() => void submit([item])}>Retry</Button>}
    </div>)}</div>}
    <div className="info-callout mt-5"><FileText size={18} /><div><strong>Processing continues on the server</strong><p>Uploads become durable queued records individually. Extraction and rubric generation may take a minute to start; closing this panel or workspace does not cancel them.</p></div></div>
    <DemoNote>Real job sources are read and stored privately. Import real resumes separately, then manually choose ready inputs for real analysis. Only the Samples workflow uses simulated scoring.</DemoNote>
    {error && <div className="mt-5"><InlineError>{error}</InlineError></div>}
  </Modal>
}

function SampleJobImport({ onClose }: { onClose: () => void }) {
  const { workspace, addJobs } = useWorkspace()
  const [mode, setMode] = useState<SourceKind>('pdf')
  const [stage, setStage] = useState<'input' | 'review'>('input')
  const [files, setFiles] = useState<ImportCandidate[]>([])
  const [urls, setUrls] = useState('')
  const [website, setWebsite] = useState('https://www.opm.gov/')
  const [scope, setScope] = useState<'single' | 'multiple' | 'deep'>('multiple')
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [scenario, setScenario] = useState<'success' | 'parsing' | 'rubric'>('success')
  const [error, setError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const seen = new Set(workspace.jobs.filter((job) => job.source === mode).map((job) => job.sourceLabel))
  const reviewed = candidates.map((item) => {
    const duplicate = seen.has(item.label)
    seen.add(item.label)
    return { item, duplicate }
  })
  const selectedItems = reviewed.filter(({ item, duplicate }) => !duplicate && selected.includes(item.key)).map(({ item }) => item)
  const duplicateCount = reviewed.filter((item) => item.duplicate).length

  function chooseFiles(list: FileList | File[]) {
    const values = Array.from(list)
    if (values.some((file) => !/\.pdf$/i.test(file.name))) { setError('Choose PDF files only. File contents will not be read.'); return }
    setFiles(values.map((file, index) => ({ key: file.name, label: file.name, title: `Fictional job profile ${index + 1}`, fixtureIndex: index % JOB_FIXTURE_COUNT })))
    setError('')
  }

  function prepare() {
    setError('')
    let items: ImportCandidate[]
    if (mode === 'pdf') {
      if (!files.length) { setError('Select a PDF or use the sample batch below.'); return }
      items = files
    } else if (mode === 'url') {
      const lines = urls.split(/\n/).map((line) => line.trim()).filter(Boolean)
      if (!lines.length) { setError('Enter at least one complete job URL.'); return }
      const invalid = lines.find((line) => !URL.canParse(line) || !['http:', 'https:'].includes(new URL(line).protocol))
      if (invalid) { setError(`Use a complete http or https URL: ${invalid}`); return }
      if (lines.some((line) => new URL(line).username || new URL(line).password)) { setError('Use URLs without embedded usernames or passwords.'); return }
      items = lines.map((line, index) => ({ key: new URL(line).href, label: new URL(line).href, title: `Fictional job profile ${index + 1}`, fixtureIndex: index % JOB_FIXTURE_COUNT }))
    } else {
      try { items = discoverJobs(website.trim(), scope) } catch (caught) {
        if (!(caught instanceof Error)) throw caught
        setError(caught.message)
        return
      }
    }
    setDiscovering(true)
    timer.current = window.setTimeout(() => {
      setCandidates(items)
      setSelected(items.map((item) => item.key))
      setStage('review')
      setDiscovering(false)
    }, mode === 'website' ? 700 : 250)
  }

  function commit() {
    try {
      addJobs(selectedItems, mode, scenario === 'success' ? undefined : scenario)
      onClose()
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught
      setError(caught.message)
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open) onClose() }} title="Bring your jobs together" description="A clear rubric starts with a clear job description." drawer
    footer={<>
      {stage === 'review' && <Button variant="ghost" icon={ChevronLeft} onClick={() => { setStage('input'); setError('') }}>Back</Button>}
      <span className="mr-auto text-[11px] text-muted">{stage === 'review' ? `${selectedItems.length} individual jobs selected` : 'Step 1 of 2'}</span>
      {stage === 'input' ? <Button variant="primary" icon={discovering ? LoaderCircle : mode === 'website' ? ScanSearch : ChevronRight} disabled={discovering} onClick={prepare}>
        {discovering ? 'Preparing samples...' : mode === 'website' ? 'Discover sample jobs' : 'Review sample jobs'}
      </Button> : <Button variant="primary" icon={Check} disabled={!selectedItems.length} onClick={commit}>Import {selectedItems.length} {selectedItems.length === 1 ? 'job' : 'jobs'}</Button>}
    </>}>
    <div className="mb-6 flex items-center gap-5"><StepLabel number={1} complete={stage === 'review'}>Choose a source</StepLabel><ChevronRight size={13} className="text-muted" /><StepLabel number={2}>Review jobs</StepLabel></div>
    {stage === 'input' ? <>
      <SegmentedControl value={mode} onChange={(value) => { setMode(value); setError('') }} label="Job source" options={[{ value: 'pdf', label: 'PDF files' }, { value: 'url', label: 'Direct URL' }, { value: 'website', label: 'Website discovery' }]} />
      <div className="my-6">
        {mode === 'pdf' && <>
          <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFiles(event.dataTransfer.files) }}>
            <UploadCloud size={32} strokeWidth={1.4} /><strong>Drop job descriptions here</strong><span>or browse files / multiple PDFs welcome</span>
            <input type="file" multiple accept=".pdf,application/pdf" className="sr-only" aria-label="Choose job PDF files" onChange={(event) => { if (event.target.files) chooseFiles(event.target.files) }} />
          </label>
          {files.length > 0 && <div className="import-items mt-4">{files.map((file, index) => <div className="import-item" key={`${file.key}-${index}`}><FileText size={17} className="text-muted" /><div><strong>{file.label}</strong><p>Sample content will be used</p></div><Badge>PDF</Badge></div>)}</div>}
          <div className="mt-4 flex items-center justify-between gap-3"><span className="text-[11px] text-muted">Just exploring the workflow?</span><Button size="sm" onClick={() => {
            setFiles(['program-manager-sample.pdf', 'data-analyst-sample.pdf', 'it-specialist-sample.pdf'].map((label, index) => ({ key: label, label, title: `Fictional job profile ${index + 1}`, fixtureIndex: index })))
            setError('')
          }}>Use sample PDFs</Button></div>
        </>}
        {mode === 'url' && <><label className="field"><span className="field-label flex items-center gap-2"><Link2 size={15} />Job posting URLs</span>
          <textarea className="input" rows={5} value={urls} onChange={(event) => setUrls(event.target.value)} placeholder={'https://example.org/careers/program-manager\nhttps://example.org/careers/data-analyst'} />
          <span className="field-hint">One direct posting URL per line. Each becomes its own sample job.</span></label>
          <Button size="sm" className="mt-4" onClick={() => setUrls('https://www.opm.gov/demo/program-manager\nhttps://www.opm.gov/demo/data-analyst')}>Use example URLs</Button>
        </>}
        {mode === 'website' && <div className="space-y-5">
          <label className="field"><span className="field-label flex items-center gap-2"><Globe2 size={15} />Website to explore</span>
            <input className="input" type="url" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://www.opm.gov/" />
            <span className="field-hint">Start with OPM or enter any website. Discovery is simulated.</span></label>
          <div><span className="field-label">Discovery scope</span><SegmentedControl label="Discovery depth" value={scope} onChange={setScope} options={[{ value: 'single', label: 'This page' }, { value: 'multiple', label: 'Multiple pages' }, { value: 'deep', label: 'Follow deeper links' }]} />
            <p className="field-hint">{scope === 'single' ? 'Preview postings from one sample listing page.' : scope === 'multiple' ? 'Include sample postings from additional listing pages.' : 'Include additional sample postings behind pagination and detail links.'}</p></div>
          <div className="info-callout"><ScanSearch size={18} /><div><strong>Designed for the modern web</strong><p>The future browser service can render JavaScript and follow page links. Here, you can review the discovery workflow without crawling a live site.</p></div></div>
        </div>}
      </div>
      <DemoNote>Only file names and source labels are used. No PDF contents are read and no URLs are fetched. You will import clearly labeled, fictional job content.</DemoNote>
    </> : <>
      <div className="mb-5 flex items-start justify-between gap-3"><div><h3 className="text-[16px] font-semibold">Review your sample jobs</h3><p className="mt-1 text-[12px] text-muted">Each selected item gets its own record and linked rubric.</p></div><Badge tone="accent">Simulated discovery</Badge></div>
      <div className="import-items">{reviewed.map(({ item, duplicate }, index) => <label className={`import-item ${duplicate ? 'is-duplicate' : ''}`} key={`${item.key}-${index}`}>
        <input type="checkbox" aria-label={`Import ${item.title} from ${item.label}`} disabled={duplicate} checked={!duplicate && selected.includes(item.key)}
          onChange={() => setSelected((values) => values.includes(item.key) ? values.filter((value) => value !== item.key) : [...values, item.key])} />
        <div><strong>{item.title}</strong><p title={item.label}>{item.label}</p></div><Badge tone={duplicate ? 'warning' : 'neutral'}>{duplicate ? 'Duplicate / skipped' : 'Sample'}</Badge>
      </label>)}</div>
      {duplicateCount > 0 && <p className="mt-3 text-[11px] text-muted">{duplicateCount} duplicate {duplicateCount === 1 ? 'source is' : 'sources are'} excluded. Existing job records will not be changed.</p>}
      <div className="info-callout mt-5"><FileText size={18} /><div><strong>Imported together. Managed individually.</strong><p>You can follow parsing and rubric progress in the jobs library. Successful jobs remain available even if another item needs a retry.</p></div></div>
      <details className="mt-6 rounded-xl border p-4"><summary className="cursor-pointer text-[11px] font-medium text-muted">Explore a demo scenario</summary>
        <label className="field mt-3"><span className="field-label">Import outcome</span><select className="input" value={scenario} onChange={(event) => {
          const value = event.target.value
          if (value === 'success' || value === 'parsing' || value === 'rubric') setScenario(value)
        }}><option value="success">All jobs succeed</option><option value="parsing">First job: document-reading failure</option><option value="rubric">First job: rubric-generation failure</option></select>
          <span className="field-hint">Failures are intentional examples. Retry in the library to complete the job.</span></label>
      </details>
      <div className="mt-5"><DemoNote>Every job and rubric here uses sample content, not information extracted from the selected sources.</DemoNote></div>
    </>}
    {error && <div className="mt-5"><InlineError>{error}</InlineError></div>}
  </Modal>
}
