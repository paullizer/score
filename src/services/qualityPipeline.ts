import { pipelineDetailSchema, pipelinePlansSchema, type PipelineDetail, type PipelinePlans } from '../domain/quality-pipeline'
import { qcIdentifier } from '../domain/quality-control'
import { cloudJsonRequest } from './cloudWorkspace'

function base(workspaceId: string): string {
  return `/admin/quality-pipeline/workspaces/${encodeURIComponent(qcIdentifier.parse(workspaceId))}/plans`
}

export async function listPipelinePlans(workspaceId: string, continuationToken?: string, signal?: AbortSignal): Promise<PipelinePlans> {
  const query = continuationToken ? `?${new URLSearchParams({ continuationToken })}` : ''
  const page = pipelinePlansSchema.parse(await cloudJsonRequest(`${base(workspaceId)}${query}`, { signal }))
  if (page.workspaceId !== workspaceId || page.items.some(item => item.workspaceId !== workspaceId)) {
    throw new Error('The quality pipeline returned a different workspace.')
  }
  return page
}

export async function readPipelinePlan(workspaceId: string, planId: string, signal?: AbortSignal): Promise<PipelineDetail> {
  const value = pipelineDetailSchema.parse(await cloudJsonRequest(`${base(workspaceId)}/${encodeURIComponent(qcIdentifier.parse(planId))}`, { signal }))
  if (value.plan.workspaceId !== workspaceId || value.plan.id !== planId) {
    throw new Error('The quality pipeline returned a different saved plan.')
  }
  return value
}
