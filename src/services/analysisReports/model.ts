import { z } from 'zod'
import { ANALYSIS_REPORT_SCHEMA_VERSION, REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, AnalysisReportBuildOptions, AnalysisReportInput, RealReportBatchResponse,
  ReportCitation, ReportCitationSource, ReportComparison, ReportDataKind, ReportGroup,
  ReportPolicy, ReportStatusCounts, ReportTarget,
} from '../../domain/analysis-reports'
import type { Citation } from '../../domain/types'
import { buildReportNotices, citationLocator } from './presentation'
import {
  realCandidateNarrativeSchema, realNarrativeReportCaptureSchema, realTargetNarrativeSchema,
  reportCandidateNarrativeSchema, reportNarrativeCaptureSchema,
  reportTargetNarrativeSchema, reportTargetPresentationSchema,
} from './narrative-schemas'
import { requireReportNarratives } from './narratives'
import { normalizeDisplayName } from '../../domain/displayNames'
import { captureReportSettings, reportLimits, reportSettingsCaptureSchema } from './policy'

const id = z.string().min(1).max(1024).refine(value => value === value.trim(), 'Identity must not contain surrounding whitespace.')
const text = z.string().max(REPORT_LIMITS.maxTextCharacters)
const requiredText = text.refine(value => value.trim().length > 0, 'Saved text must not be empty.')
const label = z.string().min(1).max(8192).refine(value => value.trim().length > 0, 'Label must not be empty.')
export const reportDisplayNameSchema = z.string().refine((value) => {
  try { return normalizeDisplayName(value) === value }
  catch { return false }
}, 'Saved display names must be normalized, nonempty, single-line text of at most 160 characters.')
const timestamp = z.iso.datetime({ offset: true })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected a SHA-256 identity.')
const version = z.number().int().min(1)
const weight = z.number().finite().min(0).max(100)
const criterionScore = z.number().finite().min(0).max(5)
const criterionCount = z.number().int().min(0).max(REPORT_LIMITS.maxCriteriaPerTarget)
const WEIGHT_TOLERANCE = 0.000001
const status = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled'])
const evidenceStatus = z.enum(['supported', 'partial', 'missing', 'not-assessed', 'not-applicable'])
const snapshot = z.strictObject({ snapshotId: id, sha256 })
const facts = z.array(z.strictObject({ label, value: requiredText })).max(REPORT_LIMITS.maxFacts)
const limitation = z.strictObject({ code: id, message: requiredText, criterionId: id.optional(), qualificationId: id.optional() })
const selection = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('job'), jobId: id, rubricId: id, rubricVersion: version, rubricHash: sha256,
    documentId: id, documentVersion: version, documentSha256: sha256,
  }),
  z.strictObject({
    kind: z.literal('grade'), ladderId: id, grade: z.number().int().min(1).max(15), versionId: id,
    version, versionHash: sha256, approvalId: id, reviewId: id, sourceSetId: id, sourceSetHash: sha256,
  }),
])

function issue(context: z.RefinementCtx, message: string, path: (string | number)[] = []): void {
  context.addIssue({ code: 'custom', message, path })
}

function unique(values: (string | number)[], context: z.RefinementCtx, description: string): void {
  if (new Set(values).size !== values.length) issue(context, `Duplicate ${description} are not allowed.`)
}

export const reportCitationSchema: z.ZodType<ReportCitation> = z.strictObject({
  documentId: id,
  documentVersion: version,
  paragraphId: id,
  page: z.number().int().min(1),
  heading: label,
  quote: requiredText,
  sourceTitle: label,
  pagination: z.enum(['pdf-pages', 'html-sections', 'markdown-sections', 'captured-sections']),
  locator: requiredText,
}).superRefine((citation, context) => {
  if (citation.locator !== citationLocator(citation)) issue(context, 'Citation locator does not match its saved source identity and page/section designation.', ['locator'])
})

