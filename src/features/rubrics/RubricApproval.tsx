import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, ListChecks } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { EVIDENCE_SCALE_VERSION } from '../../domain/evidence-scale'
import type { RubricCheckState, RubricVersionStatus } from '../../domain/rubric-approval'
import type { RubricQaFinding } from '../../domain/rubric-qa'
import { dateLabel } from '../../domain/selectors'
import type { Rubric } from '../../domain/types'
import { useRubricApproval } from './useRubricApproval'

const STATUS_LABELS: Record<RubricVersionStatus, string> = { approved: 'Approved', draft: 'Draft', superseded: 'Superseded' }

export function RubricStatusBadge({ status }: { status: RubricVersionStatus }) {
  return <Badge tone={status === 'approved' ? 'success' : status === 'draft' ? 'warning' : 'neutral'}>{STATUS_LABELS[status]}</Badge>
}

function criterionNames(rubric: Rubric, finding: RubricQaFinding): string {
  return finding.criterionIds.map((id) => {
    const index = rubric.criteria.findIndex((criterion) => criterion.id === id)
    return index < 0 ? id : `${String(index + 1).padStart(2, '0')} ${rubric.criteria[index].label}`
  }).join(' · ')
}

function FindingList({ rubric, title, findings, tone }: { rubric: Rubric; title: string; findings: RubricQaFinding[]; tone: 'warning' | 'danger' }) {
  if (!findings.length) return null
  return <section className="space-y-2">
    <h3 className="text-[12px] font-semibold">{title} <Badge tone={tone}>{findings.length}</Badge></h3>
    <ul className="space-y-2">
      {findings.map((finding, index) => <li key={`${finding.code}-${index}`} className="rounded-lg border p-3 text-[12px]">
        <p>{finding.message}</p>
        {finding.criterionIds.length > 0 && <p className="mt-1 text-[11px] text-muted">{criterionNames(rubric, finding)}</p>}
      </li>)}
    </ul>
  </section>
}

/**
 * Explains whether new analyses can use this version and, for the latest version on the evidence scale, opens the
 * checks and owner approval. Checks run once per saved version and include one AI review.
 */
export function RubricApprovalCard({ rubric, readOnly }: { rubric: Rubric; readOnly: boolean }) {
  const { cloud } = useWorkspace()
  const { jobId, approval, latestVersion, status } = useRubricApproval(rubric)
  const [open, setOpen] = useState(false)
  if (rubric.kind !== 'job' || !jobId) return null
  const features = cloud.realJobs.features
  const required = features?.rubricApprovalRequired !== false
  const role = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.role
  const scaled = rubric.scaleVersion === EVIDENCE_SCALE_VERSION
  const latest = rubric.version === latestVersion
  const canReview = !readOnly && latest && scaled && status !== 'approved' && (role === 'owner' || role === 'editor')
  const message = status === 'approved'
    ? `Approved ${dateLabel(approval!.approvedAt)}. New analyses and grade ladders use this version.`
    : status === 'superseded'
      ? `Version ${approval!.version} was approved after this one and is the version new work uses.`
      : !scaled
        ? 'This rubric was made before the evidence scale, so it can’t be approved. Import the job again to create a rubric that can.'
        : approval
          ? `Version ${approval.version} is approved and stays in use until a workspace owner approves this draft.`
          : required
            ? 'Not approved yet. New analyses and grade ladders can use this rubric only after a workspace owner approves it.'
            : 'Not approved yet. Admin settings let new analyses use rubrics without approval.'
  return <div className="rounded-xl border bg-soft p-3.5">
    <div className="flex items-start gap-2.5">
      <BadgeCheck size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[11px] font-medium">Approval <RubricStatusBadge status={status} /></p>
        <p className="mt-1 text-[11px] text-muted">{message}</p>
        {canReview && <Button className="mt-2" size="sm" icon={ListChecks} onClick={() => setOpen(true)}>
          {role === 'owner' ? 'Check and approve' : 'Run rubric checks'}
        </Button>}
      </div>
    </div>
    {open && <RubricApprovalDialog rubric={rubric} jobId={jobId} canApprove={role === 'owner'} onClose={() => setOpen(false)} />}
  </div>
}

