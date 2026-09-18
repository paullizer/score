import type { GradeIssue, ReferenceDocument, ReferenceIssueResolution, ReferenceLink, ReferenceSourceRecord } from '../../src/domain/real-grades'
import { validateReferenceDocument } from '../../server/grades/validation'
import { opmDiscoveryIssueId } from '../opm/issues'
import { WorkerError } from '../runtime'
import type { ReferenceExtraction } from './contracts'
import { referenceUrl } from './transport'

export interface CapturedReferenceEvidence {
  source: ReferenceSourceRecord
  document: ReferenceDocument
}

export type { ReferenceIssueResolution } from '../../src/domain/real-grades'

export interface ReferenceIssueReconciliation {
  issues: GradeIssue[]
  resolved: ReferenceIssueResolution[]
}

function invalidEvidence(message: string): never {
  throw new WorkerError('reference-issue-evidence-mismatch', message, false, 'parsing')
}

function sectionName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^#/, ''))
  } catch {
    return invalidEvidence('The captured reference has an invalid intended section.')
  }
}

function urlParts(value: string): { url: string; section: string } {
  const parsed = referenceUrl(value)
  const section = sectionName(parsed.hash)
  parsed.hash = ''
  return { url: parsed.href, section }
}

function selectedSection(source: ReferenceSourceRecord): string {
  return source.intendedSection !== undefined
    ? sectionName(source.intendedSection)
    : source.requestedUrl ? urlParts(source.requestedUrl).section : ''
}

function fullExtraction(evidence: CapturedReferenceEvidence): boolean {
  const { source, document } = evidence
  const errors = validateReferenceDocument(document)
  if (errors.length) invalidEvidence(`The extracted reference is invalid: ${errors[0]}`)
  if (source.documentId !== document.id || source.documentVersion !== document.version ||
    (source.pageCount !== undefined && source.pageCount !== document.pageCount)) {
    invalidEvidence('Issue reconciliation requires the exact captured source document and version.')
  }
  if (document.completeness !== 'complete') return false
  if (document.selectedPages.length && document.selectedPages.length !== document.pageCount) {
    invalidEvidence('A complete reference cannot omit original pages.')
  }
  if (source.selectedPages.length && (
    source.selectedPages.length !== document.pageCount ||
    source.selectedPages.some(page => !document.selectedPages.includes(page))
  )) invalidEvidence('The extracted reference does not match the source page selection.')
  return document.paragraphs.length > 0
}

function archivedSource(source: ReferenceSourceRecord): boolean {
  if (!source.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256) || !source.originalContentType) return false
  const extension = source.originalContentType === 'application/pdf' ? 'pdf' : 'html'
  return source.originalBlobName === `${source.workspaceId}/${source.ladderId}/${source.id}/original.${extension}`
}

function sameUrl(source: ReferenceSourceRecord, target: string): boolean {
  const wanted = urlParts(target).url
  return [source.requestedUrl, source.finalUrl].some(value => value && urlParts(value).url === wanted)
}

function containsSection(evidence: CapturedReferenceEvidence, section: string): boolean {
  const intended = selectedSection(evidence.source)
  if (evidence.source.originalContentType === 'application/pdf') {
    const page = /^page=(\d+)$/i.exec(section)?.[1]
    return page !== undefined && Number(page) >= 1 && Number(page) <= evidence.document.pageCount &&
      evidence.document.paragraphs.some(paragraph => paragraph.page === Number(page))
  }
  if (intended && intended !== section) return false
  return evidence.document.paragraphs.some(paragraph =>
    paragraph.sectionId !== undefined && sectionName(paragraph.sectionId) === section)
}

function capturesTarget(evidence: CapturedReferenceEvidence, targetUrl: string): boolean {
  if (!sameUrl(evidence.source, targetUrl)) return false
  const wanted = urlParts(targetUrl)
  if (wanted.section) return containsSection(evidence, wanted.section)
  // A fragment-specific capture is not a complete capture of an unfragmented target.
  return selectedSection(evidence.source) === ''
}

