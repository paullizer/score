import { useWorkspace } from '../../app/workspace-context'
import { rubricVersionStatus, type RubricApprovalPointer } from '../../domain/rubric-approval'
import type { Rubric } from '../../domain/types'

/** The approval state of a job rubric version, from the job's approval pointer. */
export function useRubricApproval(rubric: Rubric) {
  const { cloud } = useWorkspace()
  const jobId = rubric.kind === 'job' ? rubric.jobId : undefined
  const detail = jobId ? cloud.realJobs.detail(jobId) : undefined
  const summary = jobId ? cloud.realJobs.summaries.find((item) => item.job.id === jobId) : undefined
  const approval: RubricApprovalPointer | undefined = detail?.state === 'ready' ? detail.value.rubricApproval : summary?.rubricApproval
  const versions = detail?.state === 'ready' ? (detail.value.rubricVersions ?? []).map((item) => item.version) : []
  const latestVersion = Math.max(rubric.version, summary?.rubric?.version ?? 0, ...versions)
  return { jobId, approval, latestVersion, status: rubricVersionStatus(rubric, approval) }
}
