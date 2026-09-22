import { z } from 'zod'
import {
  ANALYSIS_NARRATIVE_LIMITS, ANALYSIS_NARRATIVE_SCHEMA_VERSION, analysisNarrativeIsCurrent,
  type AnalysisNarrativeReportCapture, type RealAnalysisNarrativeReportCapture,
  type ReadyAnalysisCandidateNarrative, type ReadyAnalysisTargetNarrative, type RealAnalysisSummariesResponse,
} from '../../domain/analysis-narratives'
import { REPORT_LIMITS, type ReportTargetPresentation } from '../../domain/analysis-reports'
import {
  AnalysisNarrativeValidationError, analysisNarrativeWorkHealthSchema, narrativeSentences, validateNarrativeProse,
} from '../../domain/analysis-narrative-validation'
import {
  SUMMARY_LIMITS, summaryApprovalSchema, summaryCandidateContentSchema, summaryDiagnosticSchema, summaryTargetContentSchema,
} from '../../domain/analysis-summary-history'

const id = z.string().min(1).max(1024).refine(value => value === value.trim())
const hash = z.string().regex(/^[a-f0-9]{64}$/i)
const timestamp = z.iso.datetime({ offset: true })
const text = z.string().max(REPORT_LIMITS.maxTextCharacters)
const nonempty = text.refine(value => value.trim().length > 0)
const count = z.number().int().min(0).max(REPORT_LIMITS.maxComparisons)
const scope = z.strictObject({ targetId: id.nullable() })
const comparisonStatus = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled'])
const narrativeStatus = z.enum(['missing', 'waiting', 'queued', 'running', 'ready', 'stale', 'failed', 'cancelled', 'not-required'])
const limits = ANALYSIS_NARRATIVE_LIMITS

function completeProse(value: string, minimum: number, maximum: number): boolean {
  const sentences = narrativeSentences(value)
  return !/\.{3}|\u2026/u.test(value) && sentences.length >= minimum && sentences.length <= maximum &&
    sentences.every(sentence => /[.!?]["'\u2019\u201d)]*$/u.test(sentence))
}

function realProse(value: string, context: z.RefinementCtx): void {
  try {
    if (validateNarrativeProse(value) !== value) {
      context.addIssue({ code: 'custom', message: 'Saved real narrative prose must match its normalized published text without edits.' })
    }
  } catch (error) {
    if (!(error instanceof AnalysisNarrativeValidationError)) throw error
    context.addIssue({ code: 'custom', message: error.message })
  }
}

const candidateContent = {
  text: z.string().min(1).max(limits.candidateMaxCharacters)
    .refine(value => completeProse(value, limits.candidateMinSentences, limits.candidateMaxSentences),
      'A saved candidate narrative must contain three or four complete sentences without truncation.'),
  overview: z.string().min(1).max(limits.overviewMaxCharacters)
    .refine(value => completeProse(value, limits.overviewSentences, limits.overviewSentences),
      'A saved candidate overview must be one complete sentence without truncation.'),
}
const targetContent = {
  paragraphs: z.array(z.string().min(1).max(limits.targetParagraphMaxCharacters)
    .refine(value => completeProse(value, 1, Number.MAX_SAFE_INTEGER), 'Saved overview paragraphs must contain complete prose without truncation.'))
    .min(limits.targetMinParagraphs).max(limits.targetMaxParagraphs)
    .refine(value => value.join('\n\n').length <= limits.targetMaxCharacters, 'The saved target overview exceeds its prose budget.'),
}
const realRevision = { revision: hash, inputFingerprint: hash }
const published = { ...realRevision, generationId: id, publishedAt: timestamp }
const sampleRevision = { revision: id, inputFingerprint: id, fixtureId: id, dataKind: z.literal('sample') }

const legacyCandidateNarrativeSchema = z.strictObject({ dataKind: z.literal('real'), ...published, ...candidateContent })
  .superRefine((value, context) => { realProse(value.text, context); realProse(value.overview, context) })
const legacyTargetNarrativeSchema = z.strictObject({ dataKind: z.literal('real'), ...published, ...targetContent })
  .superRefine((value, context) => { for (const paragraph of value.paragraphs) realProse(paragraph, context) })
const summaryPublication = { dataKind: z.literal('real'), ...published, summaryVersion: z.literal(2), approval: summaryApprovalSchema }
export const realCandidateNarrativeSchema = z.union([
  z.strictObject({ ...summaryPublication, ...summaryCandidateContentSchema.shape }), legacyCandidateNarrativeSchema,
])
export const realTargetNarrativeSchema = z.union([
  z.strictObject({ ...summaryPublication, ...summaryTargetContentSchema.shape }).refine(value =>
    value.paragraphs.join('\n\n').length <= SUMMARY_LIMITS.totalCharacters, 'The saved summary exceeds its resource budget.'),
  legacyTargetNarrativeSchema,
])
export const reportCandidateNarrativeSchema: z.ZodType<ReadyAnalysisCandidateNarrative> = z.union([
  realCandidateNarrativeSchema, z.strictObject({ ...sampleRevision, ...candidateContent }),
])
export const reportTargetNarrativeSchema: z.ZodType<ReadyAnalysisTargetNarrative> = z.union([
  realTargetNarrativeSchema, z.strictObject({ ...sampleRevision, ...targetContent }),
])

export const reportTargetPresentationSchema: z.ZodType<ReportTargetPresentation> = z.strictObject({
  title: nonempty, organization: text, description: nonempty, series: text, grade: text, versionLabel: nonempty,
})

const comparisonCapture = z.strictObject({
  comparisonId: id, targetId: id, status: comparisonStatus, resultSha256: hash.nullable(),
  narrative: z.strictObject(realRevision).nullable(),
})
const targetCapture = z.strictObject({ targetId: id, narrative: z.strictObject(realRevision).nullable() })

function invalid(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: 'custom', message })
}

