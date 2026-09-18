import type { RealJobDetail, RealJobSummary } from '../domain/real-jobs'
import type { Rubric, Workspace } from '../domain/types'
import { lifecycleIsRemoved } from '../domain/lifecycle'

export function projectRealJobs(
  legacy: Workspace,
  summaries: RealJobSummary[],
  details: Iterable<RealJobDetail>,
): Workspace {
  summaries = summaries.filter((summary) => !summary.lifecycle?.deletedAt)
  const byId = new Map(summaries.map((summary) => [summary.job.id, summary]))
  const detailList = [...details].filter((detail) => byId.get(detail.job.id)?.etag === detail.etag &&
    !lifecycleIsRemoved(byId.get(detail.job.id)?.lifecycle) && !lifecycleIsRemoved(detail.lifecycle))
  const realJobs = summaries.map((summary) => ({
    ...summary.job,
    dataKind: 'real' as const,
    error: summary.error?.message ?? summary.job.error,
  }))
  const realJobIds = new Set(realJobs.map((job) => job.id))

  const realDocuments = detailList.flatMap((detail) => detail.document
    ? [{ ...detail.document, sample: false }]
    : [])
  const realDocumentIds = new Set([
    ...realDocuments.map((document) => document.id),
    ...realJobs.map((job) => job.documentId),
  ])

  const rubricMap = new Map<string, Rubric>()
  for (const summary of summaries) {
    if (summary.rubric && !lifecycleIsRemoved(summary.lifecycle) && !lifecycleIsRemoved(summary.rubricLifecycle) && !summary.job.rubricDeletedAt) rubricMap.set(summary.rubric.id, { ...summary.rubric, dataKind: 'real' })
  }
  for (const detail of detailList) {
    if (detail.job.rubricDeletedAt || lifecycleIsRemoved(detail.rubricLifecycle)) continue
    for (const rubric of detail.rubricVersions) rubricMap.set(rubric.id, { ...rubric, dataKind: 'real' })
    if (detail.rubric) rubricMap.set(detail.rubric.id, { ...detail.rubric, dataKind: 'real' })
  }
  const realRubrics = [...rubricMap.values()]
  const realRubricIds = new Set([
    ...realRubrics.map((rubric) => rubric.id),
    ...realJobs.flatMap((job) => job.rubricId ? [job.rubricId] : []),
  ])

  return {
    ...legacy,
    lifecycle: {
      ...legacy.lifecycle,
      entities: {
        ...legacy.lifecycle?.entities,
        ...Object.fromEntries(summaries.flatMap((summary) => [
          [`job:${summary.job.id}`, summary.lifecycle ?? {}],
          ...[...rubricMap.values()].filter((rubric) => rubric.jobId === summary.job.id).map((rubric) => [`rubric:${rubric.groupId}`, { ...summary.rubricLifecycle, parentKey: `job:${summary.job.id}` }]),
        ])),
      },
    },
    jobs: [...realJobs, ...legacy.jobs.filter((job) => !realJobIds.has(job.id))],
    documents: [...realDocuments, ...legacy.documents.filter((document) => !realDocumentIds.has(document.id))],
    rubrics: [...realRubrics, ...legacy.rubrics.filter((rubric) => !realRubricIds.has(rubric.id))],
  }
}
