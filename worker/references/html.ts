import { JSDOM } from 'jsdom'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import type { ReferenceLink, ReferenceParagraph, ReferenceRelation } from '../../src/domain/real-grades'
import { normalizeText, WorkerError } from '../runtime'
import { isOpmUrl, referenceUrl } from './transport'
import { referenceTableRows } from './tables'
import type { ReferenceCell } from './tables'
import type { AdminSettings } from '../../src/domain/admin-settings'

const BLOCKS = new Set(['P', 'LI', 'DT', 'DD', 'PRE', 'BLOCKQUOTE', 'FIGCAPTION'])
const IGNORED = 'script,style,noscript,template,svg,canvas,iframe,object,embed,base,nav,header,footer,aside,form,[role="navigation"],.usa-sidenav,.usa-breadcrumb,.opm-breadcrumbs,.breadcrumb,.back-to-top,.print-controls'

export function referenceRelation(label: string, url: string, context = ''): ReferenceRelation {
  const text = `${label === url ? '' : label} ${context}`
  if (/supersed|replac(?:es|ed|ement)|issuance|memorand|cancell?ed|abolish|retir/i.test(text) || /\/chcoc\//i.test(url)) return 'supersession'
  if (/exclud|not (?:covered|applicable)|does not apply/i.test(text)) return 'exclusion'
  if (/qualif|occupational requirements/i.test(text) || /(?:general-schedule-qualification|competency-based-qualification)-standard/i.test(url)) return 'qualification'
  if (/grad(?:ing|e evaluation)|classification standard|classifying|functional guide|supervisory guide/i.test(text) ||
    /\/functional-guides\/|\/classifying-general-schedule-positions\/standards\/|competency-based-classification-standard/i.test(url)) return 'grading'
  return 'background'
}

export function referenceLinks(root: Element, url: string, maxLinks = 2_000): { links: ReferenceLink[]; warnings: string[] } {
  const links: ReferenceLink[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim() ?? ''
    if (!href || /^(?:javascript|mailto|tel|data):/i.test(href) || /^#(?:top|main-content)$/i.test(href)) continue
    try {
      const target = referenceUrl(href, url).href
      const label = normalizeText(anchor.textContent ?? '') || target
      const key = `${target}\n${label}`
      if (seen.has(key)) continue
      if (links.length >= maxLinks) throw new WorkerError('reference-link-budget', `The source contains more than ${maxLinks} links; select a narrower section.`, false, 'parsing')
      seen.add(key)
      links.push({
        url: target,
        label,
        relation: referenceRelation(label, target, normalizeText(anchor.closest('p,li,tr')?.textContent ?? '')),
      })
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'reference-link-budget') throw error
      warnings.push('An invalid or unsupported source link was not followed.')
    }
  }
  return { links, warnings: [...new Set(warnings)] }
}

function fragmentName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^#/, ''))
  } catch {
    throw new WorkerError('reference-section-invalid', 'The selected reference fragment is invalid.', false, 'parsing')
  }
}

