import { z } from 'zod'
import type { RealAnalysisNarrativeRecord } from '../../src/domain/analysis-narratives'
import {
  SUMMARY_PIPELINE_VERSION, publishSummaryDraftInputSchema,
  type AnalysisSummaryHistoryEntry, type AnalysisSummarySubject, type PublishSummaryDraftInput,
} from '../../src/domain/analysis-summary-history'
import { conflict, invalidRequest, preconditionRequired } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { isUuid } from '../jobs/validation'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError } from '../store'
import {
  assertAnalysisRunWritable, assertAnalysisWorkspaceActive, fencedSummaryActionBlobs, withManualSummaryPublication,
  type SummaryActionWriteAuthorization,
} from './guards'
import { parseAnalysisNarrativeArtifact, readAnalysisNarrativePublication } from './narrative-artifacts'
import {
  analysisNarrativeCanWork, narrativeGenerationId, narrativeTimestamp, newCandidateNarrative, newTargetNarrative,
} from './narrative-records'
import { loadAnalysisNarrative, readAnalysisSummaries } from './narratives'
import { analysisBlobReference, parseAnalysisJson } from './snapshots'
import { readSummarySubject, walkSummaryHistory } from './summary-history'
import type { AnalysisTransaction, RealAnalysesDeps } from './store'
import {
  analysisHash, analysisNarrativeBlobName, analysisNarrativeId, analysisNarrativeRequestBlobName, analysisNarrativeTargetIdSchema,
  analysisSummaryActionBlobName, assertAnalysis, isAnalysisId, parseAnalysisEntity,
} from './validation'

const actionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  runId: z.string().refine(value => isAnalysisId(value, 'run')), targetId: analysisNarrativeTargetIdSchema,
  kind: z.enum(['candidate', 'target']), subjectId: z.string().min(1).max(200),
  action: z.enum(['publish', 'retry']), requestId: z.string().uuid(), requestedBy: z.string().min(1).max(200),
  expectedEtag: z.string().min(1).max(1024), createdAt: z.iso.datetime({ precision: 3 }),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generationId: z.string().uuid(), previousGenerationId: z.string().uuid().nullable(),
  selection: publishSummaryDraftInputSchema.optional(),
  resultRevisionId: z.string().uuid().optional(),
})
type ActionReceipt = z.infer<typeof actionReceiptSchema>
type SubjectState = Awaited<ReturnType<typeof readSummarySubject>>

function headers(requestId: string, expected: string, actor: string): void {
  if (!expected) throw preconditionRequired('If-Match must contain the narrative record ETag returned by summary history.')
  if (typeof expected !== 'string' || expected.trim() !== expected || expected === '*' || expected.startsWith('W/') ||
    expected.length > 1024 || /[,\r\n]/.test(expected)) throw invalidRequest('If-Match must contain one exact narrative ETag.')
  if (typeof requestId !== 'string' || !isUuid(requestId) || typeof actor !== 'string' || !actor.trim() || actor.length > 200) {
    throw invalidRequest('A UUID Idempotency-Key and authenticated actor are required.')
  }
}

function assertWritable(state: SubjectState): void {
  assertAnalysisRunWritable(state.inventory.run.record)
  if (!analysisNarrativeCanWork(state.inventory.run.record) || state.inventory.run.record.narrativeRequestId) {
    throw conflict('Finish cancellation or pending summary scheduling before changing one summary.')
  }
  if (!state.binding) throw conflict('This summary has no completed saved assessment to summarize.')
}

async function selectedDraft(
  deps: RealAnalysesDeps, state: SubjectState, input: PublishSummaryDraftInput,
): Promise<AnalysisSummaryHistoryEntry> {
  if (!state.current?.record.history) throw conflict('This summary has no recorded draft history. Retry it to capture new drafts.')
  for await (const { entry } of walkSummaryHistory(deps, state.current.record)) {
    if (entry.scopeId !== 'final' || entry.generationId !== input.generationId || entry.round !== input.round) continue
    if (!entry.draft) continue
    if (entry.outputSha256 !== input.outputSha256) {
      throw conflict('This round has a newer saved draft or review. Reload its history before publishing.')
    }
    if (entry.inputFingerprint !== state.inputFingerprint || entry.sourceFingerprint !== state.inputFingerprint) {
      throw conflict('The selected draft belongs to older saved inputs. Retry this summary rather than rebinding an old draft.')
    }
    assertAnalysis(entry.generation && entry.modelCallId && entry.draft.kind !== 'reduction',
      'A final summary draft must retain its original model provenance.')
    return entry
  }
  throw conflict('The selected final draft is not in this exact summary history.')
}

