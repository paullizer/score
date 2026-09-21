import { lazy, Suspense, useContext, useState } from 'react'
import type { SourceDocument } from '../../domain/types'
import { UPLOAD_CONTENT_TYPES, documentPagination, type DocumentPagination } from '../../domain/document-formats'
import type { PrivateOriginalMetadata } from './docxPreviewClient'
import { SegmentedControl } from '../ui'
import { DocumentViewer } from './DocumentViewer'
import { WorkspaceContext } from '../../app/workspace-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { createDefaultAdminSettings } from '../../domain/admin-settings-defaults'

const DocxPreview = lazy(() => import('./DocxPreview'))

interface Props {
  document: SourceDocument
  originalUrl: string
  original: PrivateOriginalMetadata
  highlighted?: { id: string; quote?: string }
  pagination?: DocumentPagination
}

export function PrivateDocumentViewer(props: Props) {
  const { settings, cloud: cloudPolicy, phase, error } = usePublicSettings()
  const workspace = useContext(WorkspaceContext)
  const cloud = workspace?.cloud
  const role = cloud?.workspaces.find(item => item.id === cloud.currentWorkspaceId)?.role
  const policy = settings?.documents ?? createDefaultAdminSettings().documents
  const available = !cloudPolicy || (phase === 'ready' && Boolean(settings))
  const originalAllowed = available && (cloud ? Boolean(role && policy.originalDownloadRoles.includes(role)) : !cloudPolicy)
  const formattedAllowed = originalAllowed && policy.formattedDocxPreviewEnabled
  const reason = !available ? error ?? (phase === 'loading'
    ? 'Checking current document permissions. Extracted evidence remains available.'
    : 'Current document policy is unavailable. Extracted evidence remains available.')
    : !originalAllowed ? 'Your current workspace role cannot access original files. Formatted Word preview is unavailable; extracted evidence remains available.'
    : !policy.formattedDocxPreviewEnabled ? 'Formatted Word preview is disabled by application policy. Extracted evidence remains available.' : ''
  return <PrivateDocumentView
    key={`${props.originalUrl}:${props.document.id}:${props.document.version}:${props.original.sha256 ?? ''}:${formattedAllowed}`}
    {...props} formattedAllowed={formattedAllowed} originalAllowed={originalAllowed} policyReason={reason} />
}

function PrivateDocumentView({ document, originalUrl, original, highlighted, pagination, formattedAllowed, originalAllowed, policyReason }: Props & {
  formattedAllowed: boolean; originalAllowed: boolean; policyReason: string
}) {
  const [selection, setSelection] = useState<{ mode: 'extracted' | 'formatted'; citation?: Props['highlighted'] }>({ mode: 'extracted' })
  const docx = original.contentType === UPLOAD_CONTENT_TYPES.docx
  const legacy = original.contentType === UPLOAD_CONTENT_TYPES.doc
  const mode = formattedAllowed && selection.citation === highlighted ? selection.mode : 'extracted'
  return <>
    {docx && formattedAllowed && <div className="document-view-switcher"><SegmentedControl label="Document preview mode" value={mode}
      onChange={(value) => setSelection({ mode: value, citation: highlighted })}
      options={[{ value: 'extracted', label: 'Extracted text' }, { value: 'formatted', label: 'Formatted Word preview' }]} />
      <p>Extracted text is the authoritative citation source. Formatting is approximate.</p></div>}
    {docx && !formattedAllowed && <p className="word-preview-note" role="status">{policyReason}</p>}
    {legacy && <p className="word-preview-note"><strong>Legacy Word DOC · text-only preview.</strong> Original formatting is unavailable. Citations use captured sections with stable paragraphs, not printed pages. {originalAllowed ? 'Download the original to inspect its layout.' : policyReason} Embedded images are not extracted as evidence; use PDF/OCR for image-only content.</p>}
    {mode === 'formatted' && docx
      ? <Suspense fallback={<p className="word-preview-status" role="status">Loading the private Word preview…</p>}><DocxPreview originalUrl={originalUrl} original={original} /></Suspense>
      : <DocumentViewer document={document} highlightedId={highlighted?.id} quote={highlighted?.quote}
        pagination={docx || legacy ? 'captured-sections' : pagination ?? documentPagination(original.contentType)} />}
  </>
}
