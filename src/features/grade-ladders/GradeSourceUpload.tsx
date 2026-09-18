import { useEffect, useRef, useState, type FormEvent } from 'react'
import { FileUp, Link2, LoaderCircle } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import type { GradeLadderDetail } from '../../domain/real-grades'
import { GRADE_LADDER_LIMITS } from '../../domain/real-grades'
import { Button, InlineError, Modal, SegmentedControl } from '../../components/ui'
import { parseSelectedPages } from './gradeUi'
import { useGradeRequestKey } from './grade-request-hooks'

export function GradeSourceUpload({ detail, onClose }: { detail: GradeLadderDetail; onClose: () => void }) {
  const api = useGradeLadders()
  const limits = api?.features?.gradeLimits ?? GRADE_LADDER_LIMITS
  const [kind, setKind] = useState<'pdf' | 'url'>('pdf')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [pages, setPages] = useState('')
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [fileHash, setFileHash] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const selectedFile = useRef(0)
  const submitting = useRef(false)
  const keyFor = useGradeRequestKey()
  const guard = useGradeLeaveGuard(Boolean(file || url || pages), saving || reading, 'A supporting source upload')
  const close = () => { void guard.close(onClose) }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  async function chooseFile(next: File | null) {
    setFile(next)
    setPageCount(null)
    setFileHash('')
    setError('')
    const sequence = ++selectedFile.current
    if (!next) { setReading(false); return }
    if (!next.name.toLowerCase().endsWith('.pdf') || !next.size || next.size > limits.maxPdfBytes) { setError('Choose a nonempty PDF no larger than 20 MiB.'); return }
    setReading(true)
    try {
      const { PDFDocument } = await import('pdf-lib')
      const bytes = await next.arrayBuffer()
      const [document, digest] = await Promise.all([PDFDocument.load(bytes, { updateMetadata: false }), crypto.subtle.digest('SHA-256', bytes)])
      if (alive.current && sequence === selectedFile.current) {
        setPageCount(document.getPageCount())
        setFileHash([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
      }
    } catch {
      if (alive.current && sequence === selectedFile.current) setError('The PDF page metadata could not be read. Supply an unencrypted, readable PDF; no content was uploaded.')
    } finally {
      if (alive.current && sequence === selectedFile.current) setReading(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!api || submitting.current || !api.canWrite) return
    setError('')
    let selectedPages: number[]
    try {
      selectedPages = parseSelectedPages(pages, limits.maxPdfPages)
      if (kind === 'pdf') {
        if (!file || pageCount === null || !fileHash) throw new Error('Choose a readable PDF and wait for its page count and content fingerprint.')
        if (selectedPages.some((page) => page > pageCount)) throw new Error(`This PDF has ${pageCount} pages. Select pages within the original document.`)
        if (!selectedPages.length && pageCount > limits.maxPdfPages) throw new Error(`Select at most ${limits.maxPdfPages} relevant original pages before uploading this ${pageCount}-page PDF.`)
        const existingPages = detail.sources.filter((source) => source.origin !== 'seed-job' && source.originalContentType === 'application/pdf' && source.status !== 'cancelled')
          .reduce((total, source) => total + (source.selectedPages.length || source.pageCount || 0), 0)
        if (existingPages + (selectedPages.length || pageCount) > limits.maxTotalPdfPages) throw new Error(`This would exceed ${limits.maxTotalPdfPages} selected PDF pages. Narrow page selections in the source library first.`)
      } else {
        const parsed = new URL(url.trim())
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.trim().length > limits.maxUrlLength) {
          throw new Error('Use a direct public HTTP(S) URL without credentials.')
        }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Check the source and page selection.'); return }
    submitting.current = true
    setSaving(true)
    try {
      if (kind === 'pdf' && file) await api.uploadPdf(detail.ladder.id, file, keyFor('pdf', [detail.ladder.id, file.name, fileHash, selectedPages]), selectedPages)
      else {
        const input = { url: url.trim(), ...(selectedPages.length ? { selectedPages } : {}) }
        await api.addUrl(detail.ladder.id, input, keyFor('url', [detail.ladder.id, input]))
      }
      if (alive.current) { guard.release(); onClose() }
    } catch (caught) {
      if (alive.current) setError(`${caught instanceof Error ? caught.message : 'The source request failed.'} Retry unchanged inputs to reuse this request key. Check the source list before changing an uncertain request.`)
    } finally {
      submitting.current = false
      if (alive.current) setSaving(false)
    }
  }

  const sourceLimit = detail.sources.filter((source) => source.origin !== 'seed-job' && source.status !== 'cancelled').length >= limits.maxSources
  const disabled = !api?.canWrite || saving || reading || api.mutationPending || sourceLimit
  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Add supporting evidence" description="Upload actual PDF bytes or request a public URL. Documents are private, versioned references — not job imports."
    footer={<><Button onClick={close}>Cancel</Button><Button type="submit" form="grade-source-upload" variant="primary" icon={saving ? LoaderCircle : kind === 'pdf' ? FileUp : Link2} disabled={disabled}>{saving ? 'Submitting source…' : 'Capture supporting source'}</Button></>}>
    <form id="grade-source-upload" onSubmit={submit} className="space-y-5">
      <SegmentedControl label="Supporting source type" value={kind} onChange={(value) => { if (!saving && !reading) setKind(value) }} options={[{ value: 'pdf', label: 'Actual PDF' }, { value: 'url', label: 'Public URL' }]} />
      <fieldset disabled={saving || reading || !api?.canWrite} className="space-y-4">
        {kind === 'pdf' ? <label className="field"><span className="field-label">Supporting PDF</span><input className="input" aria-label="Supporting PDF" type="file" accept=".pdf,application/pdf" onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} />
          {file && <span className="field-hint">{file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MiB · {reading ? 'Reading page metadata…' : pageCount === null ? 'Page count unavailable' : `${pageCount} original pages`}</span>}</label>
          : <label className="field"><span className="field-label">Direct public reference URL</span><input className="input" aria-label="Direct public reference URL" type="url" value={url} maxLength={limits.maxUrlLength} onChange={(event) => setUrl(event.target.value)} placeholder="https://agency.gov/published-standard.pdf" /><span className="field-hint">Public PDF or substantive HTML page, including an intended section fragment. The server validates every redirect; private or credentialed URLs are not accepted.</span></label>}
        <label className="field"><span className="field-label">Original PDF pages (optional)</span><input className="input" aria-label="Original PDF pages (optional)" value={pages} onChange={(event) => setPages(event.target.value)} placeholder="1-12, 18, 25-30" />
          <span className="field-hint">Blank requests the whole PDF. Larger manuals require explicit selection; omitted pages are not treated as examined. HTML sources do not use PDF page ranges.</span></label>
      </fieldset>
      <p className="text-[11px] text-muted">Up to {limits.maxSources} supporting sources, plus the automatically captured seed. Each PDF: 20 MiB and {limits.maxPdfPages} selected pages; source set: {limits.maxTotalPdfPages} selected PDF pages. OCR and model processing incur service consumption.</p>
      <p className="text-[11px] text-muted">Supplied documents are supporting evidence, not automatically verified OPM authority. Scope and version conflicts remain review blockers.</p>
      {sourceLimit && <InlineError>The supporting-source limit is reached. The seed does not count toward this limit.</InlineError>}
      {error && <InlineError>{error}</InlineError>}
    </form>
  </Modal>
}
