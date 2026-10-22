import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, ListChecks } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import type { Rubric } from '../../domain/types'
import type { RubricCheckState } from '../../domain/rubric-approval'
import { CloudApiError } from '../../services/cloudWorkspace'
import { FindingList } from './RubricApproval'
import { useRubricApprovals } from './useRubricApproval'

interface ApprovalItem {
  rubric: Rubric
  review?: RubricCheckState
  error?: string
  approved?: boolean
}

export function BulkRubricApproval({ rubrics, onClose }: { rubrics: Rubric[]; onClose: () => void }) {
  const context = useWorkspace()
  const approvals = useRubricApprovals()
  const analyses = useRealAnalyses()
  const [scope] = useState(() => ({ workspaceId: context.cloud.currentWorkspaceId, userId: context.cloud.user.id }))
  const [items, setItems] = useState<ApprovalItem[]>(() => rubrics.map((rubric) => ({ rubric })))
  const [busy, setBusy] = useState<'loading' | 'checking' | 'approving' | null>('loading')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const current = useRef({ context, approvals, analyses })
  current.current = { context, approvals, analyses }
  const alive = useRef(true)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const guard = useGradeLeaveGuard(false, busy === 'approving' || busy === 'checking', 'Rubric approvals')
  const scopeValid = context.cloud.currentWorkspaceId === scope.workspaceId && context.cloud.user.id === scope.userId && approvals.canApprove

  function assertScope() {
    const latest = current.current
    if (!alive.current || latest.context.cloud.currentWorkspaceId !== scope.workspaceId ||
      latest.context.cloud.user.id !== scope.userId || !latest.approvals.canApprove) {
      throw new Error('Workspace or approval access changed. Close this dialog and reopen it in an active workspace as an owner.')
    }
  }

  function assertItem(rubric: Rubric) {
    const state = current.current.approvals.forRubric(rubric)
    if (!state.active) throw new Error('This job or rubric is no longer active. Unarchive it before approval.')
    if (!state.supported) throw new Error('This rubric predates the evidence scale. Import the job again before approval.')
    if (state.latestVersion !== rubric.version) throw new Error('A newer draft was saved. Review that version instead; it has not been substituted.')
  }

  function update(rubric: Rubric, patch: Partial<ApprovalItem>) {
    if (alive.current) setItems((rows) => rows.map((row) => row.rubric.id === rubric.id && row.rubric.version === rubric.version ? { ...row, ...patch } : row))
  }

  async function prepare(rows: ApprovalItem[], runMissing = false) {
    if (inFlight.current && !controller.current?.signal.aborted) return
    inFlight.current = true
    const abort = new AbortController()
    controller.current = abort
    setBusy(runMissing ? 'checking' : 'loading')
    setError('')
    try {
      for (const [index, { rubric }] of rows.entries()) {
        abort.signal.throwIfAborted()
        assertScope()
        setProgress(`${runMissing ? 'Checking' : 'Loading checks'} ${index + 1} of ${rows.length}`)
        try {
          assertItem(rubric)
          let review = await current.current.context.cloud.realJobs.rubricChecks(rubric.jobId!, rubric.id, rubric.version, abort.signal)
          abort.signal.throwIfAborted()
          assertScope()
          if (!review.checks && runMissing && !review.blockers.length) {
            if (!current.current.context.cloud.realJobs.features?.rubricChecks) throw new Error('New rubric checks are unavailable. Resume when processing is available.')
            review = await current.current.context.cloud.realJobs.runRubricChecks(rubric.jobId!, rubric.id, rubric.version, abort.signal)
            abort.signal.throwIfAborted()
          }
          assertScope()
          if (review.rubricId !== rubric.id || review.version !== rubric.version) throw new Error('Checks returned a different version. Reopen this rubric before approving.')
          update(rubric, { review, error: undefined, approved: review.status === 'approved' })
        } catch (caught) {
          if (abort.signal.aborted) return
          update(rubric, { error: caught instanceof Error ? caught.message : 'Checks could not be loaded. Retry this rubric.' })
          if (caught instanceof CloudApiError && (caught.status === 401 || caught.status === 403)) throw caught
        }
      }
    } catch (caught) {
      if (alive.current && !abort.signal.aborted) setError(caught instanceof Error ? caught.message : 'Rubric checks stopped. Review the unresolved items.')
    } finally {
      if (controller.current === abort) {
        inFlight.current = false
        if (alive.current) { setBusy(null); setProgress('') }
      }
    }
  }

  const initialRead = useRef(() => prepare(items))
  useEffect(() => {
    alive.current = true
    void initialRead.current()
    return () => { alive.current = false; controller.current?.abort() }
  }, [])

  const ready = items.filter((item) => !item.approved && !item.error && item.review?.checks && !item.review.blockers.length &&
    current.current.approvals.forRubric(item.rubric).canApprove)
  const unresolved = items.filter((item) => !item.approved)
  const missing = unresolved.filter((item) => !item.error && item.review && !item.review.checks && !item.review.blockers.length)
  const failed = unresolved.filter((item) => item.error)
  const approvedCount = items.filter((item) => item.approved).length

  async function approve() {
    if (inFlight.current || !ready.length) return
    inFlight.current = true
    setBusy('approving')
    setError('')
    guard.hold()
    let completed = 0
    try {
      for (const [index, item] of ready.entries()) {
        assertScope()
        setProgress(`Approving ${index + 1} of ${ready.length}`)
        try {
          assertItem(item.rubric)
          await current.current.context.cloud.realJobs.approveRubric(item.rubric.jobId!, item.review!, { notify: false })
          assertScope()
          update(item.rubric, { approved: true, error: undefined })
          completed++
        } catch (caught) {
          update(item.rubric, { error: caught instanceof Error ? caught.message : 'Approval was not acknowledged. Reload checks to verify the saved state.' })
          if (caught instanceof CloudApiError && (caught.status === 401 || caught.status === 403)) throw caught
        }
      }
      assertScope()
      if (completed) current.current.context.notify(`${completed} ${completed === 1 ? 'rubric approved' : 'rubrics approved'}. Review any unresolved items below.`)
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : 'Approval stopped. Completed approvals remain saved.')
    } finally {
      try {
        if (alive.current && current.current.context.cloud.currentWorkspaceId === scope.workspaceId) {
          await current.current.context.cloud.realJobs.refresh()
          await current.current.analyses?.refreshTargets()
        }
      } catch (caught) {
        if (alive.current) setError(`Completed approvals remain saved, but availability could not be refreshed. ${caught instanceof Error ? caught.message : 'Close and refresh the library.'}`)
      } finally {
        inFlight.current = false
        if (alive.current) { setBusy(null); setProgress(''); guard.settle() }
      }
    }
  }

  return <Modal open wide title="Check and approve job rubrics"
    description={`${items.length} exact saved ${items.length === 1 ? 'version' : 'versions'} in this batch. Review the findings, then confirm approval below. Approval never starts an analysis.`}
    dismissDisabled={busy === 'approving'}
    onOpenChange={(open) => { if (!open && busy !== 'approving') void guard.close(onClose) }}
    footer={<>
      <Button variant="ghost" disabled={busy === 'approving'} onClick={() => void guard.close(onClose)}>Close</Button>
      {failed.length > 0 && <Button disabled={busy !== null || !scopeValid} onClick={() => void prepare(failed)}>Reload failed items ({failed.length})</Button>}
      {missing.length > 0 && <Button icon={ListChecks} disabled={busy !== null || !scopeValid || !context.cloud.realJobs.features?.rubricChecks}
        onClick={() => void prepare(missing, true)}>Run missing checks ({missing.length})</Button>}
      <Button variant="primary" icon={BadgeCheck} disabled={busy !== null || !scopeValid || !ready.length} onClick={() => void approve()}>
        {busy === 'approving' ? 'Approving…' : `Approve ${ready.length} checked ${ready.length === 1 ? 'rubric' : 'rubrics'}`}
      </Button>
    </>}>
    <div className="space-y-4" aria-busy={busy !== null}>
      {!scopeValid && <InlineError>Workspace or approval access changed. Close this dialog and reopen it as a workspace owner.</InlineError>}
      {error && <InlineError>{error}</InlineError>}
      <p className="text-[12px]" role="status">{progress || `${approvedCount} approved · ${ready.length} ready for your approval · ${unresolved.length - ready.length} need attention`}</p>
      <p className="text-[12px] text-muted">Only the checked versions labeled “Ready for approval” will be approved. Blocked or failed items stay listed. Completed approvals remain saved if another item fails or this browser closes; unfinished items do not continue in the background.</p>
      {missing.length > 0 && <p className="text-[12px] text-muted">Missing checks require one AI review per version. Run them before approving. {context.cloud.realJobs.features?.rubricChecks ? '' : 'New checks are unavailable while processing is paused or the model is unavailable.'}</p>}
      <ul className="divide-y">
        {items.map((item) => {
          const findings = item.review?.checks ? [...item.review.checks.checks, ...item.review.checks.review.findings] : []
          const isReady = ready.includes(item)
          const state = approvals.forRubric(item.rubric)
          return <li className="space-y-3 py-4" key={`${item.rubric.id}:${item.rubric.version}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0"><h3 className="break-words text-[14px] font-semibold">{item.rubric.name}</h3><p className="text-[12px] text-muted">Version {item.rubric.version}</p></div>
              <Badge tone={item.approved ? 'success' : isReady ? 'accent' : 'warning'}>{item.approved ? 'Approved' : isReady ? 'Ready for approval' : 'Needs attention'}</Badge>
            </div>
            {item.error && <InlineError>{item.error}</InlineError>}
            {!item.approved && state.latestVersion !== item.rubric.version && <InlineError>A newer draft was saved. Review that version instead; it has not been substituted.</InlineError>}
            {!item.approved && !state.active && <InlineError>This job or rubric is no longer active. Unarchive it before approval.</InlineError>}
            {!item.approved && item.review?.blockers.map((message) => <InlineError key={message}>{message}</InlineError>)}
            {item.review?.checks && <details open={findings.length > 0}>
              <summary className="cursor-pointer text-[12px] font-medium">Review findings ({findings.length})</summary>
              <div className="mt-3 space-y-3">
                <p className="text-[12px]">{item.review.checks.review.summary}</p>
                <FindingList rubric={item.rubric} title="Must fix before approval" findings={findings.filter((finding) => finding.severity === 'blocker')} tone="danger" />
                <FindingList rubric={item.rubric} title="Review before approving" findings={findings.filter((finding) => finding.severity === 'warning')} tone="warning" />
                {!findings.length && <p className="text-[12px] text-muted">The checks found nothing to review.</p>}
              </div>
            </details>}
            {busy !== 'approving' && <Link className="text-link text-[12px]" to={`/rubrics/${encodeURIComponent(item.rubric.id)}?job=${encodeURIComponent(item.rubric.jobId!)}&version=${item.rubric.version}`}
              onClick={(event) => { if (busy === 'checking') event.preventDefault() }}>Inspect rubric and source</Link>}
          </li>
        })}
      </ul>
    </div>
  </Modal>
}
