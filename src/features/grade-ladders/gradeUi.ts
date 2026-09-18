import {
  GRADE_LADDER_LIMITS,
  gradeHeadId,
  type GradeContext,
  type GradeCriterion,
  type GradeIssue,
  type GradeLadderDetail,
  type GradeLadderSummary,
  type GradeLevelDetail,
  type GradeRubricVersionRecord,
  type FrozenReferenceSource,
  type ReferenceSourceRecord,
  type SourceDecision,
} from '../../domain/real-grades'
import type { Citation, Rubric, Workspace } from '../../domain/types'
import { lifecycleIsRemoved } from '../../domain/lifecycle'
import { documentPagination, isOriginalContentType, storedDocumentContentType } from '../../domain/document-formats'

export const gradeStatusLabels = {
  draft: 'Draft',
  queued: 'Queued',
  processing: 'Generating / grounding review',
  'needs-sources': 'Needs supporting sources',
  'ready-for-review': 'Grounding reviewed',
  approved: 'Reviewer approved',
  error: 'Processing error',
  cancelled: 'Cancelled',
} as const

export const sourcePurposeLabels = {
  grading: 'Work-level grading',
  classification: 'Classification / titling',
  qualification: 'Qualifications · unscored',
  agency: 'Agency supporting evidence',
  'job-context': 'Seed job context',
  background: 'Background',
  issuance: 'Issuance / version evidence',
} as const

export function gradeSourcePagination(source: ReferenceSourceRecord | FrozenReferenceSource) {
  const contentType = ('originalContentType' in source ? source.originalContentType : undefined) ??
    storedDocumentContentType(source.originalBlobName ?? '')
  if (isOriginalContentType(contentType)) return documentPagination(contentType)
  return source.origin === 'upload' || source.selectedPages.length > 0 ? 'pdf-pages' : 'captured-sections'
}

export function gradeLadderLink(ladderId: string, grade?: number, versionId?: string): string {
  const query = new URLSearchParams()
  if (grade !== undefined) query.set('grade', String(grade))
  if (versionId) query.set('version', versionId)
  return `/grade-ladders/${encodeURIComponent(ladderId)}${query.size ? `?${query}` : ''}`
}

export function parseSelectedPages(value: string, limit = GRADE_LADDER_LIMITS.maxPdfPages): number[] {
  if (!value.trim()) return []
  const pages = new Set<number>()
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim())
    if (!match) throw new Error('Use positive page numbers or ranges, such as 1-12, 18, 25-30.')
    const first = Number(match[1])
    const last = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last > 100_000 || last < first || last - first + 1 > limit) {
      throw new Error(`Choose ascending page ranges with at most ${limit} selected pages per PDF.`)
    }
    for (let page = first; page <= last; page++) {
      pages.add(page)
      if (pages.size > limit) throw new Error(`Select at most ${limit} pages per PDF.`)
    }
  }
  return [...pages].sort((a, b) => a - b)
}

export function contextErrors(name: string, context: GradeContext, grades: number[]): string[] {
  const errors: string[] = []
  if (!name.trim() || name.trim().length > 160) errors.push('Enter a family name of 1–160 characters.')
  if (!/^\d{4}$/.test(context.series)) errors.push('Confirm a four-digit GS occupational series, not an occupational group or a job title.')
  if (!grades.length || grades.some((grade) => !Number.isInteger(grade) || grade < 1 || grade > 15) || new Set(grades).size !== grades.length) {
    errors.push('Select one or more distinct grades from GS-1 through GS-15.')
  }
  if (!context.confirmed) errors.push('Confirm the position context before discovery. Unknown applicability will remain unresolved.')
  return errors
}

export function initialSourceDecisions(detail: GradeLadderDetail): SourceDecision[] {
  return detail.sources.map((source) => detail.sourceSet?.decisions.find((decision) => decision.sourceId === source.id) ?? {
    sourceId: source.id,
    selected: source.origin === 'seed-job' || source.purpose !== 'background',
    applicability: source.origin === 'seed-job' ? 'applicable' : 'uncertain',
    reason: source.origin === 'seed-job' ? 'Captured seed supplies role context, not independent federal grading authority.' : '',
  })
}

export function selectedSourceBudget(sources: ReferenceSourceRecord[], decisions: SourceDecision[]) {
  const selected = sources.filter((source) => source.origin !== 'seed-job' && decisions.some((decision) => decision.sourceId === source.id && decision.selected))
  const pdfs = selected.filter((source) => source.originalContentType === 'application/pdf')
  return {
    references: selected.length,
    pdfPages: pdfs.reduce((total, source) => total + (source.selectedPages.length || source.pageCount || 0), 0),
    unknownPdfPages: pdfs.some((source) => !source.selectedPages.length && source.pageCount === undefined),
  }
}

