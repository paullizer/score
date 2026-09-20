import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AnalysisNarrativeInputBinding, AnalysisNarrativeProcessingError, RealAnalysisNarrativeRecord,
} from '../../src/domain/analysis-narratives'
import {
  SUMMARY_LIMITS, summaryDraftCharacters, summaryHistoryEntrySchema, summaryHistoryPageSchema,
  summaryHistoryReferenceSchema, summaryIssueMatchesDraft, summaryStepSchema,
  type AnalysisSummaryHistoryEntry, type AnalysisSummaryHistoryPage, type AnalysisSummaryHistoryReference,
  type AnalysisSummaryStep, type AnalysisSummarySubject,
} from '../../src/domain/analysis-summary-history'
import { conflict, invalidRequest, notFound } from '../errors'
import { StoreConflictError } from '../store'
import { analysisIsRemoved, fencedAnalysisBlobs } from './guards'
import { loadAnalysisRun } from './lifecycle'
import { analysisNarrativeCanWork } from './narrative-records'
import { loadAnalysisNarrative, readAnalysisNarrativeInventory } from './narratives'
import { analysisPageCursor, analysisPageToken } from './paging'
import { analysisBlobReference, parseAnalysisJson, readAnalysisBlob } from './snapshots'
import type { RealAnalysesDeps } from './store'
import {
  analysisHash, analysisNarrativeId, analysisNarrativeTargetIdSchema, analysisSummaryHistoryBlobName,
  assertAnalysis, assertAnalysisSummaryHistoryReference, isAnalysisId, parseAnalysisEntity,
} from './validation'

const MAX_HISTORY_READS = 24_000
const MAX_HISTORY_BYTES = 128 * 1024 * 1024

export class SummaryHistoryCaptureError extends Error {
  readonly failure: AnalysisNarrativeProcessingError
  constructor() {
    super('Summary history could not be durably verified. Earlier saved history and publications were retained.')
    this.name = 'SummaryHistoryCaptureError'
    this.failure = {
      code: 'storage-error', stage: 'publication', message: this.message, retryable: true,
      diagnostic: { reason: 'history-write-failed' },
    }
  }
}

export function summarySubject(record: RealAnalysisNarrativeRecord): AnalysisSummarySubject {
  return record.recordType === 'analysis-candidate-narrative'
    ? { kind: 'candidate', subjectId: record.comparisonId } : { kind: 'target', subjectId: record.targetId }
}

function validateStep(step: AnalysisSummaryStep, kind: AnalysisSummarySubject['kind'], fingerprint: string, createdAt: string): void {
  const final = step.scopeId === 'final'
  assertAnalysis(final ? step.sourceFingerprint === fingerprint : kind === 'target',
    'Summary checkpoint scope does not match its frozen input.')
  if (step.draft) {
    assertAnalysis(step.draft.kind === (final ? kind : 'reduction') && step.generation && step.modelCallId &&
      step.outputSha256 === analysisHash(step.draft) && summaryDraftCharacters(step.draft) <= SUMMARY_LIMITS.totalCharacters,
    'Summary checkpoint must retain the exact usable draft, call, provenance, and output hash.')
  } else assertAnalysis(!step.outputSha256 && !step.generation && !step.review,
    'A checkpoint without usable output cannot claim generation or review provenance.')
  const timeValid = (value: NonNullable<AnalysisSummaryStep['generation']>) =>
    value.startedAt <= value.completedAt && value.completedAt <= createdAt
  if (step.generation) assertAnalysis(timeValid(step.generation), 'Summary generation time is outside its checkpoint.')
  if (step.review) {
    const review = step.review
    assertAnalysis(step.draft && review.inputFingerprint === step.sourceFingerprint && review.outputSha256 === step.outputSha256 &&
      timeValid(review.provenance) && step.generation!.completedAt <= review.provenance.startedAt &&
      (review.outcome === 'supported' ? review.issues.length === 0 : review.issues.length > 0),
    'Summary review does not bind the exact output and supplied saved input.')
    for (const issue of review.issues) {
      assertAnalysis(summaryIssueMatchesDraft(issue, step.draft),
      'Summary review issue does not identify a field in its saved draft.')
    }
  }
  assertAnalysis(step.phase !== 'started' || !step.draft && !step.review && !step.error,
    'A started summary checkpoint cannot invent a completed draft.')
  assertAnalysis(step.phase !== 'generated' || step.draft && !step.review && !step.error,
    'A generated checkpoint must retain an unreviewed usable draft.')
  assertAnalysis(step.phase !== 'reviewed' || step.review && !step.error,
    'A reviewed checkpoint must retain its actual review.')
  assertAnalysis(step.phase === 'failed' ? Boolean(step.error) : !step.error,
    'A failed checkpoint must retain its safe processing error.')
}

