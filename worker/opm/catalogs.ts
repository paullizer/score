import { JSDOM } from 'jsdom'
import type { ReferenceLink } from '../../src/domain/real-grades'
import { normalizeText, WorkerError } from '../runtime'
import { referenceContent, referenceLinks } from '../references/html'
import { referenceUrl } from '../references/transport'

export const OPM_CATALOGS = {
  classification: 'https://www.opm.gov/policy-data-oversight/classification-qualifications/classifying-general-schedule-positions/',
  qualifications: 'https://www.opm.gov/policy-data-oversight/classification-qualifications/general-schedule-qualification-standards/tabs/list-by-occupational-series/',
  groups: 'https://www.opm.gov/policy-data-oversight/classification-qualifications/general-schedule-qualification-standards/tabs/group-standards/',
  competency: 'https://www.opm.gov/policy-data-oversight/classification-qualifications/competency-based-policy/',
} as const

export const OPM_CATALOG_VERSION = 'score-opm-dom-v2'

export interface CatalogSeries {
  code: string
  title: string
  retired: boolean
}

export interface ClassificationRow {
  code: string
  title: string
  series: CatalogSeries[]
  family: boolean
  policy: boolean
  links: ReferenceLink[]
  text: string
}

export interface QualificationRow {
  code: string
  title: string
  link: ReferenceLink
  additionalLinks: ReferenceLink[]
}

export interface QualificationGroup {
  anchor: string
  title: string
}

