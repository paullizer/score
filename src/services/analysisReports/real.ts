import { z } from 'zod'
import {
  REPORT_LIMITS, type AnalysisReport, type RealReportComparison, type RealReportTarget,
} from '../../domain/analysis-reports'
import { cloudJsonRequest } from '../cloudWorkspace'
import { getRealAnalysis, listAllRealAnalysisComparisons } from '../realAnalyses'
import { assertReportResourceLimits, buildAnalysisReport, parseRealReportBatchResponse } from './model'
import { unavailableOverallScore } from './presentation'

const id = z.string().min(1).max(1024).refine(value => value === value.trim())
const text = z.string().max(REPORT_LIMITS.maxTextCharacters)
const label = text.refine(value => value.trim().length > 0)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime({ offset: true })
const version = z.number().int().min(1).max(1_000_000)
const count = z.number().int().min(0).max(REPORT_LIMITS.maxComparisons)
const status = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled'])
const blob = z.strictObject({
  blobName: id, sha256: hash, contentType: z.literal('application/json'), bytes: z.number().int().min(1).max(24 * 1024 * 1024),
})
const resumeSelection = z.strictObject({ resumeId: id, documentId: id, documentVersion: version, documentSha256: hash })
const targetSelection = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('job'), jobId: id, rubricId: id, rubricVersion: version, rubricHash: hash,
    documentId: id, documentVersion: version, documentSha256: hash,
  }),
  z.strictObject({
    kind: z.literal('grade'), ladderId: id, grade: z.number().int().min(1).max(15),
    versionId: id, version, versionHash: hash, approvalId: id, reviewId: id, sourceSetId: id, sourceSetHash: hash,
  }),
])
const resumeSummary = z.object({
  workspaceId: id, dataKind: z.literal('real'), selection: resumeSelection,
  name: text.nullable(), role: text.nullable(), sourceLabel: label, capturedAt: timestamp,
})
const targetSummary = z.object({
  id, workspaceId: id, dataKind: z.literal('real'), kind: z.enum(['job', 'grade']),
  label, sublabel: text, rubricId: id, rubricVersion: version,
  criterionCount: z.number().int().min(1).max(REPORT_LIMITS.maxCriteriaPerTarget), selection: targetSelection,
})
const processingError = z.strictObject({ code: id, message: label, stage: label, retryable: z.boolean() })
const overall = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), score: z.number().finite().min(0).max(100) }),
  z.strictObject({
    status: z.literal('withheld'), score: z.null(),
    reason: z.enum(['unassessed-weighted-criteria', 'no-assessable-weight']), message: label,
  }),
])
const coverage = z.strictObject({
  totalCriteria: count, supported: count, partial: count, missing: count, notAssessed: count, notApplicable: count,
  assessedWeight: z.number().finite().min(0).max(100.000001), totalWeight: z.number().finite().min(0).max(100.000001),
})
const resultSummary = z.strictObject({ completion: z.enum(['assessed', 'limited']), overall, coverage })
const capturedComparison = z.object({
  id, recordType: z.literal('analysis-comparison'), workspaceId: id, dataKind: z.literal('real'), runId: id, index: count, status,
  resume: z.strictObject({ snapshotId: id, blob, summary: resumeSummary }),
  target: z.strictObject({ snapshotId: id, blob, summary: targetSummary }),
  result: blob.optional(), resultSummary: resultSummary.optional(), completedAt: timestamp.optional(),
  attemptId: z.string().uuid().optional(), error: processingError.optional(),
})
const capturedRun = z.object({
  etag: id,
  run: z.object({
    id, recordType: z.literal('analysis-run'), workspaceId: id, dataKind: z.literal('real'), name: label, createdAt: timestamp,
    status: z.enum(['initializing', 'queued', 'running', 'complete', 'partial', 'failed', 'cancelled']), manifest: blob,
    initialization: z.strictObject({ nextComparisonIndex: count, completedAt: timestamp.optional() }),
    progress: z.strictObject({
      total: count, initialized: count, queued: count, running: count, complete: count,
      failed: count, cancelled: count, scored: count, unscored: count,
    }),
  }),
  resumes: z.array(resumeSummary).min(1).max(REPORT_LIMITS.maxComparisons),
  targets: z.array(targetSummary).min(1).max(REPORT_LIMITS.maxTargets),
})
type CapturedComparison = z.infer<typeof capturedComparison>
type CapturedRun = z.infer<typeof capturedRun>

function requireSaved(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`${message} No report was produced; reload the saved analysis and retry.`)
}

