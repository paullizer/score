import { useEffect, useRef, useState } from 'react'
import { Download, FileSearch, LoaderCircle } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import type { Citation } from '../../domain/types'
import type { FrozenReferenceSource, ReferenceDocument, ReferenceSourceRecord } from '../../domain/real-grades'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { Badge, Button, EmptyState, ExternalSource, InlineError, Modal } from '../../components/ui'
import { GradeIssueResolutions, GradeIssues } from './GradeShared'
import { sourcePurposeLabels } from './gradeUi'

export interface GradeSourceSelection {
  sourceId?: string
  sourceSetId?: string
  citation?: Citation
  paragraphId?: string
}

export function GradeSourceProvenance({ source }: { source: ReferenceSourceRecord | FrozenReferenceSource }) {
  const live = 'recordType' in source ? source : null
  const url = live ? live.finalUrl ?? live.requestedUrl : 'url' in source ? source.url : undefined
  return <div className="grade-provenance">
    <div className="flex flex-wrap gap-2"><Badge tone="accent">{sourcePurposeLabels[source.purpose]}</Badge><Badge>{source.origin === 'opm' ? 'Discovered OPM reference' : source.origin === 'seed-job' ? 'Automatically captured seed' : 'User supplied · not verified OPM authority'}</Badge><Badge tone={source.authorityStatus === 'current' ? 'neutral' : 'warning'}>{source.authorityStatus} authority / revision</Badge></div>
    <dl>
      <div><dt>Source identity / captured document</dt><dd><code>{live ? live.id : 'sourceId' in source ? source.sourceId : ''}</code><br /><code>{source.documentId} · v{source.documentVersion}</code></dd></div>
      <div><dt>Publisher / authority scope</dt><dd>{source.publisher || 'Not established'}</dd></div>
      <div><dt>Document version / stated revision</dt><dd>Captured v{source.documentVersion} · {source.revision || 'Revision not established'}</dd></div>
      <div><dt>Applicability</dt><dd>{source.coverage.state} · {source.coverage.explanation || 'Coverage has not been established.'}</dd></div>
      <div><dt>Series / grades / functions</dt><dd>{source.coverage.series.join(', ') || 'Unresolved series'} · {source.coverage.grades.map((grade) => `GS-${grade}`).join(', ') || 'No explicit grade coverage'} · {source.coverage.functions.join(', ') || 'No explicit functional coverage'}</dd></div>
      <div><dt>Intended section</dt><dd>{source.intendedSection || 'Whole reference / not specified'}</dd></div>
      <div><dt>Extraction completeness</dt><dd>{source.completeness} · {source.selectedPages.length ? `Selected original pages ${source.selectedPages.join(', ')}` : 'Full document requested'} · {source.pageCount === undefined ? 'Page count pending' : `${source.pageCount} original pages`}</dd></div>
      <div><dt>Captured content fingerprint</dt><dd><code>{source.sha256 || 'Capture pending — no verified hash yet'}</code></dd></div>
      {url && <div><dt>Source URL</dt><dd><ExternalSource url={url}>{url}</ExternalSource></dd></div>}
      {live && <>
        {live.requestedUrl && <div><dt>Requested URL</dt><dd><ExternalSource url={live.requestedUrl}>{live.requestedUrl}</ExternalSource></dd></div>}
        <div><dt>Captured at / original MIME / bytes</dt><dd>{live.capturedAt || 'Pending'} · {live.originalContentType || 'Pending'} · {live.bytes === undefined ? 'Size pending' : `${live.bytes.toLocaleString()} bytes`}</dd></div>
        <div><dt>Extraction method / parser version</dt><dd>{live.extractionMethod || 'Pending'} · {live.extractionVersion || 'Pending'}</dd></div>
        {!!live.redirects.length && <div><dt>Redirect chain</dt><dd><ol>{live.redirects.map((redirect, index) => <li key={index}><ExternalSource url={redirect}>{redirect}</ExternalSource></li>)}</ol></dd></div>}
        {!!live.discoveryPath.length && <div><dt>Auditable discovery path</dt><dd><ol>{live.discoveryPath.map((path, index) => <li key={index}>{URL.canParse(path) ? <ExternalSource url={path}>{path}</ExternalSource> : path}</li>)}</ol></dd></div>}
        {!!live.relatedLinks.length && <div><dt>Related evidence</dt><dd><ul>{live.relatedLinks.map((link, index) => <li key={index}>{link.relation} · <ExternalSource url={link.url}>{link.label || link.url}</ExternalSource>{link.page !== undefined && ` · p. ${link.page}`}</li>)}</ul></dd></div>}
      </>}
    </dl>
    <GradeIssues issues={source.issues.filter(issue => !source.issueResolutions?.some(resolution => resolution.issue.id === issue.id))} title="Source coverage and version issues" />
    <GradeIssueResolutions resolutions={source.issueResolutions ?? []} />
  </div>
}