const citations = z.array(reportCitationSchema).max(REPORT_LIMITS.maxCitationsPerAssessment)
const criterionDefinition = z.strictObject({
  id, label, description: requiredText, weight, guidance: requiredText,
  requirementType: z.enum(['required', 'preferred']).nullable(),
})
const targetShape = {
  id,
  dataKind: z.literal('real'),
  kind: z.enum(['job', 'grade']),
  label,
  displayName: reportDisplayNameSchema.optional(),
  sublabel: text,
  versionLabel: label,
  rubricId: id,
  rubricVersion: version,
  selection: selection.nullable(),
  snapshot: snapshot.nullable(),
  criteria: z.array(criterionDefinition).min(1).max(REPORT_LIMITS.maxCriteriaPerTarget),
  facts,
  presentation: reportTargetPresentationSchema.optional(),
  narrative: reportTargetNarrativeSchema.optional(),
}

function validateTarget(target: ReportTarget, context: z.RefinementCtx): void {
  unique(target.criteria.map(criterion => criterion.id), context, 'criterion IDs')
  if (target.narrative && target.narrative.dataKind !== target.dataKind) issue(context, 'Target narrative provenance must match the report data kind.')
  if (!target.selection || !target.snapshot) issue(context, 'Real targets require frozen selection and snapshot identities.')
  if (target.selection?.kind !== target.kind) issue(context, 'Target kind does not match its frozen selection.')
  if (target.selection?.kind === 'job' &&
    (target.selection.rubricId !== target.rubricId || target.selection.rubricVersion !== target.rubricVersion)) {
    issue(context, 'Target rubric does not match its frozen job selection.')
  }
  if (target.selection?.kind === 'grade' && target.selection.version !== target.rubricVersion) {
    issue(context, 'Target rubric version does not match its approved grade selection.')
  }
}

export const reportTargetSchema: z.ZodType<ReportTarget> = z.strictObject(targetShape).superRefine(validateTarget)
const realTargetSchema = z.strictObject({
  ...targetShape, dataKind: z.literal('real'), selection, snapshot, narrative: realTargetNarrativeSchema.optional(),
}).superRefine(validateTarget)

const candidateShape = {
  id, name: text.nullable(), displayName: reportDisplayNameSchema.optional(), role: text.nullable(), sourceLabel: label,
  documentId: id, documentVersion: version, documentSha256: sha256.nullable(), snapshot: snapshot.nullable(),
}
const candidateSchema = z.strictObject(candidateShape)
const realCandidateSchema = z.strictObject({ ...candidateShape, documentSha256: sha256, snapshot })
const overallSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), score: z.number().finite().min(0).max(100) }),
  z.strictObject({ status: z.literal('withheld'), score: z.null(), reason: id, message: requiredText }),
  z.strictObject({ status: z.literal('unavailable'), score: z.null(), reason: z.literal('not-complete'), message: requiredText }),
])
const coverageSchema = z.strictObject({
  totalCriteria: criterionCount, supported: criterionCount, partial: criterionCount, missing: criterionCount,
  notAssessed: criterionCount, notApplicable: criterionCount,
  assessedWeight: z.number().finite().min(0).max(REPORT_LIMITS.maxCriteriaPerTarget * 100),
  totalWeight: z.number().finite().min(0).max(REPORT_LIMITS.maxCriteriaPerTarget * 100),
})
const criterionAssessmentSchema = z.strictObject({
  criterionId: id, weight, score: criterionScore.nullable(), evidenceStatus, rationale: requiredText,
  citations, requirementCitations: citations, limitation: limitation.nullable(),
}).superRefine((assessment, context) => {
  switch (assessment.evidenceStatus) {
    case 'supported':
    case 'partial':
      if (assessment.score === null || !assessment.citations.length) issue(context, 'Supported or partial evidence requires a saved score and at least one exact resume citation.')
      break
    case 'missing':
      if (assessment.score !== 0 || assessment.citations.length) issue(context, 'Missing evidence must retain score zero and no supporting resume citations.')
      break
    case 'not-assessed':
      if (assessment.score !== null) issue(context, 'Not-assessed criteria must not have a score.')
      break
    case 'not-applicable':
      if (assessment.score !== null || assessment.weight !== 0 || assessment.citations.length) issue(context, 'Not-applicable exclusions must be unscored, zero-weight, and without supporting resume citations.')
  }
  if (assessment.limitation?.criterionId && assessment.limitation.criterionId !== assessment.criterionId) issue(context, 'Criterion limitation refers to a different criterion.')
})
const qualificationSchema = z.strictObject({
  qualificationId: id, text: requiredText, interpretation: text, support: z.enum(['direct', 'derived', 'gap']),
  evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']), rationale: requiredText,
  citations, requirementCitations: citations, limitation: limitation.nullable(),
}).superRefine((qualification, context) => {
  if ((qualification.evidenceStatus === 'supported' || qualification.evidenceStatus === 'partial') && !qualification.citations.length) {
    issue(context, 'Supported or partial qualifications require exact resume citations.')
  }
  if (qualification.evidenceStatus === 'missing' && qualification.citations.length) issue(context, 'Missing qualification evidence cannot have supporting resume citations.')
  if (qualification.limitation?.qualificationId && qualification.limitation.qualificationId !== qualification.qualificationId) issue(context, 'Qualification limitation refers to a different qualification.')
})
const comparisonShape = {
  id, index: z.number().int().min(0).max(REPORT_LIMITS.maxComparisons - 1),
  dataKind: z.literal('real'), targetId: id, candidate: candidateSchema, status,
  completion: z.enum(['assessed', 'limited']).nullable(), overall: overallSchema, summary: text.nullable(),
  narrative: reportCandidateNarrativeSchema.optional(),
  coverage: coverageSchema.nullable(),
  criteria: z.array(criterionAssessmentSchema).max(REPORT_LIMITS.maxCriteriaPerTarget),
  qualifications: z.array(qualificationSchema).max(REPORT_LIMITS.maxQualificationsPerComparison),
  limitations: z.array(limitation).max(REPORT_LIMITS.maxLimitations),
  error: z.strictObject({ code: id, message: requiredText, stage: text.nullable(), retryable: z.boolean().nullable() }).nullable(),
  analyzedAt: timestamp.nullable(), resultSha256: sha256.nullable(), provenance: facts,
}

