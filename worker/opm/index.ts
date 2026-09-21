import { JSDOM } from 'jsdom'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import type {
  GradeContext, GradeIssue, OpmDiscoveryResult, OpmSourceCandidate, ReferenceCoverage, ReferenceLink, ReferencePurpose,
} from '../../src/domain/real-grades'
import type { PublicFetcher } from '../../src/domain/rendering'
import { safePublicFetch } from '../public-http'
import { normalizeText, WorkerError } from '../runtime'
import type { DiscoverOpmSources, DiscoveryOptions, ReferenceOriginal } from '../references/contracts'
import { extractReferenceHtml, referenceContent, referenceLinks } from '../references/html'
import { inspectReferencePdf, referenceHash } from '../references/pdf'
import { checkCancellation, fetchOriginalUrl, isOpmUrl, referenceUrl } from '../references/transport'
import {
  catalogNavigation, comparableTitle, competencyPrintLink, intendedGroup, OPM_CATALOGS, OPM_CATALOG_VERSION,
  parseClassificationCatalog, parseQualificationCatalog, parseQualificationGroups,
} from './catalogs'
import { parseOpmDiscoveryResult } from './validation'
import { opmDiscoveryIssueId } from './issues'

export { OPM_CATALOGS, OPM_CATALOG_VERSION } from './catalogs'
export { parseOpmDiscoveryResult } from './validation'

const MAX_DISCOVERY_REQUESTS = 80
const MAX_DISCOVERY_DOCUMENTS = 35
const MAX_DISCOVERY_BYTES = 64 * 1024 * 1024
const PUBLISHER = 'U.S. Office of Personnel Management'

interface Snapshot {
  original: ReferenceOriginal
  hash: string
}

interface CandidateWork {
  candidate: OpmSourceCandidate
  depth: number
  snapshot?: Snapshot
}

function issue(code: string, message: string, options: Partial<GradeIssue> = {}, identity = ''): GradeIssue {
  return {
    id: opmDiscoveryIssueId(code, identity, options.grade),
    code, severity: 'blocker', scope: 'source', message, ...options,
  }
}

function addIssue(issues: GradeIssue[], value: GradeIssue): void {
  if (!issues.some(existing => existing.id === value.id)) issues.push(value)
}

function noFragment(value: string): string {
  const url = referenceUrl(value)
  url.hash = ''
  return url.href
}

function sourceKey(candidate: Pick<OpmSourceCandidate, 'url' | 'intendedSection'>): string {
  return `${noFragment(candidate.url)}#${candidate.intendedSection ?? new URL(candidate.url).hash.replace(/^#/, '')}`
}

function statedRevision(value: string): string | undefined {
  const date = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)[ -]+(?:\d{1,2}[, -]+)?(?:19|20)\d{2}\b/i
  return value.replace(/-/g, ' ').match(date)?.[0]
}

function functionsFor(title: string): string[] {
  if (/supervisory/i.test(title)) return ['supervisor']
  if (/\bleader\b/i.test(title)) return ['leader']
  if (/\bresearch\b/i.test(title)) return ['research']
  if (/\bdevelopment\b/i.test(title)) return ['development']
  if (/\btest(?:ing)?\b|\bevaluation (?:work|positions)\b/i.test(title)) return ['test-evaluation']
  return []
}

function requiredFunction(context: GradeContext, functions: string[]): boolean {
  return functions.every(value => value === 'supervisor' || value === 'leader'
    ? context.supervision === value
    : context.functions.includes(value as GradeContext['functions'][number]))
}

function coverage(context: GradeContext, explanation: string, overrides: Partial<ReferenceCoverage> = {}): ReferenceCoverage {
  return { series: [context.series], grades: [], functions: [], state: 'conditional', explanation, ...overrides }
}

function catalogCoverage(
  context: GradeContext,
  explanation: string,
  overrides: Partial<ReferenceCoverage> = {},
  workLevel = false,
): ReferenceCoverage {
  const uncomplicated = context.confirmed && context.agencyType !== 'non-federal' &&
    (!workLevel || (context.supervision === 'nonsupervisory' && context.functions.length === 0))
  return coverage(context, explanation, {
    state: uncomplicated ? 'confirmed' : 'conditional',
    ...(workLevel && uncomplicated ? { functions: ['nonsupervisory'] } : {}),
    ...overrides,
  })
}

function sourcePurpose(link: ReferenceLink): ReferencePurpose {
  if (link.relation === 'qualification') return 'qualification'
  if (link.relation === 'supersession') return 'issuance'
  if (link.relation === 'grading') return /flysheet/i.test(link.label) ? 'classification' : 'grading'
  return 'background'
}

function publicHtml(snapshot: Snapshot, code: string): string {
  if (snapshot.original.contentType !== 'text/html') {
    throw new WorkerError(code, 'The OPM catalog adapter expected a public HTML catalog, not another document type.', false, 'parsing')
  }
  return Buffer.from(snapshot.original.bytes).toString('utf8')
}

function discoveryTransport(options: DiscoveryOptions) {
  const base = options.fetcher ?? safePublicFetch
  const policy = options.processingSettings?.settings.grades.discovery
  const maxRequests = policy?.maxRequests ?? MAX_DISCOVERY_REQUESTS
  const maxBytes = policy?.maxBytes ?? MAX_DISCOVERY_BYTES
  let requests = 0
  let bytes = 0
  const fetcher: PublicFetcher = async (url, request = {}) => {
    checkCancellation(options.signal)
    if (++requests > maxRequests || bytes >= maxBytes) {
      throw new WorkerError('opm-network-budget-exhausted', 'OPM discovery exhausted its bounded public-request/byte budget. No fallback registry was used.', false, 'download')
    }
    const response = await base(url, { ...request, maxBytes: Math.min(request.maxBytes ?? maxBytes, maxBytes - bytes) })
    bytes += response.body.byteLength
    if (bytes > maxBytes) throw new WorkerError('opm-network-budget-exhausted', 'OPM discovery exceeded its captured aggregate response-byte budget.', false, 'download')
    return response
  }
  return fetcher
}

