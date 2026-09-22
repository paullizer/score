import type { WorkspaceCount, WorkspaceCounts } from '../src/domain/workspace-summary'
import type { AuthenticatedPrincipal } from './auth'
import type { WorkspaceRepository } from './repository'
import type { RealJobStore } from './jobs/store'
import type { ResumeStore } from './resumes/store'
import type { AnalysisStore } from './analyses/store'
import { StoreConflictError, type WorkspaceMetadataDoc } from './store'
import { errorCategory } from './telemetry-schema'

interface WorkspaceSummaryDeps {
  repository: Pick<WorkspaceRepository, 'getWorkspaceMetadata'>
  jobs?: Pick<RealJobStore, 'countActive'>
  resumes?: Pick<ResumeStore, 'countActive'>
  analyses?: Pick<AnalysisStore, 'countActive'>
}

type Metric = 'jobs' | 'resumes' | 'analyses'
const labels: Record<Metric, string> = { jobs: 'Job', resumes: 'Resume', analyses: 'Analysis' }

function lifecycleMessage(metadata: WorkspaceMetadataDoc): string | undefined {
  if (metadata.lifecycleOperation && metadata.lifecycleOperation.status !== 'complete') {
    return metadata.lifecycleOperation.status === 'failed'
      ? 'Counts are unavailable until the failed workspace lifecycle operation is retried and completed.'
      : 'Counts are unavailable while a workspace lifecycle operation is in progress.'
  }
  if (metadata.archivedAt) return 'Counts are unavailable for an archived workspace. Unarchive it to see active counts.'
  return undefined
}

function unavailableCounts(workspaceId: string, message: string): WorkspaceCounts {
  const unavailable = (): WorkspaceCount => ({ status: 'unavailable', message })
  return { workspaceId, jobs: unavailable(), resumes: unavailable(), analyses: unavailable() }
}

async function metricCount(
  metric: Metric, workspaceId: string, store: Pick<RealJobStore, 'countActive'> | undefined,
): Promise<WorkspaceCount> {
  const label = labels[metric]
  if (!store) return { status: 'unavailable', message: `${label} counts are unavailable because storage is not configured.` }
  try {
    const count = await store.countActive(workspaceId)
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('The store returned an invalid workspace count.')
    return { status: 'ready', count }
  } catch (error) {
    console.error('Workspace summary count unavailable:', { metric, category: errorCategory(error) })
    return {
      status: 'unavailable',
      message: error instanceof StoreConflictError
        ? `${label} counts are unavailable while the library is archived or lifecycle cleanup is incomplete.`
        : `${label} counts are temporarily unavailable. Try again later.`,
    }
  }
}

export async function getWorkspaceCounts(
  deps: WorkspaceSummaryDeps, principal: AuthenticatedPrincipal, workspaceId: string,
): Promise<WorkspaceCounts> {
  const { metadata } = await deps.repository.getWorkspaceMetadata(principal, workspaceId)
  const message = lifecycleMessage(metadata)
  if (message) return unavailableCounts(workspaceId, message)

  const [jobs, resumes, analyses] = await Promise.all([
    metricCount('jobs', workspaceId, deps.jobs),
    metricCount('resumes', workspaceId, deps.resumes),
    metricCount('analyses', workspaceId, deps.analyses),
  ])
  // A lifecycle transition or membership revocation can start while the independent stores answer.
  const latest = await deps.repository.getWorkspaceMetadata(principal, workspaceId)
  const changed = lifecycleMessage(latest.metadata)
  return changed ? unavailableCounts(workspaceId, changed) : { workspaceId, jobs, resumes, analyses }
}
