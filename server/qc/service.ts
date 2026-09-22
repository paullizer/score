import { randomUUID } from 'node:crypto'
import type { WorkspaceRole } from '../../src/domain/cloud'
import {
  QC_LIMITS, qcBatchInputSchema, qcComparisonRefSchema, qcReviewDraftInputSchema, qcReviewInputSchema, qcReviewReady,
  type QcActor, type QcBatchRecord, type QcCapabilities, type QcComparisonContext, type QcComparisonRef,
  type QcPage, type QcPeerFeedback, type QcReviewHead, type QcReviewInput, type QcReviewSubmission, type VersionedQc,
} from '../../src/domain/quality-control'
import { workspaceCanCoordinateQc, workspaceCanReview } from '../../src/domain/workspace-permissions'
import { conflict, forbidden, notFound, unavailable } from '../errors'
import { StoreConflictError } from '../store'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import type { RealAnalysesDeps } from '../analyses/store'
import { loadAnalysisRun } from '../analyses/lifecycle'
import { readAnalysisQcDiagnostics } from '../analyses/qc-diagnostics'
import type { ProcessingSettingsProvider } from '../jobs/policy'
import type { QcDeps, QcListOptions, QcRecord, QcRequestReceipt, QcTransaction } from './store'
import {
  parseQcRecord, qcAssert, qcControlId, qcHeadId, qcId, qcInput, qcMatch, qcRequestKey, qcRunIds, qcValueHash,
} from './validation'
import { qcAnalysisControlWritable, readExactQcEvidence, readQcEvidence } from './evidence'

export interface QcCaller {
  workspaceId: string
  actor: QcActor
  role: WorkspaceRole
  applicationAdmin: boolean
}
export interface QcServiceDeps {
  qc: QcDeps
  analyses: RealAnalysesDeps
  now?: () => Date
  settings?: ProcessingSettingsProvider
  diagnostics?: (evidence: Awaited<ReturnType<typeof readQcEvidence>>) => Promise<QcComparisonContext['diagnostics']>
}

/** Callers are derived from authenticated membership by the router, never from request bodies. */
export class QcService {
  readonly store: QcDeps['store']
  readonly blobs: QcDeps['blobs']
  constructor(readonly deps: QcServiceDeps) { this.store = deps.qc.store; this.blobs = deps.qc.blobs }
  now(): string { return (this.deps.now?.() ?? new Date()).toISOString() }
  coordinator(caller: QcCaller): boolean { return workspaceCanCoordinateQc(caller.role, caller.applicationAdmin) }