export function comparableTitle(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function tab(document: Document, title: string, code: string): Element {
  const section = [...document.querySelectorAll('section.tab-content')]
    .find(element => comparableTitle(element.getAttribute('title') ?? '') === comparableTitle(title))
  if (!section || section.querySelectorAll('table').length === 0) {
    throw new WorkerError(code, `The OPM "${title}" catalog section or its tables are missing. The reviewed DOM adapter must be updated; no fallback catalog was used.`, false, 'parsing')
  }
  return section
}

export function parseClassificationCatalog(html: string, url: string) {
  const dom = new JSDOM(html, { url })
  try {
    const document = dom.window.document
    const standards = tab(document, 'Standards', 'opm-classification-catalog-changed')
    const functional = tab(document, 'Functional Guides', 'opm-functional-catalog-changed')
    const rows: ClassificationRow[] = []
    for (const row of standards.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll(':scope > th,:scope > td')]
      const code = normalizeText(cells[0]?.textContent ?? '').match(/^(?:GS[- ]*)?(\d{4})$/)?.[1]
      if (!code || !cells[1]) continue
      const text = normalizeText(cells[1].textContent ?? '')
      const links = referenceLinks(cells[1], url).links
      const series: CatalogSeries[] = []
      for (const item of cells[1].querySelectorAll('li')) {
        const line = normalizeText(item.textContent ?? '')
        const match = line.match(/^(?:GS[- ]*)?(\d{4})(?:\s*[,–—:-]\s*|\s+)(.+)$/)
        if (match) series.push({
          code: match[1], title: match[2].replace(/\s*\(see competency.*$/i, '').trim(),
          retired: /\b(?:abolished|cancelled|canceled|retired|discontinued)\b/i.test(line),
        })
      }
      const family = /series covered/i.test(text) || series.length > 0
      if (!family && (!code.endsWith('00') || /\bseries\b/i.test(text))) {
        series.push({ code, title: links[0]?.label ?? text, retired: /\b(?:abolished|cancelled|canceled|retired|discontinued)\b/i.test(text) })
      }
      rows.push({
        code, title: links[0]?.label ?? text, series, family, links, text,
        policy: /competency[- ]based policy/i.test(text),
      })
    }
    if (rows.length === 0 || !rows.some(row => row.series.length > 0)) {
      throw new WorkerError('opm-classification-catalog-changed', 'No occupational series could be read from the OPM standards tables.', false, 'parsing')
    }
    const guides = referenceLinks(functional, url).links.filter(link => /\.pdf(?:[?#]|$)/i.test(link.url))
    if (guides.length === 0) throw new WorkerError('opm-functional-catalog-changed', 'The OPM functional-guide table has no recognized PDF links.', false, 'parsing')
    const root = referenceContent(document, url)
    const background = referenceLinks(root, url).links.filter(link => /handbook/i.test(link.label))
    return { rows, guides, background }
  } finally {
    dom.window.close()
  }
}

export function parseQualificationCatalog(html: string, url: string): QualificationRow[] {
  const dom = new JSDOM(html, { url })
  try {
    const section = tab(dom.window.document, 'Occupational Series', 'opm-qualification-catalog-changed')
    const rows: QualificationRow[] = []
    for (const row of section.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll(':scope > th,:scope > td')]
      const code = normalizeText(cells[0]?.textContent ?? '').match(/^\d{4}$/)?.[0]
      if (!code || !cells[1]) continue
      const links = referenceLinks(cells[1], url).links
      if (!links[0]) throw new WorkerError('opm-qualification-catalog-changed', `The OPM occupational-series row ${code} no longer has a qualification reference.`, false, 'parsing')
      rows.push({
        code, title: links[0].label, link: { ...links[0], relation: 'qualification' },
        additionalLinks: cells.slice(2).flatMap(cell => referenceLinks(cell, url).links),
      })
    }
    if (!rows.length) throw new WorkerError('opm-qualification-catalog-changed', 'No occupational series could be read from the OPM qualification index.', false, 'parsing')
    return rows
  } finally {
    dom.window.close()
  }
}

export function parseQualificationGroups(html: string, url: string): QualificationGroup[] {
  const dom = new JSDOM(html, { url })
  try {
    const section = tab(dom.window.document, 'Group Standards', 'opm-group-catalog-changed')
    const groups = [...section.querySelectorAll('h2')].flatMap(heading => {
      const name = heading.querySelector('a[name]')?.getAttribute('name') || heading.id
      return name && /^GS-[A-Z]+$/i.test(name) ? [{ anchor: name, title: normalizeText(heading.textContent ?? '') }] : []
    })
    if (!groups.length) throw new WorkerError('opm-group-catalog-changed', 'The OPM qualification groups no longer expose named group headings.', false, 'parsing')
    return groups
  } finally {
    dom.window.close()
  }
}

export function intendedGroup(link: ReferenceLink, groups: QualificationGroup[]): string | undefined {
  const fragment = new URL(link.url).hash.replace(/^#/, '')
  const exact = groups.find(group => group.anchor === fragment)
  if (exact) return exact.anchor
  const label = comparableTitle(link.label)
  const matching = groups.filter(group => label.includes(comparableTitle(group.title)))
  return matching.length === 1 ? matching[0].anchor : undefined
}

export function catalogNavigation(html: string, url: string): ReferenceLink[] {
  const dom = new JSDOM(html, { url })
  try {
    return referenceLinks(referenceContent(dom.window.document, url), url).links
      .filter(link => referenceUrl(link.url).pathname.includes('/competency-based-policy/'))
  } finally {
    dom.window.close()
  }

}

export function competencyPrintLink(html: string, url: string): ReferenceLink | undefined {
  const dom = new JSDOM(html, { url })
  try {
    const anchor = [...dom.window.document.querySelectorAll('a[href]')].find(element =>
      /^print (?:full )?(?:classification|qualification) standard$/i.test(normalizeText(element.textContent ?? '')))
    if (!anchor) return undefined
    const target = referenceUrl(anchor.getAttribute('href')!, url, true).href
    return {
      url: target, label: normalizeText(anchor.textContent ?? ''),
      relation: /qualification/i.test(anchor.textContent ?? '') ? 'qualification' : 'grading',
    }
  } finally {
    dom.window.close()
  }
}