function validateComparison(comparison: ReportComparison, context: z.RefinementCtx): void {
  unique(comparison.criteria.map(criterion => criterion.criterionId), context, 'criterion assessments')
  unique(comparison.qualifications.map(qualification => qualification.qualificationId), context, 'qualification assessments')
  if (comparison.narrative && comparison.narrative.dataKind !== comparison.dataKind) issue(context, 'Candidate narrative provenance must match the report data kind.')
  if (!comparison.candidate.snapshot || !comparison.candidate.documentSha256) {
    issue(context, 'Real candidates require frozen snapshot and document hashes.')
  }
  if (comparison.status !== 'complete') {
    if (comparison.overall.status !== 'unavailable' || comparison.completion !== null || comparison.summary !== null ||
      comparison.coverage !== null || comparison.criteria.length || comparison.qualifications.length || comparison.limitations.length ||
      comparison.analyzedAt !== null || comparison.resultSha256 !== null || comparison.narrative !== undefined) {
      issue(context, 'An unfinished comparison must contain status only, not a score, assessment, or result identity.')
    }
    return
  }
  if (comparison.overall.status === 'unavailable' || comparison.completion === null || !comparison.summary?.trim()) {
    issue(context, 'Complete comparisons require a saved assessment and either an available or withheld overall score.')
  }
  if (!comparison.resultSha256 || !comparison.analyzedAt || !comparison.coverage) issue(context, 'Completed real comparisons require a result hash, analysis timestamp, and saved coverage.')
  if (comparison.overall.status === 'withheld' &&
    !['unassessed-weighted-criteria', 'no-assessable-weight'].includes(comparison.overall.reason)) issue(context, 'Real overall-score withholding must retain a recognized saved reason.')
  for (const criterion of comparison.criteria) {
    if (criterion.score !== null && !Number.isInteger(criterion.score)) issue(context, 'Real criterion scores must retain integer 0–5 values.')
    if (criterion.evidenceStatus === 'not-assessed' && !criterion.limitation) issue(context, 'An unassessed real criterion requires its saved limitation.')
  }
  for (const assessment of [...comparison.criteria, ...comparison.qualifications]) {
    for (const citation of assessment.citations) {
      if (citation.documentId !== comparison.candidate.documentId || citation.documentVersion !== comparison.candidate.documentVersion) {
        issue(context, 'Resume citation does not match the frozen candidate document identity.')
      }
    }
  }
  if (comparison.coverage) {
    const coverage = comparison.coverage
    const counts = { supported: 0, partial: 0, missing: 0, 'not-assessed': 0, 'not-applicable': 0 }
    for (const criterion of comparison.criteria) counts[criterion.evidenceStatus]++
    if (coverage.totalCriteria !== comparison.criteria.length || coverage.supported !== counts.supported ||
      coverage.partial !== counts.partial || coverage.missing !== counts.missing || coverage.notAssessed !== counts['not-assessed'] ||
      coverage.notApplicable !== counts['not-applicable'] || coverage.assessedWeight > coverage.totalWeight + WEIGHT_TOLERANCE) {
      issue(context, 'Saved evidence coverage does not match the criterion assessment states.')
    }
    if (comparison.completion === 'assessed' && (coverage.notAssessed > 0 || comparison.overall.status !== 'available')) {
      issue(context, 'The saved completion state disagrees with the evidence coverage or withheld total.')
    }
    if (comparison.overall.status === 'available' && (coverage.totalWeight <= 0 ||
      Math.abs(coverage.assessedWeight - coverage.totalWeight) > WEIGHT_TOLERANCE ||
      comparison.criteria.some(criterion => criterion.evidenceStatus === 'not-assessed' && criterion.weight > 0))) {
      issue(context, 'Unassessed weighted criteria or no assessable weight cannot have an available overall score.')
    }
  }
}

