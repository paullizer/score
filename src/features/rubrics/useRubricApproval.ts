import { useWorkspace } from '../../app/workspace-context'
import { rubricApprovalPresentation, type RubricApprovalPointer } from '../../domain/rubric-approval'
import type { Rubric } from '../../domain/types'
import { EVIDENCE_SCALE_VERSION } from '../../domain/evidence-scale'
import { isEntityArchived, isEntityRemoved } from '../../domain/lifecycle'
import { latestRubrics } from '../../domain/selectors'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export const PENDING_RUBRICS_LINK = '/rubrics?kind=job&approval=pending'

export function useRubricApprovals() {
  const { cloud, workspace, lifecycleOperations = [] } = useWorkspace()
  const access = useLifecycleAccess()
  const required = cloud.realJobs.features?.rubricApprovalRequired !== false
  const role = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.role
  function forRubric(rubric: Rubric) {
    const jobId = rubric.kind === 'job' ? rubric.jobId : undefined
    const detail = jobId ? cloud.realJobs.detail(jobId) : undefined
    const summary = jobId ? cloud.realJobs.summaries.find((item) => item.job.id === jobId) : undefined
    const record = detail?.state === 'ready' ? detail.value : summary
    const approval: RubricApprovalPointer | undefined = record?.rubricApproval
    const versions = detail?.state === 'ready' ? (detail.value.rubricVersions ?? []).map((item) => item.version) : []
    const latestVersion = Math.max(rubric.version, summary?.rubric?.version ?? 0, ...versions)
    const presentation = rubricApprovalPresentation(rubric, approval, required)
    const active = Boolean(jobId && !access.archived && !access.removed && !access.deleting && !access.transitioning &&
      record?.job?.status === 'ready' && !record.job?.rubricDeletedAt &&
      !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }) &&
      !isEntityRemoved(workspace, { kind: 'rubric', id: rubric.groupId }) &&
      !record.lifecycle?.archivedAt && !record.lifecycle?.deletingAt && !record.lifecycle?.deletedAt &&
      !record.rubricLifecycle?.archivedAt && !record.rubricLifecycle?.deletingAt && !record.rubricLifecycle?.deletedAt &&
      !lifecycleOperations.some((item) => item.operation.status !== 'complete' &&
        ((item.target.kind === 'job' && item.target.id === jobId) ||
          (item.target.kind === 'rubric' && item.target.id === rubric.groupId))))
    const draft = Boolean(record && active && rubric.version === latestVersion && presentation.status === 'draft')
    const supported = rubric.scaleVersion === EVIDENCE_SCALE_VERSION
    const message = required && presentation.status === 'draft' && !supported
      ? 'This rubric predates the evidence scale and cannot be approved. Import the job again to create a supported rubric.'
      : presentation.message
    return { ...presentation, message, jobId, approval, latestVersion, known: Boolean(record), active, supported,
      pending: draft && required, canCheck: draft && supported && access.canEdit,
      canApprove: draft && supported && access.canEdit && role === 'owner' }
  }
  const pending = latestRubrics(workspace).filter((rubric) => rubric.kind === 'job' && forRubric(rubric).pending)
  return { forRubric, pending, required, role, canApprove: access.canEdit && role === 'owner' }
}

/** The approval state of a job rubric version, from the job's approval pointer. */
export function useRubricApproval(rubric: Rubric) {
  return useRubricApprovals().forRubric(rubric)
}
