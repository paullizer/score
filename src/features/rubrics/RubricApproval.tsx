import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, ListChecks, Pencil, Sparkles } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { EVIDENCE_SCALE_VERSION } from '../../domain/evidence-scale'
import {
  criterionNames,
  findingCategoryLabel,
  type RubricCheckState,
  type RubricVersionStatus,
} from '../../domain/rubric-approval'
import type { RubricQaFinding } from '../../domain/rubric-qa'
import { dateLabel } from '../../domain/selectors'
import type { Rubric } from '../../domain/types'
import { useRubricApproval } from './useRubricApproval'
import { useRealAnalyses } from '../../app/real-analyses-context'

const STATUS_LABELS: Record<RubricVersionStatus, string> = { approved: 'Approved', draft: 'Draft', superseded: 'Superseded' }

export function RubricStatusBadge({ status }: { status: RubricVersionStatus }) {
  return <Badge tone={status === 'approved' ? 'success' : status === 'draft' ? 'warning' : 'neutral'}>{STATUS_LABELS[status]}</Badge>
}

export function FindingList({
  rubric,
  title,
  findings,
  tone,
  onFixWithAi,
  onEditCriterion,
}: {
  rubric: Rubric
  title: string
  findings: RubricQaFinding[]
  tone: 'warning' | 'danger'
  onFixWithAi?: (finding: RubricQaFinding) => void
  onEditCriterion?: (criterionId: string) => void
}) {
  if (!findings.length) return null
  return <section className="space-y-2">
    <h3 className="text-[12px] font-semibold">{title} <Badge tone={tone}>{findings.length}</Badge></h3>
    <ul className="space-y-2">
      {findings.map((finding, index) => <li key={`${finding.code}-${index}`} className="rounded-lg border p-3 text-[12px]">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={tone}>{findingCategoryLabel(finding.code)}</Badge>
            {finding.criterionIds.length > 0 && <span className="text-[11px] font-medium text-muted">{criterionNames(rubric, finding)}</span>}
          </div>
          {(onFixWithAi || (onEditCriterion && finding.criterionIds[0])) && <div className="flex flex-wrap items-center gap-1.5">
            {onFixWithAi && <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => onFixWithAi(finding)}>Fix with AI</Button>}
            {onEditCriterion && finding.criterionIds[0] && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => onEditCriterion(finding.criterionIds[0]!)}>Edit</Button>}
          </div>}
        </div>
        <p>{finding.message}</p>
      </li>)}
    </ul>
  </section>
}

/**
 * Top-of-page banner explaining approval status in plain language, showing flagged overlap counts,
 * and offering direct "Fix with AI", "Edit manually", and "Ready to approve" / "Review for approval" actions.
 */
