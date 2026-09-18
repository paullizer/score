import { useEffect, useState } from 'react'
import { Download, LoaderCircle, RotateCcw } from 'lucide-react'
import { Button, InlineError } from '../ui'
import { convertDocxInWorker, fetchPrivateDocx, privateOriginalUrl, type PrivateOriginalMetadata } from './docxPreviewClient'
import { DOCX_PREVIEW_LIMITS } from './docxPreviewSafety'
import { sanitizeDocxPreview } from './docxPreviewSanitize'

type PreviewState = { state: 'loading' } | { state: 'ready'; srcDoc: string; warnings: string[] } | { state: 'error'; error: string }

export default function DocxPreview({ originalUrl, original }: { originalUrl: string; original: PrivateOriginalMetadata }) {
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState<PreviewState>({ state: 'loading' })
  const { bytes, sha256, contentType } = original
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setPreview({ state: 'loading' })
    const timer = setTimeout(() => controller.abort(new Error('Loading the private Word preview timed out. Retry or download the original.')), DOCX_PREVIEW_LIMITS.parserTimeoutMilliseconds * 2)
    void (async () => {
      try {
        const file = await fetchPrivateDocx(originalUrl, { bytes, sha256, contentType }, controller.signal)
        const result = await convertDocxInWorker(file, controller.signal)
        controller.signal.throwIfAborted()
        const sanitized = sanitizeDocxPreview(result.html)
        if (active) setPreview({ state: 'ready', srcDoc: sanitized.srcDoc, warnings: [...new Set([...result.warnings, ...sanitized.warnings])] })
      } catch (error) {
        if (!active || (controller.signal.aborted && controller.signal.reason?.name === 'AbortError')) return
        setPreview({ state: 'error', error: error instanceof Error ? error.message : 'This Word file could not be previewed.' })
      } finally { clearTimeout(timer) }
    })()
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [attempt, bytes, contentType, originalUrl, sha256])
  let download: string | undefined
  try { download = privateOriginalUrl(originalUrl) } catch { /* Invalid endpoints must not become download links either. */ }
  return <div className="docx-preview">
    <div className="word-preview-note"><strong>Approximate Word formatting</strong><p>This is not a reproduction of printed Word pages. Citations and scoring use only the authoritative extracted text. Links and external resources are disabled; embedded images are not extracted as evidence.</p></div>
    {preview.state === 'loading' && <p className="word-preview-status" role="status"><LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden="true" />Loading and privately converting the DOCX…</p>}
    {preview.state === 'error' && <div className="word-preview-status"><InlineError><strong>Formatted preview unavailable. </strong>{preview.error}<p>The imported source is unchanged. Use the Extracted text view for evidence.</p></InlineError></div>}
    {preview.state === 'ready' && <>
      {preview.warnings.length > 0 && <div className="word-preview-warnings" role="status"><strong>Preview limitations</strong><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      <iframe className="docx-preview-frame" title="Approximate formatted Word preview" sandbox="" referrerPolicy="no-referrer" srcDoc={preview.srcDoc} />
    </>}
    <div className="word-preview-actions">
      {preview.state === 'error' && <Button size="sm" icon={RotateCcw} onClick={() => setAttempt((value) => value + 1)}>Retry formatted preview</Button>}
      {download && <a className="button button-secondary button-sm" href={download} download><Download size={14} aria-hidden="true" />Download Word original</a>}
    </div>
  </div>
}