export function GradeSourceInspector({ ladderId, selection, onClose }: { ladderId: string; selection: GradeSourceSelection; onClose: () => void }) {
  const api = useGradeLadders()
  const service = useRef(api)
  service.current = api
  const [loaded, setLoaded] = useState<{ document: ReferenceDocument; source: ReferenceSourceRecord | FrozenReferenceSource; sourceSetId?: string; capturedAt?: string } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const { sourceId, sourceSetId, citation, paragraphId } = selection
  const documentId = citation?.documentId
  const documentVersion = citation?.documentVersion

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(null)
    setError('')
    void (async () => {
      const current = service.current
      if (!current) throw new Error('The private grade service is unavailable.')
      if (documentId && !sourceSetId) throw new Error('This claim has no captured source-set identity. Score will not substitute the latest source.')
      let source: ReferenceSourceRecord | FrozenReferenceSource | undefined
      let capturedAt: string | undefined
      if (sourceSetId) {
        const frozen = await current.sourceSet(ladderId, sourceSetId, controller.signal)
        source = frozen.sources.find((item) => sourceId ? item.sourceId === sourceId : item.documentId === documentId && item.documentVersion === documentVersion)
        capturedAt = frozen.createdAt
      } else {
        const detail = current.detail(ladderId)
        source = detail.state === 'ready' ? detail.value.sources.find((item) => item.id === sourceId) : undefined
      }
      if (!source) throw new Error('This source is not part of the requested captured source set.')
      if (documentId && (source.documentId !== documentId || source.documentVersion !== documentVersion)) throw new Error('The citation and captured source version do not match.')
      const id = 'sourceId' in source ? source.sourceId : source.id
      const document = await current.document(ladderId, id, sourceSetId, controller.signal)
      if (document.kind !== 'reference' || document.id !== source.documentId || document.version !== source.documentVersion) {
        throw new Error('The service did not return the exact captured reference document. No alternate source is shown.')
      }
      if (!controller.signal.aborted) setLoaded({ document, source, sourceSetId, capturedAt })
    })().catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'The private reference could not be opened.')
    })
    return () => controller.abort()
  }, [documentId, documentVersion, ladderId, retry, sourceId, sourceSetId])

  const highlighted = citation?.paragraphId ?? paragraphId
  const paragraph = loaded?.document.paragraphs.find((item) => item.id === highlighted)
  const matches = !citation || Boolean(paragraph && paragraph.page === citation.page && paragraph.heading === citation.heading && paragraph.text.includes(citation.quote))
  const resolvedSourceId = loaded ? ('sourceId' in loaded.source ? loaded.source.sourceId : loaded.source.id) : undefined
  return <Modal open onOpenChange={(open) => { if (!open) onClose() }} drawer title={loaded?.source.title ?? 'Captured source inspector'}
    description={sourceSetId ? 'The exact source version frozen for this grade version. Current extractions are never substituted.' : 'Current captured source proposal. Generated versions open their own immutable source set.'}
    footer={<><Button onClick={onClose}>Close source</Button>{loaded && resolvedSourceId && <a className="button button-secondary button-md" download href={api?.originalUrl(ladderId, resolvedSourceId, loaded.sourceSetId)}><Download size={15} aria-hidden="true" />Captured original</a>}</>}>
    {error && <InlineError>{error} <button className="underline" onClick={() => setRetry((value) => value + 1)}>Retry source</button></InlineError>}
    {!loaded && !error && <EmptyState icon={LoaderCircle} title="Opening the private reference" description="Retrieving the authorized captured document and its immutable source metadata." />}
    {loaded && <>
      {loaded.sourceSetId && <div className="grade-snapshot-label"><FileSearch size={15} aria-hidden="true" /><span>Frozen {loaded.capturedAt} · <code>{loaded.sourceSetId}</code></span></div>}
      {citation && <div className="mb-4"><span className="grade-field-kicker">Claim's exact quotation, not interpretation</span><blockquote className="source-quote">“{citation.quote}”</blockquote></div>}
      {!matches && <InlineError>The cited quotation or locator does not match this captured paragraph. Treat it as an unresolved citation; it must not support approval.</InlineError>}
      {highlighted && !paragraph && <InlineError>This passage is not in the selected extraction pages. Omitted pages were not examined.</InlineError>}
      <DocumentViewer document={loaded.document} highlightedId={highlighted} quote={matches ? citation?.quote : undefined} compact />
      <details className="mt-5" open><summary className="cursor-pointer text-[13px] font-semibold">Provenance, applicability, and captured version</summary><GradeSourceProvenance source={loaded.source} /></details>
    </>}
  </Modal>
}