/** Resolves the exact outgoing target of a legacy or current issue; never guesses it from the message. */
export function getReferenceIssueTarget(
  source: Pick<ReferenceSourceRecord, 'relatedLinks'>,
  issue: GradeIssue,
  extractedLinks: readonly ReferenceLink[] = [],
): ReferenceLink | undefined {
  if (!['opm-traversal-limit', 'opm-linked-source-unresolved', 'opm-group-selection-unresolved'].includes(issue.code)) return undefined
  const matches = [...source.relatedLinks, ...extractedLinks].filter(link =>
    issue.id === opmDiscoveryIssueId(issue.code, link.url, issue.grade))
  const targets = new Map(matches.map(link => [link.url, link]))
  return targets.size === 1 ? structuredClone([...targets.values()][0]) : undefined
}

/**
 * Removes only capture-fact notices proven by complete, same-version evidence. It never changes
 * coverage, authority, semantic issues, or prior source sets. Persist `resolved` with provenance.
 * Pass no targets when updating an extracted source. Cross-reference resolutions are source-set
 * local: pass only selected target captures when freezing, and retain the original source issues.
 */
export function reconcileReferenceIssues(
  source: ReferenceSourceRecord,
  extraction: ReferenceExtraction,
  selectedTargets: readonly CapturedReferenceEvidence[] = [],
): ReferenceIssueReconciliation {
  const result: ReferenceIssueReconciliation = { issues: structuredClone(source.issues), resolved: [] }
  const current = { source, document: extraction.document }
  const complete = fullExtraction(current)
  const captured: CapturedReferenceEvidence[] = []
  for (const evidence of selectedTargets) {
    if (evidence.source.workspaceId !== source.workspaceId || evidence.source.ladderId !== source.ladderId) {
      invalidEvidence('A cross-reference capture must belong to the same workspace and ladder.')
    }
    const targetComplete = fullExtraction(evidence)
    if (evidence.source.status === 'ready' && evidence.source.completeness === 'complete' &&
      evidence.source.documentBlobName === `${source.workspaceId}/${source.ladderId}/${evidence.source.id}/document-v${evidence.source.documentVersion}.json` &&
      archivedSource(evidence.source) && targetComplete) captured.push(evidence)
  }
  if (!complete || !archivedSource(source) || !['extracting', 'ready'].includes(source.status)) return result
  if (source.originalContentType === 'application/pdf' && extraction.method !== 'document-intelligence') {
    invalidEvidence('A PDF capture notice requires a successful PDF layout extraction.')
  }
  const sourceUrls = [source.requestedUrl, source.finalUrl].filter((url): url is string => !!url)
  result.issues = []
  for (const issue of source.issues) {
    let resolution: ReferenceIssueResolution | undefined
    const owned = source.origin === 'opm' && (!issue.sourceId || issue.sourceId === source.id)
    const selfIssue = sourceUrls.some(url => issue.id === opmDiscoveryIssueId(issue.code, url, issue.grade))
    if (owned && selfIssue && issue.code === 'opm-pdf-content-review' && issue.severity === 'warning' &&
      issue.scope === 'source' && issue.grade === undefined && source.originalContentType === 'application/pdf') {
      resolution = resolved(issue, 'complete-source-extraction', current)
    } else if (owned && selfIssue && issue.code === 'opm-linked-section-missing' && selectedSection(source) &&
      containsSection(current, selectedSection(source))) {
      resolution = resolved(issue, 'captured-named-section', current, source.requestedUrl)
    } else if (owned && issue.code === 'opm-traversal-limit') {
      const target = getReferenceIssueTarget(source, issue, extraction.links)
      const evidence = target ? [current, ...captured].find(value => capturesTarget(value, target.url)) : undefined
      if (target && evidence) resolution = resolved(issue, 'captured-reference-target', evidence, target.url)
    }
    if (resolution) result.resolved.push(resolution)
    else result.issues.push(structuredClone(issue))
  }
  return result
}

function resolved(
  issue: GradeIssue,
  reason: ReferenceIssueResolution['reason'],
  evidence: CapturedReferenceEvidence,
  targetUrl?: string,
): ReferenceIssueResolution {
  return {
    issue: structuredClone(issue),
    reason,
    evidence: {
      sourceId: evidence.source.id,
      documentId: evidence.document.id,
      documentVersion: evidence.document.version,
      sha256: evidence.source.sha256!,
      ...(targetUrl ? { targetUrl } : {}),
      ...(selectedSection(evidence.source) ? { intendedSection: selectedSection(evidence.source) } : {}),
    },
  }
}
