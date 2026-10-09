import type {
  AnalysisReport, ReportCitation, ReportGenerationOptions, ReportGroup, ReportTarget,
} from '../../domain/analysis-reports'
import type { DocumentPagination } from '../../domain/document-formats'
import { getDisplayName } from '../../domain/displayNames'
import { SCORE_LEGEND } from '../../domain/rubric-exports'
import type { RubricExportPayload } from '../../domain/rubric-exports'
import type { RubricVersionStatus } from '../../domain/rubric-approval'
import { reportReviewLinks, trustedApplicationOrigin } from './links'
import { reportTargetPresentation } from './narratives'
import { formatReportWeight, paginationLabel } from './presentation'
import { readableAnalysisDate, readableTargetSourceLabel } from './readable'

export const RUBRIC_DETAILS_TITLE = 'Job & rubric details'
export const RUBRIC_SECTION_SUBTITLE = 'How each criterion is defined and scored'
export const RUBRIC_ROUNDED_WEIGHT_NOTE = '~ marks a weight rounded for display.'
const RUBRIC_APPROVAL_LABELS: Record<RubricVersionStatus, string> = {
  approved: 'Approved',
  draft: 'Draft, not approved',
  superseded: 'Superseded by a newer approved version',
}

export function rubricDetailsTitle(kind: 'job' | 'grade'): string {
  return kind === 'grade' ? 'Grade & rubric details' : RUBRIC_DETAILS_TITLE
}

export interface RubricDocumentFact {
  label: string
  value: string
}

export interface RubricDocumentLink {
  text: string
  url: string
}

export interface RubricDocumentSource {
  quote: string
  location: string
}

export interface RubricGuidanceAnchor {
  score: number
  level: string
  text: string
}

/** Anchors only when the guidance states distinct 0–5 levels in order; anything else stays verbatim. */
export type RubricDocumentGuidance =
  | { kind: 'anchors'; introduction: string; anchors: RubricGuidanceAnchor[] }
  | { kind: 'text'; text: string }

export interface RubricDocumentCriterion {
  code: string
  label: string
  description: string
  weight: number
  weightLabel: string
  requirement: string
  scored: boolean
  guidance: RubricDocumentGuidance
  guidanceText: string
  sources: RubricDocumentSource[]
  support: string | null
  interpretation: string | null
}

export interface RubricDocumentQualification {
  code: string
  text: string
  interpretation: string
  support: string
  sources: RubricDocumentSource[]
}

/** One rubric, in reader-facing text only. It never carries internal IDs, hashes or locators. */
export interface RubricExportDocument {
  kind: 'job' | 'grade'
  title: string
  sourceTitle: string | null
  organization: string
  rubricName: string
  version: number
  versionLabel: string
  origin: string | null
  savedAt: string | null
  exportedAt: string | null
  description: string
  about: RubricDocumentFact[]
  scoring: string[]
  weightTotal: number
  weightNotice: string | null
  criteria: RubricDocumentCriterion[]
  qualifications: RubricDocumentQualification[]
  /** Shown in place of source quotes when a criterion has none. */
  noSources: string
  link: RubricDocumentLink | null
  tableLabel: string
  tableDisplayTitle: string | null
}

const GUIDANCE_ANCHOR = /(?:^|[\n;|]|[.!?]\s+)\s*(?:score\s+)?([0-5])\s*[:.)=\-–—]\s*/giu
const SUPPORT_LABELS: Record<string, string> = {
  direct: 'Direct support',
  derived: 'Derived support',
  gap: 'Evidence gap',
  'not-applicable': 'Not applicable · unscored',
}

const plain = (value: string): string => value.replace(/\s+/gu, ' ').trim()

// A sentence-ending mark that the anchor pattern consumed belongs to the preceding text.
const sentenceEnd = (match: RegExpMatchArray): number => match.index! + (/^[.!?]/u.test(match[0]) ? 1 : 0)

export function parseRubricGuidance(guidance: string): RubricDocumentGuidance {
  const text = guidance.trim()
  const matches = [...text.matchAll(GUIDANCE_ANCHOR)]
  if (matches.length === 6 && matches.every((match, index) => Number(match[1]) === index)) {
    const anchors = matches.map((match, index) => ({
      score: index, level: SCORE_LEGEND[index].label,
      text: text.slice(match.index! + match[0].length, matches[index + 1] ? sentenceEnd(matches[index + 1]) : text.length).trim(),
    }))
    if (anchors.every(anchor => anchor.text)) {
      return { kind: 'anchors', introduction: text.slice(0, sentenceEnd(matches[0])).trim(), anchors }
    }
  }
  return { kind: 'text', text }
}

