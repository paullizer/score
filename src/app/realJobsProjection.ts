import type { RealJobDetail, RealJobSummary } from '../domain/real-jobs'
import type { Rubric, Workspace } from '../domain/types'

export function projectRealJobs(
  legacy: Workspace,
  summaries: RealJobSummary[],
  details: Iterable<RealJobDetail>,
): Workspace {
  const detailList = [...details]
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
    if (summary.rubric) rubricMap.set(summary.rubric.id, { ...summary.rubric, dataKind: 'real' })
  }
  for (const detail of detailList) {
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
    jobs: [...realJobs, ...legacy.jobs.filter((job) => !realJobIds.has(job.id))],
    documents: [...realDocuments, ...legacy.documents.filter((document) => !realDocumentIds.has(document.id))],
    rubrics: [...realRubrics, ...legacy.rubrics.filter((rubric) => !realRubricIds.has(rubric.id))],
  }
}