  async get<T extends QcRecord['recordType']>(
    workspaceId: string, id: string, type: T,
  ): Promise<VersionedQc<Extract<QcRecord, { recordType: T }>> | undefined> {
    const value = await this.store.get(workspaceId, id)
    if (!value) return undefined
    const record = parseQcRecord(value.record)
    qcAssert(record.workspaceId === workspaceId && record.id === id && record.recordType === type && value.etag,
      'QC record lookup returned foreign data.')
    return { record, etag: value.etag } as VersionedQc<Extract<QcRecord, { recordType: T }>>
  }
  async assertRead(caller: QcCaller, runIds: string[] = []): Promise<void> {
    if (!workspaceCanReview(caller.role, caller.applicationAdmin)) throw forbidden('QC requires a reviewer, editor, owner, or member administrator.')
    for (const id of [qcControlId(), ...[...new Set(runIds)].map(qcControlId)]) {
      const control = await this.get(caller.workspaceId, id, 'qc-control')
      if (control && ['deleting', 'deleted'].includes(control.record.state)) throw notFound('This QC evidence is being removed.')
    }
    for (const runId of [...new Set(runIds)]) {
      const [run, control] = await Promise.all([
        loadAnalysisRun(this.deps.analyses.store, caller.workspaceId, runId),
        this.deps.analyses.store.getControl(caller.workspaceId, runId),
      ])
      if (!run || run.record.lifecycle?.deletingAt || run.record.lifecycle?.deletedAt ||
        control && ['deleting', 'deleted'].includes(control.record.state)) throw notFound('This saved analysis is being removed.')
    }
    const control = await this.deps.analyses.store.getControl(caller.workspaceId)
    if (control && ['deleting', 'deleted'].includes(control.record.state)) throw notFound('This workspace is being removed.')
  }
  async assertWritable(caller: QcCaller, runIds: string[] = []): Promise<void> {
    await this.assertRead(caller, runIds)
    for (const runId of [undefined, ...new Set(runIds)]) {
      const [qc, analysis] = await Promise.all([
        this.get(caller.workspaceId, qcControlId(runId), 'qc-control'),
        this.deps.analyses.store.getControl(caller.workspaceId, runId),
      ])
      if (qc && (qc.record.state !== 'active' || qc.record.cleanupPending || qc.record.cancellationPending) ||
        !qcAnalysisControlWritable(analysis)) {
        throw conflict('This QC scope is archived or has incomplete lifecycle cleanup. Restore it or finish cleanup before making changes.')
      }
      if (runId) {
        const run = await loadAnalysisRun(this.deps.analyses.store, caller.workspaceId, runId)
        if (!run || run.record.lifecycle?.archivedAt || run.record.lifecycle?.deletingAt || run.record.lifecycle?.deletedAt ||
          run.record.cancellation && !run.record.cancellation.completedAt) throw conflict('This analysis is not writable for QC.')
      }
    }
    assertWorkspaceMutationLease(caller.workspaceId)
  }
  async capabilities(caller: QcCaller, workspaceWritable = true, admissionEnabled = false): Promise<QcCapabilities> {
    await this.assertRead(caller)
    let writable = workspaceWritable
    if (writable) {
      try { await this.assertWritable(caller) } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 409) writable = false
        else throw error
      }
    }
    return {
      reviews: true, improvements: admissionEnabled && this.deps.qc.workerEnabled, admissionEnabled, applicationAdmin: caller.applicationAdmin,
      coordinator: this.coordinator(caller), writable,
      message: !admissionEnabled
        ? 'New QC reviews and improvement changes are disabled. Saved QC remains readable and accepted work can still be cancelled.'
        : !writable ? 'Archived QC is read-only.' : !this.deps.qc.workerEnabled ? 'The dedicated improvement worker is not enabled.' : null,
    }
  }
  async commit(workspaceId: string, operations: QcTransaction[], lifecycle = false, exposure = false): Promise<void> {
    for (const operation of operations) parseQcRecord(operation.record)
    assertWorkspaceMutationLease(workspaceId)
    try { await this.store.transact(workspaceId, operations, { lifecycle, exposure }) } catch (error) {
      if (error instanceof StoreConflictError) throw conflict('QC changed before this action could be saved. Reload and retry with the same request key.')
      throw error
    }
  }
  receipt(caller: QcCaller, key: string, action: string, targetId: string, value: unknown, runIds: string[]): QcRequestReceipt {
    key = qcRequestKey(key)
    return {
      id: qcId('request', caller.actor.principalId, key), recordType: 'qc-request', workspaceId: caller.workspaceId,
      createdAt: this.now(), updatedAt: this.now(), actorId: caller.actor.principalId, requestId: key,
      action, targetId, requestHash: qcValueHash({ action, targetId, value, actorId: caller.actor.principalId }),
      runIds: [...new Set(runIds)],
    }
  }
  async replay(receipt: QcRequestReceipt): Promise<boolean> {
    const value = await this.get(receipt.workspaceId, receipt.id, 'qc-request')
    if (!value) return false
    if (value.record.requestHash !== receipt.requestHash || value.record.targetId !== receipt.targetId ||
      value.record.action !== receipt.action || value.record.actorId !== receipt.actorId) {
      throw conflict('This request key was already used for another QC action or payload.')
    }
    return true
  }
  async head(caller: QcCaller, scope: QcComparisonRef) {
    return this.get(caller.workspaceId, qcHeadId(scope, caller.actor.principalId), 'qc-review')
  }
  async canSeePeers(caller: QcCaller, scope: QcComparisonRef): Promise<boolean> {
    if (this.coordinator(caller)) return true
    const head = await this.head(caller, scope)
    if (!head?.record.submittedId) return false
    const submitted = await this.get(caller.workspaceId, head.record.submittedId, 'qc-submission')
    qcAssert(submitted?.record.author.principalId === caller.actor.principalId &&
      qcValueHash(submitted.record.scope) === qcValueHash(scope) && submitted.record.headId === head.record.id,
    'QC peer gate does not match the reviewer and exact result.')
    return true
  }
  async requirePeerScopes(caller: QcCaller, scopes: QcComparisonRef[]): Promise<void> {
    await this.assertRead(caller, scopes.map(item => item.runId))
    for (const scope of scopes) {
      if (!await this.canSeePeers(caller, scope)) {
        throw forbidden('Submit your own complete review of every selected exact result before accessing its peer feedback or improvement outputs.')
      }
    }
  }
  async expose(caller: QcCaller, scopes: QcComparisonRef[]): Promise<void> {
    await this.requirePeerScopes(caller, scopes)
    const unique = new Map(scopes.map(scope => [qcValueHash(scope), scope]))
    for (const scope of unique.values()) {
      const current = await this.head(caller, scope)
      if (current?.record.peerExposedAt) continue
      const timestamp = this.now()
      const record: QcReviewHead = current ? { ...current.record, peerExposedAt: timestamp, updatedAt: timestamp } : {
        id: qcHeadId(scope, caller.actor.principalId), recordType: 'qc-review', workspaceId: caller.workspaceId,
        scope, author: caller.actor, feedback: [], submittedId: null, submissionNumber: 0,
        peerExposedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
        lastRequestId: randomUUID(), lastRequestHash: qcValueHash({ exposure: scope }),
      }
      // Exposure is audit metadata, including while archived; it never changes draft feedback.
      await this.assertRead(caller, [scope.runId])
      await this.commit(caller.workspaceId, [{
        kind: current ? 'replace' : 'create', record, ...(current ? { etag: current.etag } : {}),
      } as QcTransaction], false, true)
    }
  }
  async context(caller: QcCaller, runId: string, comparisonId: string, revision?: string): Promise<QcComparisonContext> {
    await this.assertRead(caller, [runId])
    const evidence = await readQcEvidence(this.deps.analyses, caller.workspaceId, runId, comparisonId, revision)
    const heads = await this.collect(caller.workspaceId, { recordType: 'qc-review', ...evidence.scope })
    const myReview = await this.head(caller, evidence.scope)
    await this.assertRead(caller, [runId])
    const control = await this.get(caller.workspaceId, qcControlId(), 'qc-control')
    const runControl = await this.get(caller.workspaceId, qcControlId(runId), 'qc-control')
    const diagnostics = this.deps.diagnostics ? await this.deps.diagnostics(evidence) : await (async () => {
      const saved = await readAnalysisQcDiagnostics(this.deps.analyses.blobs, {
        run: evidence.run, comparison: evidence.analysis.comparison, result: evidence.analysis.result!,
        resumeSnapshot: evidence.analysis.resumeSnapshot, targetSnapshot: evidence.analysis.targetSnapshot,
      })
      return {
        status: saved.status,
        message: saved.status === 'not-recorded'
          ? evidence.analysis.comparison.resultRevision
            ? 'Not recorded for this corrected result. Original model confidence is not fresh confidence in a changed score.'
            : 'Confidence and ambiguity were not recorded for this historical assessment.'
          : 'Model-reported certainty applying this saved rubric, not a probability of correctness or a statement about a person.',
        criteria: saved.criteria.map(row => {
          const diagnostic = 'diagnostic' in row ? row.diagnostic : undefined
          return {
            criterionId: row.criterionId, confidence: diagnostic?.confidence ?? null,
            explanation: diagnostic?.explanation ?? 'Not recorded for this rating.',
            ambiguities: diagnostic?.ambiguity.map(item => ({ kind: item.category, message: item.explanation })) ?? [],
            alternativeScores: diagnostic?.alternativeScores ?? [],
          }
        }),
      } satisfies QcComparisonContext['diagnostics']
    })()
    return {
      workspaceId: caller.workspaceId, scope: evidence.scope, analysis: evidence.analysis,
      writable: evidence.writable && (!control || control.record.state === 'active') && (!runControl || runControl.record.state === 'active'),
      isCoordinator: this.coordinator(caller), canSeePeers: await this.canSeePeers(caller, evidence.scope),
      myReview: myReview ?? null,
      submissionCount: heads.filter(value => value.record.recordType === 'qc-review' && value.record.submittedId).length,
      diagnostics,
    }
  }
  async collect(workspaceId: string, options: QcListOptions, maximum = 5000): Promise<VersionedQc<QcRecord>[]> {
    const all: VersionedQc<QcRecord>[] = []
    const tokens = new Set<string>()
    let continuationToken: string | undefined
    do {
      const page = await this.store.list(workspaceId, { ...options, limit: QC_LIMITS.pageSize, continuationToken })
      for (const item of page.items) { parseQcRecord(item.record); qcAssert(item.record.workspaceId === workspaceId); all.push(item) }
      if (all.length > maximum) throw unavailable('This QC selection exceeds a bounded inventory. Narrow the selection; nothing was truncated.')
      continuationToken = page.continuationToken
      if (continuationToken) {
        qcAssert(!tokens.has(continuationToken) && tokens.size < 1000, 'QC pagination did not advance.')
        tokens.add(continuationToken)
      }
    } while (continuationToken)
    return all
  }
  async saveReview(
    caller: QcCaller, value: unknown, key: string, expected?: string, submit = false, createOnly = false,
  ): Promise<VersionedQc<QcReviewHead>> {
    const input = qcInput(submit ? qcReviewInputSchema : qcReviewDraftInputSchema, value), { scope } = input
    await this.assertWritable(caller, [scope.runId])
    const id = qcHeadId(scope, caller.actor.principalId)
    const receipt = this.receipt(caller, key, submit ? 'submit-review' : 'save-review', id, input, [scope.runId])
    if (await this.replay(receipt)) {
      const current = await this.head(caller, scope)
      if (!current) throw notFound('The saved review was removed.')
      return current
    }
    const evidence = await readExactQcEvidence(this.deps.analyses, caller.workspaceId, scope)
    this.validateFeedback(input, evidence)
    const criterionIds = evidence.analysis.result!.criteria.map(item => item.criterionId)
    if (submit && !qcReviewReady(input.feedback, criterionIds)) {
      throw conflict('Explicit feedback for every criterion is required before submission; untouched rows are not agreement.')
    }
    const current = await this.head(caller, scope)
    if (current) {
      if (createOnly) throw conflict('A draft already exists for this result. Reload its current ETag.')
      qcMatch(current.etag, expected)
    } else if (expected) throw conflict('There is no existing draft matching that ETag.')
    const timestamp = this.now()
    const exposedAt = current?.record.peerExposedAt ?? (this.coordinator(caller) ? timestamp : null)
    const record: QcReviewHead = {
      id, workspaceId: caller.workspaceId, recordType: 'qc-review', createdAt: current?.record.createdAt ?? timestamp,
      updatedAt: timestamp, scope, author: caller.actor, feedback: input.feedback,
      submittedId: current?.record.submittedId ?? null, submissionNumber: current?.record.submissionNumber ?? 0,
      peerExposedAt: exposedAt, lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
    }
    const operations: QcTransaction[] = []
    if (submit) {
      const submitted: QcReviewSubmission = {
        id: qcId('submission', id, receipt.requestId), recordType: 'qc-submission', workspaceId: caller.workspaceId,
        headId: id, scope, author: caller.actor, createdAt: timestamp, updatedAt: timestamp,
        feedback: input.feedback, submissionNumber: record.submissionNumber + 1,
        peerIndependent: exposedAt === null && !this.coordinator(caller), peerExposedAt: exposedAt,
        requestId: receipt.requestId, requestHash: receipt.requestHash,
      }
      record.submittedId = submitted.id
      record.submissionNumber = submitted.submissionNumber
      operations.push({ kind: 'create', record: submitted })
    }
    operations.push(current ? { kind: 'replace', record, etag: current.etag } : { kind: 'create', record },
      { kind: 'create', record: receipt })
    await this.assertWritable(caller, [scope.runId])
    await this.commit(caller.workspaceId, operations)
    const saved = await this.head(caller, scope)
    qcAssert(saved, 'QC review publication could not be confirmed.')
    return saved
  }
  private validateFeedback(input: QcReviewInput, evidence: Awaited<ReturnType<typeof readQcEvidence>>): void {
    const rows = new Map(evidence.analysis.result!.criteria.map(item => [item.criterionId, item]))
    const target = evidence.analysis.targetSnapshot
    const paragraphs = new Set([
      ...evidence.analysis.resumeSnapshot.document.paragraphs,
      ...(target.kind === 'job' ? target.document : target.seed.document).paragraphs,
      ...evidence.references.flatMap(document => document.paragraphs),
    ].map(item => item.id))
    for (const item of input.feedback) {
      const criterion = rows.get(item.criterionId)
      if (!criterion || item.evidenceParagraphIds.some(id => !paragraphs.has(id))) throw conflict('Feedback contains a criterion or evidence link outside this frozen result.')
      if (item.recommendation?.kind === 'not-applicable' && criterion.evidenceStatus !== 'not-applicable' ||
        criterion.evidenceStatus === 'not-applicable' && item.recommendation?.kind === 'score') {
        throw conflict('A saved zero-weight exclusion cannot be converted to an invented numeric score or applied to another criterion.')
      }
    }
  }
  async reviewHistory(caller: QcCaller, scope: QcComparisonRef, options: Pick<QcListOptions, 'limit' | 'continuationToken'>): Promise<QcPage<QcReviewSubmission>> {
    qcInput(qcComparisonRefSchema, scope)
    await this.assertRead(caller, [scope.runId])
    await readExactQcEvidence(this.deps.analyses, caller.workspaceId, scope)
    return this.store.list(caller.workspaceId, {
      recordType: 'qc-submission', ...scope, authorId: caller.actor.principalId, ...options,
    }) as Promise<QcPage<QcReviewSubmission>>
  }
  async peers(
    caller: QcCaller, value: unknown, key: string, options: Pick<QcListOptions, 'limit' | 'continuationToken'> = {},
  ): Promise<QcPeerFeedback> {
    const scope = qcInput(qcComparisonRefSchema, value)
    await this.requirePeerScopes(caller, [scope])
    await readExactQcEvidence(this.deps.analyses, caller.workspaceId, scope)
    const receipt = this.receipt(caller, key, 'peers', qcHeadId(scope, caller.actor.principalId), scope, [scope.runId])
    await this.replay(receipt)
    await this.expose(caller, [scope])
    const page = await this.store.list(caller.workspaceId, { recordType: 'qc-review', ...scope, ...options })
    const submissions: QcReviewSubmission[] = []
    for (const value of page.items) {
      qcAssert(value.record.recordType === 'qc-review' && qcValueHash(value.record.scope) === qcValueHash(scope))
      if (!value.record.submittedId) continue
      const submission = await this.get(caller.workspaceId, value.record.submittedId, 'qc-submission')
      qcAssert(submission && submission.record.author.principalId === value.record.author.principalId &&
        submission.record.headId === value.record.id && qcValueHash(submission.record.scope) === qcValueHash(scope))
      submissions.push(submission.record)
    }
    await this.assertRead(caller, [scope.runId])
    if (!await this.replay(receipt)) await this.commit(caller.workspaceId, [{ kind: 'create', record: receipt }], false, true)
    return {
      scope, submissions, coordinatorView: this.coordinator(caller),
      ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}),
    }
  }
  async createBatch(caller: QcCaller, value: unknown, key: string): Promise<VersionedQc<QcBatchRecord>> {
    if (!this.coordinator(caller)) throw forbidden('Only QC coordinators can create shared review batches.')
    const input = qcInput(qcBatchInputSchema, value)
    const runs = [...new Set(input.comparisons.map(item => item.runId))]
    if (runs.length > 90) throw conflict('Select at most 90 distinct runs in one atomically fenced review batch.')
    await this.assertWritable(caller, runs)
    const id = qcId('batch', caller.actor.principalId, qcRequestKey(key))
    const receipt = this.receipt(caller, key, 'create-batch', id, input, runs)
    if (await this.replay(receipt)) {
      const existing = await this.get(caller.workspaceId, id, 'qc-batch')
      if (!existing) throw notFound('The batch was removed.')
      return existing
    }
    for (const scope of input.comparisons) await readExactQcEvidence(this.deps.analyses, caller.workspaceId, scope)
    const timestamp = this.now()
    const record: QcBatchRecord = {
      ...input, id, recordType: 'qc-batch', workspaceId: caller.workspaceId, createdBy: caller.actor,
      createdAt: timestamp, updatedAt: timestamp,
    }
    await this.assertWritable(caller, runs)
    await this.commit(caller.workspaceId, [{ kind: 'create', record }, { kind: 'create', record: receipt }])
    const result = await this.get(caller.workspaceId, id, 'qc-batch')
    qcAssert(result)
    return result
  }
  async batches(caller: QcCaller, options: Pick<QcListOptions, 'limit' | 'continuationToken'>): Promise<QcPage<QcBatchRecord>> {
    await this.assertRead(caller)
    const page = await this.store.list(caller.workspaceId, { recordType: 'qc-batch', ...options })
    const items: VersionedQc<QcBatchRecord>[] = []
    for (const value of page.items) {
      qcAssert(value.record.recordType === 'qc-batch')
      await this.assertRead(caller, qcRunIds(value.record))
      items.push(value as VersionedQc<QcBatchRecord>)
    }
    return { items, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
  }
}