export function rubricScoringParagraphs(kind: 'job' | 'grade', unscored: boolean): string[] {
  return [
    'Each criterion is scored from 0 to 5 against its scoring guidance, using only evidence found in the submitted resume.',
    'A criterion’s weight is its share of the overall score. Each criterion adds its score ÷ 5 × its weight, so the overall score is out of 100. It is rounded to one decimal place. For example, a score of 4 on a 25% criterion adds 20 points.',
    'When the resume has no evidence for a criterion, that criterion scores 0. When a weighted criterion can’t be assessed at all, the overall score is withheld. The other weights are never rescaled to make up the difference.',
    ...(unscored ? ['Criteria marked “Not scored” don’t apply to this grade. They carry no weight.'] : []),
    ...(kind === 'grade' ? ['GS qualifications are listed separately. They aren’t scored, and they aren’t an official eligibility finding.'] : []),
    'Scores describe evidence in a document, not a person’s ability. Missing evidence doesn’t mean a person lacks the skill. A qualified reviewer checks the evidence and makes every decision.',
  ]
}

function readableDate(value: string | undefined): string | null {
  if (!value?.trim()) return null
  return Number.isFinite(Date.parse(value)) ? readableAnalysisDate(value) : value
}

function sourceLocation(pagination: DocumentPagination, page: number, heading: string, sourceTitle?: string): string {
  return [sourceTitle ? plain(sourceTitle) : '', paginationLabel(pagination, page), plain(heading)].filter(Boolean).join(' · ')
}

function requirementLabel(value: 'required' | 'preferred' | null | undefined): string {
  return value === 'required' ? 'Required' : value === 'preferred' ? 'Preferred' : ''
}

function weightNotice(total: number): string | null {
  if (Number.isFinite(total) && Math.abs(total - 100) <= 0.000001) return null
  return `The criterion weights total ${Number.isFinite(total) ? `${Number(total.toFixed(6))}%` : 'an invalid amount'}, not 100%. Review the rubric in Score before relying on its overall scores.`
}

function criterion(
  index: number, value: {
    label: string; description: string; weight: number; guidance: string
    requirementType: 'required' | 'preferred' | null | undefined
  },
  sources: RubricDocumentSource[], support: string | null = null, interpretation: string | null = null,
): RubricDocumentCriterion {
  const scored = value.weight > 0 && support !== SUPPORT_LABELS['not-applicable']
  return {
    code: `C${index + 1}`, label: value.label, description: value.description,
    weight: value.weight, weightLabel: scored ? formatReportWeight(value.weight) : 'Not scored',
    requirement: requirementLabel(value.requirementType), scored,
    guidance: parseRubricGuidance(value.guidance), guidanceText: value.guidance.trim(),
    sources, support, interpretation,
  }
}

function about(entries: [string, string | undefined][]): RubricDocumentFact[] {
  return entries.flatMap(([label, value]) => value?.trim() ? [{ label, value: value.trim() }] : [])
}

export function rubricPageLink(payload: Pick<RubricExportPayload, 'workspaceId' | 'job' | 'rubric'>, origin: string): string {
  const trusted = trustedApplicationOrigin(origin, 'Rubric links')
  const query = new URLSearchParams({ job: payload.job.id })
  return `${trusted}/workspaces/${encodeURIComponent(payload.workspaceId)}/rubrics/${encodeURIComponent(payload.rubric.id)}?${query}`
}