/** Catalog identity includes retrieval time and hashes of inspected responses; this never supplies grading from model memory. */
export const discoverOpmSources: DiscoverOpmSources = async (context, options = {}) => {
  if (!/^\d{4}$/.test(context.series) || context.series === '0000') {
    throw new WorkerError('opm-invalid-series', 'Confirm one four-digit GS occupational series, not a job title or occupational group.', false, 'parsing')
  }
  checkCancellation(options.signal)
  const retrievedAt = new Date().toISOString()
  const limits = options.processingSettings?.settings.grades.references
  const discovery = options.processingSettings?.settings.grades.discovery
  const maxSources = limits?.maxSources ?? GRADE_LADDER_LIMITS.maxSources
  const maxHops = discovery?.maxHops ?? GRADE_LADDER_LIMITS.maxDiscoveryHops
  const fetcher = discoveryTransport(options)
  const snapshots = new Map<string, Snapshot>()
  const issues: GradeIssue[] = []
  const queue: CandidateWork[] = []
  const workByKey = new Map<string, CandidateWork>()
  const catalogLinks = new Map<string, ReferenceLink[]>()
  const catalogBindings = new Set<CandidateWork>()
  const guideParents = new Map<CandidateWork, Set<CandidateWork>>()
  const standardPrintTargets = new Map<string, string>()
  const load = async (url: string): Promise<Snapshot> => {
    const key = noFragment(referenceUrl(url, undefined, true).href)
    const saved = snapshots.get(key)
    if (saved) return saved
    if (snapshots.size >= (discovery?.maxDocuments ?? MAX_DISCOVERY_DOCUMENTS)) {
      throw new WorkerError('opm-document-budget-exhausted', 'OPM discovery reached its captured document-inspection budget; the remaining graph is unresolved.', false, 'parsing')
    }
    const original = await fetchOriginalUrl(url, { ...options, fetcher }, true)
    if (original.contentType === 'text/html' && limits) {
      const dom = new JSDOM(Buffer.from(original.bytes).toString('utf8'), { url: original.finalUrl ?? url })
      try { referenceLinks(referenceContent(dom.window.document, original.finalUrl ?? url), original.finalUrl ?? url, limits.maxLinks) }
      finally { dom.window.close() }
    }
    const snapshot = { original, hash: referenceHash(original.bytes) }
    snapshots.set(key, snapshot)
    return snapshot
  }

  const classificationSnapshot = await load(OPM_CATALOGS.classification)
  const qualificationSnapshot = await load(OPM_CATALOGS.qualifications)
  const groupSnapshot = await load(OPM_CATALOGS.groups)
  const policySnapshot = await load(OPM_CATALOGS.competency)
  const classification = parseClassificationCatalog(publicHtml(classificationSnapshot, 'opm-classification-catalog-changed'),
    classificationSnapshot.original.finalUrl ?? OPM_CATALOGS.classification)
  const qualifications = parseQualificationCatalog(publicHtml(qualificationSnapshot, 'opm-qualification-catalog-changed'),
    qualificationSnapshot.original.finalUrl ?? OPM_CATALOGS.qualifications)
  const groups = parseQualificationGroups(publicHtml(groupSnapshot, 'opm-group-catalog-changed'),
    groupSnapshot.original.finalUrl ?? OPM_CATALOGS.groups)
  const matchingRows = classification.rows.filter(row => row.series.some(series => series.code === context.series))
  const qualification = qualifications.find(row => row.code === context.series)
  const matchingSeries = matchingRows.flatMap(row => row.series).find(series => series.code === context.series)
  let seriesStatus: OpmDiscoveryResult['seriesStatus'] = matchingSeries || qualification ? 'listed' : 'unknown'
  let seriesTitle = matchingSeries?.title || qualification?.title

  const add = (
    link: ReferenceLink,
    purpose: ReferencePurpose,
    path: string[],
    depth: number,
    sourceCoverage: ReferenceCoverage,
    authorityStatus: OpmSourceCandidate['authorityStatus'] = 'current',
    intendedSection?: string,
  ): CandidateWork | undefined => {
    if (!isOpmUrl(link.url)) {
      addIssue(issues, issue('opm-external-source-review', 'An external reference was not automatically traversed. Add it as a supplied source for review.', { severity: 'warning' }, link.url))
      return undefined
    }
    const candidate: OpmSourceCandidate = {
      url: link.url,
      title: normalizeText(link.label),
      purpose,
      ...(intendedSection ? { intendedSection } : new URL(link.url).hash ? { intendedSection: new URL(link.url).hash.slice(1) } : {}),
      publisher: PUBLISHER,
      coverage: sourceCoverage,
      discoveryPath: path,
      revision: statedRevision(`${link.label} ${link.url}`),
      authorityStatus,
      relatedLinks: [], issues: [],
    }
    const existing = workByKey.get(sourceKey(candidate))
    if (existing) return existing
    if (depth > maxHops) {
      addIssue(issues, issue('opm-traversal-limit', `A relevant reference remains beyond the captured ${maxHops}-hop discovery budget. Coverage is incomplete.`, {}, link.url))
      return undefined
    }
    if (queue.length >= maxSources) {
      addIssue(issues, issue('opm-source-budget-exhausted', `More than ${maxSources} relevant supporting sources were found (the seed is not counted). Discovery is partial; narrow the context or explicitly select additional references.`, {}, link.url))
      return undefined
    }
    const work = { candidate, depth }
    queue.push(work)
    workByKey.set(sourceKey(candidate), work)
    return work
  }

  const guideFor = (link: ReferenceLink): ReferenceLink | undefined => {
    const label = comparableTitle(link.label)
    const file = new URL(link.url).pathname.split('/').at(-1)?.toLowerCase()
    return [...classification.guides, ...classification.background].find(guide =>
      noFragment(guide.url) === noFragment(link.url) ||
      (file && new URL(guide.url).pathname.split('/').at(-1)?.toLowerCase() === file) ||
      (file === 'gsintro.pdf' && /introduction to.*classification/i.test(guide.label)) ||
      (file === 'clashnbk.pdf' && /classifier.*handbook/i.test(guide.label)) ||
      (label && comparableTitle(guide.label).replace(/:$/, '') === label.replace(/^the /, '').replace(/:$/, '')) ||
      (/classifier.*handbook/i.test(link.label) && /classifier.*handbook/i.test(guide.label)))
  }

  const addGuide = (link: ReferenceLink, path: string[], depth: number, parent?: CandidateWork) => {
    const guide = guideFor(link) ?? link
    const functions = functionsFor(guide.label)
    if (!requiredFunction(context, functions)) return undefined
    const isHandbook = /handbook|introduction to.*classification/i.test(guide.label)
    const work = add(guide, isHandbook ? 'background' : 'grading', [...path, guide.url], depth,
      (isHandbook ? catalogCoverage : coverage)(context, isHandbook
        ? 'Background methodology and compatible-work comparisons, not a sole current occupational registry or independent grade-level standard.'
        : 'A catalog-listed OPM functional guide. Its series/function binding requires a real reference from the matching series standard or requirements; selecting a function or recognizing a title alone is not proof.',
      { functions }))
    if (work && parent) {
      const parents = guideParents.get(work) ?? new Set<CandidateWork>()
      parents.add(parent)
      guideParents.set(work, parents)
    }
    if (work && /administrative analysis grade evaluation/i.test(guide.label)) {
      addIssue(work.candidate.issues, issue('opm-aageg-illustrations', 'AAGEG factor combinations are typical FES position-classification illustrations, not mandatory hiring checklists or hiring-score weights.', { severity: 'warning' }, guide.url))
    }
    if (work && functions.includes('supervisor')) {
      addIssue(work.candidate.issues, issue('opm-supervisory-coverage', 'Confirm the GSSG coverage conditions in the source. Matrix leadership, contractor oversight, and a manager title alone do not establish supervisory-guide coverage.', { severity: 'warning' }, guide.url))
    }
    return work
  }

  // Navigation hops identify the catalog entry; the two-hop budget below applies to substantive reference edges.
  const policyNavigation = catalogNavigation(publicHtml(policySnapshot, 'opm-policy-catalog-changed'),
    policySnapshot.original.finalUrl ?? OPM_CATALOGS.competency)
  const generalScheduleLink = policyNavigation.find(link => /\/competency-based-policy\/general-schedule\/?$/i.test(new URL(link.url).pathname))
  if (!generalScheduleLink) throw new WorkerError('opm-policy-catalog-changed', 'The OPM competency-policy catalog has no recognized General Schedule navigation link.', false, 'parsing')
  const generalSchedule = await load(generalScheduleLink.url)
  const groupLinks = catalogNavigation(publicHtml(generalSchedule, 'opm-policy-catalog-changed'), generalSchedule.original.finalUrl ?? generalScheduleLink.url)
    .filter(link => /^\d{4}\b/.test(link.label))
  if (!groupLinks.length) throw new WorkerError('opm-policy-catalog-changed', 'The OPM competency General Schedule catalog contains no occupational-group links.', false, 'parsing')
  const policyGroup = groupLinks.find(link => link.label.startsWith(`${context.series.slice(0, 2)}00`))
  let policyRoot: { link: ReferenceLink; snapshot: Snapshot; path: string[] } | undefined
  if (policyGroup) {
    const snapshot = await load(policyGroup.url)
    const seriesLinks = catalogNavigation(publicHtml(snapshot, 'opm-policy-group-changed'), snapshot.original.finalUrl ?? policyGroup.url)
      .filter(link => /^\d{4}\b/.test(link.label))
    if (!seriesLinks.length) throw new WorkerError('opm-policy-group-changed', 'The OPM competency occupational-group page contains no recognized series links.', false, 'parsing')
    const seriesLink = seriesLinks.find(link => link.label.startsWith(context.series))
    if (seriesLink) policyRoot = {
      link: seriesLink, snapshot: await load(seriesLink.url),
      path: [OPM_CATALOGS.competency, generalScheduleLink.url, policyGroup.url, seriesLink.url],
    }
  }

  if (policyRoot) {
    seriesStatus = 'listed'
    seriesTitle = policyRoot.link.label.replace(/^\d{4}\s*/, '')
    const dom = new JSDOM(publicHtml(policyRoot.snapshot, 'opm-policy-series-changed'))
    try {
      const root = referenceContent(dom.window.document, policyRoot.snapshot.original.finalUrl ?? policyRoot.link.url)
      const links = referenceLinks(root, policyRoot.snapshot.original.finalUrl ?? policyRoot.link.url, limits?.maxLinks).links
      const standards = links.filter(link => /classification standard|qualification standard/i.test(link.label) && !/job aid|memorand|issuance/i.test(link.label) &&
        !/\.(?:docx?|xlsx?)(?:[?#]|$)/i.test(link.url))
      if (!standards.some(link => /classification standard/i.test(link.label)) || !standards.some(link => /qualification standard/i.test(link.label))) {
        throw new WorkerError('opm-policy-series-changed', 'The current competency-policy series page no longer links both classification and qualification standards.', false, 'parsing')
      }
      for (const link of standards) {
        const snapshot = await load(link.url)
        const print = snapshot.original.contentType === 'text/html'
          ? competencyPrintLink(publicHtml(snapshot, 'opm-policy-series-changed'), snapshot.original.finalUrl ?? link.url)
          : undefined
        if (print) standardPrintTargets.set(noFragment(link.url), noFragment(print.url))
        const target = print ? { ...print, label: `${seriesTitle ?? context.series} — ${link.label}` } : link
        const qualificationStandard = /qualification/i.test(link.label)
        const work = add(target, qualificationStandard ? 'qualification' : 'grading',
          [...policyRoot.path, link.url, ...(print ? [print.url] : [])], 1,
          catalogCoverage(context, 'Current competency-policy navigation explicitly lists this series and standard. A linked full-print representation is selected where available, not the navigation shell. Confirmed catalog binding is not proof of any particular grade-level claim; issued/effective text and draft placeholders are checked separately.', {}, !qualificationStandard))
        if (work) catalogBindings.add(work)
      }
      for (const link of links.filter(link => link.relation === 'supersession')) {
        const work = add(link, 'issuance', [...policyRoot.path, link.url], 1,
          catalogCoverage(context, 'Linked issuance/job-aid evidence for the competency-policy standards; not a substitute for the standard’s substantive requirements.'))
        if (work) catalogBindings.add(work)
      }
      addIssue(issues, issue('opm-competency-policy-current', 'Current competency-policy classification and qualification references take precedence over obsolete alternatives. No Administrative qualification group was inferred.', { severity: 'warning', scope: 'context' }, policyRoot.link.url))
    } finally {
      dom.window.close()
    }
  } else {
    for (const row of matchingRows) {
      for (const link of row.links) {
        if (link !== row.links[0] && !/\.pdf(?:[?#]|$)/i.test(link.url) && !/standard|flysheet|classification|guide/i.test(link.label)) continue
        const work = add(link, context.series === '0340' || context.series === '0343' ? 'classification' : 'grading',
          [OPM_CATALOGS.classification, link.url], 1,
          catalogCoverage(context, row.family
            ? `The current classification catalog explicitly lists ${context.series} in the “Series Covered”/family list. The uncomplicated nonsupervisory series binding is confirmed after context confirmation; specialized functions require their applicable guide. Grade-specific work claims still require captured source evidence.`
            : 'The current classification catalog explicitly links this series. The uncomplicated nonsupervisory series binding is confirmed after context confirmation; grade-level requirements, functional conditions, and exclusions must come from captured substantive passages.',
          { series: row.series.filter(series => !series.retired).map(series => series.code) }, true))
        if (work) catalogBindings.add(work)
      }
    }
    if (qualification) {
      const work = add(qualification.link, 'qualification', [OPM_CATALOGS.qualifications, qualification.link.url], 1,
        catalogCoverage(context, 'The occupational-series qualification index explicitly links these requirements to the confirmed series. Agency exclusions are checked separately. Individual requirements, associated groups, exceptions, and alternatives remain separate from work-level grading.'))
      if (work) {
        catalogBindings.add(work)
        catalogLinks.set(sourceKey(work.candidate), qualification.additionalLinks.map(link => ({
          ...link, label: `Qualification-index exception/policy: ${link.label}`, relation: 'qualification',
        })))
      }
    }
    if (matchingRows.some(row => row.policy)) {
      addIssue(issues, issue('opm-policy-series-unresolved', 'The classification catalog directs this series to competency-based policy, but the corresponding current policy entry was not found. No legacy qualification fallback was used.', { scope: 'context' }, context.series))
    }
  }

  const retiredFamily = ['0892', '0894'].includes(context.series)
    ? classification.rows.find(row => row.code === '0800' && row.family && /professional.*engineering|engineering.*architecture/i.test(row.title))
    : undefined
  if (retiredFamily && matchingSeries && !matchingSeries.retired) {
    seriesStatus = 'conflicting'
    addIssue(issues, issue('opm-series-status-conflict', 'The current catalog explicitly lists a series covered by a reviewed retirement rule. Resolve current issuance/status evidence rather than silently treating either listing as decisive.', { scope: 'context' }, context.series))
  } else if (matchingSeries?.retired || retiredFamily) {
    seriesStatus = 'retired'
    addIssue(issues, issue('opm-series-retired', `Series ${context.series} is retired. Old qualification listings do not re-establish a current series; confirm a current occupational series and its applicable standards.`, { scope: 'context' }, context.series))
    if (retiredFamily?.links[0]) {
      add(retiredFamily.links[0], 'background', [OPM_CATALOGS.classification, retiredFamily.links[0].url], 1,
        coverage(context, 'Reviewed 0800-family retirement evidence for Ceramic Engineering 0892 / Welding Engineering 0894. The retired code is not added to the family’s current Series Covered list.',
          { series: retiredFamily.series.filter(series => !series.retired).map(series => series.code), state: 'unknown' }))
    }
    if (qualification) addIssue(issues, issue('opm-retired-qualification-listing', 'The qualification index still links this retired series. Treat that as historical/status-conflicting evidence, not a current registry determination.', { severity: 'warning', scope: 'context' }, context.series))
  } else if (seriesStatus === 'unknown') {
    const isGroup = classification.rows.some(row => row.code === context.series && row.family)
    addIssue(issues, issue(isGroup ? 'opm-group-not-series' : 'opm-series-unresolved',
      isGroup ? `${context.series} is an occupational-group/family entry, not a confirmed occupational series.`
        : `Neither current catalog explicitly establishes series ${context.series}. Missing a classification standard alone does not prove invalidity, and no URL or replacement series was invented.`,
      { scope: 'context' }, context.series))
  } else if (!matchingRows.some(row => row.links.length) && !policyRoot) {
    addIssue(issues, issue('opm-grading-source-unresolved', 'The series is listed, but a specific applicable grading reference was not resolved from the catalog. Additional source-backed classification guidance is required.', { scope: 'context' }, context.series))
  }

  if (!context.confirmed) addIssue(issues, issue('opm-context-unconfirmed', 'Confirm the occupational series and applicable position context; a job title is not a series determination.', { scope: 'context' }))
  if (context.series === '0340') {
    addIssue(issues, issue('opm-program-management-title', 'Program/project management work and titles occur in multiple series; “program management” is not uniquely series 0340.', { severity: 'warning', scope: 'context' }))
  }
  if (seriesStatus === 'listed') {
    for (const guide of classification.guides) {
      const functions = functionsFor(guide.label)
      const generalFunctionalGuide = /^(?:Research Grade Evaluation Guide|Equipment Development Grade Evaluation Guide|General Schedule Supervisory Guide|General Schedule Leader Grade Evaluation Guide)$/i.test(normalizeText(guide.label))
      if (generalFunctionalGuide && functions.length && requiredFunction(context, functions)) addGuide(guide, [OPM_CATALOGS.classification], 1)
    }
    const handbook = classification.background.find(link => /classifier.*handbook/i.test(link.label))
    if (handbook) addGuide(handbook, [OPM_CATALOGS.classification], 1)
  }

  // This reviewed bridge follows the actual 0340 PDF annotation; it never synthesizes a fedclass URL.
  let legacy343: CandidateWork | undefined
  if (context.series === '0343' && !policyRoot) {
    const bridge = classification.rows.find(row => row.series.some(series => series.code === '0340'))?.links.find(link => /\.pdf(?:[?#]|$)/i.test(link.url))
    if (bridge) {
      const snapshot = await load(bridge.url)
      if (snapshot.original.contentType !== 'application/pdf') throw new WorkerError('opm-version-bridge-changed', 'The reviewed OPM version-reference bridge is no longer a PDF.', false, 'parsing')
      const metadata = await inspectReferencePdf(snapshot.original.bytes, snapshot.original.finalUrl ?? bridge.url, limits)
      const legacy = metadata.links.find(link => /(?:gs0343\.pdf|series[, -]+0343)/i.test(`${link.url} ${link.label}`))
      if (legacy) {
        legacy343 = add({ ...legacy, label: 'Management and Program Analysis Series, 0343 — linked legacy revision' },
          'classification', [OPM_CATALOGS.classification, bridge.url, legacy.url], 2,
          coverage(context, 'Actual PDF cross-reference through the catalog-linked 0340 flysheet. Compare this captured revision with the catalog’s separately linked May 2024 revision.'), 'unknown')
      } else {
        addIssue(issues, issue('opm-version-path-unresolved', 'The reviewed 0340-to-0343 PDF link is no longer present. The 0343 version-resolution path must be reviewed; no legacy URL was invented.', {}, bridge.url))
      }
    } else {
      addIssue(issues, issue('opm-version-path-unresolved', 'The catalog no longer exposes the reviewed source for the 0343 legacy-version link. Resolve the changed version path before relying on a single revision.', {}, context.series))
    }
  }

  const belongsToOtherSeries = (link: ReferenceLink): boolean => {
    const matches = classification.rows.filter(row => row.links.some(candidate => noFragment(candidate.url) === noFragment(link.url)))
    if (matches.length) return matches.every(row => !row.series.some(series => series.code === context.series))
    const code = (link.label.match(/\bGS[- ]*(\d{3,4})\b/i)?.[1] ??
      `${new URL(link.url).pathname} ${link.label}`.match(/(?:gs|series[-, ]+)(\d{3,4})(?:\b|[a-z])/i)?.[1])?.padStart(4, '0')
    return !!code && code !== context.series && code !== `${context.series.slice(0, 2)}00`
  }

  const relevantLink = (link: ReferenceLink, parent: CandidateWork): ReferenceLink => {
    const guide = guideFor(link)
    if (guide) {
      if (!requiredFunction(context, functionsFor(guide.label))) return { ...link, relation: 'exclusion' }
      return { ...link, label: guide.label, relation: /handbook/i.test(guide.label) ? 'background' : 'grading' }
    }
    if (belongsToOtherSeries(link)) return { ...link, relation: 'exclusion' }
    if (/supervisory(?: qualification)? guide|leader(?: grade evaluation)? guide/i.test(link.label) &&
      !requiredFunction(context, functionsFor(link.label))) return { ...link, relation: 'exclusion' }
    if (/\/fedclass\/html\/gsfunctn\.asp(?:[?#]|$)/i.test(link.url) ||
      /^(?:job analysis|general schedule operating manual|functional guide)$/i.test(normalizeText(link.label))) {
      return { ...link, relation: 'background' }
    }
    if (/\/chcoc\//i.test(link.url)) {
      const text = `${link.label} ${link.url}`
      const mentionsSeries = new RegExp(`\\b${context.series}\\b`).test(text)
      if (mentionsSeries && /FWCI|MOSAIC|competency (?:library|framework)/i.test(text)) return { ...link, relation: 'qualification' }
      const standardIssuance = mentionsSeries && /classification[- ]standard|qualification[- ]standards?|issuance|supersed|replac/i.test(text)
      return { ...link, relation: standardIssuance || /issuance memorandum|supersedes|replaces/i.test(link.label) ? 'supersession' : 'background' }
    }
    if (parent.candidate.purpose === 'qualification' && /individual occupational requirements|professional engineering positions/i.test(link.label)) {
      return { ...link, relation: 'qualification' }
    }
    return link
  }

  const sourceAssertions = (work: CandidateWork, text: string, pageCount?: number) => {
    const candidate = work.candidate
    if (context.series === '0340' && candidate.purpose === 'classification' && /gs0340\.pdf/i.test(candidate.url)) {
      if (pageCount !== 14) {
        candidate.coverage.state = 'unknown'
        addIssue(candidate.issues, issue('opm-reviewed-source-changed', 'The reviewed May 2019 0340 flysheet no longer has 14 pages. Recheck its scope and grading instructions before using the reviewed applicability rule.', {}, candidate.url))
      } else {
        candidate.revision ??= 'May 2019'
        candidate.coverage.grades = [9, 10, 11, 12, 13, 14, 15]
        candidate.coverage.explanation += ' The May 2019 introductory scope (original p.2: GS-13+) conflicts with the later grading directions (original p.11: GS-9+). This is an applicability conflict, not a categorical prohibition on lower grades.'
        for (const grade of [9, 10, 11, 12]) addIssue(candidate.issues, issue('opm-0340-grade-scope-conflict',
          'The 0340 flysheet’s GS-13+ introductory scope and GS-9+ grading directions conflict for this grade. Applicable supporting grading evidence and a source-backed resolution are required.',
          { scope: 'grade', grade }, candidate.url))
      }
    }
    if (/\b(?:DRAFT|TBD)\b|\[(?:insert|effective date)|insert (?:date|link)|MONTH DD/i.test(text)) {
      addIssue(candidate.issues, issue('opm-draft-placeholder', 'The captured OPM standard contains draft/placeholder language. Reconcile its issued/effective version with the actual linked issuance evidence.', {}, candidate.url))
      candidate.authorityStatus = 'conflicting'
      candidate.coverage.state = 'conflicting'
    }
    const defenseExclusion = /(?:does not apply|not applicable|exclud(?:es|ing|ed))[\s\S]{0,160}(?:Department\s+of\s+Defense|\bDoD\b)|(?:Department\s+of\s+Defense|\bDoD\b)[\s\S]{0,100}(?:exclud|does not apply)/i.test(text)
    if (candidate.purpose === 'qualification' && defenseExclusion) {
      candidate.coverage.explanation += ' The source expressly excludes Department of Defense positions.'
      if (context.agencyType === 'unknown' || !context.agency.trim()) {
        candidate.coverage.state = 'conditional'
        addIssue(candidate.issues, issue('opm-agency-context-required', 'This qualification source excludes DoD. Confirm the agency and agency type before determining applicability.', { scope: 'context' }, candidate.url))
      } else if (context.agencyType === 'dod') {
        candidate.coverage.state = 'conflicting'
        addIssue(candidate.issues, issue('opm-agency-excluded', 'This qualification standard excludes DoD positions. It cannot establish the position’s minimum qualifications; supply the applicable agency authority.', { scope: 'qualification' }, candidate.url))
      }
    }
    if (candidate.purpose === 'qualification' && /there (?:is|are) no (?:associated )?group coverage qualification standard/i.test(text)) {
      candidate.coverage.explanation += ' The source explicitly states there is no Group Coverage Qualification Standard for this series.'
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    checkCancellation(options.signal)
    const work = queue[index]
    const candidate = work.candidate
    const snapshot = await load(candidate.url)
    work.snapshot = snapshot
    const catalogOnly = !candidate.intendedSection && [
      OPM_CATALOGS.classification, OPM_CATALOGS.qualifications, OPM_CATALOGS.groups, OPM_CATALOGS.competency,
      qualificationSnapshot.original.finalUrl, groupSnapshot.original.finalUrl,
    ].some(url => url && noFragment(url) === noFragment(snapshot.original.finalUrl ?? candidate.url))
    if (catalogOnly) {
      candidate.purpose = 'background'
      candidate.authorityStatus = 'unknown'
      candidate.coverage.state = 'unknown'
      addIssue(candidate.issues, issue('opm-catalog-navigation-reference', 'This legacy reference resolves to a catalog/navigation page, not an individual standard. Its full catalog was not recursively selected as grading evidence.', { severity: 'warning' }, candidate.url))
      continue
    }
    let links: ReferenceLink[]
    let text = ''
    let pageCount: number | undefined
    if (snapshot.original.contentType === 'application/pdf') {
      const metadata = await inspectReferencePdf(snapshot.original.bytes, snapshot.original.finalUrl ?? candidate.url, limits)
      links = metadata.links
      pageCount = metadata.pageCount
      candidate.revision ??= statedRevision(metadata.title ?? '')
      if (candidate.purpose === 'grading' && /flysheet/i.test(metadata.title ?? '')) candidate.purpose = 'classification'
      addIssue(candidate.issues, issue('opm-pdf-content-review', 'Discovery inspected the original PDF’s page metadata and URI annotations, not its complete prose. Extract the selected pages and review prose-only references and exclusions before relying on grading or qualification claims.', { severity: 'warning' }, candidate.url))
      for (const warning of metadata.warnings) addIssue(candidate.issues, issue('opm-pdf-link-unresolved', warning, { severity: 'warning' }, `${candidate.url}:${warning}`))
    } else {
      const html = publicHtml(snapshot, 'opm-source-structure-changed')
      let extracted: ReturnType<typeof extractReferenceHtml>
      try {
        extracted = extractReferenceHtml(html, snapshot.original.finalUrl ?? candidate.url, candidate.title, candidate.intendedSection, limits)
      } catch (error) {
        if (!(error instanceof WorkerError) || error.code !== 'reference-section-not-found') throw error
        candidate.authorityStatus = 'unknown'
        candidate.coverage.state = 'unknown'
        candidate.coverage.explanation += ' The captured source is missing its intended fragment; no alternate tab/section was substituted.'
        const grades = candidate.coverage.grades.length ? candidate.coverage.grades : [undefined]
        for (const grade of grades) addIssue(candidate.issues, issue('opm-linked-section-missing', error.message,
          grade === undefined ? {} : { scope: 'grade', grade }, candidate.url))
        continue
      }
      if (extracted.thin) throw new WorkerError('opm-source-structure-changed', 'The linked OPM source has no recognized substantive reference text.', false, 'parsing')
      links = extracted.links
      text = extracted.paragraphs.map(paragraph => paragraph.text).join('\n')
      candidate.revision ??= statedRevision(text.match(/(?:effective|issued|revised|updated)[^\n]{0,180}/i)?.[0] ?? '')
      if (candidate.purpose === 'qualification' && !candidate.intendedSection && !/competency-based-policy/i.test(candidate.url) &&
        /general-schedule-qualification-standards\/\d{4}\//.test(candidate.url) && !/individual occupational requirements|qualification standard/i.test(text)) {
        throw new WorkerError('opm-ior-structure-changed', 'The OPM individual-requirements page has lost its expected qualification headings.', false, 'parsing')
      }
    }
    sourceAssertions(work, text, pageCount)
    candidate.relatedLinks = [...links, ...(catalogLinks.get(sourceKey(candidate)) ?? [])].map(link => relevantLink(link, work))
    if (candidate.relatedLinks.length > (limits?.maxLinks ?? GRADE_LADDER_LIMITS.maxReferenceLinks)) {
      throw new WorkerError('reference-link-budget', 'The complete discovery relationships exceed the captured link budget. No relationship was silently removed.', false, 'parsing')
    }
    const noGroup = /there (?:is|are) no (?:associated )?group coverage qualification standard/i.test(text)
    for (const related of candidate.relatedLinks) {
      if (!isOpmUrl(related.url)) continue
      if (['exclusion', 'background'].includes(related.relation)) continue
      const relatedUrl = referenceUrl(related.url)
      const relatedBase = noFragment(related.url)
      if (relatedBase === noFragment(candidate.url) || relatedBase === noFragment(snapshot.original.finalUrl ?? candidate.url)) continue
      if (standardPrintTargets.has(relatedBase) || [...standardPrintTargets.entries()].some(([navigation, print]) =>
        noFragment(candidate.url) === print && relatedBase.startsWith(navigation))) continue
      if (policyRoot && /superseded|retired|alternative\s*[AB]\b/i.test(related.label)) {
        addIssue(candidate.issues, issue('opm-obsolete-alternative', 'An obsolete alternative is retained as a supersession relationship, not automatically selected as a current qualification standard.', { severity: 'warning' }, related.url))
        continue
      }
      if (/\.(?:docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(related.url) || /\/umbraco\/https?:/i.test(relatedUrl.pathname)) {
        addIssue(candidate.issues, issue('opm-linked-source-unresolved', 'A relevant source link is unsupported or malformed. It remains visible for supplied-source review; its URL was not rewritten or guessed.', {}, related.url))
        continue
      }
      const guide = guideFor(related)
      if (guide) {
        if (work.depth < maxHops || workByKey.has(sourceKey({ url: guide.url }))) {
          addGuide(guide, candidate.discoveryPath, work.depth + 1, work)
        } else {
          addIssue(candidate.issues, issue('opm-traversal-limit', `The outgoing functional reference ${related.url} remains beyond the ${maxHops}-hop discovery budget. This issue concerns that target, not this source's own extraction. Capture the exact target before relying on it; applicability still requires review.`, {}, related.url))
        }
        continue
      }
      const isGroupLink = /\/tabs\/group-standards\/?$/i.test(relatedUrl.pathname) ||
        /^GS-(?:ADMIN|PROF|TECH|CLER)$/i.test(relatedUrl.hash.slice(1))
      let section: string | undefined
      if (isGroupLink) {
        if (noGroup) continue
        section = intendedGroup(related, groups)
        if (!section) {
          addIssue(candidate.issues, issue('opm-group-selection-unresolved', 'An associated qualification-group link does not identify a unique named group. No first-tab or Administrative-group fallback was used.', {}, related.url))
          continue
        }
      } else if ([
        OPM_CATALOGS.classification, OPM_CATALOGS.qualifications, OPM_CATALOGS.groups, OPM_CATALOGS.competency,
        qualificationSnapshot.original.finalUrl, groupSnapshot.original.finalUrl,
      ].some(url => url && noFragment(url) === relatedBase)) continue
      if (workByKey.has(sourceKey({ url: related.url, intendedSection: section }))) continue
      if (work.depth >= maxHops) {
        addIssue(candidate.issues, issue('opm-traversal-limit', `The outgoing reference ${related.url} remains beyond the ${maxHops}-hop discovery budget. This issue concerns that target and intended section, not this source's own extraction. Capture the exact target before relying on it; applicability still requires review.`, {}, related.url))
        continue
      }
      const relatedGrades = /^Qualification-index exception\/policy:/i.test(related.label)
        ? (related.label.match(/GS[- ]*(\d{1,2}(?:\/\d{1,2})*)/i)?.[1].split('/').map(Number).filter(grade => grade >= 1 && grade <= 15) ?? [])
        : []
      const relatedPurpose = sourcePurpose(related)
      const boundRequirement = relatedPurpose === 'qualification' && candidate.purpose === 'qualification' &&
        catalogBindings.has(work) && candidate.coverage.state === 'confirmed' && candidate.authorityStatus === 'current'
      const boundIssuance = relatedPurpose === 'issuance' && catalogBindings.has(work) &&
        candidate.authorityStatus === 'current' && new RegExp(`\\b${context.series}\\b`).test(`${related.label} ${related.url}`)
      const child = add(related, relatedPurpose, [...candidate.discoveryPath, related.url], work.depth + 1,
        (boundRequirement || boundIssuance ? catalogCoverage : coverage)(context, isGroupLink
          ? `The individual requirements explicitly name the ${groups.find(group => group.anchor === section)?.title} group. The intended fragment is independent of redirect URLs; retain grade-column alternatives and footnotes.`
          : 'A real link from the selected source or its qualification-index policy column. Its relationship and exact series/grade/function applicability require captured-text review.',
        { grades: relatedGrades }),
        'current', section)
      if (child && (boundRequirement || boundIssuance)) catalogBindings.add(child)
    }
  }

  if (legacy343?.snapshot) {
    const catalog343 = queue.find(work => work !== legacy343 && work.candidate.purpose === 'classification' &&
      work.candidate.discoveryPath[0] === OPM_CATALOGS.classification && work.depth === 1)
    if (catalog343?.snapshot && catalog343.snapshot.hash !== legacy343.snapshot.hash) {
      for (const work of [catalog343, legacy343]) {
        work.candidate.authorityStatus = 'conflicting'
        work.candidate.coverage.state = 'conflicting'
        addIssue(work.candidate.issues, issue('opm-0343-version-conflict',
          'The catalog-linked May 2024 capture differs from the actual legacy-linked 0343 capture (the reviewed legacy path has served October 2024). Compare both captured revision/issuance texts; discovery does not choose a version silently.', {}, work.candidate.url))
        const other = work === catalog343 ? legacy343 : catalog343
        work.candidate.relatedLinks.push({ url: other.candidate.url, label: 'Other captured 0343 revision — resolve supersession', relation: 'supersession' })
      }
    } else if (catalog343?.snapshot) {
      legacy343.candidate.authorityStatus = catalog343.candidate.authorityStatus
      legacy343.candidate.coverage = {
        ...catalog343.candidate.coverage,
        explanation: `${legacy343.candidate.coverage.explanation} Both real paths returned identical bytes, matching the current catalog-linked capture.`,
      }
      catalogBindings.add(legacy343)
    }
  }
  if (context.series === '0343' && !legacy343 && !policyRoot) {
    for (const work of queue.filter(work => work.candidate.purpose === 'classification' && catalogBindings.has(work))) {
      work.candidate.authorityStatus = 'unknown'
    }
  }
  for (const [guide, parents] of guideParents) {
    const candidate = guide.candidate
    const eligibleParents = [...parents].filter(parent => catalogBindings.has(parent) &&
      parent.candidate.authorityStatus === 'current' && !['unknown', 'conflicting'].includes(parent.candidate.coverage.state) &&
      !parent.candidate.issues.some(value => value.severity === 'blocker' && value.grade === undefined))
    if (candidate.purpose !== 'grading' || candidate.authorityStatus !== 'current' || eligibleParents.length === 0 ||
      !context.confirmed || context.agencyType === 'non-federal' || context.supervision === 'unknown' ||
      !requiredFunction(context, candidate.coverage.functions)) continue
    candidate.coverage.state = 'confirmed'
    if (candidate.coverage.functions.length === 0) candidate.coverage.functions = [context.supervision]
    candidate.coverage.grades = eligibleParents.some(parent => parent.candidate.coverage.grades.length === 0)
      ? [] : [...new Set(eligibleParents.flatMap(parent => parent.candidate.coverage.grades))].sort((a, b) => a - b)
    candidate.coverage.explanation += ' The matching catalog-listed series source explicitly references this current guide and the confirmed position context matches its function. This confirms the source binding, not a grade-specific claim or a hiring checklist.'
  }
  if (seriesStatus === 'retired') {
    for (const work of queue.filter(work => work.candidate.purpose === 'qualification')) work.candidate.authorityStatus = 'superseded'
  } else if (seriesStatus === 'conflicting') {
    for (const work of queue.filter(work => work.candidate.purpose !== 'background')) work.candidate.coverage.state = 'conflicting'
  }
  checkCancellation(options.signal)
  const snapshotIdentity = [...snapshots.entries()].map(([url, snapshot]) =>
    [url, snapshot.original.finalUrl, snapshot.original.redirects, snapshot.hash]).sort(([left], [right]) => String(left).localeCompare(String(right)))
  return parseOpmDiscoveryResult({
    series: context.series, seriesTitle, seriesStatus,
    catalogVersion: `${OPM_CATALOG_VERSION}@${retrievedAt}:${referenceHash(JSON.stringify(snapshotIdentity))}`,
    candidates: queue.map(work => work.candidate),
    issues,
  })
}
