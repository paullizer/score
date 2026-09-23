import { z } from 'zod'
import {
  QC_LIMITS, type QcPage, type QcReviewSubmission, type VersionedQc,
} from '../../src/domain/quality-control'
import {
  QC_PROMPT_FAMILIES, qcPlanInputSchema, qcPlanProposalSchema,
  type QcCasePack, type QcPlanDetail, type QcPlanRecord, type QcPlanRevision, type QcPromptHistoryEntry,
  type QcPromptSet, type QcWorkRecord,
} from '../../src/domain/quality-improvement'
import { captureQcProcessingSettings, processingSettingsSnapshotSchema } from '../../src/domain/admin-settings'
import { promptActorSchema, promptGuidanceSchema, type PromptBundleSnapshot } from '../../src/domain/prompt-versions'
import type { AuthenticatedPrincipal } from '../auth'
import { conflict, forbidden, invalidRequest, notFound, unavailable } from '../errors'
import { assertNewWork, currentProcessingSettings, newWorkProcessingSettings } from '../jobs/policy'
import { createPromptCandidate, type PromptPublicationGuard, type PromptRegistryService } from '../settings/prompts'
import type { QcListOptions, QcTransaction } from './store'
import { QcService, type QcCaller } from './service'
import {
  parseQcCasePack, qcAssert, qcCandidateGuidance, qcId, qcInput, qcMatch, qcPlanHash, qcRequestKey,
  qcRunIds, qcSettingsHash, qcValueHash, validateQcProposal,
} from './validation'
import {
  putQcJson, readQcCasePack, readQcEvaluation, readQcJson, qcTrialScope, qcCheckpointBinding, qcTrialModelsMatch,
  type QcEvaluationCheckpoint,
} from './artifacts'
import { readExactQcEvidence } from './evidence'
import { captureQcControlFences, qcWorkDrain } from './fences'

export const qcReasonInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1000), confirm: z.literal(true),
})
export const qcRestoreInputSchema = qcReasonInputSchema.extend({ revision: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) })
export function qcPromptSet(snapshot: PromptBundleSnapshot, etag: string): QcPromptSet {
  return {
    revision: snapshot.bundle.bundleId, etag,
    guidance: Object.fromEntries(QC_PROMPT_FAMILIES.map(family => [family, snapshot.revisions[family].guidance!])) as QcPromptSet['guidance'],
  }
}
export function qcPlanRevision(record: QcPlanRecord): QcPlanRevision {
  return {
    id: qcId('revision', record.id, record.revision), recordType: 'qc-plan-revision', workspaceId: record.workspaceId,
    planId: record.id, revision: record.revision, value: structuredClone(record),
    createdAt: record.updatedAt, updatedAt: record.updatedAt,
  }
}