export async function readSummaryHistoryEntry(
  deps: RealAnalysesDeps, record: RealAnalysisNarrativeRecord, reference: AnalysisSummaryHistoryReference,
): Promise<AnalysisSummaryHistoryEntry> {
  const subject = summarySubject(record)
  assertAnalysisSummaryHistoryReference(reference, record.workspaceId, record.runId, subject.kind, subject.subjectId)
  const entry = summaryHistoryEntrySchema.parse(parseAnalysisJson(
    await readAnalysisBlob(deps.blobs, reference.blob, record.workspaceId, record.runId),
  ))
  assertAnalysis(entry.id === reference.id && entry.generationId === reference.generationId && entry.createdAt === reference.createdAt &&
    entry.workspaceId === record.workspaceId && entry.runId === record.runId && entry.targetId === record.targetId &&
    entry.kind === subject.kind && entry.subjectId === subject.subjectId && entry.manifestSha256 === record.manifestSha256 &&
    reference.blob.blobName === analysisSummaryHistoryBlobName(record.workspaceId, record.runId, subject.kind, subject.subjectId,
      entry.generationId, entry.attemptId, entry.id),
  'Summary history crossed its subject, manifest, generation, or attempt.')
  if (subject.kind === 'candidate' || entry.generationId === record.generationId) {
    assertAnalysis(entry.inputFingerprint === record.inputFingerprint, 'Summary checkpoint changed its saved generation input.')
  }
  validateStep(entry, subject.kind, entry.inputFingerprint, entry.createdAt)
  if (entry.previous) {
    assertAnalysisSummaryHistoryReference(entry.previous, record.workspaceId, record.runId, subject.kind, subject.subjectId)
    assertAnalysis(entry.previous.id !== entry.id && entry.previous.createdAt <= entry.createdAt,
      'Summary history predecessor does not advance chronologically.')
  }
  return entry
}

export async function writeSummaryCheckpoint(
  deps: RealAnalysesDeps, record: RealAnalysisNarrativeRecord, value: AnalysisSummaryStep,
  options: { createdAt: string; signal?: AbortSignal; assertActive: () => Promise<unknown> },
): Promise<AnalysisSummaryHistoryReference> {
  parseAnalysisEntity(record)
  const step = summaryStepSchema.parse(value)
  const subject = summarySubject(record)
  assertAnalysis(record.status === 'running' && record.attemptId && record.lease && record.inputFingerprint,
    'Summary checkpoints require the current claimed worker attempt.')
  validateStep(step, subject.kind, record.inputFingerprint, options.createdAt)
  const id = randomUUID()
  const entry = summaryHistoryEntrySchema.parse({
    ...step, schemaVersion: 1, dataKind: 'real', id, workspaceId: record.workspaceId, runId: record.runId,
    targetId: record.targetId, ...subject, generationId: record.generationId, attemptId: record.attemptId,
    inputFingerprint: record.inputFingerprint, manifestSha256: record.manifestSha256, createdAt: options.createdAt,
    ...(record.history ? { previous: record.history } : {}),
  })
  assertAnalysis(entry.createdAt >= record.updatedAt, 'Summary checkpoint cannot precede its current work state.')
  const name = analysisSummaryHistoryBlobName(record.workspaceId, record.runId, subject.kind, subject.subjectId,
    record.generationId, record.attemptId, id)
  const bytes = Buffer.from(JSON.stringify(entry))
  assertAnalysis(bytes.byteLength <= SUMMARY_LIMITS.checkpointBytes, 'Summary checkpoint exceeds its technical storage budget.')
  const assertActive = async () => {
    options.signal?.throwIfAborted()
    await options.assertActive()
    const current = await loadAnalysisNarrative(deps.store, record.workspaceId, record.id)
    if (!current || current.record.status !== 'running' || current.record.generationId !== record.generationId ||
      current.record.attemptId !== record.attemptId || current.record.lease?.owner !== record.lease?.owner ||
      current.record.inputFingerprint !== record.inputFingerprint ||
      analysisHash(current.record.history ?? null) !== analysisHash(record.history ?? null)) {
      throw new StoreConflictError('Summary checkpoint lost its worker generation, attempt, or history head.')
    }
  }
  await assertActive()
  try {
    if (record.history) await readSummaryHistoryEntry(deps, record, record.history)
    let stored
    try {
      stored = (await fencedAnalysisBlobs(deps, record.workspaceId, record.runId, options.signal, assertActive)
        .putImmutable(name, bytes, 'application/json')).blob
    } catch (error) {
      await assertActive()
      stored = await deps.blobs.read(name)
      if (!stored) throw error
    }
    const reference = summaryHistoryReferenceSchema.parse({
      id, generationId: entry.generationId, createdAt: entry.createdAt, blob: analysisBlobReference(name, stored),
    })
    const saved = await readSummaryHistoryEntry(deps, record, reference)
    assertAnalysis(analysisHash(saved) === analysisHash(entry), 'Summary checkpoint immutable winner differs from the generated checkpoint.')
    await assertActive()
    return reference
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof StoreConflictError) throw error
    throw new SummaryHistoryCaptureError()
  }
}