export function referenceContent(document: Document, url: string, intendedSection?: string): Element {
  const body = document.body.cloneNode(true) as HTMLElement
  body.querySelectorAll(IGNORED).forEach(node => node.remove())
  const competency = isOpmUrl(url) && new URL(url).pathname.includes('/competency-based-policy/')
  let root: Element = competency ? body : body.querySelector('#main-main-content') ?? body.querySelector('article,main,[role="main"],#main-content') ?? body
  if (intendedSection) {
    const name = fragmentName(intendedSection)
    const target = [...root.querySelectorAll('[id],a[name]')].find(element => element.id === name || element.getAttribute('name') === name)
      ?? (root.id === name ? root : undefined)
    if (!target) throw new WorkerError('reference-section-not-found', `The captured reference does not contain the intended section "${name}". A redirect must not select another section.`, false, 'parsing')
    const heading = target.closest('h1,h2,h3,h4,h5,h6')
    if (!heading && /^(?:SECTION|ARTICLE|DIV|TABLE)$/.test(target.tagName) && normalizeText(target.textContent ?? '')) {
      root = target
    } else {
      const start = heading ?? target.closest('p,li,dt,dd') ?? target
      const level = heading ? Number(heading.tagName[1]) : 6
      const following = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .find(element => (start.compareDocumentPosition(element) & 4) !== 0 && Number(element.tagName[1]) <= level)
      const range = document.createRange()
      range.setStartBefore(start)
      if (following) range.setEndBefore(following)
      else range.setEndAfter(root.lastChild ?? start)
      const selected = document.createElement('div')
      selected.append(range.cloneContents())
      root = selected
    }
    if (/^GS-(?:ADMIN|PROF|TECH|CLER)$/.test(name) && (!root.querySelector('table') || !/grade|GS[-– ]*\d/i.test(root.textContent ?? ''))) {
      throw new WorkerError('opm-group-structure-changed', 'The intended OPM qualification group no longer contains its expected grade table.', false, 'parsing')
    }
  }
  if (competency && /(?:classification-standard|qualification-standard)(?:\/print)?\/?$/i.test(new URL(url).pathname)) {
    const headings = [...root.querySelectorAll('h1,h2,h3,h4')].map(element => element.textContent).join(' ')
    const expected = /qualification-standard(?:\/print)?\/?$/i.test(new URL(url).pathname)
      ? /qualifications by grade|minimum qualification|grade level/i
      : /grading (?:information|positions|criteria)|factor (?:level descriptions|1\b)|grade[- ]level (?:criteria|descriptions)/i
    if (!expected.test(headings) || !/competenc/i.test(root.textContent ?? '')) {
      throw new WorkerError('opm-competency-structure-changed', 'The OPM competency-policy print content is missing its expected substantive headings.', false, 'parsing')
    }
  }
  return root
}

export function elementText(element: Node): string {
  if (element.nodeType === 3) return element.textContent ?? ''
  if (element.nodeType !== 1) return ''
  const tag = (element as Element).tagName
  if (tag === 'BR') return '\n'
  const text = [...element.childNodes].map(elementText).join('')
  if (tag === 'TD' || tag === 'TH') return `${text} | `
  return /^(?:P|DIV|LI|TR|H[1-6])$/.test(tag) ? `${text}\n` : text
}

function htmlTable(table: HTMLTableElement) {
  const rows = [...table.rows].filter(row => row.closest('table') === table)
  if (rows.length > 20_000) throw new WorkerError('reference-table-budget', 'The reference table contains too many rows.', false, 'parsing')
  const cells: ReferenceCell[] = []
  const occupied = new Set<string>()
  let columns = 0
  rows.forEach((row, rowIndex) => {
    let column = 0
    const explicitHeader = row.parentElement?.tagName === 'THEAD' || [...row.cells].every(cell => cell.tagName === 'TH' && cell.scope !== 'row')
    const values = [...row.cells].map(cell => normalizeText(cell.textContent ?? ''))
    const inferredHeader = rowIndex === 0 && values.every(value => value.length < 160) && (
      values.filter(value => /^GS[-– ]*\d{1,2}$/i.test(value)).length >= 2 ||
      (/^(?:grade(?: level)?|gs(?: grade| level)?|pay grade|level|qualification|requirement|path|education|experience)$/i.test(values[0] ?? '') &&
        !values.slice(1).some(value => /\b(?:\d+\s*(?:year|month)|degree|equivalent to)\b/i.test(value)))
    )
    for (const cell of row.cells) {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1
      const rowSpan = cell.rowSpan === 0 ? rows.length - rowIndex : cell.rowSpan
      const columnSpan = cell.colSpan
      if (rowSpan > rows.length - rowIndex || column + columnSpan > 200) {
        throw new WorkerError('reference-table-invalid', 'The HTML reference table has unsupported row/column spans.', false, 'parsing')
      }
      const value: ReferenceCell = {
        row: rowIndex, column, rowSpan, columnSpan,
        text: normalizeText(elementText(cell).replace(/ \| $/, '')),
        columnHeader: explicitHeader || inferredHeader,
      }
      cells.push(value)
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = column; c < column + columnSpan; c += 1) occupied.add(`${r}:${c}`)
      }
      column += columnSpan
      columns = Math.max(columns, column)
    }
  })
  return rows.length && columns ? referenceTableRows(cells, rows.length, columns) : []
}

