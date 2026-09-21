import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ANALYSIS_CORRECTION_LIMITS, ANALYSIS_CORRECTION_POLICY_VERSION,
  type AnalysisCorrectionHistoryEntry, type AnalysisCorrectionHistoryPage, type AnalysisCorrectionHistoryReference,
  type AnalysisCorrectionInput, type AnalysisCorrectionPreview, type AnalysisCorrectionProposal,
  type AnalysisCorrectionResponse, type RealAnalysisCorrectionRecord,
} from '../../src/domain/analysis-corrections'
import type { RealAnalysisAssessmentOutput, RealAnalysisResult, RealAnalysisResultSummary } from '../../src/domain/real-analyses'
import { conflict, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { isUuid } from '../jobs/validation'
import { StoreConflictError } from '../store'
import { analysisIsRemoved, assertAnalysisRunWritable, assertAnalysisWorkspaceActive, fencedAnalysisBlobs } from './guards'
import { loadAnalysisComparison, loadAnalysisRun } from './lifecycle'
import { narrativeTimestamp } from './narrative-records'
import { analysisBlobReference, parseAnalysisJson, putAnalysisJson, readAnalysisBlob, readAnalysisResult, readAnalysisSnapshots } from './snapshots'
import type { RealAnalysesDeps } from './store'
import {
  analysisCorrectionHistoryBlobName, analysisCorrectionId, analysisCorrectionProposalBlobName,
  analysisHash, assertAnalysis, calculateAnalysisSummary, isAnalysisId, parseAnalysisEntity,
} from './validation'
import {
  analysisCorrectionFingerprint, analysisCorrectionInputSchema, buildEvidenceCorrectionAssessment,
  correctionBlockedReason, parseAnalysisCorrectionHistoryEntry, parseAnalysisCorrectionProposal,
} from './correction-validation'
import { analysisCorrectionCanWork, loadAnalysisCorrection, projectAnalysisComparison } from './current-results'
import { analysisCorrectionSummary } from './corrections'
import { readAnalysisCorrectionHistoryEntry } from './correction-artifacts'

function exactEtag(value: string): void {
  if (!value) throw preconditionRequired('Use the exact ETag returned by the correction preview or current correction.')
  if (typeof value !== 'string' || value.trim() !== value || value === '*' || value.startsWith('W/') ||
    value.length > 1024 || /[,\r\n]/.test(value)) throw invalidRequest('If-Match must contain one exact correction ETag.')
}
function assessment(result: RealAnalysisResult): RealAnalysisAssessmentOutput {
  return { criteria: result.criteria, qualifications: result.qualifications, summary: result.summary, limitations: result.limitations }
}
function summary(result: RealAnalysisResult): RealAnalysisResultSummary {
  return { completion: result.completion, overall: result.overall, coverage: result.coverage }
}
function scope(workspaceId: string, runId: string, comparisonId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !isAnalysisId(runId, 'run') || !isAnalysisId(comparisonId, 'comparison')) {
    throw notFound('The saved comparison was not found.')
  }
}

export class AnalysisCorrectionService {
  constructor(private readonly deps: RealAnalysesDeps, private readonly now: () => Date = () => new Date()) {}

  private async context(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal) {
    scope(workspaceId, runId, comparisonId)
    const [run, original, correction] = await Promise.all([
      loadAnalysisRun(this.deps.store, workspaceId, runId, signal),
      loadAnalysisComparison(this.deps.store, workspaceId, runId, comparisonId, signal),
      loadAnalysisCorrection(this.deps.store, workspaceId, runId, comparisonId, signal),
    ])
    if (!run || analysisIsRemoved(run.record.lifecycle) || !original) throw notFound('The saved comparison is unavailable or being removed.')
    assertAnalysis(!correction || correction.record.manifestSha256 === run.record.manifest.sha256,
      'Correction belongs to another frozen manifest.')
    const current = projectAnalysisComparison(original.record, correction?.record)
    return { run, original, correction, current, etag: correction?.etag ?? original.etag }
  }

