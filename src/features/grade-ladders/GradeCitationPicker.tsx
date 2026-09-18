import { useEffect, useRef, useState } from 'react'
import type { Citation } from '../../domain/types'
import type { GradeSourceSetRecord, ReferenceDocument } from '../../domain/real-grades'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Button, InlineError, Modal } from '../../components/ui'
import { sourcePurposeLabels } from './gradeUi'

export function GradeCitationPicker({ ladderId, sourceSet, onAdd, onClose }: { ladderId: string; sourceSet: GradeSourceSetRecord; onAdd: (citation: Citation) => void; onClose: () => void }) {
  const api = useGradeLadders()
  const service = useRef(api)
  service.current = api
  const [sourceId, setSourceId] = useState('')
  const [document, setDocument] = useState<ReferenceDocument | null>(null)
  const [paragraphId, setParagraphId] = useState('')
  const [quote, setQuote] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const guard = useGradeLeaveGuard(Boolean(quote), false, 'An unsaved source quotation')
  const paragraph = document?.paragraphs.find((item) => item.id === paragraphId)
  const source = sourceSet.sources.find((item) => item.sourceId === sourceId)
  const matches = Boolean(quote.trim() && paragraph?.text.includes(quote.trim()))
  useEffect(() => {
    const controller = new AbortController()
    setDocument(null)
    setError('')
    if (sourceId) void service.current?.document(ladderId, sourceId, sourceSet.id, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      if (value.kind !== 'reference' || value.id !== source?.documentId || value.version !== source?.documentVersion) throw new Error('This is not the frozen reference version.')
      setDocument(value)
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'The frozen source could not be loaded.') })
    return () => controller.abort()
  }, [ladderId, retry, source?.documentId, source?.documentVersion, sourceId, sourceSet.id])
  const close = () => { void guard.close(onClose) }
  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Cite an exact captured passage" description="Choose only from this version's frozen sources. Adding new sources requires a newly confirmed source set and generation." wide
    footer={<><Button onClick={close}>Cancel quotation</Button><Button variant="primary" disabled={!matches} onClick={() => {
      if (!paragraph || !document || !matches) return
      onAdd({ documentId: document.id, documentVersion: document.version, paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: quote.trim() })
      guard.release()
      onClose()
    }}>Add exact quotation</Button></>}>
    <div className="space-y-4">
      <label className="field"><span className="field-label">Frozen reference</span><select className="input" aria-label="Frozen reference" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setParagraphId(''); setQuote('') }}>
        <option value="">Select a captured source</option>{sourceSet.sources.map((item) => <option key={item.sourceId} value={item.sourceId}>{item.title} · v{item.documentVersion} · {sourcePurposeLabels[item.purpose]}</option>)}
      </select></label>
      {sourceId && !document && !error && <p role="status" className="text-[12px] text-muted">Loading exact selected-page extraction…</p>}
      {document && <label className="field"><span className="field-label">Original page / section / paragraph</span><select className="input" aria-label="Original page / section / paragraph" value={paragraphId} onChange={(event) => { setParagraphId(event.target.value); setQuote('') }}>
        <option value="">Choose a source paragraph</option>{document.paragraphs.map((item) => <option key={item.id} value={item.id}>p. {item.page} · {item.heading || item.id} · {item.text.slice(0, 100)}</option>)}
      </select></label>}
      {paragraph && <><div><span className="grade-field-kicker">Captured paragraph — read in context</span><blockquote className="source-quote whitespace-pre-wrap">{paragraph.text}</blockquote></div>
        <label className="field"><span className="field-label">Exact quotation</span><textarea className="input" aria-label="Exact quotation" maxLength={6000} value={quote} rows={4} onChange={(event) => setQuote(event.target.value)} placeholder="Copy the exact supporting words. Put any interpretation in the separate interpretation field." />
          <span className="field-hint">{matches ? 'This text occurs in the selected captured paragraph. The server still reviews applicability and meaning.' : 'The quotation must exactly occur in the selected paragraph.'}</span></label></>}
      <p className="text-[11px] text-muted">Qualification requirements cannot substitute for work-level grading evidence. Quotation matching alone does not establish that a grade distinction is supported.</p>
      {error && <InlineError>{error} <button className="underline" onClick={() => setRetry((value) => value + 1)}>Retry captured source</button></InlineError>}
    </div>
  </Modal>
}