export function enforceReferenceCharacters(paragraphs: ReferenceParagraph[], maxCharacters: number = GRADE_LADDER_LIMITS.maxSourceCharacters): void {
  const characters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + paragraph.heading.length, 0)
  if (characters > maxCharacters) {
    throw new WorkerError('reference-too-long', `Reference extraction exceeds ${maxCharacters} characters. Select fewer pages or a narrower section; no text was silently truncated.`, false, 'parsing')
  }
}

export function extractReferenceHtml(html: string, url: string, title: string, intendedSection?: string, limits?: AdminSettings['grades']['references']): {
  paragraphs: ReferenceParagraph[]
  links: ReferenceLink[]
  warnings: string[]
  thin: boolean
} {
  const dom = new JSDOM(html, { url })
  try {
    const root = referenceContent(dom.window.document, url, intendedSection)
    const { links, warnings } = referenceLinks(root, url, limits?.maxLinks)
    const paragraphs: ReferenceParagraph[] = []
    const headings: string[] = [title]
    let sectionId = intendedSection?.replace(/^#/, '')
    let tableNumber = 0
    const add = (text: string, extra: Partial<ReferenceParagraph> = {}) => {
      text = normalizeText(text)
      if (!/[\p{L}\p{N}]/u.test(text)) return
      paragraphs.push({
        id: `ref-p0001-b${String(paragraphs.length + 1).padStart(5, '0')}`,
        page: 1,
        heading: headings.filter(Boolean).join(' / ') || title,
        text,
        ...(sectionId ? { sectionId } : {}),
        ...extra,
      })
    }
    const walk = (element: Element) => {
      const tag = element.tagName
      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1])
        const text = normalizeText(elementText(element))
        headings.length = level
        headings[level] = text
        sectionId = element.id || element.querySelector('a[name]')?.getAttribute('name') || sectionId
        add(text)
        return
      }
      if (tag === 'TABLE') {
        tableNumber += 1
        const tableId = element.id || `${sectionId ?? 'section'}-table-${tableNumber}`
        const caption = element.querySelector(':scope > caption')
        if (caption) add(elementText(caption), { sectionId: tableId })
        for (const row of htmlTable(element as HTMLTableElement)) {
          add(row.text, { sectionId: tableId, table: { headers: row.headers, row: row.row } })
        }
        return
      }
      if (BLOCKS.has(tag)) {
        const localId = element.id || element.querySelector('a[name]')?.getAttribute('name')
        add(elementText(element), localId ? { sectionId: localId } : {})
        return
      }
      let inline = ''
      const flush = () => { add(inline); inline = '' }
      for (const child of element.childNodes) {
        if (child.nodeType === 3) {
          inline += child.textContent ?? ''
        } else if (child.nodeType === 1) {
          const childElement = child as Element
          if (/^(?:A|SPAN|STRONG|B|I|EM|SMALL|SUP|SUB|BR|U)$/.test(childElement.tagName)) inline += elementText(child)
          else { flush(); walk(childElement) }
        }
      }
      flush()
    }
    walk(root)
    enforceReferenceCharacters(paragraphs, limits?.maxSourceCharacters)
    const text = paragraphs.map(paragraph => paragraph.text).join('\n')
    if (/\b(?:draft|insert (?:date|link)|TBD|placeholder|XX\/XX|MONTH DD)\b/i.test(text)) {
      warnings.push('This source contains draft or placeholder language; reconcile it with the linked issuance/effective-version evidence before relying on it.')
    }
    return {
      paragraphs, links, warnings,
      thin: !paragraphs.some(paragraph => paragraph.table) && text.length < 120,
    }
  } finally {
    dom.window.close()
  }
}