export const reportComparisonSchema: z.ZodType<ReportComparison> = z.strictObject(comparisonShape).superRefine(validateComparison)
const realComparisonSchema = z.strictObject({
  ...comparisonShape, dataKind: z.literal('real'), candidate: realCandidateSchema, narrative: realCandidateNarrativeSchema.optional(),
}).superRefine(validateComparison)

function validateCollection(targets: ReportTarget[], comparisons: ReportComparison[], dataKind: ReportDataKind, context: z.RefinementCtx): void {
  unique(targets.map(target => target.id), context, 'target IDs')
  unique(targets.map(target => JSON.stringify(target.selection ?? [target.kind, target.rubricId, target.rubricVersion])), context, 'frozen target identities')
  unique(comparisons.map(comparison => comparison.id), context, 'comparison IDs')
  unique(comparisons.map(comparison => comparison.index), context, 'comparison indexes')
  unique(comparisons.map(comparison => JSON.stringify([comparison.candidate.id, comparison.targetId])), context, 'candidate/target pairs')
  const targetMap = new Map(targets.map(target => [target.id, target]))
  const candidateIdentities = new Map<string, string>()
  const usedTargets = new Set<string>()
  for (const target of targets) if (target.dataKind !== dataKind) issue(context, 'Targets from another data source are not allowed.')
  for (const comparison of comparisons) {
    if (comparison.dataKind !== dataKind) issue(context, 'Comparisons from another data source are not allowed.')
    const candidateIdentity = JSON.stringify(comparison.candidate)
    const existing = candidateIdentities.get(comparison.candidate.id)
    if (existing && existing !== candidateIdentity) issue(context, 'A candidate has inconsistent frozen identities across comparisons.')
    candidateIdentities.set(comparison.candidate.id, candidateIdentity)
    const target = targetMap.get(comparison.targetId)
    if (!target) { issue(context, 'A comparison is missing its exact frozen target definition.'); continue }
    usedTargets.add(target.id)
    if (comparison.status !== 'complete') continue
    const definitions = new Map(target.criteria.map(criterion => [criterion.id, criterion]))
    if (comparison.criteria.length !== target.criteria.length) issue(context, 'A completed comparison must include exactly one assessment for every saved criterion.')
    for (const assessment of comparison.criteria) {
      const definition = definitions.get(assessment.criterionId)
      if (!definition || definition.weight !== assessment.weight) issue(context, 'A criterion assessment does not match its frozen definition and weight.')
    }
    if (target.kind !== 'grade' && comparison.qualifications.length) issue(context, 'GS qualification assessments may only belong to a grade target.')
    for (const assessment of [...comparison.criteria, ...comparison.qualifications]) {
      for (const citation of assessment.requirementCitations) {
        if (target.selection?.kind === 'job' && (citation.documentId !== target.selection.documentId ||
          citation.documentVersion !== target.selection.documentVersion)) issue(context, 'Job requirement citation does not match the frozen job document.')
      }
    }
    const qualificationIds = new Set(comparison.qualifications.map(qualification => qualification.qualificationId))
    for (const limitation of comparison.limitations) {
      if ((limitation.criterionId && !definitions.has(limitation.criterionId)) ||
        (limitation.qualificationId && !qualificationIds.has(limitation.qualificationId))) issue(context, 'A limitation references a missing assessment.')
    }
  }
  if (usedTargets.size !== targets.length) issue(context, 'Every included target must have an included comparison.')
}

