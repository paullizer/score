import type { PipelineDetail, PipelinePlan, PipelinePlans } from '../../src/domain/quality-pipeline'
import { pipelineDetailSchema } from '../../src/domain/quality-pipeline'
import { QC_PROMPT_FAMILIES, type QcPlanRecord } from '../../src/domain/quality-improvement'
import { HttpError, conflict, notFound } from '../errors'
import { readQcEvaluation } from './artifacts'
import type { QcListOptions } from './store'
import { QcService, type QcCaller } from './service'
import { parseQcRecord, qcAssert } from './validation'

function summary(plan: QcPlanRecord): PipelinePlan {
  return {
    workspaceId: plan.workspaceId, id: plan.id, name: plan.name,
    revision: plan.revision, status: plan.status, updatedAt: plan.updatedAt,
  }
}

/** Metadata reads deliberately do not call the plan service's peer-exposure paths. */
export class QualityPipelineService {
  constructor(private readonly qc: QcService) {}

  async list(caller: QcCaller, options: Pick<QcListOptions, 'limit' | 'continuationToken'>): Promise<PipelinePlans> {
    await this.qc.assertRead(caller)
    const page = await this.qc.store.list(caller.workspaceId, { recordType: 'qc-plan', ...options })
    const items: PipelinePlan[] = []
    for (const value of page.items) {
      const plan = parseQcRecord(value.record)
      qcAssert(plan.recordType === 'qc-plan' && plan.workspaceId === caller.workspaceId, 'The pipeline returned a foreign plan.')
      try {
        await this.qc.requirePeerScopes(caller, plan.cases.map(item => item.scope))
        items.push(summary(plan))
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status)) continue
        throw error
      }
    }
    await this.qc.assertRead(caller)
    return { workspaceId: caller.workspaceId, items, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) }
  }

  async detail(caller: QcCaller, planId: string): Promise<PipelineDetail> {
    const current = await this.qc.get(caller.workspaceId, planId, 'qc-plan')
    if (!current) throw notFound('The requested improvement plan was not found.')
    const plan = current.record
    await this.qc.requirePeerScopes(caller, plan.cases.map(item => item.scope))
    const [artifact, work] = await Promise.all([
      readQcEvaluation(this.qc.blobs, plan),
      plan.workId ? this.qc.get(caller.workspaceId, plan.workId, 'qc-work') : undefined,
    ])
    if (plan.workId) qcAssert(work, 'The pipeline plan references missing saved work.')
    if (work) qcAssert(work.record.planId === plan.id && work.record.planRevision === plan.revision,
      'The pipeline work does not belong to this exact plan revision.')
    const latest = await this.qc.get(caller.workspaceId, planId, 'qc-plan')
    if (!latest || latest.etag !== current.etag) throw conflict('The improvement plan changed. Refresh its saved path.')
    await this.qc.requirePeerScopes(caller, plan.cases.map(item => item.scope))
    return pipelineDetailSchema.parse({
      plan: summary(plan),
      casePackSha256: plan.casePack.sha256,
      cases: plan.cases.map(item => ({ scope: item.scope, purpose: item.purpose, includedReviews: item.reviewIds.length })),
      excludedReviews: plan.excludedFeedback.length,
      changedFamilies: plan.proposal?.changes.map(change => change.familyId) ?? [],
      tasks: QC_PROMPT_FAMILIES.map(family => {
        const ai = plan.processingSettings.settings.ai
        const deploymentId = ai.tasks[family].deploymentId ?? ai.defaultDeploymentId
        const deployment = ai.deployments.find(item => item.id === deploymentId)
        qcAssert(deployment, 'A captured task deployment is missing.')
        return { family, deployment: deployment.deploymentName, model: deployment.modelName, modelVersion: deployment.modelVersion }
      }),
      settings: { revision: plan.processingSettings.revision, capturedAt: plan.processingSettings.capturedAt },
      baseline: { id: plan.baseline.revision, sha256: plan.processingSettings.promptBundle?.bundle.bundleSha256 ?? null },
      candidate: artifact ? { id: artifact.candidate.bundle.bundleId, sha256: artifact.candidate.bundle.bundleSha256 } : null,
      evaluation: artifact ? {
        sha256: plan.evaluation!.sha256, completedAt: artifact.evaluation.completedAt,
        eligibleAtCompletion: artifact.evaluation.eligible, trials: artifact.evaluation.cases.length,
        holdoutTrials: artifact.evaluation.cases.filter(item => item.purpose === 'holdout').length,
        failedBaselineTrials: artifact.evaluation.cases.filter(item => item.baseline.status === 'failed').length,
        failedCandidateTrials: artifact.evaluation.cases.filter(item => item.candidate.status === 'failed').length,
      } : null,
      work: work ? {
        kind: work.record.kind, status: work.record.status, attempts: work.record.attempts, nextAttemptAt: work.record.nextAttemptAt,
      } : null,
      activatedBundleId: plan.activatedRevision,
    })
  }
}