function verifyReceipt(
  receipt: ActionReceipt, workspaceId: string, runId: string, subject: AnalysisSummarySubject,
  action: ActionReceipt['action'], requestId: string, expected: string, actor: string, recordId: string, selection?: PublishSummaryDraftInput,
): void {
  if (receipt.workspaceId !== workspaceId || receipt.runId !== runId || receipt.kind !== subject.kind ||
    receipt.subjectId !== subject.subjectId || receipt.action !== action || receipt.requestId !== requestId ||
    receipt.expectedEtag !== expected || receipt.requestedBy !== actor ||
    analysisHash(receipt.selection ?? null) !== analysisHash(selection ?? null) ||
    recordId !== analysisNarrativeId(subject.kind, runId, subject.subjectId, receipt.resultRevisionId) ||
    receipt.generationId !== narrativeGenerationId(requestId, recordId)) {
    throw conflict('This Idempotency-Key already identifies a different summary action, actor, draft, or revision.')
  }
}

function committed(state: SubjectState, receipt: ActionReceipt): boolean {
  return state.current?.record.requestId === receipt.requestId && state.current.record.generationId === receipt.generationId &&
    state.current.record.requestedBy === receipt.requestedBy
}

function audit(receipt: ActionReceipt, selected?: AnalysisSummaryHistoryEntry): void {
  const event = {
    component: 'score-analysis-narrative', timestamp: receipt.createdAt,
    event: receipt.action === 'publish' ? 'summary-manual-publication' : 'summary-retry',
    pipelineVersion: SUMMARY_PIPELINE_VERSION, workspaceId: receipt.workspaceId, runId: receipt.runId,
    kind: receipt.kind, subjectId: receipt.subjectId, generationId: receipt.generationId, requestId: receipt.requestId,
    ...(selected ? { round: selected.round, draftGenerationId: selected.generationId,
      attemptId: selected.attemptId, modelCallId: selected.modelCallId, outcome: selected.review?.outcome ?? 'not-reviewed',
      issueCount: selected.review?.issues.length ?? 0, issueCodes: [...new Set(selected.review?.issues.map(issue => issue.code) ?? [])] } : {}),
  }
  try { console.info(JSON.stringify(event)) } catch {
    console.error('Analysis summary audit sink failed.')
  }
}