export function rubricDocumentFromPayload(payload: RubricExportPayload, links: { origin: string }): RubricExportDocument {
  const { job, rubric } = payload
  const criteria = rubric.criteria.map((item, index) => criterion(index, item, item.citations.map(citation => ({
    quote: citation.quote, location: sourceLocation(job.pagination, citation.page, citation.heading),
  }))))
  const weightTotal = rubric.criteria.reduce((sum, item) => sum + item.weight, 0)
  return {
    kind: 'job',
    title: getDisplayName(job, job.title),
    sourceTitle: job.displayName !== undefined ? job.title : null,
    organization: job.organization.trim(),
    rubricName: rubric.name,
    version: rubric.version,
    versionLabel: [
      rubric.version === rubric.latestVersion ? `Version ${rubric.version} (current)`
        : `Version ${rubric.version} of ${rubric.latestVersion} — a newer version exists`,
      ...(rubric.approval ? [RUBRIC_APPROVAL_LABELS[rubric.approval]] : []),
    ].join(' · '),
    origin: rubric.provenance === 'edited' ? 'Edited by a reviewer' : 'Generated from the job posting',
    savedAt: readableDate(rubric.createdAt),
    exportedAt: readableDate(payload.generatedAt),
    description: rubric.description,
    about: about([
      ['Location', job.location], ['Work arrangement', job.arrangement], ['Employment type', job.employmentType],
      ['Series', job.series], ['Grade', job.grade], ['Source', job.sourceLabel],
    ]),
    scoring: rubricScoringParagraphs('job', criteria.some(item => !item.scored)),
    weightTotal, weightNotice: weightNotice(weightTotal),
    criteria, qualifications: [],
    noSources: RUBRIC_NO_SOURCES,
    link: { text: 'View rubric in Score', url: rubricPageLink(payload, links.origin) },
    tableLabel: job.title,
    tableDisplayTitle: job.displayName ?? null,
  }
}

function citationKey(citation: ReportCitation): string {
  return JSON.stringify([citation.documentId, citation.documentVersion, citation.paragraphId, citation.page, citation.heading, citation.quote])
}

function uniqueCitations(citations: ReportCitation[]): ReportCitation[] {
  const unique = new Map<string, ReportCitation>()
  for (const citation of citations) if (!unique.has(citationKey(citation))) unique.set(citationKey(citation), citation)
  return [...unique.values()]
}

function fact(target: ReportTarget, label: string): string | undefined {
  return target.facts.find(item => item.label === label)?.value
}

/**
 * Frozen rubric details for one exact report target. Criterion definitions come from the target snapshot;
 * source quotes and GS qualifications come from its completed comparisons.
 */
export function rubricDocumentFromReportGroup(
  report: AnalysisReport, group: ReportGroup, options?: ReportGenerationOptions,
): RubricExportDocument {
  const { target } = group
  const completed = group.comparisons.filter(comparison => comparison.status === 'complete')
  const presentation = reportTargetPresentation(target)
  const criterionCitations = new Map(target.criteria.map(definition => [definition.id, uniqueCitations(completed.flatMap(comparison =>
    comparison.criteria.find(assessment => assessment.criterionId === definition.id)?.requirementCitations ?? []))]))
  const qualificationRows = new Map<string, { text: string; interpretation: string; support: string; citations: ReportCitation[] }>()
  for (const qualification of completed.flatMap(comparison => comparison.qualifications)) {
    const row = qualificationRows.get(qualification.qualificationId)
    if (row) row.citations = uniqueCitations([...row.citations, ...qualification.requirementCitations])
    else qualificationRows.set(qualification.qualificationId, {
      text: qualification.text, interpretation: qualification.interpretation,
      support: SUPPORT_LABELS[qualification.support] ?? qualification.support,
      citations: uniqueCitations(qualification.requirementCitations),
    })
  }
  const allCitations = [...criterionCitations.values(), ...[...qualificationRows.values()].map(row => row.citations)].flat()
  const multipleSources = new Set(allCitations.map(citation => JSON.stringify([citation.documentId, citation.documentVersion]))).size > 1
  const sources = (citations: ReportCitation[]): RubricDocumentSource[] => citations.map(citation => ({
    quote: citation.quote,
    location: sourceLocation(citation.pagination, citation.page, citation.heading, multipleSources ? citation.sourceTitle : undefined),
  }))
  const criteria = target.criteria.map((definition, index) => {
    const prefix = `${definition.label} (${definition.id}) — `
    const support = target.kind === 'grade' ? fact(target, `${prefix}source support`) : undefined
    return criterion(index, definition, sources(criterionCitations.get(definition.id) ?? []),
      support === undefined ? null : SUPPORT_LABELS[support] ?? support,
      target.kind === 'grade' ? fact(target, `${prefix}interpretation`)?.trim() || null : null)
  })
  const weightTotal = target.criteria.reduce((sum, definition) => sum + definition.weight, 0)
  const origin = fact(target, 'Rubric origin')
  const linked = completed[0] ?? group.comparisons[0]
  return {
    kind: target.kind,
    title: getDisplayName(target, presentation.title),
    sourceTitle: target.displayName !== undefined ? presentation.title : null,
    organization: presentation.organization.trim(),
    rubricName: fact(target, 'Rubric name')?.trim() || presentation.title,
    version: target.rubricVersion,
    versionLabel: presentation.versionLabel,
    origin: origin?.trim() || null,
    savedAt: readableDate(fact(target, 'Rubric created')),
    exportedAt: null,
    description: presentation.description,
    about: target.kind === 'grade' ? about([
      ['GS grade', fact(target, 'GS grade')], ['Series', fact(target, 'Series')], ['Agency type', fact(target, 'Agency type')],
      ['Supervision', fact(target, 'Supervision')], ['Specialty', fact(target, 'Specialty')], ['Functions', fact(target, 'Functions')],
    ]) : about([
      ['Location', fact(target, 'Job location')], ['Work arrangement', fact(target, 'Job work arrangement')],
      ['Employment type', fact(target, 'Job employment type')], ['Series', fact(target, 'Series')],
      ['Grade', fact(target, 'Grade')], ['Source', fact(target, 'Job source')],
    ]),
    scoring: rubricScoringParagraphs(target.kind, criteria.some(item => !item.scored)),
    weightTotal, weightNotice: weightNotice(weightTotal),
    criteria,
    qualifications: [...qualificationRows.values()].map((row, index) => ({
      code: `Q${index + 1}`, text: row.text, interpretation: row.interpretation, support: row.support, sources: sources(row.citations),
    })),
    noSources: completed.length ? RUBRIC_NO_SOURCES : RUBRIC_NO_COMPLETED_SOURCES,
    link: linked ? {
      text: target.kind === 'grade' ? 'View grade requirements' : 'View job',
      url: reportReviewLinks(report, linked, options).target,
    } : null,
    tableLabel: readableTargetSourceLabel(report, group),
    tableDisplayTitle: target.displayName ?? null,
  }
}