export function RubricApprovalCard({
  rubric,
  readOnly,
  assistantAvailable = false,
  editable = false,
  onFixWithAi,
  onEditManually,
  onChecksLoaded,
}: {
  rubric: Rubric
  readOnly: boolean
  assistantAvailable?: boolean
  editable?: boolean
  onFixWithAi?: (findings: readonly RubricQaFinding[], focusCriterionId?: string | null) => void
  onEditManually?: (focusCriterionId?: string | null) => void
  onChecksLoaded?: (state: RubricCheckState) => void
}) {
  const { cloud } = useWorkspace()
  const { jobId, approval, latestVersion, status, qaSummary, actionLabel } = useRubricApproval(rubric)
  const [open, setOpen] = useState(false)
  const [loadedState, setLoadedState] = useState<RubricCheckState | null>(null)
  if (rubric.kind !== 'job' || !jobId) return null
  const features = cloud.realJobs.features
  const required = features?.rubricApprovalRequired !== false
  const role = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.role
  const scaled = rubric.scaleVersion === EVIDENCE_SCALE_VERSION
  const latest = rubric.version === latestVersion
  const canReview = !readOnly && latest && scaled && status !== 'approved' && (role === 'owner' || role === 'editor')
  const loadedChecks = loadedState && loadedState.rubricId === rubric.id && loadedState.version === rubric.version ? loadedState.checks : null
  const effectiveFindings = loadedChecks
    ? [...loadedChecks.checks, ...loadedChecks.review.findings]
    : qaSummary?.findings ?? []
  const hasQaResult = Boolean(loadedChecks || qaSummary)
  const issueCount = hasQaResult ? effectiveFindings.length : null
  const blockerCount = hasQaResult ? effectiveFindings.filter((item) => item.severity === 'blocker').length : null
  const cleanDraft = status === 'draft' && scaled && latest && issueCount === 0
  const flaggedDraft = status === 'draft' && scaled && latest && issueCount !== null && issueCount > 0
  const reviewSummary = loadedChecks?.review.summary ?? qaSummary?.summary
  const message = status === 'approved'
    ? `Approved ${dateLabel(approval!.approvedAt)}. New analyses and grade ladders use this version.`
    : status === 'superseded'
      ? `Version ${approval!.version} was approved after this one and is the version new work uses.`
      : !scaled
        ? 'This rubric was made before the evidence scale, so it can’t be approved. Import the job again to create a rubric that can.'
        : approval
          ? `Version ${approval.version} is approved and stays in use until a workspace owner approves this draft.`
          : !required
            ? 'Not approved yet. Admin settings let new analyses use rubrics without approval.'
            : cleanDraft
              ? 'Not approved yet. All rubric checks passed with no overlapping criteria — ready for a workspace owner to approve.'
              : flaggedDraft
                ? `Not approved yet. ${issueCount} ${issueCount === 1 ? 'item needs' : 'items need'} review before a workspace owner approves this rubric.`
                : 'Not approved yet. New analyses and grade ladders can use this rubric only after a workspace owner approves it.'
  const primaryLabel = role !== 'owner'
    ? 'Run rubric checks'
    : cleanDraft
      ? 'Ready to approve'
      : flaggedDraft
        ? `Review for approval (${issueCount})`
        : actionLabel
  const bannerClass = cleanDraft ? 'approval-banner is-clean' : flaggedDraft ? 'approval-banner is-warning' : 'approval-banner'
  return <div id="rubric-approval" className={bannerClass}>
    <div className="flex items-start gap-3">
      {flaggedDraft
        ? <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        : <BadgeCheck size={17} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-2 text-[12px] font-semibold">
            Approval <RubricStatusBadge status={status} />
            {cleanDraft && <Badge tone="success">Ready for approval · 0 issues</Badge>}
            {flaggedDraft && <Badge tone={blockerCount ? 'danger' : 'warning'}>{issueCount} {issueCount === 1 ? 'item to review' : 'items to review'}</Badge>}
          </p>
          {canReview && <div className="flex flex-wrap items-center gap-2">
            {flaggedDraft && assistantAvailable && onFixWithAi && (
              <Button size="sm" variant="primary" icon={Sparkles} onClick={() => onFixWithAi(effectiveFindings, effectiveFindings[0]?.criterionIds[0] ?? null)}>
                Fix with AI
              </Button>
            )}
            {flaggedDraft && editable && onEditManually && (
              <Button size="sm" variant="secondary" icon={Pencil} onClick={() => onEditManually(effectiveFindings[0]?.criterionIds[0] ?? null)}>
                Edit manually
              </Button>
            )}
            <Button
              size="sm"
              variant={cleanDraft && role === 'owner' ? 'success' : flaggedDraft && assistantAvailable ? 'secondary' : 'primary'}
              icon={cleanDraft && role === 'owner' ? BadgeCheck : ListChecks}
              onClick={() => setOpen(true)}
            >
              {primaryLabel}
            </Button>
          </div>}
        </div>
        <p className="mt-1.5 text-[12px]">{message}</p>
        {flaggedDraft && reviewSummary && <p className="mt-1 text-[11px] text-muted">{reviewSummary}</p>}
      </div>
    </div>
    {open && <RubricApprovalDialog
      rubric={rubric}
      jobId={jobId}
      canApprove={role === 'owner'}
      assistantAvailable={assistantAvailable}
      editable={editable}
      onFixWithAi={onFixWithAi ? (findings, focusId) => { setOpen(false); onFixWithAi(findings, focusId) } : undefined}
      onEditManually={onEditManually ? (focusId) => { setOpen(false); onEditManually(focusId) } : undefined}
      onChecksLoaded={(next) => { setLoadedState(next); onChecksLoaded?.(next) }}
      onClose={() => setOpen(false)}
    />}
  </div>
}

function RubricApprovalDialog({
  rubric,
  jobId,
  canApprove,
  assistantAvailable = false,
  editable = false,
  onFixWithAi,
  onEditManually,
  onChecksLoaded,
  onClose,
}: {
  rubric: Rubric
  jobId: string
  canApprove: boolean
  assistantAvailable?: boolean
  editable?: boolean
  onFixWithAi?: (findings: readonly RubricQaFinding[], focusCriterionId?: string | null) => void
  onEditManually?: (focusCriterionId?: string | null) => void
  onChecksLoaded?: (state: RubricCheckState) => void
  onClose: () => void
}) {
  const { cloud } = useWorkspace()
  const analyses = useRealAnalyses()
  const [state, setState] = useState<RubricCheckState | null>(null)
  const [busy, setBusy] = useState<'loading' | 'checking' | 'approving' | null>('loading')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const checksAvailable = cloud.realJobs.features?.rubricChecks === true
  // Load once per opened version, even when the workspace context supplies a new reader function.
  const readChecks = useRef(cloud.realJobs.rubricChecks)
  readChecks.current = cloud.realJobs.rubricChecks
  const notifyLoaded = useRef(onChecksLoaded)
  notifyLoaded.current = onChecksLoaded

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    readChecks.current(jobId, rubric.id, rubric.version, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setState(value)
          notifyLoaded.current?.(value)
        }
      })
      .catch((caught) => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : 'The rubric checks could not be loaded.') })
      .finally(() => { if (!abort.signal.aborted) setBusy(null) })
    return () => abort.abort()
  }, [jobId, rubric.id, rubric.version])

  async function runChecks() {
    setBusy('checking')
    setError('')
    try {
      const next = await cloud.realJobs.runRubricChecks(jobId, rubric.id, rubric.version, controller.current?.signal)
      setState(next)
      notifyLoaded.current?.(next)
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
      await analyses?.refreshTargets()
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
  const clean = Boolean(checks && findings.length === 0 && !blocked)
  return <Modal open onOpenChange={(next) => { if (!next && busy !== 'approving') onClose() }} wide dismissDisabled={busy === 'approving'}
    title={`Check and approve version ${rubric.version}`}
    description="Review the rubric checks below. You can fix overlapping criteria with AI, edit them manually, or approve this version."
    footer={<>
      <Button variant="ghost" onClick={onClose} disabled={busy === 'approving'}>Close</Button>
      {findings.length > 0 && editable && onEditManually && (
        <Button variant="secondary" icon={Pencil} disabled={busy === 'approving'} onClick={() => onEditManually(findings[0]?.criterionIds[0] ?? null)}>
          Edit manually
        </Button>
      )}
      {findings.length > 0 && assistantAvailable && onFixWithAi && (
        <Button variant="secondary" icon={Sparkles} disabled={busy === 'approving'} onClick={() => onFixWithAi(findings, findings[0]?.criterionIds[0] ?? null)}>
          Fix with AI ({findings.length})
        </Button>
      )}
      {canApprove && <Button variant={clean ? 'success' : 'primary'} icon={BadgeCheck} onClick={() => void approve()}
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
        {findings.length > 0 && (assistantAvailable || editable) && (
          <div className="rounded-xl border bg-soft p-3 text-[12px]">
            <p className="font-medium">How would you like to handle {findings.length === 1 ? 'this item' : `these ${findings.length} items`}?</p>
            <p className="mt-1 text-[11px] text-muted">
              Use <strong>Fix with AI</strong> to automatically merge or separate overlapping criteria and preview the highlighted changes before saving a new version, or <strong>Approve version {rubric.version}</strong> to keep the rubric as-is.
            </p>
          </div>
        )}
        <FindingList
          rubric={rubric}
          title="Must fix before approval"
          findings={blockers}
          tone="danger"
          onFixWithAi={assistantAvailable && onFixWithAi ? (finding) => onFixWithAi([finding], finding.criterionIds[0] ?? null) : undefined}
          onEditCriterion={editable && onEditManually ? (id) => onEditManually(id) : undefined}
        />
        <FindingList
          rubric={rubric}
          title="Review before approving"
          findings={warnings}
          tone="warning"
          onFixWithAi={assistantAvailable && onFixWithAi ? (finding) => onFixWithAi([finding], finding.criterionIds[0] ?? null) : undefined}
          onEditCriterion={editable && onEditManually ? (id) => onEditManually(id) : undefined}
        />
        {!findings.length && <p className="text-[12px] text-muted">The checks found nothing to review.</p>}
        <p className="text-[11px] text-muted">Checked {dateLabel(checks.createdAt)} · version {state!.version} · {state!.rubricHash.slice(0, 12)}</p>
        {!canApprove && <p className="text-[11px] text-muted">Only a workspace owner can approve rubrics.</p>}
      </div>}
    </div>
  </Modal>
}