function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return canonical(left) === canonical(right)
}

function unique(values: (string | number)[], description: string): void {
  requireSaved(new Set(values).size === values.length, `The captured inventory has duplicate ${description}.`)
}

function validateInventory(detail: CapturedRun, inventory: CapturedComparison[], workspaceId: string, runId: string): void {
  const { run, resumes, targets } = detail
  const total = resumes.length * targets.length
  const p = run.progress
  requireSaved(run.id === runId && run.workspaceId === workspaceId &&
    run.manifest.blobName === `${workspaceId}/${runId}/manifest.json`, 'The captured run or manifest belongs to a different analysis.')
  requireSaved(total <= REPORT_LIMITS.maxComparisons && total === p.total &&
    p.initialized <= p.total && p.initialized === run.initialization.nextComparisonIndex &&
    p.queued + p.running + p.complete + p.failed + p.cancelled === p.initialized && p.scored + p.unscored === p.complete,
  'The saved manifest selections and run progress disagree.')
  requireSaved((run.status !== 'complete' || p.complete === p.total) &&
    (run.status !== 'initializing' || p.initialized < p.total) &&
    (run.status !== 'queued' || (p.queued > 0 && p.running === 0)) &&
    (run.status !== 'running' || p.running > 0) &&
    (run.status !== 'partial' || (p.complete > 0 && p.complete < p.total && p.queued + p.running === 0)),
  'The captured run status and its saved progress disagree.')
  requireSaved(inventory.length === total && p.initialized === total && run.initialization.completedAt,
    'The captured comparison inventory is incomplete. Wait for initialization to finish.')
  unique(resumes.map(resume => resume.selection.resumeId), 'resume selections')
  unique(targets.map(target => target.id), 'target IDs')
  unique(targets.map(({ selection }) => JSON.stringify(selection.kind === 'job'
    ? [selection.kind, selection.jobId, selection.rubricId, selection.rubricVersion]
    : [selection.kind, selection.ladderId, selection.grade, selection.versionId, selection.version])), 'target selections')
  unique(inventory.map(comparison => comparison.id), 'comparison IDs')
  unique(inventory.map(comparison => comparison.index), 'comparison indexes')
  const resumeSnapshots = new Map<string, string>()
  const targetSnapshots = new Map<string, string>()
  const snapshotOwners = new Map<string, string>()
  const bindSnapshot = (
    reference: CapturedComparison['resume'] | CapturedComparison['target'], owner: string, cache: Map<string, string>,
  ) => {
    requireSaved(reference.blob.blobName === `${workspaceId}/${runId}/snapshots/${reference.snapshotId}/${reference.blob.sha256}.json`,
      'A captured snapshot reference belongs to a different analysis.')
    const previous = cache.get(owner)
    const identity = JSON.stringify([reference.snapshotId, reference.blob])
    requireSaved(previous === undefined || previous === identity, 'The inventory contains inconsistent frozen snapshot identities.')
    const previousOwner = snapshotOwners.get(reference.snapshotId)
    requireSaved(previousOwner === undefined || previousOwner === owner, 'A frozen snapshot was reused for different saved selections.')
    cache.set(owner, identity)
    snapshotOwners.set(reference.snapshotId, owner)
  }
  for (const resume of resumes) requireSaved(resume.workspaceId === workspaceId, 'The manifest contains a foreign resume.')
  for (const target of targets) {
    requireSaved(target.workspaceId === workspaceId && target.kind === target.selection.kind &&
      (target.selection.kind === 'job' ? target.rubricId === target.selection.rubricId && target.rubricVersion === target.selection.rubricVersion
        : target.rubricVersion === target.selection.version), 'The manifest contains a mismatched frozen target.')
  }
  let completed = 0
  let scored = 0
  for (const comparison of inventory) {
    const resume = resumes[Math.floor(comparison.index / targets.length)]
    const target = targets[comparison.index % targets.length]
    requireSaved(comparison.workspaceId === workspaceId && comparison.runId === runId && comparison.index < total &&
      same(comparison.resume.summary, resume) && same(comparison.target.summary, target),
    'A comparison does not match the exact manifest resume/target pair.')
    bindSnapshot(comparison.resume, `resume:${resume.selection.resumeId}`, resumeSnapshots)
    bindSnapshot(comparison.target, `target:${target.id}`, targetSnapshots)
    if (comparison.status === 'complete') {
      requireSaved(comparison.result && comparison.resultSummary && comparison.completedAt && comparison.attemptId && !comparison.error &&
        comparison.result.blobName === `${workspaceId}/${runId}/results/${comparison.id}/${comparison.attemptId}.json`,
      'A completed comparison is missing its immutable result identity.')
      const summary = comparison.resultSummary
      const c = summary.coverage
      requireSaved(c.totalCriteria === target.criterionCount &&
        c.totalCriteria === c.supported + c.partial + c.missing + c.notAssessed + c.notApplicable &&
        c.assessedWeight <= c.totalWeight + 0.000001 &&
        (summary.completion !== 'assessed' || (c.notAssessed === 0 && summary.overall.status === 'available')) &&
        (summary.overall.status !== 'available' || (c.totalWeight > 0 && Math.abs(c.assessedWeight - c.totalWeight) <= 0.000001)),
      'A captured result summary disagrees with its saved criteria or evidence coverage.')
      completed++
      if (comparison.resultSummary.overall.status === 'available') scored++
    } else {
      requireSaved(!comparison.result && !comparison.resultSummary, 'An unfinished captured comparison unexpectedly contains a result.')
      requireSaved(comparison.status !== 'failed' || comparison.error, 'A failed captured comparison has no saved processing error.')
    }
  }
  requireSaved(completed >= p.complete && scored >= p.scored && completed - scored >= p.unscored,
    'Previously completed immutable results are missing from the captured inventory.')
}