export async function* walkSummaryHistory(
  deps: RealAnalysesDeps, record: RealAnalysisNarrativeRecord,
): AsyncGenerator<{ entry: AnalysisSummaryHistoryEntry; reference: AnalysisSummaryHistoryReference }> {
  let reference = record.history
  const seen = new Set<string>()
  let bytes = 0
  while (reference) {
    assertAnalysis(!seen.has(reference.id) && seen.size < MAX_HISTORY_READS &&
      (bytes += reference.blob.bytes) <= MAX_HISTORY_BYTES,
    'Summary history is cyclic or exceeds this bounded read. No earlier rounds were silently omitted.')
    seen.add(reference.id)
    const entry = await readSummaryHistoryEntry(deps, record, reference)
    yield { entry, reference }
    reference = entry.previous
  }
}

function stepOf(entry: AnalysisSummaryHistoryEntry): AnalysisSummaryStep {
  return summaryStepSchema.parse(Object.fromEntries(
    Object.entries(entry).filter(([key]) => Object.hasOwn(summaryStepSchema.shape, key)),
  ))
}

export async function readSummaryGeneration(
  deps: RealAnalysesDeps, record: RealAnalysisNarrativeRecord,
): Promise<{ steps: AnalysisSummaryStep[]; seed?: AnalysisSummaryStep }> {
  const steps: AnalysisSummaryStep[] = []
  let previousGeneration = false
  for await (const { entry } of walkSummaryHistory(deps, record)) {
    if (entry.generationId === record.generationId) {
      assertAnalysis(!previousGeneration && entry.inputFingerprint === record.inputFingerprint,
        'Current summary generation has a discontinuous history or changed frozen input.')
      steps.push(stepOf(entry))
    } else {
      previousGeneration = true
      if (entry.scopeId === 'final' && entry.draft && entry.inputFingerprint === record.inputFingerprint) {
        return { steps, seed: stepOf(entry) }
      }
    }
  }
  return { steps }
}