export function assertReportResourceLimits(value: unknown, maxBytes: number = REPORT_LIMITS.maxInputBytes): void {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new Error('Report data must be JSON-serializable without circular references.') }
  if (serialized === undefined) throw new Error('Report data must be a JSON-serializable value.')
  if (serialized.length > maxBytes || new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new Error(`Report data exceeds the ${maxBytes.toLocaleString('en-US')}-byte resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
  }
}

function validateResources(value: unknown, maxBytes: number, context: z.RefinementCtx): void {
  try { assertReportResourceLimits(value, maxBytes) } catch (error) { issue(context, error instanceof Error ? error.message : 'Report resource limit exceeded.') }
}

export const realReportBatchResponseSchema: z.ZodType<RealReportBatchResponse> = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_REPORT_SCHEMA_VERSION),
  dataKind: z.literal('real'),
  workspaceId: id,
  runId: id,
  targets: z.array(realTargetSchema).min(1).max(REPORT_LIMITS.batchComparisons),
  comparisons: z.array(realComparisonSchema).min(1).max(REPORT_LIMITS.batchComparisons),
  summaries: realNarrativeReportCaptureSchema.optional(),
  settings: reportSettingsCaptureSchema.optional(),
}).superRefine((response, context) => {
  validateCollection(response.targets, response.comparisons, 'real', context)
  validateResources(response, REPORT_LIMITS.maxBatchBytes, context)
  if (response.settings && response.comparisons.length > response.settings.policy.batchComparisons) {
    issue(context, 'The report response exceeds the captured comparison batch limit.')
  }
})

export function parseRealReportBatchResponse(value: unknown): RealReportBatchResponse {
  assertReportResourceLimits(value, REPORT_LIMITS.maxBatchBytes)
  return realReportBatchResponseSchema.parse(value)
}

const reportInputSchema: z.ZodType<AnalysisReportInput> = z.strictObject({
  dataKind: z.literal('real'),
  workspaceId: id,
  run: z.strictObject({ id, name: label, createdAt: timestamp }),
  capture: z.strictObject({
    startedAt: timestamp, completedAt: timestamp,
    summaries: reportNarrativeCaptureSchema.optional(), settings: reportSettingsCaptureSchema.optional(),
  }),
  generatedAt: timestamp,
  targets: z.array(reportTargetSchema).min(1).max(REPORT_LIMITS.maxTargets),
  comparisons: z.array(reportComparisonSchema).min(1).max(REPORT_LIMITS.maxComparisons),
}).superRefine((input, context) => {
  if (Date.parse(input.capture.startedAt) > Date.parse(input.capture.completedAt) || Date.parse(input.capture.completedAt) > Date.parse(input.generatedAt)) {
    issue(context, 'The capture interval and generation timestamp must be in chronological order.')
  }
  validateCollection(input.targets, input.comparisons, input.dataKind, context)
})

export function createReportCitation(citation: Citation, source: ReportCitationSource): ReportCitation {
  if (citation.documentId !== source.id || citation.documentVersion !== source.version) {
    throw new Error('Citation source does not match the saved document ID and version.')
  }
  const normalized = {
    documentId: citation.documentId, documentVersion: citation.documentVersion, paragraphId: citation.paragraphId,
    page: citation.page, heading: citation.heading, quote: citation.quote,
    sourceTitle: source.title, pagination: source.pagination,
  }
  return reportCitationSchema.parse({ ...normalized, locator: citationLocator(normalized) })
}

export function countReportStatuses(comparisons: readonly Pick<ReportComparison, 'status' | 'overall'>[]): ReportStatusCounts {
  const counts: ReportStatusCounts = { total: comparisons.length, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0, scored: 0, withheld: 0 }
  for (const comparison of comparisons) {
    counts[comparison.status]++
    if (comparison.status === 'complete') {
      if (comparison.overall.status === 'available') counts.scored++
      if (comparison.overall.status === 'withheld') counts.withheld++
    }
  }
  return counts
}

function buildGroup(target: ReportTarget, comparisons: ReportComparison[], policy: ReportPolicy): ReportGroup {
  const ordered = [...comparisons].sort((left, right) => {
    const leftScore = left.status === 'complete' && left.overall.status === 'available' ? left.overall.score : null
    const rightScore = right.status === 'complete' && right.overall.status === 'available' ? right.overall.score : null
    if (leftScore === null) return rightScore === null ? left.index - right.index : 1
    if (rightScore === null) return -1
    return rightScore - leftScore || left.index - right.index
  })
  const scored = ordered.filter(comparison => comparison.status === 'complete' && comparison.overall.status === 'available')
  const cutoff = scored[Math.min(policy.highlightCount, scored.length) - 1]
  const cutoffScore = cutoff?.overall.status === 'available' ? cutoff.overall.score : null
  const eligible = scored.filter(comparison => comparison.overall.status === 'available' && cutoffScore !== null && comparison.overall.score >= cutoffScore)
  const highlightedComparisonIds = eligible.slice(0, policy.maxHighlights).map(comparison => comparison.id)
  const highlighted = new Set(highlightedComparisonIds)
  let lastScore: number | null = null
  let lastRank = 0
  return {
    target,
    comparisons: ordered.map((comparison, index) => {
      let rank: number | null = null
      if (comparison.status === 'complete' && comparison.overall.status === 'available') {
        if (comparison.overall.score !== lastScore) lastRank = index + 1
        lastScore = comparison.overall.score
        rank = lastRank
      }
      const byId = new Map(comparison.criteria.map(criterion => [criterion.criterionId, criterion]))
      return { ...comparison, criteria: comparison.status === 'complete' ? target.criteria.map(criterion => byId.get(criterion.id)!) : [],
        rank, highlighted: highlighted.has(comparison.id) }
    }),
    counts: countReportStatuses(ordered),
    highlightedComparisonIds,
    cutoffScore,
    additionalCutoffTies: Math.max(0, eligible.length - highlightedComparisonIds.length),
    highlightLimit: policy.maxHighlights,
  }
}

export function buildAnalysisReport(input: AnalysisReportInput, options: AnalysisReportBuildOptions = {}): AnalysisReport {
  assertReportResourceLimits(input)
  const source = reportInputSchema.parse(input)
  const filter = z.strictObject({ targetId: id.optional() }).parse(options)
  if (filter.targetId && !source.targets.some(target => target.id === filter.targetId)) throw new Error('The selected exact target is not in this saved analysis.')
  const targets = source.targets.filter(target => !filter.targetId || target.id === filter.targetId)
  const comparisons = source.comparisons.filter(comparison => !filter.targetId || comparison.targetId === filter.targetId)
  const settings = captureReportSettings(source.capture.settings)
  const limits = reportLimits(settings.policy)
  if (comparisons.length > limits.maxComparisons) {
    throw new Error(`This export exceeds the ${limits.maxComparisons}-comparison report limit. Narrow the export to one exact job/grade target; no comparisons have been omitted.`)
  }
  assertReportResourceLimits({ ...source, targets, comparisons, capture: { ...source.capture, settings } }, limits.maxInputBytes)
  const counts = countReportStatuses(comparisons)
  if (!counts.complete) throw new Error('At least one comparison in the selected scope must be complete before exporting. A completed result with a withheld score is eligible.')
  const report: AnalysisReport = {
    schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
    dataKind: source.dataKind,
    workspaceId: source.workspaceId,
    run: source.run,
    capture: { ...source.capture, settings },
    generatedAt: source.generatedAt,
    scope: { targetId: filter.targetId ?? null },
    candidateCount: new Set(comparisons.map(comparison => comparison.candidate.id)).size,
    counts,
    partial: counts.complete !== counts.total,
    notices: buildReportNotices(counts, settings.policy.additionalFooter),
    groups: targets.map(target => buildGroup(target, comparisons.filter(comparison => comparison.targetId === target.id), settings.policy)),
  }
  assertReportResourceLimits(report, limits.maxInputBytes)
  if (report.capture.summaries !== undefined) requireReportNarratives(report)
  return report
}