export const realNarrativeReportCaptureSchema: z.ZodType<RealAnalysisNarrativeReportCapture> = z.strictObject({
  dataKind: z.literal('real'), scope, revision: hash, ready: z.boolean(),
  comparisons: z.array(comparisonCapture).min(1).max(REPORT_LIMITS.maxComparisons),
  targets: z.array(targetCapture).min(1).max(REPORT_LIMITS.maxTargets),
}).superRefine((capture, context) => {
  const targets = new Set(capture.targets.map(target => target.targetId))
  const ids = new Set(capture.comparisons.map(comparison => comparison.comparisonId))
  if (targets.size !== capture.targets.length || ids.size !== capture.comparisons.length) {
    invalid(context, 'Summary capture contains duplicate target or comparison pins.')
  }
  if (capture.scope.targetId !== null && (targets.size !== 1 || !targets.has(capture.scope.targetId))) {
    invalid(context, 'Summary capture does not match its exact selected target scope.')
  }
  const used = new Set<string>()
  const completed = new Set<string>()
  for (const comparison of capture.comparisons) {
    used.add(comparison.targetId)
    if (!targets.has(comparison.targetId)) invalid(context, 'A summary pin references a target outside the selected scope.')
    if (comparison.status === 'complete') {
      completed.add(comparison.targetId)
      if (!comparison.resultSha256 || (capture.ready && !comparison.narrative)) {
        invalid(context, 'A completed comparison is missing its result hash or ready narrative pin.')
      }
    } else if (comparison.resultSha256 !== null || (capture.ready && comparison.narrative !== null)) {
      invalid(context, 'An unassessed comparison cannot carry a completed result or ready narrative pin.')
    }
    if (capture.ready && (comparison.status === 'queued' || comparison.status === 'running')) {
      invalid(context, 'Selected scoring is still in progress; summaries are not ready for export.')
    }
  }
  if (used.size !== targets.size) invalid(context, 'Summary capture includes a target without its comparison pins.')
  if (capture.ready) for (const target of capture.targets) {
    if (Boolean(target.narrative) !== completed.has(target.targetId)) {
      invalid(context, 'A target with completed results needs a ready overview; an unassessed target must be not-required.')
    }
  }
})

export const reportNarrativeCaptureSchema: z.ZodType<AnalysisNarrativeReportCapture> = z.union([
  realNarrativeReportCaptureSchema,
  z.strictObject({ dataKind: z.literal('sample'), source: z.literal('fixture'), fixtureId: id, ready: z.literal(true), scope, revision: id }),
])

const summaryState = {
  status: narrativeStatus, generationId: id.nullable(), inputFingerprint: hash.nullable(), targetId: id,
  waitingFor: z.enum(['scoring', 'candidate-narratives']).nullable(),
  attempts: z.number().int().min(0), retryCount: z.number().int().min(0),
  nextAttemptAt: timestamp.nullable(), updatedAt: timestamp.nullable(),
  hasHistory: z.boolean().optional(), summaryRound: z.number().int().min(1).max(SUMMARY_LIMITS.rounds).optional(),
  workHealth: analysisNarrativeWorkHealthSchema.optional(),
  error: z.strictObject({
    code: z.enum(['invalid-input', 'stale-input', 'snapshot-unavailable', 'snapshot-invalid', 'context-limit', 'invalid-model-output',
      'invalid-citation', 'grounding-failed', 'service-unavailable', 'storage-error', 'timeout', 'internal-error', 'dependency-failed']),
    stage: z.enum(['dependencies', 'candidate-generation', 'target-generation', 'grounding', 'publication']),
    message: nonempty, retryable: z.boolean(),
    diagnostic: summaryDiagnosticSchema.optional(),
  }).nullable(),
}
const summaryCounts = z.strictObject({
  total: count, missing: count, waiting: count, queued: count, running: count, ready: count, stale: count,
  failed: count, cancelled: count, notRequired: count,
})