function checkTarget(target: RealReportTarget, captured: CapturedComparison): void {
  const expected = captured.target
  requireSaved(target.id === expected.summary.id && target.kind === expected.summary.kind &&
    target.label === expected.summary.label && target.sublabel === expected.summary.sublabel &&
    target.rubricId === expected.summary.rubricId && target.rubricVersion === expected.summary.rubricVersion &&
    target.criteria.length === expected.summary.criterionCount && same(target.selection, expected.summary.selection) &&
    target.snapshot.snapshotId === expected.snapshotId && target.snapshot.sha256 === expected.blob.sha256,
  'The report target does not match the captured frozen selection, rubric, or snapshot.')
}

function capturedResult(comparison: RealReportComparison, captured: CapturedComparison): RealReportComparison {
  const { candidate } = comparison
  const expected = captured.resume
  requireSaved(comparison.id === captured.id && comparison.index === captured.index && comparison.targetId === captured.target.summary.id &&
    candidate.id === expected.summary.selection.resumeId && candidate.name === expected.summary.name &&
    candidate.role === expected.summary.role && candidate.sourceLabel === expected.summary.sourceLabel &&
    candidate.documentId === expected.summary.selection.documentId && candidate.documentVersion === expected.summary.selection.documentVersion &&
    candidate.documentSha256 === expected.summary.selection.documentSha256 &&
    candidate.snapshot.snapshotId === expected.snapshotId && candidate.snapshot.sha256 === expected.blob.sha256,
  'The report comparison or candidate differs from the captured frozen identities.')
  if (captured.status === 'complete') {
    requireSaved(comparison.status === 'complete' && comparison.error === null && comparison.resultSha256 === captured.result!.sha256 &&
      same({ completion: comparison.completion, overall: comparison.overall, coverage: comparison.coverage }, captured.resultSummary),
    'The saved completed result changed or its hash and assessment summary do not match the capture.')
    return comparison
  }
  // Later completions/retries are not part of this export's captured status inventory.
  return {
    ...comparison, status: captured.status, completion: null, overall: unavailableOverallScore(captured.status),
    summary: null, coverage: null, criteria: [], qualifications: [], limitations: [], error: captured.error ?? null,
    analyzedAt: null, resultSha256: null, provenance: [],
  }
}

