import { lazy, Suspense, useState } from 'react'
import type { SourceDocument } from '../../domain/types'
import { UPLOAD_CONTENT_TYPES, documentPagination, type DocumentPagination } from '../../domain/document-formats'
import type { PrivateOriginalMetadata } from './docxPreviewClient'
import { SegmentedControl } from '../ui'
import { DocumentViewer } from './DocumentViewer'

const DocxPreview = lazy(() => import('./DocxPreview'))

interface Props {
  document: SourceDocument
  originalUrl: string
  original: PrivateOriginalMetadata
  highlighted?: { id: string; quote?: string }
  pagination?: DocumentPagination
}

export function PrivateDocumentViewer(props: Props) {
  return <PrivateDocumentView key={`${props.originalUrl}:${props.document.id}:${props.document.version}:${props.original.sha256 ?? ''}`} {...props} />
}

function PrivateDocumentView({ document, originalUrl, original, highlighted, pagination }: Props) {
  const [selection, setSelection] = useState<{ mode: 'extracted' | 'formatted'; citation?: Props['highlighted'] }>({ mode: 'extracted' })
  const docx = original.contentType === UPLOAD_CONTENT_TYPES.docx
  const legacy = original.contentType === UPLOAD_CONTENT_TYPES.doc
  const mode = selection.citation === highlighted ? selection.mode : 'extracted'
  return <>
    {docx && <div className="document-view-switcher"><SegmentedControl label="Document preview mode" value={mode}
      onChange={(value) => setSelection({ mode: value, citation: highlighted })}
      options={[{ value: 'extracted', label: 'Extracted text' }, { value: 'formatted', label: 'Formatted Word preview' }]} />
      <p>Extracted text is the authoritative citation source. Formatting is approximate.</p></div>}
    {legacy && <p className="word-preview-note"><strong>Legacy Word DOC · text-only preview.</strong> Original formatting is unavailable. Citations use captured sections with stable paragraphs, not printed pages. Download the original to inspect its layout. Embedded images are not extracted as evidence; use PDF/OCR for image-only content.</p>}
    {mode === 'formatted' && docx
      ? <Suspense fallback={<p className="word-preview-status" role="status">Loading the private Word preview…</p>}><DocxPreview originalUrl={originalUrl} original={original} /></Suspense>
      : <DocumentViewer document={document} highlightedId={highlighted?.id} quote={highlighted?.quote}
        pagination={docx || legacy ? 'captured-sections' : pagination ?? documentPagination(original.contentType)} />}
  </>
}