export const realAnalysisSummariesResponseSchema: z.ZodType<RealAnalysisSummariesResponse> = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_NARRATIVE_SCHEMA_VERSION), dataKind: z.literal('real'),
  workspaceId: id, runId: id, scope, revision: hash, etag: id, ready: z.boolean(),
  workRevision: hash.optional(),
  capture: realNarrativeReportCaptureSchema,
  scoring: z.strictObject({ total: count, initialized: count, queued: count, running: count, complete: count, failed: count, cancelled: count }),
  counts: z.strictObject({ candidates: summaryCounts, targets: summaryCounts }),
  capabilities: z.strictObject({
    canGenerate: z.boolean(),
    reason: z.enum(['read-only', 'archived', 'deleting', 'cancelling', 'service-unavailable']).nullable(),
  }),
  comparisons: z.array(z.strictObject({
    ...summaryState, kind: z.literal('candidate'), comparisonId: id, comparisonStatus,
    resultSha256: hash.nullable().optional(),
    published: realCandidateNarrativeSchema.nullable(),
  })).min(1).max(REPORT_LIMITS.maxComparisons),
  targets: z.array(z.strictObject({
    ...summaryState, kind: z.literal('target'), published: realTargetNarrativeSchema.nullable(),
  })).min(1).max(REPORT_LIMITS.maxTargets),
}).superRefine((response, context) => {
  const capture = response.capture
  if (response.scope.targetId !== capture.scope.targetId || response.revision !== capture.revision ||
    response.ready !== capture.ready || response.etag !== `"${response.revision}"`) {
    invalid(context, 'Summary response and authoritative capture scope, revision, readiness, or ETag disagree.')
  }
  const comparisons = new Map(response.comparisons.map(item => [item.comparisonId, item]))
  const targets = new Map(response.targets.map(item => [item.targetId, item]))
  if (comparisons.size !== response.comparisons.length || targets.size !== response.targets.length ||
    comparisons.size !== capture.comparisons.length || targets.size !== capture.targets.length) {
    invalid(context, 'Summary response contains duplicate, omitted, or extraneous selected-scope entries.')
  }
  const sameRevision = (left: { revision: string; inputFingerprint: string } | null, right: { revision: string; inputFingerprint: string } | null) =>
    left === null ? right === null : right !== null && left.revision === right.revision && left.inputFingerprint === right.inputFingerprint
  for (const pin of capture.comparisons) {
    const state = comparisons.get(pin.comparisonId)
    if (!state || state.targetId !== pin.targetId || state.comparisonStatus !== pin.status ||
      state.resultSha256 !== undefined && state.resultSha256 !== pin.resultSha256) {
      invalid(context, 'Candidate summary identity, scoring status, or result hash does not match its authoritative pin.')
      continue
    }
    if (response.ready && (pin.status === 'complete'
      ? !analysisNarrativeIsCurrent(state, pin.narrative?.inputFingerprint ?? null) || !sameRevision(pin.narrative, state.published)
      : state.status !== 'not-required')) {
      invalid(context, 'A required candidate narrative is missing, stale, failed, or in a different generation. Open Manage summaries and retry when ready.')
    }
  }
  for (const pin of capture.targets) {
    const state = targets.get(pin.targetId)
    if (!state) {
      invalid(context, 'A target overview is missing from the authoritative selected scope.')
      continue
    }
    if (response.ready && (pin.narrative
      ? !analysisNarrativeIsCurrent(state, pin.narrative.inputFingerprint) || !sameRevision(pin.narrative, state.published)
      : state.status !== 'not-required')) {
      invalid(context, 'A required target overview is missing, stale, failed, or in a different generation. Open Manage summaries and retry when ready.')
    }
  }
  for (const [states, counts] of [[response.comparisons, response.counts.candidates], [response.targets, response.counts.targets]] as const) {
    const actual = { total: states.length, missing: 0, waiting: 0, queued: 0, running: 0, ready: 0, stale: 0, failed: 0, cancelled: 0, notRequired: 0 }
    for (const state of states) actual[state.status === 'not-required' ? 'notRequired' : state.status]++
    for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
      if (counts[key] !== actual[key]) invalid(context, 'Saved summary counts disagree with the exhaustive selected-scope states.')
    }
  }
  if (response.ready) {
    const actual = { total: capture.comparisons.length, initialized: capture.comparisons.length, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0 }
    for (const comparison of capture.comparisons) actual[comparison.status]++
    for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
      if (response.scoring[key] !== actual[key]) invalid(context, 'Scoring counts disagree with the authoritative selected-scope pins.')
    }
  }
})
