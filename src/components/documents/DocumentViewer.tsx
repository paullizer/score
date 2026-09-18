import { useEffect, useRef } from 'react'
import { FileText, ScanLine } from 'lucide-react'
import type { SourceDocument } from '../../domain/types'
import type { ReferenceDocument } from '../../domain/real-grades'
import type { DocumentPagination } from '../../domain/source-files'
import { Badge } from '../ui'

export function DocumentViewer({ document, highlightedId, quote, compact = false, pagination = 'pdf-pages' }: {
  document: SourceDocument | ReferenceDocument; highlightedId?: string; quote?: string; compact?: boolean
  pagination?: DocumentPagination
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlightedId) return
    const element = container.current?.querySelector<HTMLElement>(`[data-paragraph-id="${CSS.escape(highlightedId)}"]`)
    element?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    element?.focus({ preventScroll: true })
  }, [highlightedId, quote, document.id, document.version])
  const pages = [...new Set(document.paragraphs.map((paragraph) => paragraph.page))].sort((a, b) => a - b)
  const reference = document.kind === 'reference'
  const paginated = pagination === 'pdf-pages'
  const sectionLabel = pagination === 'markdown-sections' ? 'Markdown' : pagination === 'html-sections' ? 'Captured HTML' : 'Captured source'
  const pageCount = reference ? document.pageCount : Math.max(...pages, 0)
  return <div ref={container} className={`document-viewer ${compact ? 'document-compact' : ''}`}>
    <div className="document-toolbar"><span><FileText size={15} />{reference ? 'Captured reference' : 'Source document'} · v{document.version}</span><Badge tone={document.sample ? 'neutral' : 'accent'}>{document.sample ? 'Sample content' : 'Actual source'}</Badge></div>
    {reference && <p className="reference-completeness" role="status">{document.completeness === 'complete' ? 'Complete extraction' : document.completeness === 'selected-pages' ? 'Selected-page extraction — omitted pages were not examined' : 'Incomplete extraction — do not assume full coverage'} · {pages.length} captured {paginated ? `${pages.length === 1 ? 'page' : 'pages'} of ${pageCount}` : 'section groups'}{document.selectedPages.length > 0 && <> · Selected original pages: {document.selectedPages.join(', ')}</>}</p>}
    <div className="document-scroll">
      {pages.map((page, pageIndex) => <article className="document-page" key={page} aria-label={`${document.title}, ${paginated ? 'page' : pagination === 'markdown-sections' ? 'Markdown section' : 'captured section'} ${page}`}>
        <div className="document-kicker">{reference ? 'REFERENCE / STANDARD' : document.kind === 'resume' ? 'PROFESSIONAL PROFILE' : 'POSITION DESCRIPTION'}<span>{String(page).padStart(2, '0')}</span></div>
        {pageIndex === 0 && <><h2>{document.title}</h2><div className="document-rule" /></>}
        {document.paragraphs.filter((paragraph) => paragraph.page === page).map((paragraph) => {
          const active = paragraph.id === highlightedId
          const match = active && quote ? paragraph.text.indexOf(quote) : -1
          return <section key={paragraph.id} data-paragraph-id={paragraph.id} tabIndex={-1} className={`document-paragraph ${active ? 'is-highlighted' : ''}`}>
            <h3>{active && <ScanLine size={14} />}{paragraph.heading}</h3>
            {'sectionId' in paragraph && typeof paragraph.sectionId === 'string' && <span className="reference-locator">Section {paragraph.sectionId}</span>}
            {'table' in paragraph && typeof paragraph.table === 'object' && paragraph.table !== null && 'headers' in paragraph.table && Array.isArray(paragraph.table.headers) && <span className="reference-locator">Table columns: {paragraph.table.headers.join(' · ')}</span>}
            <p>{match >= 0 && quote ? <>{paragraph.text.slice(0, match)}<mark>{quote}</mark>{paragraph.text.slice(match + quote.length)}</> : paragraph.text}</p>
          </section>
        })}
        <footer><span>{document.sample ? 'Fictional document / Score demo' : 'Private workspace source'}</span><span>{paginated ? `Original page ${page} of ${pageCount}` : `${sectionLabel} section ${pageIndex + 1} of ${pages.length}`}</span></footer>
      </article>)}
    </div>
  </div>
}
