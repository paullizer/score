import { useEffect, useRef } from 'react'
import { FileText, ScanLine } from 'lucide-react'
import type { SourceDocument } from '../../domain/types'
import { Badge } from '../ui'

export function DocumentViewer({ document, highlightedId, quote, compact = false }: {
  document: SourceDocument; highlightedId?: string; quote?: string; compact?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlightedId) return
    const element = container.current?.querySelector<HTMLElement>(`[data-paragraph-id="${CSS.escape(highlightedId)}"]`)
    element?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    element?.focus({ preventScroll: true })
  }, [highlightedId, quote, document.id])
  const pages = [...new Set(document.paragraphs.map((paragraph) => paragraph.page))]
  return <div ref={container} className={`document-viewer ${compact ? 'document-compact' : ''}`}>
    <div className="document-toolbar"><span><FileText size={15} />Source document</span><Badge>Sample content</Badge></div>
    <div className="document-scroll">
      {pages.map((page, pageIndex) => <article className="document-page" key={page} aria-label={`${document.title}, page ${page}`}>
        <div className="document-kicker">{document.kind === 'resume' ? 'PROFESSIONAL PROFILE' : 'POSITION DESCRIPTION'}<span>0{page}</span></div>
        {pageIndex === 0 && <><h2>{document.title}</h2><div className="document-rule" /></>}
        {document.paragraphs.filter((paragraph) => paragraph.page === page).map((paragraph) => {
          const active = paragraph.id === highlightedId
          const match = active && quote ? paragraph.text.indexOf(quote) : -1
          return <section key={paragraph.id} data-paragraph-id={paragraph.id} tabIndex={-1} className={`document-paragraph ${active ? 'is-highlighted' : ''}`}>
            <h3>{active && <ScanLine size={14} />}{paragraph.heading}</h3>
            <p>{match >= 0 && quote ? <>{paragraph.text.slice(0, match)}<mark>{quote}</mark>{paragraph.text.slice(match + quote.length)}</> : paragraph.text}</p>
          </section>
        })}
        <footer><span>Fictional document / Score demo</span><span>Page {page} of {pages.length}</span></footer>
      </article>)}
    </div>
  </div>
}
