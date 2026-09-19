export const DOCUMENT_REPORT_PAGE = {
  width: 612, height: 792, margin: 46, bodyTop: 685, bodyBottom: 66,
} as const

export const DOCUMENT_REPORT_WIDTH = DOCUMENT_REPORT_PAGE.width - DOCUMENT_REPORT_PAGE.margin * 2

export function documentMetadataText(entries: string[], measure: (text: string) => number): string {
  const rows: string[] = []
  let row = ''
  const flush = () => { if (row) rows.push(row); row = '' }
  for (const entry of entries) {
    if (/[\r\n\u0085\u2028\u2029]/u.test(entry) || measure(entry) > DOCUMENT_REPORT_WIDTH) {
      flush()
      rows.push(entry)
      continue
    }
    const combined = row ? `${row} \u00b7 ${entry}` : entry
    if (measure(combined) > DOCUMENT_REPORT_WIDTH) {
      flush()
      row = entry
    } else row = combined
  }
  flush()
  return rows.join('\n')
}

export interface DocumentReportLink {
  text: string
  url: string
}

export type DocumentTableCell = string | DocumentReportLink
export type DocumentTextLink = string | { destination: string }

export interface DocumentContentsEntry {
  label: string
  title: string
  organization: string
  metadata: string[]
  detail: string
  destination: string
}

export interface DocumentTextStyle<Color> {
  size?: number
  leading?: number
  bold?: boolean
  color?: Color
  padding?: number
  background?: Color
  rule?: boolean
  before?: number
  after?: number
  keepWithNext?: number
  keepTailWithNext?: boolean
  link?: DocumentTextLink
  headingLevel?: 1 | 2 | 3
}

export interface DocumentPageIdentity {
  section: string
  primary: string
  primaryFallback?: string
  secondary: string
}

export interface DocumentReportLayout<Color> {
  readonly colors: { background: Color; accent: Color; muted: Color }
  startSection(identity: DocumentPageIdentity): void
  markDestination(destination: string): void
  paragraph(text: string, style?: DocumentTextStyle<Color>): void
  heading(text: string, size?: number): void
  label(text: string): void
  metadata(entries: string[]): void
  links(links: readonly DocumentReportLink[]): void
  contentsEntry(entry: DocumentContentsEntry): void
  table(headers: string[], rows: DocumentTableCell[][], widths: number[]): void
  explanation(label: string, text: string, source: string | null): void
}
