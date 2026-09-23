import type { RealJobDetail, RealJobSummary } from '../domain/real-jobs'
import type { Rubric, Workspace } from '../domain/types'
import { lifecycleIsRemoved } from '../domain/lifecycle'

/** Projects server-owned jobs, their parsed sources, and rubric versions into the in-memory workspace. */
export function projectRealJobs(
  base: Workspace,
  summaries: RealJobSummary[],
  details: Iterable<RealJobDetail>,
): Workspace {
  summaries = summaries.filter((summary) => !summary.lifecycle?.deletedAt)
  const byId = new Map(summaries.map((summary) => [summary.job.id, summary]))
  const detailList = [...details].filter((detail) => byId.get(detail.job.id)?.etag === detail.etag &&
    !lifecycleIsRemoved(byId.get(detail.job.id)?.lifecycle) && !lifecycleIsRemoved(detail.lifecycle))
  const jobs = summaries.map((summary) => ({
    ...summary.job,
    ...(summary.displayName === undefined ? {} : { displayName: summary.displayName }),
    dataKind: 'real' as const,
    error: summary.error?.message ?? summary.job.error,
  }))

  const documents = detailList.flatMap((detail) => detail.document
    ? [{ ...detail.document, sample: false as const }]
    : [])

  const rubricMap = new Map<string, Rubric>()
  for (const summary of summaries) {
    if (summary.rubric && !lifecycleIsRemoved(summary.lifecycle) && !lifecycleIsRemoved(summary.rubricLifecycle) && !summary.job.rubricDeletedAt) rubricMap.set(summary.rubric.id, { ...summary.rubric, dataKind: 'real' })
  }
  for (const detail of detailList) {
    if (detail.job.rubricDeletedAt || lifecycleIsRemoved(detail.rubricLifecycle)) continue
    for (const rubric of detail.rubricVersions) rubricMap.set(rubric.id, { ...rubric, dataKind: 'real' })
    if (detail.rubric) rubricMap.set(detail.rubric.id, { ...detail.rubric, dataKind: 'real' })
  }

  return {
    ...base,
    lifecycle: {
      ...base.lifecycle,
      entities: {
        ...base.lifecycle?.entities,
        ...Object.fromEntries(summaries.flatMap((summary) => [
          [`job:${summary.job.id}`, summary.lifecycle ?? {}],
          ...[...rubricMap.values()].filter((rubric) => rubric.jobId === summary.job.id).map((rubric) => [`rubric:${rubric.groupId}`, { ...summary.rubricLifecycle, parentKey: `job:${summary.job.id}` }]),
        ])),
      },
    },
    jobs,
    documents,
    rubrics: [...rubricMap.values()],
  }
}