function RubricApprovalDialog({ rubric, jobId, canApprove, onClose }: { rubric: Rubric; jobId: string; canApprove: boolean; onClose: () => void }) {
  const { cloud } = useWorkspace()
  const [state, setState] = useState<RubricCheckState | null>(null)
  const [busy, setBusy] = useState<'loading' | 'checking' | 'approving' | null>('loading')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const checksAvailable = cloud.realJobs.features?.rubricChecks === true
  // Load once per opened version, even when the workspace context supplies a new reader function.
  const readChecks = useRef(cloud.realJobs.rubricChecks)
  readChecks.current = cloud.realJobs.rubricChecks

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    readChecks.current(jobId, rubric.id, rubric.version, abort.signal)
      .then((value) => { if (!abort.signal.aborted) setState(value) })
      .catch((caught) => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : 'The rubric checks could not be loaded.') })
      .finally(() => { if (!abort.signal.aborted) setBusy(null) })
    return () => abort.abort()
  }, [jobId, rubric.id, rubric.version])

  async function runChecks() {
    setBusy('checking')
    setError('')
    try {
      setState(await cloud.realJobs.runRubricChecks(jobId, rubric.id, rubric.version, controller.current?.signal))
    } catch (caught) {
      if (!controller.current?.signal.aborted) setError(caught instanceof Error ? caught.message : 'The rubric checks could not run. Try again.')
    } finally {
      if (!controller.current?.signal.aborted) setBusy(null)
    }
  }

  async function approve() {
    if (!state) return
    setBusy('approving')
    setError('')
    try {
      await cloud.realJobs.approveRubric(jobId, state)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The rubric could not be approved. Try again.')
      setBusy(null)
    }
  }

  const checks = state?.checks
  const findings = checks ? [...checks.checks, ...checks.review.findings] : []
  const blockers = findings.filter((finding) => finding.severity === 'blocker')
  const warnings = findings.filter((finding) => finding.severity === 'warning')
  const blocked = Boolean(state && state.blockers.length > 0)
  return <Modal open onOpenChange={(next) => { if (!next && busy !== 'approving') onClose() }} wide dismissDisabled={busy === 'approving'}
    title={`Check and approve version ${rubric.version}`}
    description="Approval locks this exact version for new analyses and grade ladders. Edits create a new draft; the approved version stays in use until a newer one is approved."
    footer={<>
      <Button variant="ghost" onClick={onClose} disabled={busy === 'approving'}>Close</Button>
      {canApprove && <Button variant="primary" icon={BadgeCheck} onClick={() => void approve()}
        disabled={busy !== null || !checks || blocked}>{busy === 'approving' ? 'Approving…' : `Approve version ${rubric.version}`}</Button>}
    </>}>
    <div className="space-y-4" aria-busy={busy !== null}>
      {busy === 'loading' && <p className="text-[12px] text-muted">Loading the rubric checks…</p>}
      {error && <InlineError>{error}</InlineError>}
      {state && state.blockers.length > 0 && <InlineError>
        <p className="mb-1 font-medium">This version can’t be approved yet.</p>
        <ul className="list-disc space-y-1 pl-4">{state.blockers.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
      </InlineError>}
      {state && !checks && <div className="space-y-3 text-[12px]">
        <p>The checks look for criteria that assess the same capability, level examples a résumé can’t show, and examples that don’t follow the evidence scale. They run once for this version, use AI for one review, and take up to a minute.</p>
        {checksAvailable
          ? <Button icon={ListChecks} onClick={() => void runChecks()} disabled={busy !== null}>{busy === 'checking' ? 'Running checks…' : 'Run rubric checks'}</Button>
          : <p className="text-muted">Rubric checks aren’t available right now: they need the job-rubric model and are stopped while new work is paused.</p>}
      </div>}
      {checks && <div className="space-y-4">
        <p className="text-[12px]">{checks.review.summary}</p>
        <FindingList rubric={rubric} title="Must fix before approval" findings={blockers} tone="danger" />
        <FindingList rubric={rubric} title="Review before approving" findings={warnings} tone="warning" />
        {!findings.length && <p className="text-[12px] text-muted">The checks found nothing to review.</p>}
        <p className="text-[11px] text-muted">Checked {dateLabel(checks.createdAt)} · version {state!.version} · {state!.rubricHash.slice(0, 12)}</p>
        {!canApprove && <p className="text-[11px] text-muted">Only a workspace owner can approve rubrics.</p>}
      </div>}
    </div>
  </Modal>
}