/** Only guidance is a candidate: source text, model/schema contracts and fixed reviewers stay pinned. */
export function validateGeneralizedQcGuidance(plan: QcPlanRecord, pack: QcCasePack): void {
  qcAssert(plan.proposal)
  validateQcProposal(plan.proposal, plan)
  const identities = new Set<string>()
  const privateText: string[] = []
  for (const entry of pack.cases) {
    const { analysis, reviews } = entry
    const target = analysis.targetSnapshot
    const documents = [analysis.resumeSnapshot.document, target.kind === 'job' ? target.document : target.seed.document, ...entry.references]
    const targetIds = target.kind === 'job' ? [target.job.id, target.rubric.id] : [
      target.version.id, target.sourceSet.id, target.seed.job.id, target.seed.rubric.id,
      ...target.sourceSet.sources.flatMap(source => [source.sourceId, source.documentId]),
    ]
    for (const id of [
      analysis.resumeSnapshot.resume.name, analysis.resumeSnapshot.resume.id, analysis.resumeSnapshot.document.id,
      analysis.comparison.id, analysis.comparison.runId, target.snapshotId, ...targetIds,
      ...documents.flatMap(document => [document.id, ...document.paragraphs.map(paragraph => paragraph.id)]),
      ...reviews.flatMap(review => [review.id, review.author.principalId, review.author.name]),
    ]) if (typeof id === 'string' && id.trim().length >= 4) identities.add(id.toLowerCase())
    privateText.push(...documents.flatMap(document => document.paragraphs.map(paragraph => paragraph.text)),
      ...reviews.flatMap(review => review.feedback.map(row => row.reason)))
  }
  const normalized = privateText.map(value => value.toLowerCase().replace(/\s+/g, ' ').trim()).filter(value => value.length >= 60)
  for (const change of plan.proposal.changes) {
    if (!promptGuidanceSchema.safeParse(change.guidance).success) throw invalidRequest('Candidate task guidance must satisfy the bounded immutable prompt renderer contract.')
    const text = change.guidance.toLowerCase().replace(/\s+/g, ' ')
    if ([...identities].some(value => text.includes(value)) || /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(change.guidance) ||
      normalized.some(value => {
        for (let offset = 0; offset + 60 <= value.length; offset += 20) if (text.includes(value.slice(offset, offset + 60))) return true
        return false
      })) {
      throw invalidRequest('Generalize the candidate instructions before evaluation or activation. Private names, source identifiers, quotations, and copied feedback cannot become app-wide guidance.')
    }
  }
}