async function executeSummaryAction(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject,
  action: ActionReceipt['action'], requestId: string, expected: string, actor: string,
  now: () => Date, selection?: PublishSummaryDraftInput,
) {
  headers(requestId, expected, actor)
  requestId = requestId.toLowerCase()
  if (selection) {
    const parsed = publishSummaryDraftInputSchema.safeParse(selection)
    if (!parsed.success) throw invalidRequest('Select one saved generation, round, and output hash.')
    selection = parsed.data
  }
  await assertAnalysisWorkspaceActive(deps.store, workspaceId)
  const state = await readSummarySubject(deps, workspaceId, runId, subject)
  assertWritable(state)
  const id = state.recordId
  const name = analysisSummaryActionBlobName(workspaceId, runId, requestId)
  let stored = await deps.blobs.read(name)
  let receipt = stored ? actionReceiptSchema.parse(parseAnalysisJson(stored)) : undefined
  if (receipt) {
    verifyReceipt(receipt, workspaceId, runId, subject, action, requestId, expected, actor, id, selection)
    if (committed(state, receipt)) return { summaries: await readAnalysisSummaries(deps, workspaceId, runId, receipt.targetId) }
  } else if (await deps.blobs.read(analysisNarrativeRequestBlobName(workspaceId, runId, requestId))) {
    throw conflict('This Idempotency-Key already belongs to a summary generation request.')
  }
  if (state.etag !== expected) throw conflict('This summary changed. Reload its history before publishing or retrying.')
  const generationId = narrativeGenerationId(requestId, id)
  if (state.current?.record.generationId === generationId) throw conflict('Use a new request key for a new summary generation.')
  const selected = action === 'publish' ? await selectedDraft(deps, state, selection!) : undefined
  const timestamp = narrativeTimestamp(state.inventory.run.record,
    new Date(Math.max(now().getTime(), Date.parse(state.current?.record.updatedAt ?? state.inventory.run.record.updatedAt))).toISOString())
  const planned: ActionReceipt = {
    schemaVersion: 1, workspaceId, runId, targetId: state.target.target.summary.id, ...subject, action, requestId,
    requestedBy: actor, expectedEtag: expected, createdAt: timestamp,
    manifestSha256: state.inventory.run.record.manifest.sha256, inputFingerprint: state.inputFingerprint!,
    generationId, previousGenerationId: state.current?.record.generationId ?? null, ...(selection ? { selection } : {}),
    ...(state.pair?.comparison?.resultRevision ? { resultRevisionId: state.pair.comparison.resultRevision.id } : {}),
  }
  const assertCurrent = async () => {
    assertWorkspaceMutationLease(workspaceId)
    await assertAnalysisWorkspaceActive(deps.store, workspaceId)
    const latest = await readSummarySubject(deps, workspaceId, runId, subject)
    assertWritable(latest)
    if (latest.etag !== expected || latest.inputFingerprint !== planned.inputFingerprint ||
      latest.inventory.run.record.manifest.sha256 !== planned.manifestSha256) {
      throw conflict('This summary or its exact saved inputs changed before the action could be committed.')
    }
  }
  const authorization: SummaryActionWriteAuthorization = {
    action, ...subject, recordId: id, etag: state.current?.etag, generationId: state.current?.record.generationId,
    requestId, ...(selected ? { publicationAttemptId: selected.attemptId } : {}),
    ...(planned.resultRevisionId ? { resultRevisionId: planned.resultRevisionId } : {}),
  }
  const blobs = fencedSummaryActionBlobs(deps, workspaceId, runId, authorization, assertCurrent)
  if (!stored) {
    await assertCurrent()
    try { stored = (await blobs.putImmutable(name, Buffer.from(JSON.stringify(planned)), 'application/json')).blob } catch (error) {
      stored = await deps.blobs.read(name)
      if (!stored) throw error
    }
    receipt = actionReceiptSchema.parse(parseAnalysisJson(stored))
  }
  assertAnalysis(receipt, 'The immutable summary action receipt is missing.')
  verifyReceipt(receipt, workspaceId, runId, subject, action, requestId, expected, actor, id, selection)
  if (receipt.inputFingerprint !== planned.inputFingerprint || receipt.manifestSha256 !== planned.manifestSha256 ||
    receipt.targetId !== planned.targetId || receipt.previousGenerationId !== planned.previousGenerationId ||
    receipt.createdAt <= (state.inventory.run.record.narrativeCancelledAt ?? '')) {
    throw conflict('This reserved summary action predates changed inputs or cancellation. Reload and use a new request key.')
  }
  const request = { requestId, requestedAt: receipt.createdAt, requestedBy: actor, reason: 'all' as const }
  let record: RealAnalysisNarrativeRecord
  if (action === 'retry') {
    if (subject.kind === 'candidate') {
      assertAnalysis(state.pair?.comparison?.status === 'complete' &&
        (!state.current || state.current.record.recordType === 'analysis-candidate-narrative'), 'Candidate retry requires its exact completed comparison.')
      record = newCandidateNarrative(state.inventory.run.record, state.pair.comparison, request,
        state.current?.record.recordType === 'analysis-candidate-narrative' ? state.current.record : undefined)
    } else {
      assertAnalysis(!state.current || state.current.record.recordType === 'analysis-target-narrative', 'Target retry has an invalid work identity.')
      record = newTargetNarrative(state.inventory.run.record, state.target.target, request,
        state.current?.record.recordType === 'analysis-target-narrative' ? state.current.record : undefined)
    }
  } else {
    assertAnalysis(selected?.draft && selected.generation && selected.outputSha256 && state.current && state.binding,
      'Manual publication requires a verified saved final draft.')
    const review = selected.review
    const artifact = parseAnalysisNarrativeArtifact({
      schemaVersion: 2, dataKind: 'real', kind: subject.kind, createdAt: receipt.createdAt, generationId,
      requestId, inputFingerprint: state.inputFingerprint, humanReviewRequired: true, binding: state.binding, claims: [],
      ...(selected.draft.kind === 'candidate' ? { text: selected.draft.text, overview: selected.draft.overview }
        : { paragraphs: selected.draft.paragraphs }),
      approval: {
        kind: 'manual', approvedAt: receipt.createdAt, approvedBy: actor,
        reviewOutcome: review?.outcome ?? 'not-reviewed', issues: review?.issues ?? [],
      },
      provenance: {
        attemptId: selected.attemptId, outputSha256: selected.outputSha256, generation: selected.generation,
        correctionCount: selected.round - 1,
        groundingReviews: review ? [{
          id: review.id, inputFingerprint: review.inputFingerprint, outputSha256: review.outputSha256, provenance: review.provenance,
          outcome: review.outcome, issues: review.issues.map(issue => ({ code: issue.code, message: issue.message, references: [] })),
        }] : [],
      },
      history: state.current.record.history, ...(state.current.record.published ? { previousPublication: state.current.record.published } : {}),
    })
    const publicationName = analysisNarrativeBlobName(workspaceId, runId, subject.kind, subject.subjectId, generationId, selected.attemptId)
    let published = await deps.blobs.read(publicationName)
    if (!published) {
      await assertCurrent()
      try { published = (await blobs.putImmutable(publicationName, Buffer.from(JSON.stringify(artifact)), 'application/json')).blob } catch (error) {
        published = await deps.blobs.read(publicationName)
        if (!published) throw error
      }
    }
    const saved = parseAnalysisNarrativeArtifact(parseAnalysisJson(published))
    assertAnalysis(analysisHash(saved) === analysisHash(artifact), 'Manual publication immutable winner identifies a different approval.')
    const blob = analysisBlobReference(publicationName, published)
    record = {
      ...state.current.record, ...request, generationId, inputFingerprint: state.inputFingerprint!, updatedAt: receipt.createdAt,
      status: 'ready', attempts: 0, attemptId: selected.attemptId, summaryRound: selected.round,
      published: { blob, revision: blob.sha256, inputFingerprint: state.inputFingerprint!, generationId, publishedAt: receipt.createdAt },
    }
    delete record.lease
    delete record.nextAttemptAt
    delete record.error
    delete record.waitingFor
    await readAnalysisNarrativePublication(deps.blobs, record)
  }
  const operations: AnalysisTransaction[] = [
    state.current ? { kind: 'replace', record, etag: state.current.etag } : { kind: 'create', record },
  ]
  if (subject.kind === 'candidate') {
    const previous = await loadAnalysisNarrative(deps.store, workspaceId, analysisNarrativeId('target', runId, state.target.target.summary.id))
    assertAnalysis(!previous || previous.record.recordType === 'analysis-target-narrative', 'Dependent target summary has an invalid identity.')
    const next = newTargetNarrative(state.inventory.run.record, state.target.target,
      { ...request, reason: 'comparison-changed' }, previous?.record.recordType === 'analysis-target-narrative' ? previous.record : undefined)
    operations.push(previous ? { kind: 'replace', record: next, etag: previous.etag } : { kind: 'create', record: next })
  }
  await assertCurrent()
  const latest = await readSummarySubject(deps, workspaceId, runId, subject)
  assertWritable(latest)
  if (latest.etag !== expected || latest.inputFingerprint !== receipt.inputFingerprint) throw conflict('The saved summary changed before publication.')
  const updatedAt = operations.reduce((value, operation) => operation.record.updatedAt > value ? operation.record.updatedAt : value,
    narrativeTimestamp(latest.inventory.run.record, now().toISOString()))
  operations.push({ kind: 'replace', record: { ...latest.inventory.run.record, updatedAt }, etag: latest.inventory.run.etag })
  operations.forEach(operation => parseAnalysisEntity(operation.record))
  assertWorkspaceMutationLease(workspaceId)
  try {
    const commit = () => deps.store.transact(workspaceId, operations)
    if (action === 'publish') await withManualSummaryPublication(state.current!.record, record, commit)
    else await commit()
  } catch (error) {
    const winner = await readSummarySubject(deps, workspaceId, runId, subject)
    if (!committed(winner, receipt)) {
      if (error instanceof StoreConflictError) throw conflict('The summary changed before the action could be saved. Reload its history.')
      throw error
    }
  }
  audit(receipt, selected)
  return { summaries: await readAnalysisSummaries(deps, workspaceId, runId, receipt.targetId) }
}

export function publishAnalysisSummaryDraft(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject, input: PublishSummaryDraftInput,
  requestId: string, expected: string, actor: string, now: () => Date = () => new Date(),
) {
  return executeSummaryAction(deps, workspaceId, runId, subject, 'publish', requestId, expected, actor, now, input)
}

export function retryAnalysisSummary(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, subject: AnalysisSummarySubject,
  requestId: string, expected: string, actor: string, now: () => Date = () => new Date(),
) {
  return executeSummaryAction(deps, workspaceId, runId, subject, 'retry', requestId, expected, actor, now)
}