export function uniqueCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  return citations.filter((citation) => {
    const key = JSON.stringify([citation.documentId, citation.documentVersion, citation.paragraphId, citation.quote])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function relevantIssues(issues: GradeIssue[], grade: number): GradeIssue[] {
  return issues.filter((issue) => issue.grade === undefined || issue.grade === grade)
}

export function gradeDraftWeightState(criteria: readonly Pick<GradeCriterion, 'support' | 'weight'>[]) {
  const supported = criteria.filter((criterion) => criterion.support === 'direct' || criterion.support === 'derived')
  const fullySupported = supported.length > 0 && !criteria.some((criterion) => criterion.support === 'gap')
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const errors: string[] = []
  if (criteria.some((criterion) => !Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100)) {
    errors.push('Each review weight must be finite and between 0% and 100%.')
  }
  if (criteria.some((criterion) => (criterion.support === 'gap' || criterion.support === 'not-applicable') && criterion.weight !== 0)) {
    errors.push('Gap and not-applicable rows must stay at 0%; do not allocate weight to unscored expectations.')
  }
  if (supported.some((criterion) => criterion.weight <= 0)) errors.push('Direct and derived expectations need positive review weights.')
  if (Number.isFinite(total) && total > 100 + 0.000001) errors.push('Allocated review weights must not exceed 100%, including incomplete drafts.')
  else if (fullySupported && Number.isFinite(total) && Math.abs(total - 100) > 0.000001) {
    errors.push('A nonempty assessment without evidence gaps must allocate exactly 100% to its supported expectations.')
  }
  return { total, fullySupported, errors }
}

function isFrozenExclusionCitation(citation: Citation, detail: GradeLadderDetail): boolean {
  const source = detail.sourceSet?.sources.find((source) => source.documentId === citation.documentId)
  if (!source || source.documentVersion !== citation.documentVersion || !citation.paragraphId.trim() || !citation.quote.trim() ||
      !Number.isInteger(citation.page) || citation.page < 1 || citation.page > source.pageCount ||
      (source.selectedPages.length > 0 && !source.selectedPages.includes(citation.page))) return false
  return source.origin !== 'seed-job' && ['grading', 'classification', 'agency'].includes(source.purpose) &&
    ['current', 'supplied'].includes(source.authorityStatus) && source.completeness !== 'incomplete' &&
    Boolean(detail.sourceSet?.decisions.some((decision) => decision.sourceId === source.sourceId && decision.selected && decision.applicability === 'applicable'))
}

export function gradeApprovalBlockers(detail: GradeLadderDetail, level: GradeLevelDetail): string[] {
  const { head, version, review } = level
  if (detail.ladder.lifecycle?.archivedAt || head.lifecycle?.archivedAt || lifecycleIsRemoved(detail.ladder.lifecycle) || lifecycleIsRemoved(head.lifecycle)) return ['Archived or removed grades are read-only. Unarchive the ladder and grade before approval.']
  if (!version) return ['No generated version is available yet.']
  if (head.approvedVersionId === version.id) return ['This immutable version is already approved.']
  const reasons: string[] = []
  if (head.status !== 'ready-for-review') reasons.push('Wait for a successful grounding review of the latest draft.')
  if (head.latestVersionId !== version.id || !review || head.latestReviewId !== review.id ||
      review.outcome !== 'supported' || review.versionId !== version.id || review.versionHash !== version.contentHash ||
      review.sourceSetId !== version.sourceSetId || review.grade !== version.grade || head.grade !== version.grade ||
      review.ladderId !== version.ladderId || review.workspaceId !== version.workspaceId) reasons.push('The latest version needs its own matching supported review.')
  if (detail.ladder.sourceSetId !== version.sourceSetId || detail.ladder.generationId !== version.generationId) {
    reasons.push('Context or sources changed. Confirm the current source set and generate a new revision.')
  }
  const supported = version.rubric.criteria.filter((criterion) => criterion.support === 'direct' || criterion.support === 'derived')
  const exclusions = version.rubric.criteria.filter((criterion) => criterion.support === 'not-applicable')
  if (version.rubric.criteria.some((criterion) => !['direct', 'derived', 'not-applicable'].includes(criterion.support)) || version.qualifications.some((item) => item.support === 'gap')) {
    reasons.push('Unsupported work expectations or qualifications remain drafts until sources support them.')
  }
  if (!version.rubric.criteria.length || version.rubric.criteria.some((criterion) => !criterion.label.trim() || !criterion.description.trim() || !criterion.guidance.trim())) {
    reasons.push('Each competency needs a complete expectation and evaluation guidance.')
  }
  reasons.push(...gradeDraftWeightState(version.rubric.criteria).errors)
  if (!supported.length) reasons.push('Approval requires at least one supported, weighted work-level expectation; exclusions alone are not an assessment.')
  if (version.rubric.criteria.some((criterion) => !criterion.sourceCitations?.length || !criterion.interpretation.trim()) ||
      supported.some((criterion) => !criterion.gradeBasis.length) ||
      version.qualifications.some((item) => !item.citations.length || !item.interpretation.trim())) {
    reasons.push('Claims need exact supporting citations and a separate grounded interpretation.')
  }
  if (exclusions.some((criterion) => criterion.gradeBasis.length > 0 ||
      /(?:^|[\n;|]|[.!?]\s+)\s*(?:score\s*)?[0-5]\s*[:.)=\-–—]/i.test(criterion.guidance))) {
    reasons.push('Not-applicable exclusions need unscored guidance and no asserted grade basis or numeric score anchors.')
  }
  // The matching server review validates exact quotation text; exclusions must also bind to its frozen work-level sources.
  if (exclusions.some((criterion) => detail.sourceSet?.id !== version.sourceSetId ||
      !criterion.sourceCitations?.length || criterion.sourceCitations.some((citation) => !isFrozenExclusionCitation(citation, detail)))) {
    reasons.push('Not-applicable exclusions need exact citations to applicable work-level evidence in this version’s frozen source set.')
  }
  const total = supported.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (!Number.isFinite(total) || Math.abs(total - 100) > 0.000001) reasons.push('Supported work-level weights must total 100%; exclusions remain unscored.')
  for (const issue of relevantIssues([
    ...detail.ladder.issues, ...(detail.sourceSet?.issues ?? []), ...(detail.sourceSet?.sources.flatMap((source) => source.issues) ?? []), ...head.issues, ...version.issues, ...(review?.issues ?? []),
  ], head.grade)) if (issue.severity === 'blocker') reasons.push(issue.message)
  return [...new Set(reasons)]
}

export function gradeSummaryStamp(summary: GradeLadderSummary): string {
  return JSON.stringify([summary.etag, [...summary.levels].sort((a, b) => a.head.grade - b.head.grade).map((level) => [level.head.id, level.etag])])
}

export function gradeWorkActive(detail: GradeLadderSummary): boolean {
  return ['discovering', 'generating'].includes(detail.ladder.status) ||
    detail.levels.some((level) => ['queued', 'processing'].includes(level.head.status)) ||
    ('workItems' in detail && (detail as GradeLadderDetail).workItems.some((work) => work.status === 'queued' || work.status === 'running'))
}

export function projectRealGrades(workspace: Workspace, versions: GradeRubricVersionRecord[], summaries?: GradeLadderSummary[]): Workspace {
  const projected = new Map<string, Rubric>()
  const families = new Map((summaries ?? []).map((summary) => [summary.ladder.id, summary]))
  for (const version of versions) {
    const summary = families.get(version.ladderId)
    const level = summary?.levels.find((level) => level.head.grade === version.grade)
    if (summaries && (!summary || !level || lifecycleIsRemoved(summary.ladder.lifecycle) || lifecycleIsRemoved(level.head.lifecycle))) continue
    if ((projected.get(version.rubric.id)?.version ?? 0) > version.version) continue
    projected.set(version.rubric.id, {
      ...version.rubric,
      kind: 'grade',
      dataKind: 'real',
      groupId: gradeHeadId(version.ladderId, version.grade),
    })
  }
  return {
    ...workspace,
    lifecycle: {
      ...workspace.lifecycle,
      entities: {
        ...workspace.lifecycle?.entities,
        ...Object.fromEntries((summaries ?? []).flatMap(({ ladder, levels }) => [
          [`ladder:${ladder.id}`, ladder.lifecycle ?? {}],
          ...levels.map(({ head }) => [`rubric:${head.id}`, { ...head.lifecycle, parentKey: `ladder:${ladder.id}` }]),
        ])),
      },
    },
    rubrics: [...workspace.rubrics.filter((rubric) => !projected.has(rubric.id) && !(rubric.kind === 'grade' && rubric.dataKind === 'real')), ...projected.values()],
  }
}