  private async writable(state: Awaited<ReturnType<AnalysisCorrectionService['context']>>, requireCapability = true) {
    if (requireCapability && !this.deps.evidenceCorrectionsEnabled) throw unavailable('Evidence corrections are not enabled on this deployment.')
    try {
      await assertAnalysisWorkspaceActive(this.deps.store, state.run.record.workspaceId)
      assertAnalysisRunWritable(state.run.record)
    } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('This analysis or workspace is archived, removed, or changed. Reload before correcting.')
      throw error
    }
    if (!analysisCorrectionCanWork(state.run.record)) throw conflict('Finish cancellation or pending summary scheduling before requesting a correction.')
  }

  async state(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal) {
    const state = await this.context(workspaceId, runId, comparisonId, signal)
    return { correction: state.correction ? analysisCorrectionSummary(state.correction, state.run.record) : null }
  }

  async preview(workspaceId: string, runId: string, comparisonId: string, signal?: AbortSignal): Promise<AnalysisCorrectionPreview> {
    const state = await this.context(workspaceId, runId, comparisonId, signal)
    if (!state.current.result || !state.original.record.result) throw conflict('Only a successfully completed saved assessment can be reviewed for evidence gaps.')
    const snapshots = await readAnalysisSnapshots(this.deps.blobs, state.run.record, state.current, signal)
    const result = await readAnalysisResult(this.deps.blobs, state.run.record, state.current, snapshots, signal)
    assertAnalysis(result, 'The completed assessment is missing.')
    const target = snapshots.targetSnapshot
    const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
    const criteria: AnalysisCorrectionPreview['criteria'] = result.criteria.flatMap(row => {
      if (row.evidenceStatus !== 'not-assessed') return []
      const definition = rubric.criteria.find(item => item.id === row.criterionId)
      assertAnalysis(definition, 'The saved criterion has no frozen definition.')
      const blockedReason = correctionBlockedReason(result, target, row)
      return [{
        criterionId: row.criterionId, label: definition.label, weight: row.weight, rationale: row.rationale,
        limitation: row.limitation, eligible: blockedReason === null, blockedReason,
      }]
    })
    const criterionIds = criteria.filter(row => row.eligible).map(row => row.criterionId)
    const proposed = criterionIds.length ? buildEvidenceCorrectionAssessment(result, target, criterionIds) : null
    const latest = await this.context(workspaceId, runId, comparisonId, signal)
    if (latest.etag !== state.etag || latest.current.result?.sha256 !== state.current.result.sha256) {
      throw conflict('This result changed while its preview was being prepared. Reload the preview.')
    }
    return {
      dataKind: 'real', workspaceId, runId, comparisonId, etag: state.etag,
      resultSha256: state.current.result.sha256, originalResultSha256: state.original.record.result.sha256,
      policyVersion: ANALYSIS_CORRECTION_POLICY_VERSION, before: summary(result),
      after: proposed ? calculateAnalysisSummary(proposed.criteria, proposed.qualifications, proposed.limitations) : null,
      criteria, criterionIds, correction: state.correction ? analysisCorrectionSummary(state.correction, state.run.record) : null,
    }
  }

  private async historyEntry(
    workspaceId: string, runId: string, comparisonId: string, reference: AnalysisCorrectionHistoryReference, signal?: AbortSignal,
  ): Promise<AnalysisCorrectionHistoryEntry> {
    return readAnalysisCorrectionHistoryEntry(this.deps.blobs, workspaceId, runId, comparisonId, reference, signal)
  }

  private async close(
    workspaceId: string, runId: string, comparisonId: string, expected: string,
  ): Promise<AnalysisCorrectionResponse> {
    exactEtag(expected)
    const state = await this.context(workspaceId, runId, comparisonId)
    await this.writable(state, false)
    const work = state.correction
    if (!work) throw conflict('This comparison has no correction to cancel.')
    if (work.etag !== expected) throw conflict('This correction changed. Reload its status before cancelling.')
    if (work.record.status === 'ready') throw conflict('A published correction cannot be cancelled or overwritten.')
    if (work.record.history && ['failed', 'cancelled'].includes(work.record.status)) {
      const last = await this.historyEntry(workspaceId, runId, comparisonId, work.record.history)
      if (last.requestId === work.record.requestId && last.attemptId === work.record.attemptId &&
        last.outcome === work.record.status) return { requestId: work.record.requestId, correction: analysisCorrectionSummary(work, state.run.record) }
    }
    const timestamp = narrativeTimestamp(state.run.record,
      [this.now().toISOString(), work.record.updatedAt].sort().at(-1)!)
    const id = randomUUID()
    const entry: AnalysisCorrectionHistoryEntry = {
      schemaVersion: 1, dataKind: 'real', workspaceId, runId, comparisonId, id, createdAt: timestamp,
      requestId: work.record.requestId, ...(work.record.attemptId ? { attemptId: work.record.attemptId } : {}),
      outcome: work.record.status === 'failed' ? 'failed' : 'cancelled', proposal: work.record.proposal,
      ...(work.record.error ? { error: work.record.error } : {}), ...(work.record.history ? { previous: work.record.history } : {}),
    }
    parseAnalysisCorrectionHistoryEntry(entry)
    const assertCurrent = async () => {
      const current = await this.context(workspaceId, runId, comparisonId)
      await this.writable(current, false)
      if (current.etag !== expected) throw conflict('This correction changed before cancellation could be saved.')
    }
    const blob = await putAnalysisJson(fencedAnalysisBlobs(this.deps, workspaceId, runId, undefined, assertCurrent),
      analysisCorrectionHistoryBlobName(workspaceId, runId, comparisonId, work.record.requestId, id), entry)
    const record: RealAnalysisCorrectionRecord = {
      ...work.record, status: entry.outcome === 'failed' ? 'failed' : 'cancelled', updatedAt: timestamp,
      history: { id, createdAt: timestamp, blob },
    }
    delete record.lease
    delete record.nextAttemptAt
    for (let race = 0; race < 8; race++) {
      const current = await this.context(workspaceId, runId, comparisonId)
      await this.writable(current, false)
      if (current.correction?.record.history?.id === id) {
        return { requestId: record.requestId, correction: analysisCorrectionSummary(current.correction, current.run.record) }
      }
      if (current.etag !== expected) throw conflict('This correction changed before cancellation could be committed.')
      record.updatedAt = [timestamp, current.run.record.updatedAt].sort().at(-1)!
      try {
        await this.deps.store.transact(workspaceId, [
          { kind: 'replace', record, etag: expected },
          { kind: 'replace', record: { ...current.run.record, updatedAt: record.updatedAt }, etag: current.run.etag },
        ])
      } catch (error) {
        const latest = await loadAnalysisCorrection(this.deps.store, workspaceId, runId, comparisonId)
        if (latest?.record.history?.id === id) return { requestId: record.requestId, correction: analysisCorrectionSummary(latest, current.run.record) }
        if (error instanceof StoreConflictError) continue
        throw error
      }
      const saved = await loadAnalysisCorrection(this.deps.store, workspaceId, runId, comparisonId)
      assertAnalysis(saved?.record.history?.id === id, 'Correction cancellation was not durably saved.')
      return { requestId: record.requestId, correction: analysisCorrectionSummary(saved, current.run.record) }
    }
    throw conflict('This analysis changed too often. Reload before cancelling.')
  }

  cancel(workspaceId: string, runId: string, comparisonId: string, expected: string) {
    return this.close(workspaceId, runId, comparisonId, expected)
  }

  async request(
    workspaceId: string, runId: string, comparisonId: string, input: AnalysisCorrectionInput,
    requestId: string, expected: string, actor: string,
  ): Promise<AnalysisCorrectionResponse> {
    exactEtag(expected)
    if (typeof requestId !== 'string' || !isUuid(requestId) || typeof actor !== 'string' || !actor.trim() || actor.length > 200) {
      throw invalidRequest('A UUID Idempotency-Key and authenticated actor are required.')
    }
    const parsed = analysisCorrectionInputSchema.safeParse(input)
    if (!parsed.success) throw invalidRequest('Provide one saved result hash, unique criterion IDs, and a correction reason.')
    input = parsed.data
    requestId = requestId.toLowerCase()
    const fingerprint = analysisCorrectionFingerprint(workspaceId, runId, comparisonId, input, actor)
    let state = await this.context(workspaceId, runId, comparisonId)
    await this.writable(state)
    const replay = () => {
      if (state.correction?.record.requestId !== requestId) return undefined
      if (state.correction.record.requestFingerprint !== fingerprint) throw conflict('This request key belongs to a different correction or actor.')
      return { requestId, correction: analysisCorrectionSummary(state.correction, state.run.record) }
    }
    const completed = replay()
    if (completed) return completed
    if (state.etag !== expected) throw conflict('This correction or result changed. Reload its preview before requesting a correction.')
    if (!state.current.result || !state.original.record.result || state.current.result.sha256 !== input.resultSha256) {
      throw conflict('The preview no longer identifies this exact completed result.')
    }
    if (state.correction && ['queued', 'running'].includes(state.correction.record.status)) {
      if (analysisCorrectionCanWork(state.run.record, state.correction.record)) {
        throw conflict('This comparison already has correction work. Wait for it or cancel it explicitly.')
      }
      await this.close(workspaceId, runId, comparisonId, state.etag)
      state = await this.context(workspaceId, runId, comparisonId)
    } else if (state.correction && ['failed', 'cancelled'].includes(state.correction.record.status)) {
      await this.close(workspaceId, runId, comparisonId, state.etag)
      state = await this.context(workspaceId, runId, comparisonId)
    }
    const headEtag = state.etag
    const name = analysisCorrectionProposalBlobName(workspaceId, runId, comparisonId, requestId)
    let blob = await this.deps.blobs.read(name)
    let proposal: AnalysisCorrectionProposal
    if (blob) {
      proposal = parseAnalysisCorrectionProposal(parseAnalysisJson(blob))
    } else {
      const snapshots = await readAnalysisSnapshots(this.deps.blobs, state.run.record, state.current)
      const result = await readAnalysisResult(this.deps.blobs, state.run.record, state.current, snapshots)
      assertAnalysis(result && state.current.result && state.original.record.result && state.current.attemptId, 'Correction needs its exact completed result.')
      const blocked = input.criterionIds.map(id => {
        const row = result.criteria.find(criterion => criterion.criterionId === id)
        return row ? correctionBlockedReason(result, snapshots.targetSnapshot, row) : 'The criterion is absent from this result.'
      }).find(reason => reason !== null)
      if (blocked) throw invalidRequest(blocked)
      const criterionIds = result.criteria.filter(row => input.criterionIds.includes(row.criterionId)).map(row => row.criterionId)
      const proposed = buildEvidenceCorrectionAssessment(result, snapshots.targetSnapshot, criterionIds)
      const timestamp = narrativeTimestamp(state.run.record, [this.now().toISOString(), state.correction?.record.updatedAt ?? ''].sort().at(-1)!)
      proposal = parseAnalysisCorrectionProposal({
        schemaVersion: 1, dataKind: 'real', workspaceId, runId, comparisonId, requestId, createdAt: timestamp,
        requestFingerprint: fingerprint, expectedEtag: headEtag, manifestSha256: state.run.record.manifest.sha256,
        originalResultSha256: state.original.record.result.sha256, baseResult: state.current.result,
        baseAttemptId: state.current.attemptId, ...(state.current.resultRevision ? { baseRevision: state.current.resultRevision } : {}),
        resumeSnapshot: { snapshotId: state.current.resume.snapshotId, sha256: state.current.resume.blob.sha256 },
        targetSnapshot: { snapshotId: state.current.target.snapshotId, sha256: state.current.target.blob.sha256 },
        provenance: {
          requestId, policyVersion: ANALYSIS_CORRECTION_POLICY_VERSION, originalResultSha256: state.original.record.result.sha256,
          baseResultSha256: state.current.result.sha256, baseAssessmentSha256: result.provenance.assessmentSha256,
          criterionIds, requestedBy: actor, requestedAt: timestamp, reason: input.reason,
        },
        assessment: proposed, summary: calculateAnalysisSummary(proposed.criteria, proposed.qualifications, proposed.limitations),
      })
      const assertCurrent = async () => {
        const current = await this.context(workspaceId, runId, comparisonId)
        await this.writable(current)
        if (current.etag !== headEtag || current.current.result?.sha256 !== input.resultSha256) {
          throw conflict('The accepted result changed before this correction could be reserved.')
        }
      }
      await assertCurrent()
      try {
        blob = (await fencedAnalysisBlobs(this.deps, workspaceId, runId, undefined, assertCurrent)
          .putImmutable(name, Buffer.from(JSON.stringify(proposal)), 'application/json')).blob
      } catch (error) {
        blob = await this.deps.blobs.read(name)
        if (!blob) throw error
      }
      proposal = parseAnalysisCorrectionProposal(parseAnalysisJson(blob))
    }
    if (proposal.workspaceId !== workspaceId || proposal.runId !== runId || proposal.comparisonId !== comparisonId ||
      proposal.requestId !== requestId || proposal.requestFingerprint !== fingerprint || proposal.expectedEtag !== headEtag ||
      proposal.baseResult.sha256 !== input.resultSha256 || proposal.createdAt <= (state.run.record.narrativeCancelledAt ?? '')) {
      throw conflict('This request key is reserved for older or different work. Reload the preview and use a new request key.')
    }
    const record: RealAnalysisCorrectionRecord = {
      id: analysisCorrectionId(runId, comparisonId), recordType: 'analysis-correction', workspaceId, runId, comparisonId, dataKind: 'real',
      createdAt: state.correction?.record.createdAt ?? proposal.createdAt, updatedAt: proposal.createdAt,
      manifestSha256: proposal.manifestSha256, originalResult: state.original.record.result!,
      resumeSnapshot: proposal.resumeSnapshot, targetSnapshot: proposal.targetSnapshot,
      status: 'queued', requestId, requestFingerprint: fingerprint, requestedAt: proposal.createdAt,
      requestedBy: actor, reason: input.reason, policyVersion: ANALYSIS_CORRECTION_POLICY_VERSION,
      criterionIds: proposal.provenance.criterionIds, baseResult: proposal.baseResult, baseAttemptId: proposal.baseAttemptId,
      ...(proposal.baseRevision ? { baseRevision: proposal.baseRevision } : {}),
      proposal: analysisBlobReference(name, blob), attempts: 0, retryCount: state.correction ? state.correction.record.retryCount + 1 : 0,
      nextAttemptAt: proposal.createdAt, ...(state.correction?.record.published ? { published: state.correction.record.published } : {}),
      ...(state.correction?.record.history ? { history: state.correction.record.history } : {}),
    }
    parseAnalysisEntity(record)
    for (let race = 0; race < 8; race++) {
      state = await this.context(workspaceId, runId, comparisonId)
      await this.writable(state)
      const winner = replay()
      if (winner) return winner
      if (state.etag !== headEtag || state.current.result?.sha256 !== input.resultSha256) {
        throw conflict('This result changed before correction scheduling. Reload its preview.')
      }
      record.updatedAt = [record.updatedAt, state.run.record.updatedAt].sort().at(-1)!
      try {
        await this.deps.store.transact(workspaceId, [
          state.correction ? { kind: 'replace', record, etag: state.correction.etag } : { kind: 'create', record },
          { kind: 'replace', record: { ...state.run.record, updatedAt: record.updatedAt }, etag: state.run.etag },
        ])
      } catch (error) {
        const latest = await this.context(workspaceId, runId, comparisonId)
        if (latest.correction?.record.requestId === requestId && latest.correction.record.requestFingerprint === fingerprint) {
          return { requestId, correction: analysisCorrectionSummary(latest.correction, latest.run.record) }
        }
        if (error instanceof StoreConflictError) continue
        throw error
      }
      const saved = await loadAnalysisCorrection(this.deps.store, workspaceId, runId, comparisonId)
      assertAnalysis(saved?.record.requestId === requestId, 'Correction scheduling was not durably saved.')
      return { requestId, correction: analysisCorrectionSummary(saved, state.run.record) }
    }
    throw conflict('This analysis changed too often. Reload before requesting a correction.')
  }

  async history(workspaceId: string, runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal): Promise<AnalysisCorrectionHistoryPage> {
    const state = await this.context(workspaceId, runId, comparisonId, signal)
    if (!state.original.record.result) throw conflict('This comparison has no completed assessment history.')
    const original = await readAnalysisResult(this.deps.blobs, state.run.record, state.original.record, undefined, signal)
    assertAnalysis(original, 'The original assessment is missing.')
    const head = state.correction?.record.history
    const revision = analysisHash({ workspaceId, runId, comparisonId, history: head ?? null })
    let offset = 0
    if (continuationToken !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(continuationToken)) throw invalidRequest('Invalid correction history page token.')
      let cursor: unknown
      try { cursor = JSON.parse(Buffer.from(continuationToken, 'base64url').toString('utf8')) } catch { throw invalidRequest('Invalid correction history page token.') }
      const parsed = z.strictObject({ revision: z.string(), offset: z.number().int().min(0).max(ANALYSIS_CORRECTION_LIMITS.maxHistoryEntries) }).safeParse(cursor)
      if (!parsed.success) throw invalidRequest('Invalid correction history page token.')
      if (parsed.data.revision !== revision) throw conflict('Correction history changed. Reload its first page.')
      offset = parsed.data.offset
    }
    const entries: AnalysisCorrectionHistoryPage['entries'] = []
    const seen = new Set<string>()
    let reference = head, index = 0, bytes = state.original.record.result.bytes
    while (reference && entries.length < ANALYSIS_CORRECTION_LIMITS.historyPageSize) {
      assertAnalysis(!seen.has(reference.id) && index < ANALYSIS_CORRECTION_LIMITS.maxHistoryEntries &&
        (bytes += reference.blob.bytes) <= 128 * 1024 * 1024, 'Correction history is cyclic or exceeds its bounded read; no entries were silently omitted.')
      seen.add(reference.id)
      const entry = await this.historyEntry(workspaceId, runId, comparisonId, reference, signal)
      reference = entry.previous
      if (index++ < offset) continue
      assertAnalysis((bytes += entry.proposal.bytes) <= 128 * 1024 * 1024, 'Correction history proposals exceed the bounded read budget.')
      const proposal = parseAnalysisCorrectionProposal(parseAnalysisJson(await readAnalysisBlob(this.deps.blobs, entry.proposal, workspaceId, runId, signal)))
      assertAnalysis(proposal.workspaceId === workspaceId && proposal.runId === runId && proposal.comparisonId === comparisonId &&
        proposal.requestId === entry.requestId && proposal.manifestSha256 === state.run.record.manifest.sha256 &&
        proposal.originalResultSha256 === state.original.record.result.sha256, 'Correction history proposal belongs to other saved inputs.')
      entries.push({
        id: entry.id, createdAt: entry.createdAt, requestId: entry.requestId, outcome: entry.outcome,
        requestedBy: proposal.provenance.requestedBy, reason: proposal.provenance.reason, criterionIds: proposal.provenance.criterionIds,
        beforeResultSha256: proposal.baseResult.sha256, after: proposal.summary,
        review: entry.review ? { outcome: entry.review.outcome, issues: entry.review.issues } : null,
        error: entry.error ?? null, resultSha256: entry.result?.sha256 ?? null,
      })
    }
    if (offset > index) throw invalidRequest('Correction history page is outside this saved history.')
    const latest = await this.context(workspaceId, runId, comparisonId, signal)
    if (analysisHash(latest.correction?.record.history ?? null) !== analysisHash(head ?? null)) {
      throw conflict('Correction history changed while it was read. Reload its first page.')
    }
    return {
      dataKind: 'real', workspaceId, runId, comparisonId, originalResultSha256: state.original.record.result.sha256,
      original: summary(original), originalAssessment: assessment(original),
      correction: latest.correction ? analysisCorrectionSummary(latest.correction, latest.run.record) : null, entries,
      ...(reference ? { continuationToken: Buffer.from(JSON.stringify({ revision, offset: index })).toString('base64url') } : {}),
    }
  }
}