export async function readSummarySubject(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject,
) {
  if (subject.kind !== 'candidate' && subject.kind !== 'target' ||
    (subject.kind === 'candidate' ? !isAnalysisId(subject.subjectId, 'comparison')
      : !analysisNarrativeTargetIdSchema.safeParse(subject.subjectId).success)) {
    throw notFound('The exact saved summary was not found.')
  }
  const inventory = await readAnalysisNarrativeInventory(deps, workspaceId, runId)
  const pair = subject.kind === 'candidate' ? inventory.comparisons.find(item => item.id === subject.subjectId) : undefined
  const target = inventory.targets.find(item => item.target.summary.id === (pair?.target.summary.id ?? subject.subjectId))
  if (!target || subject.kind === 'candidate' && !pair) throw notFound('The exact saved summary was not found in this run.')
  const id = analysisNarrativeId(subject.kind, runId, subject.subjectId)
  const current = await loadAnalysisNarrative(deps.store, workspaceId, id)
  if (current) assertAnalysis(current.record.runId === runId && current.record.targetId === target.target.summary.id &&
    current.record.manifestSha256 === inventory.run.record.manifest.sha256 &&
    analysisHash(current.record.targetSnapshot) === analysisHash({ snapshotId: target.target.snapshotId, sha256: target.target.blob.sha256 }),
  'Summary history work record does not match its frozen target.')
  const binding: AnalysisNarrativeInputBinding | null = subject.kind === 'candidate' ? pair!.binding
    : target.binding.comparisons.some(item => item.status === 'complete') ? target.binding : null
  const inputFingerprint = binding ? analysisHash(binding) : null
  const etag = current?.etag ?? `"${analysisHash({ id, missing: true, inputFingerprint, manifestSha256: inventory.run.record.manifest.sha256 })}"`
  return { inventory, current, pair, target, binding, etag, inputFingerprint }
}

const historyCursorSchema = z.strictObject({
  headId: z.string().uuid(), next: summaryHistoryReferenceSchema,
})

export async function readAnalysisSummaryHistory(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject, continuationToken?: string,
): Promise<AnalysisSummaryHistoryPage> {
  const scope = { workspaceId, runId, kind: 'summary-history' as const, summaryKind: subject.kind, subjectId: subject.subjectId }
  const cursor = analysisPageCursor(scope, continuationToken)
  for (let race = 0; race < 4; race++) {
    const state = await readSummarySubject(deps, workspaceId, runId, subject)
    const record = state.current?.record
    let reference = record?.history
    if (cursor) {
      let parsed: z.infer<typeof historyCursorSchema>
      try { parsed = historyCursorSchema.parse(JSON.parse(cursor)) } catch {
        throw invalidRequest('The summary history cursor is invalid.')
      }
      if (!reference || reference.id !== parsed.headId) throw conflict('Summary history changed. Reload its first page to include every checkpoint.')
      try {
        assertAnalysisSummaryHistoryReference(parsed.next, workspaceId, runId, subject.kind, subject.subjectId)
        assertAnalysis(parsed.next.createdAt <= reference.createdAt, 'Summary history cursor is newer than its captured head.')
      } catch { throw invalidRequest('The summary history cursor belongs to another subject or history capture.') }
      reference = parsed.next
    }
    const entries: AnalysisSummaryHistoryEntry[] = []
    const seen = new Set<string>()
    while (reference && entries.length < SUMMARY_LIMITS.historyPageSize) {
      assertAnalysis(!seen.has(reference.id), 'Summary history contains a repeated checkpoint.')
      seen.add(reference.id)
      const entry = await readSummaryHistoryEntry(deps, record!, reference)
      entries.push(entry)
      reference = entry.previous
    }
    const [run, latest, workspace] = await Promise.all([
      loadAnalysisRun(deps.store, workspaceId, runId),
      loadAnalysisNarrative(deps.store, workspaceId, analysisNarrativeId(subject.kind, runId, subject.subjectId)),
      deps.store.getControl(workspaceId),
    ])
    if (!run || analysisIsRemoved(run.record.lifecycle) || workspace && ['deleting', 'deleted'].includes(workspace.record.state)) {
      throw notFound('The saved analysis is being removed.')
    }
    if (run.etag !== state.inventory.run.etag || latest?.etag !== state.current?.etag) continue
    const writable = (!workspace || workspace.record.state === 'active') && analysisNarrativeCanWork(run.record) &&
      !run.record.narrativeRequestId && Boolean(state.binding)
    const next = reference ? analysisPageToken(scope, JSON.stringify({ headId: record!.history!.id, next: reference })) : undefined
    return summaryHistoryPageSchema.parse({
      schemaVersion: 1, workspaceId, runId, ...subject, etag: state.etag, inputFingerprint: state.inputFingerprint,
      entries, ...(next ? { continuationToken: next } : {}),
      capabilities: { canPublish: writable && Boolean(record?.history), canRetry: writable },
    })
  }
  throw conflict('Summary history changed while it was being read. Reload before choosing a draft.')
}