export class QcPlanService {
  constructor(readonly base: QcService, readonly prompts: PromptRegistryService) {}
  private async assertCapturedSettings(plan: QcPlanRecord): Promise<void> {
    const settings = captureQcProcessingSettings(await currentProcessingSettings(this.base.deps.settings))
    if (qcSettingsHash(settings) !== qcSettingsHash(plan.processingSettings)) {
      throw conflict('Model or processing settings changed after capture. Create and evaluate a new plan against the new settings.')
    }
  }
  private editable(caller: QcCaller, plan: QcPlanRecord): boolean {
    return this.base.coordinator(caller) || plan.createdBy.principalId === caller.actor.principalId
  }
  private async load(caller: QcCaller, id: string, expose = true): Promise<VersionedQc<QcPlanRecord>> {
    await this.base.assertRead(caller)
    const current = await this.base.get(caller.workspaceId, id, 'qc-plan')
    if (!current) throw notFound('The requested improvement plan was not found.')
    await this.base.requirePeerScopes(caller, current.record.cases.map(item => item.scope))
    if (expose) await this.base.expose(caller, current.record.cases.map(item => item.scope))
    return current
  }
  private async changeable(caller: QcCaller, id: string, expected?: string) {
    const current = await this.load(caller, id)
    if (!this.editable(caller, current.record)) throw forbidden('Only the plan creator or a QC coordinator may change this plan.')
    await this.base.assertWritable(caller, qcRunIds(current.record))
    qcMatch(current.etag, expected)
    if (['activated', 'invalidated'].includes(current.record.status)) throw conflict('Published or invalidated candidates cannot be edited or reused.')
    return current
  }
  async promptSet(caller: QcCaller): Promise<QcPromptSet> {
    await this.base.assertRead(caller)
    const current = await this.prompts.read()
    return qcPromptSet(current.snapshot, current.etag)
  }
  async promptHistory(caller: QcCaller, limit = 20, continuationToken?: string) {
    await this.base.assertRead(caller)
    const history = await this.prompts.history(limit, continuationToken)
    const items: QcPromptHistoryEntry[] = []
    for (const activation of history.activations) {
      const captured = await this.prompts.capture(activation.bundleId)
      items.push({
        revision: activation.bundleId, createdAt: activation.createdAt,
        actor: 'system' in activation.actor ? 'System initialization' : `${activation.actor.tenantId}:${activation.actor.oid}`,
        reason: activation.reason, guidance: qcPromptSet(captured, 'history').guidance,
      })
    }
    return { items, ...(history.nextBefore ? { continuationToken: history.nextBefore } : {}) }
  }
  async create(caller: QcCaller, value: unknown, key: string): Promise<QcPlanDetail> {
    const input = qcInput(qcPlanInputSchema, value)
    const id = qcId('plan', caller.actor.principalId, qcRequestKey(key))
    const runIds = [...new Set(input.cases.map(item => item.scope.runId))]
    await this.base.assertWritable(caller, runIds)
    await this.base.requirePeerScopes(caller, input.cases.map(item => item.scope))
    const receipt = this.base.receipt(caller, key, 'create-plan', id, input, runIds)
    if (await this.base.replay(receipt)) return this.detail(caller, id)
    const existing = await this.base.get(caller.workspaceId, id, 'qc-plan')
    if (existing) throw conflict('This plan key already identifies another accepted selection.')
    await this.base.expose(caller, input.cases.map(item => item.scope))
    const timestamp = this.base.now()
    const pack: QcCasePack = {
      schemaVersion: 1, workspaceId: caller.workspaceId, planId: id, createdBy: caller.actor, createdAt: timestamp, cases: [],
    }
    const selected = new Set(input.cases.flatMap(item => item.reviewIds))
    const excludedIds = new Set<string>()
    for (const excluded of input.excludedFeedback) {
      if (selected.has(excluded.reviewId) || excludedIds.has(excluded.reviewId)) throw invalidRequest('Feedback cannot be both included and excluded or excluded more than once.')
      excludedIds.add(excluded.reviewId)
      const submission = await this.base.get(caller.workspaceId, excluded.reviewId, 'qc-submission')
      if (!submission || !input.cases.some(item => qcValueHash(item.scope) === qcValueHash(submission.record.scope))) {
        throw forbidden('Excluded feedback must belong to an authorized selected exact result.')
      }
    }
    let bytes = Buffer.byteLength(JSON.stringify(pack))
    for (const selection of input.cases) {
      const evidence = await readExactQcEvidence(this.base.deps.analyses, caller.workspaceId, selection.scope)
      const criteria = new Map(evidence.analysis.result!.criteria.map(item => [item.criterionId, item]))
      const references = selection.referenceDecisions
      if (new Set(references.map(item => item.criterionId)).size !== references.length ||
        references.some(item => !criteria.has(item.criterionId) ||
          criteria.get(item.criterionId)!.evidenceStatus === 'not-applicable' && item.score !== null)) {
        throw invalidRequest('Reference decisions must name distinct criteria from the exact saved rubric and preserve zero-weight exclusions.')
      }
      const reviews: QcReviewSubmission[] = []
      const authors = new Set<string>()
      for (const reviewId of selection.reviewIds) {
        const review = await this.base.get(caller.workspaceId, reviewId, 'qc-submission')
        if (!review || qcValueHash(review.record.scope) !== qcValueHash(selection.scope)) {
          throw forbidden('Only immutable submitted feedback from this exact result may be selected.')
        }
        if (authors.has(review.record.author.principalId)) throw invalidRequest('Select one submitted revision per reviewer, not multiple votes from one person.')
        authors.add(review.record.author.principalId)
        reviews.push(review.record)
      }
      const entry: QcCasePack['cases'][number] = {
        selection, analysis: evidence.analysis, references: evidence.references, reviews,
      }
      bytes += Buffer.byteLength(JSON.stringify(entry))
      if (bytes > QC_LIMITS.artifactBytes) throw invalidRequest('The complete frozen case selection exceeds 16 MiB. Narrow or partition it; no source text was truncated.')
      pack.cases.push(entry)
    }
    parseQcCasePack(pack, caller.workspaceId, id)
    const [settings, active] = await Promise.all([currentProcessingSettings(this.base.deps.settings), this.prompts.read()])
    const processingSettings = processingSettingsSnapshotSchema.parse({
      ...captureQcProcessingSettings(settings), schemaVersion: 2, promptBundle: active.snapshot,
    })
    const casePack = await putQcJson(this.base.blobs, caller.workspaceId, id, pack, {
      runIds, assertActive: () => this.base.assertWritable(caller, runIds),
    })
    const plan: QcPlanRecord = {
      ...input, id, workspaceId: caller.workspaceId, recordType: 'qc-plan', createdBy: caller.actor,
      createdAt: timestamp, updatedAt: timestamp, revision: 1, casePack,
      baseline: qcPromptSet(active.snapshot, active.etag), processingSettings,
      proposal: null, status: 'draft', workId: null, evaluation: null, activatedRevision: null, error: null,
      lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
    }
    await this.base.assertWritable(caller, runIds)
    await this.base.commit(caller.workspaceId, [
      { kind: 'create', record: plan }, { kind: 'create', record: qcPlanRevision(plan) }, { kind: 'create', record: receipt },
    ])
    return this.detail(caller, id)
  }
  async detail(caller: QcCaller, id: string): Promise<QcPlanDetail> {
    const current = await this.load(caller, id)
    const plan = current.record
    const pack = plan.proposal && plan.status !== 'invalidated' ? await readQcCasePack(this.base.blobs, plan) : undefined
    const artifact = plan.status === 'invalidated' ? null : await readQcEvaluation(this.base.blobs, plan, pack)
    const work = plan.workId ? await this.base.get(caller.workspaceId, plan.workId, 'qc-work') : undefined
    if (work) qcAssert(work.record.planId === plan.id)
    let writable = true
    try { await this.base.assertWritable(caller, qcRunIds(plan)) } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) writable = false
      else throw error
    }
    return {
      plan, etag: current.etag, evaluation: artifact?.evaluation ?? null,
      ...(pack ? { trialScope: qcTrialScope(plan, pack) } : {}),
      canEdit: writable && this.editable(caller, plan) && !['activated', 'invalidated', 'planning', 'evaluating'].includes(plan.status),
      canCancel: writable && this.editable(caller, plan) && ['planning', 'evaluating'].includes(plan.status) &&
        Boolean(work && ['queued', 'running'].includes(work.record.status)),
      canActivate: writable && caller.applicationAdmin && plan.status === 'ready' && artifact?.evaluation.eligible === true,
      work: work?.record ?? null,
    }
  }
  async list(caller: QcCaller, options: Pick<QcListOptions, 'limit' | 'continuationToken'>): Promise<QcPage<QcPlanRecord>> {
    await this.base.assertRead(caller)
    const page = await this.base.store.list(caller.workspaceId, { recordType: 'qc-plan', ...options })
    const items: VersionedQc<QcPlanRecord>[] = []
    for (const value of page.items) {
      qcAssert(value.record.recordType === 'qc-plan')
      try {
        await this.base.requirePeerScopes(caller, value.record.cases.map(item => item.scope))
        await this.base.expose(caller, value.record.cases.map(item => item.scope))
        items.push(value as VersionedQc<QcPlanRecord>)
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && [403, 404].includes(Number(error.status))) continue
        throw error
      }
    }
    return { items, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
  }
  async history(caller: QcCaller, id: string, options: Pick<QcListOptions, 'limit' | 'continuationToken'>): Promise<QcPage<QcPlanRevision>> {
    await this.load(caller, id)
    return this.base.store.list(caller.workspaceId, { recordType: 'qc-plan-revision', planId: id, ...options }) as Promise<QcPage<QcPlanRevision>>
  }
  async edit(caller: QcCaller, id: string, value: unknown, key: string, expected?: string): Promise<QcPlanDetail> {
    const input = qcInput(z.strictObject({ proposal: qcPlanProposalSchema }), value)
    const loaded = await this.load(caller, id)
    const receipt = this.base.receipt(caller, key, 'edit-plan', id, input, qcRunIds(loaded.record))
    if (await this.base.replay(receipt)) return this.detail(caller, id)
    const current = await this.changeable(caller, id, expected)
    if (['planning', 'evaluating'].includes(current.record.status)) throw conflict('Cancel active work before editing its candidate.')
    const plan: QcPlanRecord = {
      ...current.record, proposal: input.proposal, revision: current.record.revision + 1, updatedAt: this.base.now(),
      status: 'draft', evaluation: null, workId: null, error: null,
      lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
    }
    const pack = await readQcCasePack(this.base.blobs, plan)
    validateGeneralizedQcGuidance(plan, pack)
    await this.base.assertWritable(caller, qcRunIds(plan))
    await this.base.commit(caller.workspaceId, [
      { kind: 'replace', record: plan, etag: current.etag }, { kind: 'create', record: qcPlanRevision(plan) },
      { kind: 'create', record: receipt },
    ])
    return this.detail(caller, id)
  }
  async request(
    caller: QcCaller, id: string, kind: 'plan' | 'evaluation', key: string, expected?: string, retry = false,
  ): Promise<QcPlanDetail> {
    const loaded = await this.load(caller, id)
    const receipt = this.base.receipt(caller, key, retry ? 'retry-plan' : kind === 'plan' ? 'draft-plan' : 'evaluate-plan',
      id, { kind }, qcRunIds(loaded.record))
    if (await this.base.replay(receipt)) return this.detail(caller, id)
    const current = await this.changeable(caller, id, expected), plan = current.record
    if (!this.base.deps.qc.workerEnabled) throw unavailable('The dedicated QC worker is not enabled.')
    if (['planning', 'evaluating'].includes(plan.status)) throw conflict('This plan already has active work; the request did not start a second paid operation.')
    if (retry && !['failed', 'cancelled'].includes(plan.status)) throw conflict('Only failed or cancelled QC work can be retried.')
    if (retry) {
      const previous = plan.workId ? await this.base.get(caller.workspaceId, plan.workId, 'qc-work') : undefined
      if (!previous || previous.record.kind !== kind || previous.record.planRevision !== plan.revision) throw conflict('There is no matching previously requested work to retry.')
    }
    const policy = retry ? plan.processingSettings : await newWorkProcessingSettings(this.base.deps.settings)
    assertNewWork(policy)
    if (kind === 'evaluation') {
      if (!plan.proposal) throw conflict('Save a complete proposal before requesting an evaluation.')
      const pack = await readQcCasePack(this.base.blobs, plan)
      validateGeneralizedQcGuidance(plan, pack)
      if (qcTrialScope(plan, pack).unsupportedFamilies.length) {
        throw invalidRequest('Each changed prompt family requires at least one compatible frozen evidence case.')
      }
    }
    const timestamp = this.base.now()
    receipt.controlFences = await captureQcControlFences(this.base.store, caller.workspaceId, qcRunIds(plan))
    const work: QcWorkRecord = {
      id: qcId('work', plan.id, receipt.requestId), recordType: 'qc-work', workspaceId: caller.workspaceId,
      planId: plan.id, planRevision: plan.revision, kind, status: 'queued', requestedBy: caller.actor,
      createdAt: timestamp, updatedAt: timestamp, requestId: receipt.requestId, requestHash: receipt.requestHash,
      attempts: 0, lease: null, nextAttemptAt: timestamp, checkpoint: null, error: null,
    }
    if (kind === 'evaluation') {
      const baseline = plan.processingSettings.promptBundle
      qcAssert(baseline, 'QC work requires its exact captured prompt bundle.')
      const oldWork = retry && plan.workId ? await this.base.get(caller.workspaceId, plan.workId, 'qc-work') : undefined
      let checkpoint: QcEvaluationCheckpoint
      if (oldWork?.record.checkpoint) {
        checkpoint = await readQcJson(this.base.blobs, oldWork.record.checkpoint, caller.workspaceId, plan.id) as QcEvaluationCheckpoint
        qcCheckpointBinding(checkpoint, plan, oldWork.record.id)
        const failed = checkpoint.cases.findIndex((item, index) =>
          item.baseline.status !== 'complete' || item.candidate.status !== 'complete' ||
          !qcTrialModelsMatch(checkpoint.executions[index]))
        if (failed >= 0) {
          checkpoint.cases = checkpoint.cases.slice(0, failed)
          checkpoint.executions = checkpoint.executions.slice(0, failed)
          delete checkpoint.pendingTrial
        }
        if (checkpoint.pendingTrial?.baseline.status === 'failed') delete checkpoint.pendingTrial
        checkpoint.workId = work.id
      } else {
        const [tenantId, oid] = caller.actor.principalId.split(':')
        const actor = promptActorSchema.parse({ tenantId, oid })
        const candidate = createPromptCandidate(baseline, qcCandidateGuidance(plan), actor, timestamp,
          qcId('candidate', plan.id, plan.revision, receipt.requestId))
        checkpoint = {
          schemaVersion: 1, workId: work.id, planHash: qcPlanHash(plan), startedAt: timestamp,
          candidate, cases: [], executions: [],
        }
      }
      work.checkpoint = await putQcJson(this.base.blobs, caller.workspaceId, plan.id, checkpoint, {
        runIds: qcRunIds(plan), assertActive: () => this.base.assertWritable(caller, qcRunIds(plan)),
      })
    } else if (retry && plan.workId) {
      const previous = await this.base.get(caller.workspaceId, plan.workId, 'qc-work')
      if (previous?.record.checkpoint) {
        const checkpoint = await readQcJson(this.base.blobs, previous.record.checkpoint, caller.workspaceId, plan.id) as Record<string, unknown>
        qcAssert(checkpoint.planHash === qcPlanHash(plan))
        work.checkpoint = await putQcJson(this.base.blobs, caller.workspaceId, plan.id, { ...checkpoint, workId: work.id }, {
          runIds: qcRunIds(plan), assertActive: () => this.base.assertWritable(caller, qcRunIds(plan)),
        })
      }
    }
    const updated: QcPlanRecord = {
      ...plan, workId: work.id, status: kind === 'plan' ? 'planning' : 'evaluating', evaluation: null,
      updatedAt: timestamp, error: null, lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
    }
    await this.base.assertWritable(caller, qcRunIds(plan))
    await this.base.commit(caller.workspaceId, [
      { kind: 'replace', record: updated, etag: current.etag }, { kind: 'create', record: work }, { kind: 'create', record: receipt },
    ])
    return this.detail(caller, id)
  }
  async retry(caller: QcCaller, id: string, key: string, expected?: string): Promise<QcPlanDetail> {
    const current = await this.load(caller, id)
    const work = current.record.workId ? await this.base.get(caller.workspaceId, current.record.workId, 'qc-work') : undefined
    if (!work) throw conflict('This plan has no previously accepted work to retry.')
    return this.request(caller, id, work.record.kind, key, expected, true)
  }
  async cancel(caller: QcCaller, id: string, key: string, expected?: string): Promise<QcPlanDetail> {
    const loaded = await this.load(caller, id)
    const receipt = this.base.receipt(caller, key, 'cancel-plan', id, {}, qcRunIds(loaded.record))
    if (await this.base.replay(receipt)) return this.detail(caller, id)
    const current = await this.changeable(caller, id, expected)
    const record = current.record
    if (!['planning', 'evaluating'].includes(record.status)) throw conflict('There is no active QC work to cancel.')
    const timestamp = this.base.now(), operations: QcTransaction[] = []
    if (record.workId) {
      const work = await this.base.get(caller.workspaceId, record.workId, 'qc-work')
      if (work && ['queued', 'running'].includes(work.record.status)) {
        const drain = qcWorkDrain(work.record, qcRunIds(record), timestamp)
        if (drain) operations.push({ kind: 'create', record: drain })
        operations.push({
          kind: 'replace', etag: work.etag, record: { ...work.record, status: 'cancelled', lease: null, nextAttemptAt: null, error: null, updatedAt: timestamp },
        })
      }
    }
    operations.push({
      kind: 'replace', etag: current.etag, record: {
        ...record, status: 'cancelled', evaluation: null, error: null, updatedAt: timestamp,
        lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
      },
    }, { kind: 'create', record: receipt })
    await this.base.assertWritable(caller, qcRunIds(record))
    await this.base.commit(caller.workspaceId, operations)
    return this.detail(caller, id)
  }

  async activationContext(caller: QcCaller, principal: AuthenticatedPrincipal, id: string, expected?: string) {
    if (!caller.applicationAdmin || principal.principalKey !== caller.actor.principalId) throw forbidden('Only an application administrator with workspace membership can activate prompts.')
    const current = await this.load(caller, id)
    await this.base.assertWritable(caller, qcRunIds(current.record))
    qcMatch(current.etag, expected)
    if (current.record.status !== 'ready') throw conflict('Only a complete, successfully evaluated exact plan revision can be activated.')
    const pack = await readQcCasePack(this.base.blobs, current.record)
    const artifact = await readQcEvaluation(this.base.blobs, current.record, pack)
    if (!artifact?.evaluation.eligible) throw conflict('This evaluation is incomplete, failed, or unsafe; activation is blocked.')
    validateGeneralizedQcGuidance(current.record, pack)
    await this.assertCapturedSettings(current.record)
    const active = await this.prompts.current()
    if (active.bundle.bundleId !== current.record.baseline.revision || active.etag !== current.record.baseline.etag ||
      active.bundle.bundleSha256 !== current.record.processingSettings.promptBundle?.bundle.bundleSha256) {
      throw conflict('The active prompt baseline changed. Create and evaluate a new plan before activation.')
    }
    qcAssert(artifact.evaluation.planHash === qcPlanHash(current.record) &&
      artifact.evaluation.candidateHash === qcValueHash(qcCandidateGuidance(current.record)))
    return { current, artifact, active }
  }
  async activate(
    caller: QcCaller, principal: AuthenticatedPrincipal, id: string,
    value: z.infer<typeof qcReasonInputSchema>, key: string, expected?: string,
    authorizePublication?: PromptPublicationGuard,
  ): Promise<QcPlanDetail> {
    const input = qcInput(qcReasonInputSchema, value)
    if (!caller.applicationAdmin || principal.principalKey !== caller.actor.principalId) {
      throw forbidden('Only an application administrator with source-workspace membership can activate prompts.')
    }
    const loaded = await this.load(caller, id)
    await this.base.assertWritable(caller, qcRunIds(loaded.record))
    const receipt = this.base.receipt(caller, key, 'activate-plan', id, input, qcRunIds(loaded.record))
    if (await this.base.replay(receipt)) return this.detail(caller, id)
    // Recover an acknowledged registry transaction even if the private QC acknowledgement was lost.
    let published: string | undefined, cursor: string | undefined
    const seen = new Set<string>()
    if (loaded.record.evaluation && ['ready', 'activated'].includes(loaded.record.status)) {
      for (let page = 0; page < 20; page++) {
        const history = await this.prompts.history(100, cursor)
        const exact = history.activations.find(activation => {
          const reference = activation.evaluation
          return reference?.workspaceId === caller.workspaceId && reference.planId === id &&
            reference.planSha256 === qcPlanHash(loaded.record) && reference.evaluationSha256 === loaded.record.evaluation!.sha256 &&
            !('system' in activation.actor) && activation.actor.tenantId === principal.tenantId &&
            activation.actor.oid === principal.oid && activation.reason === input.reason
        })
        if (exact) { published = exact.bundleId; break }
        cursor = history.nextBefore
        if (!cursor) break
        qcAssert(!seen.has(cursor), 'Prompt activation history did not advance.')
        seen.add(cursor)
      }
    }
    let current = loaded
    if (!published) {
      const context = await this.activationContext(caller, principal, id, expected)
      current = context.current
      const record = current.record, candidate = context.artifact.candidate
      await this.base.assertWritable(caller, qcRunIds(record))
      const activated = await this.prompts.activate(principal, {
        bundleId: candidate.bundle.bundleId, bundleSha256: candidate.bundle.bundleSha256, reason: input.reason, candidate,
        evaluation: {
          workspaceId: caller.workspaceId, planId: id, planRevisionId: qcId('revision', id, record.revision),
          planSha256: qcPlanHash(record), evaluationId: qcId('evaluation', record.evaluation!.sha256),
          evaluationSha256: record.evaluation!.sha256,
          baselineBundleId: context.active.bundle.bundleId, baselineBundleSha256: context.active.bundle.bundleSha256,
          evaluatedBundleId: candidate.bundle.bundleId, evaluatedBundleSha256: candidate.bundle.bundleSha256,
        },
      }, context.active.etag, async () => {
        await authorizePublication?.()
        const fresh = await this.load(caller, id, false)
        qcMatch(fresh.etag, current.etag)
        await this.assertCapturedSettings(fresh.record)
        await this.base.assertWritable(caller, qcRunIds(fresh.record))
      })
      published = activated.bundle.bundleId
    }
    await this.base.assertWritable(caller, qcRunIds(current.record))
    const operations: QcTransaction[] = [{ kind: 'create', record: receipt }]
    if (current.record.status !== 'activated') operations.push({
      kind: 'replace', etag: current.etag, record: {
        ...current.record, status: 'activated', activatedRevision: published, updatedAt: this.base.now(), error: null,
        lastRequestId: receipt.requestId, lastRequestHash: receipt.requestHash,
      },
    })
    await this.base.commit(caller.workspaceId, operations)
    return this.detail(caller, id)
  }
  async restore(
    caller: QcCaller, principal: AuthenticatedPrincipal, value: z.infer<typeof qcRestoreInputSchema>, key: string, expected?: string,
    authorizePublication?: PromptPublicationGuard,
  ): Promise<QcPromptSet> {
    const input = qcInput(qcRestoreInputSchema, value)
    if (!caller.applicationAdmin || principal.principalKey !== caller.actor.principalId) {
      throw forbidden('Only an application administrator with workspace membership may restore prompts.')
    }
    await this.base.assertWritable(caller)
    const receipt = this.base.receipt(caller, key, 'restore-prompts', input.revision, input, [])
    if (await this.base.replay(receipt)) return this.promptSet(caller)
    const publication = await this.prompts.published(input.revision)
    const beforePublish = async () => {
      await authorizePublication?.()
      const source = publication.activation.evaluation
      let runIds: string[] = []
      if (source) {
        if (source.workspaceId !== caller.workspaceId) {
          throw conflict('Restore this release from its source workspace with authorized access to the evaluated plan.')
        }
        const plan = await this.load(caller, source.planId, false)
        runIds = qcRunIds(plan.record)
        if (source.planRevisionId !== qcId('revision', plan.record.id, plan.record.revision) ||
          source.planSha256 !== qcPlanHash(plan.record) || source.evaluationSha256 !== plan.record.evaluation?.sha256) {
          throw conflict('The source plan or its evaluated revision is no longer available for this restoration.')
        }
        const pack = await readQcCasePack(this.base.blobs, plan.record)
        const artifact = await readQcEvaluation(this.base.blobs, plan.record, pack)
        if (!artifact?.evaluation.eligible || artifact.candidate.bundle.bundleId !== publication.snapshot.bundle.bundleId ||
          artifact.candidate.bundle.bundleSha256 !== publication.snapshot.bundle.bundleSha256) {
          throw conflict('The source evaluation does not support this exact published release.')
        }
      }
      await this.base.assertWritable(caller, runIds)
    }
    await beforePublish()
    const restored = await this.prompts.restore(principal, input.revision, input.reason, expected, receipt.requestId, beforePublish)
    await this.base.assertWritable(caller)
    await this.base.commit(caller.workspaceId, [{ kind: 'create', record: receipt }])
    return qcPromptSet(await this.prompts.capture(restored.bundle.bundleId), restored.etag)
  }
}