/** Title-block entries shared by every writer. */
export function rubricMetadataEntries(document: RubricExportDocument): string[] {
  return [
    `Rubric: ${plain(document.rubricName)}`,
    document.versionLabel,
    document.origin ?? '',
    document.savedAt ? `Saved ${document.savedAt}` : '',
    document.exportedAt ? `Exported ${document.exportedAt}` : '',
  ].filter(Boolean)
}

export function rubricLegendText(): string {
  return SCORE_LEGEND.map(item => `${item.value} ${item.label}`).join(' · ')
}

export function rubricSourceLabel(document: Pick<RubricExportDocument, 'kind'>): string {
  return document.kind === 'grade' ? 'From the grade sources' : 'From the job posting'
}

/** Grades have no required/preferred split, so their overview shows how each criterion is supported instead. */
export function rubricGlanceTable(document: Pick<RubricExportDocument, 'kind' | 'criteria'>): { headers: string[]; rows: string[][] } {
  const grade = document.kind === 'grade'
  return {
    headers: ['#', 'Criterion', grade ? 'Source support' : 'Requirement', 'Weight'],
    rows: document.criteria.map(criterion => [
      criterion.code, criterion.label, (grade ? criterion.support : criterion.requirement) || '—', criterion.weightLabel,
    ]),
  }
}

export function rubricCriterionSummary(criterion: Pick<RubricDocumentCriterion, 'requirement' | 'weightLabel'>): string {
  return [criterion.requirement, `Weight: ${criterion.weightLabel}`].filter(Boolean).join(' · ')
}

export function rubricAnchorLabel(anchor: RubricGuidanceAnchor): string {
  return `${anchor.score} · ${anchor.level}`
}

export function rubricQuote(source: Pick<RubricDocumentSource, 'quote'>): string {
  return `“${source.quote}”`
}

export const RUBRIC_NO_GUIDANCE = 'No scoring guidance was provided.'
export const RUBRIC_NO_SOURCES = 'No source quotes were recorded.'
export const RUBRIC_NO_COMPLETED_SOURCES = 'Source quotes are saved with completed comparisons, and no comparison for this target completed.'
export const RUBRIC_QUALIFICATIONS_TITLE = 'GS qualifications (unscored)'
export const RUBRIC_QUALIFICATIONS_NOTE = 'These notes help a reviewer check GS qualification evidence. They aren’t scored, and they aren’t an official eligibility finding.'

export function rubricAboutTitle(document: Pick<RubricExportDocument, 'kind'>): string {
  return document.kind === 'grade' ? 'About the grade' : 'About the job'
}

export function rubricNoDetails(document: Pick<RubricExportDocument, 'kind'>): string {
  return `No other ${document.kind} details were recorded.`
}