export async function loadRealAnalysisReport(
  workspaceId: string, runId: string,
  options: { targetId?: string; signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {},
): Promise<AnalysisReport> {
  id.parse(workspaceId)
  id.parse(runId)
  if (options.targetId !== undefined) id.parse(options.targetId)
  const cancellation = new AbortController()
  const signal = AbortSignal.any([
    cancellation.signal, AbortSignal.timeout(REPORT_LIMITS.maxGenerationMilliseconds),
    ...(options.signal ? [options.signal] : []),
  ])
  signal.throwIfAborted()
  const startedAt = new Date().toISOString()
  try {
    const rawDetail = await getRealAnalysis(workspaceId, runId, signal)
    signal.throwIfAborted()
    assertReportResourceLimits(rawDetail)
    const detail = capturedRun.parse(rawDetail)
    const inventory = (await listAllRealAnalysisComparisons(workspaceId, runId, signal, {
      maxItems: REPORT_LIMITS.maxComparisons, maxPages: REPORT_LIMITS.maxComparisons, maxBytes: REPORT_LIMITS.maxInputBytes,
    })).map(value => capturedComparison.parse(value.comparison))
    signal.throwIfAborted()
    const completedAt = new Date().toISOString()
    validateInventory(detail, inventory, workspaceId, runId)
    if (options.targetId !== undefined) requireSaved(detail.targets.some(target => target.id === options.targetId),
      'The selected exact target is not in this saved analysis.')
    const selected = inventory.filter(comparison => options.targetId === undefined || comparison.target.summary.id === options.targetId)
      .sort((left, right) => left.index - right.index)
    if (!selected.some(comparison => comparison.status === 'complete')) {
      throw new Error('At least one comparison in the selected scope must be complete before exporting. Completed results with withheld scores are eligible.')
    }
    options.onProgress?.(0, selected.length)
    const targets = new Map<string, RealReportTarget>()
    const comparisons = new Map<string, RealReportComparison>()
    const batches: CapturedComparison[][] = []
    for (let index = 0; index < selected.length; index += REPORT_LIMITS.batchComparisons) {
      batches.push(selected.slice(index, index + REPORT_LIMITS.batchComparisons))
    }
    let nextBatch = 0
    let loaded = 0
    let inputBytes = 0
    let receivedBytes = 0
    const load = async () => {
      while (nextBatch < batches.length) {
        signal.throwIfAborted()
        const batch = batches[nextBatch++]
        const query = new URLSearchParams(batch.map(comparison => ['comparisonId', comparison.id]))
        const payload = await cloudJsonRequest<unknown>(
          `/workspaces/${encodeURIComponent(workspaceId)}/analyses/${encodeURIComponent(runId)}/report-comparisons?${query}`,
          { method: 'GET', signal },
        )
        signal.throwIfAborted()
        const response = parseRealReportBatchResponse(payload)
        receivedBytes += new TextEncoder().encode(JSON.stringify(payload)).byteLength
        if (receivedBytes > REPORT_LIMITS.maxInputBytes) {
          throw new Error('The report responses exceed the input byte budget. Narrow the export to one exact job/grade target; no comparisons or evidence were omitted.')
        }
        requireSaved(response.workspaceId === workspaceId && response.runId === runId && response.comparisons.length === batch.length,
          'A report batch belongs to a different workspace/run or is missing requested comparisons.')
        const requested = new Map(batch.map(comparison => [comparison.id, comparison]))
        const batchTargets = new Map(response.targets.map(target => [target.id, target]))
        for (const comparison of response.comparisons) {
          const captured = requested.get(comparison.id)
          const target = batchTargets.get(comparison.targetId)
          requireSaved(captured && target && !comparisons.has(comparison.id), 'A report batch returned duplicate, missing, or unrequested comparisons.')
          checkTarget(target, captured)
          const previous = targets.get(target.id)
          requireSaved(!previous || same(previous, target), 'A frozen report target changed between batches.')
          const normalized = capturedResult(comparison, captured)
          if (!previous) {
            targets.set(target.id, target)
            inputBytes += new TextEncoder().encode(JSON.stringify(target)).byteLength
          }
          comparisons.set(normalized.id, normalized)
          inputBytes += new TextEncoder().encode(JSON.stringify(normalized)).byteLength
          if (inputBytes > REPORT_LIMITS.maxInputBytes) {
            throw new Error('The saved report exceeds the input byte budget. Narrow the export to one exact job/grade target; no comparisons or evidence were omitted.')
          }
        }
        loaded += batch.length
        signal.throwIfAborted()
        options.onProgress?.(loaded, selected.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(REPORT_LIMITS.maxConcurrentBatches, batches.length) }, load))
    signal.throwIfAborted()
    requireSaved(comparisons.size === selected.length, 'Required report comparisons are missing.')
    const report = buildAnalysisReport({
      dataKind: 'real', workspaceId, run: { id: detail.run.id, name: detail.run.name, createdAt: detail.run.createdAt },
      capture: { startedAt, completedAt }, generatedAt: new Date().toISOString(),
      targets: detail.targets.filter(target => targets.has(target.id)).map(target => targets.get(target.id)!),
      comparisons: selected.map(comparison => comparisons.get(comparison.id)!),
    }, { targetId: options.targetId })
    signal.throwIfAborted()
    return report
  } catch (error) {
    cancellation.abort(error)
    throw error
  }
}
