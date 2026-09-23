import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { FlaskConical, History, LoaderCircle, Plus, Save, ShieldCheck } from 'lucide-react'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, EmptyState, InlineError, Modal, PageHeader } from '../../components/ui'
import {
  QC_LIMITS, qcScopeKey, type QcComparisonContext, type QcReviewSubmission,
} from '../../domain/quality-control'
import {
  QC_PROMPT_FAMILIES, qcPlanInputSchema, qcPlanProposalSchema, qcPromptActivationReasonSchema,
  type QcCaseSelection, type QcEvaluation, type QcPlanDetail, type QcPlanInput, type QcPlanProposal,
  type QcPromptFamily, type QcPromptHistoryEntry, type QcTrialResult,
} from '../../domain/quality-improvement'
import type { Citation } from '../../domain/types'
import {
  actOnQcPlan, createQcPlan, getQcPeers, getQcPlan, getQcPlanHistory, getQcPromptHistory,
  getQcPrompts, listQcPlans, restoreQcPrompts, updateQcPlan, type QcPlanAction,
} from '../../services/qualityControl'
import { FeedbackRows, QcResultPin, QcScopePicker, type QcPageProps } from './QcReviews'
import { qcReviewLink, useQcPolling, useQcRequest, useQcResource } from './qc-ui'
import { QcRequestError } from './QcPrivacyBoundary'

const familyLabels: Record<QcPromptFamily, string> = {
  jobRubric: 'Job rubric generation', gradeCompetencies: 'Grade competency generation',
  gradeDraft: 'Grade rubric drafting', assessment: 'Analysis assessment',
}
const fixedNotice = 'Only reusable task guidance is editable. Evidence, safety, schema, citation, weight, protected-trait, qualification, and automated grounding contracts are fixed and version-pinned.'
const futureWarning = 'Activation changes app-wide defaults for FUTURE newly accepted work in every workspace. Existing results, accepted jobs, retries, and corrections retain their captured prompt versions.'

export function ImprovementPlans({ workspaceId, capabilities }: QcPageProps) {
  const [cursor, setCursor] = useState<string>()
  const load = useCallback((signal: AbortSignal) => listQcPlans(workspaceId, cursor, signal), [cursor, workspaceId])
  const plans = useQcResource(load)
  return <div className="qc-stack"><PageHeader eyebrow="QUALITY IMPROVEMENT" title="Saved improvement plans"
    description="Curate attributable feedback, inspect prompt changes, and explicitly trial a candidate. Nothing learns or activates automatically."
    actions={capabilities.writable && capabilities.admissionEnabled && <Link className="button button-primary button-md" to="/qc/improvements/new"><Plus size={16} />Collect feedback</Link>} />
    <p className="qc-notice">You can only open plans whose selected feedback you are authorized to see. Reviewers may draft and evaluate; only a member application administrator may activate.</p>
    {plans.error && <InlineError>{plans.error} <Button onClick={plans.reload}>Reload plans</Button></InlineError>}
    {plans.loading && <p role="status">Loading saved plans…</p>}
    {plans.value?.items.length === 0 && <EmptyState icon={FlaskConical} title="No visible saved plans" description="Start with submitted reviews of completed real comparisons. Empty lists do not expose blinded feedback." />}
    {plans.value?.items.map(({ record }) => <article className="qc-card" key={record.id}><div className="qc-toolbar"><div className="qc-grow">
      <h2><Link to={`/qc/improvements/${encodeURIComponent(record.id)}`}>{record.name}</Link></h2><p>{record.objective}</p></div>
      <Badge tone={record.status === 'failed' ? 'danger' : record.status === 'ready' ? 'success' : 'neutral'}>{record.status}</Badge></div>
      <p className="qc-muted">Revision {record.revision} · {record.cases.length} cases · {record.createdBy.name} · {record.updatedAt}</p></article>)}
    <div className="qc-toolbar">{cursor && <Button onClick={() => setCursor(undefined)}>First plans</Button>}
      {plans.value?.continuationToken && <Button onClick={() => setCursor(plans.value?.continuationToken)}>More plans</Button>}
      <Button disabled={plans.loading} onClick={plans.reload}>Refresh saved plans</Button></div>
  </div>
}

interface CuratedCase {
  context: QcComparisonContext
  purpose: QcCaseSelection['purpose']
  note: string
  reviews: QcReviewSubmission[]
  collected: boolean
  continuationToken?: string
  choices: Record<string, { disposition: '' | 'include' | 'exclude'; reason: string }>
  references: Record<string, { enabled: boolean; name: string; score: string; reason: string }>
}
function newCase(context: QcComparisonContext): CuratedCase {
  return { context, purpose: 'drafting', note: '', reviews: [], collected: false, choices: {}, references: {} }
}
function planInput(name: string, objective: string, cases: CuratedCase[]): QcPlanInput {
  return {
    name, objective,
    cases: cases.map(item => ({
      scope: item.context.scope, purpose: item.purpose, note: item.note,
      reviewIds: item.reviews.filter(review => item.choices[review.id]?.disposition === 'include').map(review => review.id),
      referenceDecisions: Object.entries(item.references).filter(([, reference]) => reference.enabled).map(([criterionId, reference]) => ({
        criterionId, score: reference.score === 'unscored' ? null : Number(reference.score),
        reason: `Named reference “${reference.name.trim()}”: ${reference.reason.trim()}`,
      })),
    })),
    excludedFeedback: cases.flatMap(item => item.reviews.filter(review => item.choices[review.id]?.disposition === 'exclude')
      .map(review => ({ reviewId: review.id, reason: item.choices[review.id].reason }))),
  }
}
function curationProblem(cases: CuratedCase[]): string | null {
  if (cases.some(item => !item.collected)) return 'Explicitly load authorized feedback for every selected case.'
  if (cases.some(item => item.reviews.some(review => !item.choices[review.id]?.disposition))) return 'Choose Include or Exclude for each loaded review revision.'
  if (cases.some(item => item.reviews.some(review => item.choices[review.id]?.disposition === 'exclude' && !item.choices[review.id].reason.trim()))) return 'Record a reason for each excluded review revision.'
  if (cases.some(item => Object.values(item.references).some(reference => reference.enabled &&
    (!reference.name.trim() || !reference.reason.trim() || reference.score === '' ||
      `Named reference “${reference.name.trim()}”: ${reference.reason.trim()}`.length > QC_LIMITS.reasonCharacters)))) {
    return 'Every optional human reference needs a name, an explicit rating/unscored choice, and a reason within the character limit.'
  }
  return null
}

export function CreateImprovementPlan({ workspaceId, capabilities }: QcPageProps) {
  const [cases, setCases] = useState<CuratedCase[]>([])
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [versionFilter, setVersionFilter] = useState('')
  const [confidenceFilter, setConfidenceFilter] = useState('')
  const request = useQcRequest()
  const navigate = useNavigate()
  const guard = useGradeLeaveGuard(Boolean(cases.length || name || objective) || request.unresolved, request.pending, 'Unsaved improvement case selection')
  const disabled = !capabilities.writable || !capabilities.admissionEnabled || request.pending || request.unresolved
  const input = planInput(name, objective, cases)
  const validation = qcPlanInputSchema.safeParse(input)
  const problem = curationProblem(cases) ?? (validation.success ? null : validation.error.issues[0]?.message)
  const selectedCount = input.cases.reduce((sum, item) => sum + item.reviewIds.length, 0)
  const reviewsCount = cases.reduce((sum, item) => sum + item.reviews.length, 0)
  function update(key: string, updateCase: (value: CuratedCase) => CuratedCase) {
    setCases(current => current.map(item => qcScopeKey(item.context.scope) === key ? updateCase(item) : item))
  }
  return <div className="qc-stack"><PageHeader eyebrow="COLLECT AND CURATE" title="Create an improvement plan"
    description="Select exact saved results across analyses. Deliberately load permitted feedback, preserve disagreement, and freeze a bounded selection before asking AI for a plan." />
    <p className="qc-notice">Limits: {QC_LIMITS.planCases} comparisons, {QC_LIMITS.selectedReviews} included review revisions, {QC_LIMITS.selectedReviews} explicit exclusions, and {QC_LIMITS.artifactBytes / 1024 / 1024} MiB for complete frozen evidence. Oversized cases must be narrowed, never silently truncated.</p>
    <fieldset disabled={disabled} className="qc-stack">
      <label className="qc-field"><span>Plan name</span><input value={name} maxLength={160} onChange={event => setName(event.target.value)} /></label>
      <label className="qc-field"><span>Improvement objective</span><textarea aria-label="Improvement objective" value={objective} rows={3} maxLength={4000} onChange={event => setObjective(event.target.value)} /></label>
    </fieldset>
    <QcScopePicker workspaceId={workspaceId} disabled={disabled} requirePeerAccess includeBatches selected={cases.map(item => qcScopeKey(item.context.scope))}
      onChoose={context => setCases(current => current.some(item => qcScopeKey(item.context.scope) === qcScopeKey(context.scope))
        ? current.filter(item => qcScopeKey(item.context.scope) !== qcScopeKey(context.scope)) : [...current, newCase(context)])} />
    <section className="qc-card qc-stack"><h2>Curated cases · {cases.length} / {QC_LIMITS.planCases}</h2>
      <p>{selectedCount} / {QC_LIMITS.selectedReviews} included revisions · {reviewsCount} loaded opinions · {input.excludedFeedback.length} explicitly excluded.
        {' '}{cases.filter(item => item.purpose === 'holdout').length} holdout cases. {cases.some(item => item.continuationToken) && 'Some peer pages remain unloaded: coverage is incomplete.'}</p>
      <p className="qc-muted">Filters only change what is visible; they never include or exclude feedback. No majority vote becomes ground truth. Case and rubric identities stay separate.</p>
      <div className="qc-toolbar"><label className="qc-field"><span>Filter selected cases by prompt / rubric version</span><input value={versionFilter} onChange={event => setVersionFilter(event.target.value)} /></label>
        <label className="qc-field"><span>Filter by recorded model confidence</span><select aria-label="Filter by recorded model confidence" value={confidenceFilter} onChange={event => setConfidenceFilter(event.target.value)}>
          <option value="">Any recorded state</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="not-recorded">Not recorded</option>
        </select></label></div>
    </section>
    {cases.map(item => {
      const key = qcScopeKey(item.context.scope)
      const analysis = item.context.analysis
      const version = `${analysis.result?.provenance.assessment.promptVersion ?? ''} ${analysis.comparison.target.summary.rubricId} ${analysis.comparison.target.summary.rubricVersion}`
      const matches = (!versionFilter || version.toLowerCase().includes(versionFilter.toLowerCase())) &&
        (!confidenceFilter || (confidenceFilter === 'not-recorded' ? item.context.diagnostics.status !== 'recorded'
          : item.context.diagnostics.criteria.some(row => row.confidence === confidenceFilter)))
      return <div key={key} hidden={!matches}><CuratedCaseEditor value={item} workspaceId={workspaceId} disabled={disabled} selectedCount={selectedCount}
        update={change => update(key, change)} onRemove={() => setCases(current => current.filter(row => qcScopeKey(row.context.scope) !== key))} /></div>
    })}
    <section className="qc-card qc-stack"><p>The server will freeze all selected evidence and settings. Saving this selection does not invoke AI. Opening the saved plan also does not invoke AI.</p>
      {problem && <p className="qc-notice">{problem}</p>}<QcRequestError request={request} />
      <Button variant="primary" icon={Save} disabled={disabled || Boolean(problem)} onClick={() => void request.run(JSON.stringify(input),
        (key, signal) => createQcPlan(workspaceId, input, key, signal), detail => {
          guard.release(); navigate(`/qc/improvements/${encodeURIComponent(detail.plan.id)}`)
        })}>Save draft plan — no AI work</Button></section>
  </div>
}

function CuratedCaseEditor({ value, workspaceId, disabled, selectedCount, update, onRemove }: {
  value: CuratedCase; workspaceId: string; disabled: boolean; selectedCount: number
  update: (change: (value: CuratedCase) => CuratedCase) => void; onRemove: () => void
}) {
  const request = useQcRequest()
  const [criterionFilter, setCriterionFilter] = useState('')
  const [disagreementsOnly, setDisagreementsOnly] = useState(false)
  const { context } = value
  const analysis = context.analysis
  const rubric = analysis.targetSnapshot.kind === 'job' ? analysis.targetSnapshot.rubric : analysis.targetSnapshot.version.rubric
  const closed = disabled || request.pending || request.unresolved
  const referenceDisabled = closed
  const included = value.reviews.filter(review => value.choices[review.id]?.disposition === 'include')
  const conflicts = rubric.criteria.filter(criterion => {
    const opinions = included.flatMap(review => review.feedback.filter(row => row.criterionId === criterion.id))
    return new Set(opinions.map(row => JSON.stringify({ decision: row.decision, recommendation: row.recommendation }))).size > 1
  })
  function collect() {
    const cursor = value.collected ? value.continuationToken : undefined
    void request.run(JSON.stringify({ scope: context.scope, cursor }), (key, signal) => getQcPeers(workspaceId, context.scope, key, cursor, signal),
      peers => update(current => ({ ...current, collected: true, continuationToken: peers.continuationToken,
        reviews: [...current.reviews, ...peers.submissions.filter(review => !current.reviews.some(row => row.id === review.id))] })))
  }
  return <section className="qc-card qc-stack"><div className="qc-toolbar"><h2 className="qc-grow">{analysis.comparison.resume.summary.name ?? 'Name not stated'} → {analysis.targetSnapshot.summary.label}</h2>
    <Button disabled={closed} size="sm" onClick={onRemove}>Remove case</Button></div>
    <Link to={qcReviewLink(context.scope)}>Inspect exact evidence and review</Link><QcResultPin scope={context.scope} />
    <p className="qc-muted">Rubric {rubric.id} v{rubric.version} · assessor prompt {analysis.result?.provenance.assessment.promptVersion ?? 'Not recorded'} · {context.submissionCount} submitted reviewers reported by context.</p>
    <fieldset disabled={closed} className="qc-stack"><label className="qc-field"><span>Case purpose</span><select aria-label="Case purpose" value={value.purpose}
      onChange={event => update(current => ({ ...current, purpose: event.target.value as QcCaseSelection['purpose'] }))}>
      <option value="drafting">Drafting — planner may use this feedback</option><option value="holdout">Holdout — evaluation, not plan drafting</option></select></label>
      <label className="qc-field"><span>Curation note / known omissions</span><textarea aria-label="Curation note / known omissions" rows={2} maxLength={QC_LIMITS.reasonCharacters} value={value.note}
        onChange={event => update(current => ({ ...current, note: event.target.value }))} /></label>
    </fieldset>
    <p>{context.isCoordinator ? 'Coordinator aggregation: loading this feedback is explicitly recorded as peer exposure.' : 'Only feedback already visible after your own submission can be collected.'}</p>
    {(!value.collected || value.continuationToken) && <Button disabled={closed} onClick={collect}>
      {value.collected ? 'Load more authorized review revisions' : 'Load authorized feedback for this case'}</Button>}
    <QcRequestError request={request} />
    {value.collected && <><p>{value.reviews.length} opinions loaded · {included.length} included · {new Set(included.map(review => review.author.principalId)).size} included reviewers.
      {' '}{conflicts.length} criteria with differing decisions/recommendations. These counts describe opinions, not truth.</p>
      {conflicts.length > 0 && <p className="qc-notice">Unresolved differences: {conflicts.map(row => row.label).join('; ')}. Reasons remain individually attributable below.</p>}
      <div className="qc-toolbar"><label className="qc-field"><span>Find criterion in loaded feedback</span><input value={criterionFilter} onChange={event => setCriterionFilter(event.target.value)} /></label>
        <label className="qc-check"><input type="checkbox" checked={disagreementsOnly} onChange={event => setDisagreementsOnly(event.target.checked)} />Show opinions with disagreements only</label></div>
      {value.reviews.map(review => {
        const choice = value.choices[review.id] ?? { disposition: '', reason: '' }
        const filtered = review.feedback.filter(row => (!disagreementsOnly || row.decision === 'disagree') &&
          (!criterionFilter || `${row.criterionId} ${rubric.criteria.find(criterion => criterion.id === row.criterionId)?.label ?? ''}`.toLowerCase().includes(criterionFilter.toLowerCase())))
        return <article key={review.id} className="qc-peer-selection" hidden={filtered.length === 0}>
          <h3>{review.author.name} · submitted revision {review.submissionNumber}</h3><p className="qc-muted">{review.createdAt} · {review.id} · {review.peerIndependent ? 'Before peer exposure' : 'Peer-exposed / coordinator'}</p>
          <p className="qc-muted">Reviewer identity: {review.author.principalId}</p>
          <label className="qc-field"><span>Disposition of {review.author.name} revision {review.submissionNumber}</span><select aria-label={`Disposition of ${review.author.name} revision ${review.submissionNumber}`} disabled={closed} value={choice.disposition}
            onChange={event => update(current => ({ ...current, choices: { ...current.choices, [review.id]: { ...choice, disposition: event.target.value as typeof choice.disposition } } }))}>
            <option value="">Choose explicitly</option><option value="include" disabled={choice.disposition !== 'include' && selectedCount >= QC_LIMITS.selectedReviews}>Include this exact revision</option>
            <option value="exclude">Exclude with reason</option></select></label>
          {choice.disposition === 'exclude' && <label className="qc-field"><span>Exclusion reason for {review.author.name}</span><textarea aria-label={`Exclusion reason for ${review.author.name}`} value={choice.reason} disabled={closed} rows={2} maxLength={QC_LIMITS.reasonCharacters}
            onChange={event => update(current => ({ ...current, choices: { ...current.choices, [review.id]: { ...choice, reason: event.target.value } } }))} /></label>}
          <FeedbackRows feedback={filtered} labels={rubric.criteria} />
        </article>
      })}
      {value.reviews.length === 0 && <p className="qc-notice">No submitted feedback was returned. No synthetic feedback will be used.</p>}
    </>}
    <details><summary>Optional named human reference decisions</summary><p className="qc-muted">An explicit curator judgment used only for assessment evaluation. It is not automatic reviewer consensus. Each decision is attributed to the saved plan’s creator and stays scoped to this exact rubric criterion.</p>
      {rubric.criteria.map(criterion => {
        const reference = value.references[criterion.id] ?? { enabled: false, name: '', score: '', reason: '' }
        function change(patch: Partial<typeof reference>) { update(current => ({ ...current, references: { ...current.references, [criterion.id]: { ...reference, ...patch } } })) }
        return <fieldset key={criterion.id} disabled={referenceDisabled} className="qc-reference"><legend>{criterion.label}</legend>
          <label className="qc-check"><input type="checkbox" checked={reference.enabled} onChange={event => change({ enabled: event.target.checked })} />Record a named human reference for {criterion.label}</label>
          {reference.enabled && <div className="qc-stack"><label className="qc-field"><span>Reference name for {criterion.label}</span><input maxLength={120} value={reference.name} onChange={event => change({ name: event.target.value })} /></label>
            <label className="qc-field"><span>Reference score for {criterion.label}</span><select aria-label={`Reference score for ${criterion.label}`} value={reference.score} onChange={event => change({ score: event.target.value })}>
              <option value="">Choose explicitly</option>{[0, 1, 2, 3, 4, 5].map(score => <option key={score} value={score}
                disabled={analysis.result?.criteria.find(row => row.criterionId === criterion.id)?.evidenceStatus === 'not-applicable'}>{score} / 5</option>)}<option value="unscored">Explicitly unscored</option></select></label>
            <label className="qc-field"><span>Reference reason for {criterion.label}</span><textarea aria-label={`Reference reason for ${criterion.label}`} rows={2} maxLength={QC_LIMITS.reasonCharacters - 150} value={reference.reason} onChange={event => change({ reason: event.target.value })} /></label></div>}
        </fieldset>
      })}</details>
  </section>
}

export function ImprovementPlan({ workspaceId, capabilities }: QcPageProps) {
  const { planId = '' } = useParams()
  const load = useCallback((signal: AbortSignal) => getQcPlan(workspaceId, planId, signal), [planId, workspaceId])
  const resource = useQcResource(load)
  if (!resource.value) return <><EmptyState icon={resource.loading ? LoaderCircle : FlaskConical}
    title={resource.loading ? 'Opening saved improvement plan' : 'Plan unavailable'}
    description="This read never schedules planning or evaluation. Access to every selected review is checked by the server."
    action={<Button onClick={resource.reload}>Reload saved plan</Button>} />{resource.error && <InlineError>{resource.error}</InlineError>}</>
  return <PlanEditor key={resource.value.plan.id} initial={resource.value} workspaceId={workspaceId} capabilities={capabilities} />
}

function PlanEditor({ initial, workspaceId, capabilities }: QcPageProps & { initial: QcPlanDetail }) {
  const { cloud } = useWorkspace()
  const [detail, setDetail] = useState(initial)
  const [proposal, setProposal] = useState<QcPlanProposal | null>(initial.plan.proposal)
  const [remote, setRemote] = useState<QcPlanDetail | null>(null)
  const [confirmation, setConfirmation] = useState<QcPlanAction | null>(null)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState('')
  const request = useQcRequest()
  const refreshRequest = useQcRequest()
  const plan = detail.plan
  const dirty = JSON.stringify(proposal) !== JSON.stringify(plan.proposal)
  const active = detail.work?.status === 'queued' || detail.work?.status === 'running'
  const canCancel = detail.canCancel ?? (capabilities.coordinator ||
    Boolean(cloud && plan.createdBy.principalId === `${cloud.user.tenantId}:${cloud.user.id}`))
  const closed = !detail.canEdit || !capabilities.writable || !capabilities.admissionEnabled || request.pending || request.unresolved || active
  useGradeLeaveGuard(dirty || request.unresolved || Boolean(confirmation && (reason || confirmed)), request.pending, `Improvement plan: ${plan.name}`)
  function accept(value: QcPlanDetail) {
    setDetail(value); setProposal(value.plan.proposal); setRemote(null)
  }
  const pollError = useQcPolling(active && !dirty && !request.pending && !request.unresolved,
    signal => getQcPlan(workspaceId, plan.id, signal), accept)
  const validProposal = proposal && qcPlanProposalSchema.safeParse(proposal)
  const validReason = qcPromptActivationReasonSchema.safeParse(reason).success
  const exactEvaluation = Boolean(detail.evaluation && detail.evaluation.planRevision === plan.revision && detail.evaluation.baselineRevision === plan.baseline.revision)
  const mayActivate = capabilities.applicationAdmin && capabilities.writable && capabilities.admissionEnabled && detail.canActivate && exactEvaluation && detail.evaluation?.eligible && !dirty && !active && plan.status === 'ready'
  const unsupportedTrials = !dirty && Boolean(detail.trialScope?.unsupportedFamilies.length)
  function requestAction(action: QcPlanAction) {
    const signature = JSON.stringify({ action, id: plan.id, etag: detail.etag, reason: action === 'activate' ? reason.trim() : undefined })
    void request.run(signature, (key, signal) => actOnQcPlan(workspaceId, detail, action, key, reason, signal), value => {
      accept(value); setConfirmation(null); setConfirmed(false); setReason('')
      setMessage(action === 'activate' ? 'The evaluated prompt release was activated for future newly accepted work.' : 'The action was acknowledged. Status below is the saved server state.')
    })
  }
  return <div className="qc-stack"><PageHeader eyebrow="SAVED QUALITY IMPROVEMENT" title={plan.name} description={plan.objective}
    actions={<Link className="button button-secondary button-md" to="/qc/improvements">All plans</Link>} />
    <section className="qc-card qc-stack"><div className="qc-toolbar"><Badge tone={plan.status === 'failed' ? 'danger' : plan.status === 'ready' ? 'success' : 'neutral'}>{plan.status}</Badge>
      <Badge>Plan revision {plan.revision}</Badge><span>{plan.createdBy.name} · saved {plan.updatedAt}</span></div>
      <p>Frozen baseline prompt bundle: <code>{plan.baseline.revision}</code> · {plan.cases.length} cases · {plan.cases.reduce((sum, item) => sum + item.reviewIds.length, 0)} selected review revisions.</p>
      <p className="qc-muted">Captured model / policy settings: <code>{plan.processingSettings.revision}</code>{plan.processingSettings.capturedAt && ` · ${plan.processingSettings.capturedAt}`}. Both evaluation variants retain this capture.</p>
      <p className="qc-muted">Opening, refreshing, or polling this plan starts no model work. Only the explicit paid actions below do.</p>
      {detail.work && <div className="qc-work-status" role="status"><h3>{detail.work.kind === 'plan' ? 'Plan drafting' : 'Baseline / candidate evaluation'} · {detail.work.status}</h3>
        <p>Durable work {detail.work.id} · pinned plan revision {detail.work.planRevision} · {detail.work.attempts} attempts</p>
        {detail.work.nextAttemptAt && <p>Next scheduled retry: {detail.work.nextAttemptAt}</p>}
        {detail.work.lease && <p>Worker lease expires: {detail.work.lease.expiresAt}</p>}
        <p>{detail.work.checkpoint ? 'A server checkpoint is saved; explicit resume retains frozen inputs and completed progress.' : 'No checkpoint has been recorded yet.'}</p>
        {detail.work.error && <InlineError>{detail.work.error}</InlineError>}</div>}
      {plan.error && <InlineError>{plan.error}</InlineError>}
      {pollError && <InlineError>Saved-status polling failed: {pollError}. No new work was scheduled.</InlineError>}
      {message && <p role="status">{message}</p>}
      <QcRequestError request={request} /><QcRequestError request={refreshRequest} />
      <div className="qc-toolbar">
        <Button disabled={refreshRequest.pending || request.pending || request.unresolved} onClick={() => void refreshRequest.run(`read:${plan.id}`,
          (_key, signal) => getQcPlan(workspaceId, plan.id, signal), value => dirty ? setRemote(value) : accept(value))}>Refresh saved status</Button>
        {!proposal && <Button variant="primary" disabled={closed || !capabilities.improvements} onClick={() => { setConfirmation('draft'); setConfirmed(false) }}>Draft improvement plan</Button>}
        {proposal && <Button icon={Save} disabled={closed || !dirty || !validProposal?.success} onClick={() => void request.run(
          JSON.stringify({ proposal, etag: detail.etag }), (key, signal) => updateQcPlan(workspaceId, detail, proposal, key, signal),
          value => { accept(value); setMessage('A new plan revision was saved. Prior evaluation readiness is invalidated; explicitly evaluate this revision before activation.') })}>Save new plan revision</Button>}
        {proposal && <Button icon={FlaskConical} disabled={closed || dirty || unsupportedTrials || !capabilities.improvements || !validProposal?.success}
          onClick={() => { setConfirmation('evaluate'); setConfirmed(false) }}>Run baseline / candidate trial</Button>}
        {canCancel && capabilities.writable && active && <Button disabled={request.pending || request.unresolved} onClick={() => requestAction('cancel')}>Cancel QC work</Button>}
        {detail.canEdit && capabilities.writable && capabilities.admissionEnabled && capabilities.improvements && ['failed', 'cancelled'].includes(plan.status) && detail.work &&
          <Button disabled={request.pending || request.unresolved || dirty || (detail.work.kind === 'evaluation' && unsupportedTrials)}
            onClick={() => { setConfirmation('retry'); setConfirmed(false) }}>Resume / retry saved work</Button>}
      </div>
      {dirty && <p className="qc-notice">Unsaved changes. Saving creates a new revision and invalidates previous evaluation readiness. Evaluation and activation are disabled until this revision is saved and evaluated.</p>}
      {unsupportedTrials && <p className="qc-notice" role="alert">No compatible frozen case for: {detail.trialScope?.unsupportedFamilies.map(family => familyLabels[family]).join(', ')}. Edit the proposal or create a plan with compatible cases before evaluation.</p>}
      {validProposal && !validProposal.success && <p className="qc-notice">{validProposal.error.issues[0]?.message}</p>}
      {remote && <div className="qc-notice"><h3>Saved revision {remote.plan.revision} inspected</h3><p>Your local edits are still here. Acknowledge the current version before choosing to save over it; this creates another immutable revision.</p>
        <p>{remote.plan.proposal?.summary ?? 'No saved proposal'}</p>
        {remote.plan.proposal && <details><summary>Inspect the complete newer saved proposal</summary>
          <ProposalEditor value={remote.plan.proposal} baseline={remote.plan.baseline.guidance} disabled onChange={() => {}} /></details>}
        <Button onClick={() => { setDetail(remote); setRemote(null) }}>Keep my edits against this reviewed version</Button>
        <Button onClick={() => accept(remote)}>Discard my edits and use the saved version</Button></div>}
    </section>
    <details className="qc-card"><summary>Frozen selection, exclusions, and named references</summary><p className="qc-muted">Case pack SHA-256: {plan.casePack.sha256} · {plan.casePack.bytes.toLocaleString()} bytes. Complete evidence is retained privately by the server.</p>
      {plan.cases.map(item => <article className="qc-reference" key={qcScopeKey(item.scope)}><h3>{item.purpose === 'holdout' ? 'Holdout — not used for drafting' : 'Drafting case'}</h3>
        <Link to={qcReviewLink(item.scope)}>Inspect pinned evidence</Link><QcResultPin scope={item.scope} /><p className="qc-prose">{item.note}</p>
        <p className="qc-muted">Included review revisions: {item.reviewIds.length ? item.reviewIds.join(', ') : 'None'}</p>
        {item.referenceDecisions.map(reference => <p key={reference.criterionId}><strong>{reference.criterionId}: </strong>{reference.score === null ? 'Explicitly unscored' : `${reference.score} / 5`}
          {' · '}{reference.reason} · curator: {plan.createdBy.name}</p>)}</article>)}
      {plan.excludedFeedback.map(item => <p key={item.reviewId}><strong>Excluded {item.reviewId}: </strong>{item.reason}</p>)}
    </details>
    {proposal && <ProposalEditor value={proposal} baseline={plan.baseline.guidance} disabled={closed} onChange={setProposal} />}
    {detail.evaluation && <EvaluationView evaluation={detail.evaluation} current={exactEvaluation && !dirty} />}
    {proposal && !detail.evaluation && <p className="qc-notice">No evaluation artifact is attached to this revision. A generated or edited proposal is not approval-ready.</p>}
    <section className="qc-card qc-stack"><h2>Activation is a separate administrator decision</h2><p className="qc-notice">{futureWarning}</p>
      <p>Trial metrics diagnose a selected sample, not general model accuracy or a hiring outcome. Review disagreements, failures, leakage risks, and holdout limitations before approval.</p>
      {!capabilities.applicationAdmin && <p>Reviewers, editors, and owners can propose and evaluate; application-admin status with workspace access is required to activate.</p>}
      {capabilities.applicationAdmin && <Button icon={ShieldCheck} variant="primary" disabled={!mayActivate || request.pending || request.unresolved}
        onClick={() => { setConfirmation('activate'); setConfirmed(false); setReason('') }}>Review activation of evaluated revision {plan.revision}</Button>}
      {!mayActivate && capabilities.applicationAdmin && <p className="qc-muted">Activation requires server eligibility, an unchanged saved/evaluated revision, and current workspace access.</p>}
      {plan.activatedRevision && <p role="status">Activated release: <code>{plan.activatedRevision}</code> · <Link to="/qc/prompts">Compare prompt history</Link></p>}
    </section>
    <PlanHistory key={plan.revision} workspaceId={workspaceId} planId={plan.id} revision={plan.revision} />
    <Modal open={confirmation !== null} onOpenChange={open => { if (!open) { setConfirmation(null); setReason(''); setConfirmed(false) } }}
      dismissDisabled={request.pending || request.unresolved} title={confirmation === 'activate' ? 'Activate app-wide prompt guidance?' : confirmation === 'draft' ? 'Confirm paid plan drafting' : confirmation === 'retry' ? 'Confirm paid work resume' : 'Confirm paid evaluation'}
      description={confirmation === 'activate' ? 'Only this exact evaluated revision is eligible. Current application prompts may have changed since evaluation.' : 'No work starts until you explicitly confirm this action.'}
      footer={<><Button disabled={request.pending || request.unresolved} onClick={() => { setConfirmation(null); setReason(''); setConfirmed(false) }}>Not now</Button>
        <Button variant="primary" disabled={request.pending || request.unresolved || !confirmed ||
          (confirmation === 'activate' ? !validReason || !mayActivate : closed || !capabilities.improvements ||
            ((confirmation === 'evaluate' || confirmation === 'retry' && detail.work?.kind === 'evaluation') && unsupportedTrials))}
          onClick={() => confirmation && requestAction(confirmation)}>{confirmation === 'activate' ? 'Activate evaluated revision for FUTURE work' : 'Confirm paid QC work'}</Button></>}>
      <div className="qc-stack">{confirmation === 'activate' ? <><p className="qc-notice">{futureWarning}</p>
        <p>Plan revision {plan.revision} · evaluated candidate <code>{detail.evaluation?.candidateHash}</code> · baseline {plan.baseline.revision}.</p>
        <PromptRationale label="Required administrator rationale" value={reason} disabled={request.pending || request.unresolved} onChange={setReason} />
        <p>Confirm the text is generalized guidance: no resume excerpts, personal names, reviewer comments, or source identifiers belong in app-wide instructions.</p></>
        : confirmation === 'draft' || (confirmation === 'retry' && detail.work?.kind === 'plan') ? <><p>One durable AI planning job over {plan.cases.filter(item => item.purpose === 'drafting').length} drafting cases and their selected feedback. Holdout feedback is withheld from drafting.</p>
          <p>Model generation may incur charges and bounded retries. A successful draft does not run evaluations or activate prompts.</p></>
          : <TrialScopePreview detail={detail} />}
        <label className="qc-check"><input type="checkbox" checked={confirmed} disabled={request.pending || request.unresolved} onChange={event => setConfirmed(event.target.checked)} />
          {confirmation === 'activate' ? 'I reviewed this evaluated revision and understand the app-wide FUTURE-work effect.' : 'I approve the displayed paid QC scope.'}</label>
        <QcRequestError request={request} /></div>
    </Modal>
  </div>
}

function TrialScopePreview({ detail }: { detail: QcPlanDetail }) {
  const { plan, trialScope: scope } = detail
  const maximumPairs = plan.cases.length * (plan.proposal?.changes.length ?? 0)
  return <>
    {scope ? <>
      <p><strong>{scope.pairs.length} paired case/family comparisons</strong> · {scope.baselineTrials} baseline trial executions and {scope.candidateTrials} candidate trial executions.</p>
      <p>{scope.pairs.filter(item => item.purpose === 'drafting').length} drafting pairs; {scope.pairs.filter(item => item.purpose === 'holdout').length} holdout pairs. This is the complete saved evaluation scope, not a remaining-work count.</p>
      <details className="qc-trial-scope"><summary>Inspect exact compatible trial scope</summary><ul className="qc-list">
        {scope.pairs.map(item => <li key={`${qcScopeKey(item.scope)}:${item.familyId}`}><strong>{familyLabels[item.familyId]}</strong> · {item.purpose}
          {' · '}<Link to={qcReviewLink(item.scope)}>{item.scope.runId} / {item.scope.comparisonId}</Link><QcResultPin scope={item.scope} /></li>)}
      </ul></details>
    </> : <>
      <p><strong>Up to {2 * maximumPairs} baseline/candidate family-case trials</strong> (at most {maximumPairs} paired comparisons: {plan.cases.length} frozen cases × {plan.proposal?.changes.length ?? 0} changed prompt families).</p>
      <p>Exact compatible pairing is not provided for this saved plan. These are upper bounds, subject to target-family compatibility, not an exact trial count.</p>
      <p>{plan.proposal?.changes.map(change => familyLabels[change.familyId]).join(' · ')}</p>
      <p>{plan.cases.filter(item => item.purpose === 'holdout').length} holdout cases; {plan.cases.filter(item => item.purpose === 'drafting').length} drafting cases.</p>
    </>}
    <p>Trial executions are not model-call counts. Grounding, GS planning/drafting stages, and bounded repairs can add calls. This is not a currency quote.</p>
    <p>Resume can reuse completed checkpoints and rerun failed or model-drifted pairs. Remaining model calls and completion percentages are not reported.</p>
    <p>Only QC artifacts are written. Baseline and candidate use the same frozen inputs and captured model settings. Resume retains saved work and does not change production scores.</p>
  </>
}

function PromptRationale({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const validation = qcPromptActivationReasonSchema.safeParse(value)
  return <label className="qc-field"><span>{label}</span>
    <textarea aria-label={label} aria-invalid={Boolean(value) && !validation.success} rows={4}
      maxLength={QC_LIMITS.activationReasonCharacters} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} />
    <span className="qc-muted">{value.trim().length} / {QC_LIMITS.activationReasonCharacters} characters after trimming.</span>
    {value && !validation.success && <span role="alert">{validation.error.issues[0]?.message}</span>}
  </label>
}

function ProposalEditor({ value, baseline, disabled, onChange }: {
  value: QcPlanProposal; baseline: Record<QcPromptFamily, string>; disabled: boolean; onChange: (proposal: QcPlanProposal) => void
}) {
  return <section className="qc-stack"><h2>Inspect and edit the proposal</h2><p className="qc-notice">{fixedNotice}</p>
    <fieldset disabled={disabled} className="qc-card qc-stack">
      <label className="qc-field"><span>Plan summary</span><textarea aria-label="Plan summary" rows={4} maxLength={4000} value={value.summary} onChange={event => onChange({ ...value, summary: event.target.value })} /></label>
      <h3>Findings and attributable feedback</h3>{value.findings.map((finding, index) => <label className="qc-field" key={index}><span>Finding {index + 1} · reviews {finding.reviewIds.join(', ')}</span>
        <textarea aria-label={`Finding ${index + 1}`} rows={3} maxLength={2000} value={finding.description} onChange={event => onChange({ ...value, findings: value.findings.map((item, offset) => offset === index ? { ...item, description: event.target.value } : item) })} /></label>)}
      <h3>Conflicting feedback / unresolved questions</h3>{value.disagreements.length === 0 && <p className="qc-muted">The planner recorded no conflict statements. This is not proof of consensus; inspect individual submitted opinions.</p>}
      {value.disagreements.map((disagreement, index) => <div className="qc-stack" key={index}><label className="qc-field"><span>Unresolved difference {index + 1}</span><textarea aria-label={`Unresolved difference ${index + 1}`} rows={2} maxLength={2000} value={disagreement}
        onChange={event => onChange({ ...value, disagreements: value.disagreements.map((item, offset) => offset === index ? event.target.value : item) })} /></label>
        <Button size="sm" onClick={() => onChange({ ...value, disagreements: value.disagreements.filter((_, offset) => offset !== index) })}>Remove unresolved difference {index + 1}</Button></div>)}
      {value.disagreements.length < 30 && <Button onClick={() => onChange({ ...value, disagreements: [...value.disagreements, ''] })}>Add unresolved difference</Button>}
      <label className="qc-field"><span>Expected effects</span><textarea aria-label="Expected effects" rows={3} maxLength={4000} value={value.expectedEffects} onChange={event => onChange({ ...value, expectedEffects: event.target.value })} /></label>
      <label className="qc-field"><span>Risks and limitations</span><textarea aria-label="Risks and limitations" rows={3} maxLength={4000} value={value.risks} onChange={event => onChange({ ...value, risks: event.target.value })} /></label>
    </fieldset>
    {QC_PROMPT_FAMILIES.map(family => {
      const change = value.changes.find(item => item.familyId === family)
      return <fieldset disabled={disabled} className="qc-card qc-stack" key={family}><legend>{familyLabels[family]}</legend>
        <label className="qc-check"><input type="checkbox" checked={Boolean(change)} onChange={event => onChange({ ...value, changes: event.target.checked
          ? [...value.changes, { familyId: family, guidance: baseline[family], reason: '' }] : value.changes.filter(item => item.familyId !== family) })} />Propose a change to {familyLabels[family].toLowerCase()}</label>
        <div className="qc-diff"><div><h4>Frozen baseline guidance</h4><pre>{baseline[family]}</pre></div><div><h4>{change ? 'Proposed guidance' : 'Unchanged guidance'}</h4>
          {change ? <label className="qc-field"><span className="sr-only">Proposed {familyLabels[family]} guidance</span><textarea aria-label={`Proposed ${familyLabels[family]} guidance`} rows={12} value={change.guidance} maxLength={QC_LIMITS.guidanceCharacters}
            onChange={event => onChange({ ...value, changes: value.changes.map(item => item.familyId === family ? { ...item, guidance: event.target.value } : item) })} /><span className="qc-muted">{change.guidance.length} / {QC_LIMITS.guidanceCharacters} characters</span></label>
            : <pre>{baseline[family]}</pre>}</div></div>
        {change && <label className="qc-field"><span>Rationale for {familyLabels[family].toLowerCase()} change</span><textarea aria-label={`Rationale for ${familyLabels[family].toLowerCase()} change`} rows={2} maxLength={QC_LIMITS.reasonCharacters} value={change.reason}
          onChange={event => onChange({ ...value, changes: value.changes.map(item => item.familyId === family ? { ...item, reason: event.target.value } : item) })} /></label>}
        {change && <GuidanceDiff before={baseline[family]} after={change.guidance} />}
      </fieldset>
    })}
  </section>
}

function GuidanceDiff({ before, after }: { before: string; after: string }) {
  const original = Array.from(before), candidate = Array.from(after)
  let start = 0, end = 0
  while (start < original.length && start < candidate.length && original[start] === candidate[start]) start++
  while (end < original.length - start && end < candidate.length - start &&
    original[original.length - end - 1] === candidate[candidate.length - end - 1]) end++
  if (before === after) return <p className="qc-muted">No text changes relative to this baseline.</p>
  const removed = original.slice(start, original.length - end).join('')
  const added = candidate.slice(start, candidate.length - end).join('')
  return <details className="qc-text-diff"><summary>Changed text relative to baseline</summary>
    <p className="qc-muted">Common beginning and ending text are omitted. The changed region is shown in full, including any unchanged text between edits.</p>
    <div className="qc-diff"><div><h4>Removed region</h4>{removed ? <pre><del>{removed}</del></pre> : <p>No text removed.</p>}</div>
      <div><h4>Added region</h4>{added ? <pre><ins>{added}</ins></pre> : <p>No text added.</p>}</div></div>
  </details>
}

function EvaluationView({ evaluation, current }: { evaluation: QcEvaluation; current: boolean }) {
  return <section className="qc-stack"><h2>Pinned baseline / candidate evaluation</h2>
    <div className="qc-card qc-stack"><div className="qc-toolbar"><Badge tone={current && evaluation.eligible ? 'success' : 'warning'}>{current ? evaluation.eligible ? 'Server reports eligible' : 'Not eligible for activation' : 'Historical / invalidated by current edits'}</Badge>
      <span>Evaluated plan revision {evaluation.planRevision} · completed {evaluation.completedAt}</span></div>
      <details className="qc-pin"><summary>Exact evaluation and settings pins</summary><dl><dt>Baseline release</dt><dd>{evaluation.baselineRevision}</dd>
        <dt>Candidate SHA-256</dt><dd>{evaluation.candidateHash}</dd><dt>Plan SHA-256</dt><dd>{evaluation.planHash}</dd><dt>Captured settings SHA-256</dt><dd>{evaluation.settingsHash}</dd></dl></details>
      <p className="qc-notice">Selected-sample diagnostics, not general accuracy. Drafting cases were visible to the planner; holdout cases provide separate evidence, not guaranteed generalization.</p>
      <ul className="qc-list">{evaluation.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      <p>{evaluation.cases.length} paired case/family outcomes · {evaluation.cases.filter(item => item.purpose === 'holdout').length} holdout pairs · {evaluation.cases.filter(item => item.baseline.status === 'failed' || item.candidate.status === 'failed').length} pairs with a failed variant.</p>
    </div>
    {evaluation.cases.map((item, index) => <article className="qc-card qc-stack" key={`${qcScopeKey(item.scope)}:${item.familyId}:${index}`}>
      <h3>{familyLabels[item.familyId]} · {item.purpose}</h3><QcResultPin scope={item.scope} />
      {item.familyId !== 'assessment' && <p className="qc-notice">Regenerated rubric criteria are not assumed equivalent to historical criteria with matching numeric IDs. Inspect each variant’s labels, meanings, weights, and evidence separately; old criterion agreement metrics do not validate a new rubric.</p>}
      <div className="qc-diff"><TrialResult title="Baseline" value={item.baseline} assessment={item.familyId === 'assessment'} />
        <TrialResult title="Candidate" value={item.candidate} assessment={item.familyId === 'assessment'} /></div>
    </article>)}
  </section>
}
function TrialResult({ title, value, assessment }: { title: string; value: QcTrialResult; assessment: boolean }) {
  return <section className="qc-stack" aria-label={`${title} trial`}><h4>{title} <Badge tone={value.status === 'failed' ? 'danger' : 'neutral'}>{value.status}</Badge></h4>
    {value.error && <InlineError>{value.error}</InlineError>}
    {assessment && <p>{value.reviewedCriteria > 0
      ? `${value.exactAgreements} / ${value.reviewedCriteria} exact numeric agreements with named human references; total absolute difference ${value.absoluteDifference} across ${value.reviewedCriteria} referenced criteria.`
      : 'No numeric human-reference denominator. Agreement/error rates are not reported.'}</p>}
    {value.summary && <p>{value.summary.overall.status === 'available' ? `QC trial evidence-match score: ${value.summary.overall.score} / 100` : `Score withheld: ${value.summary.overall.message}`}</p>}
    {value.summary && <p className="qc-muted">Evidence coverage: {value.summary.coverage.supported} supported, {value.summary.coverage.partial} partial, {value.summary.coverage.missing} missing,
      {' '}{value.summary.coverage.notAssessed} not assessed, {value.summary.coverage.notApplicable} not applicable. Coverage is not confidence.</p>}
    {value.findings.map((finding, index) => <p key={index}>{finding}</p>)}
    {value.assessment && <details><summary>Trial assessment, evidence, and limitations</summary><p className="qc-prose">{value.assessment.summary}</p>
      {value.assessment.criteria.map(row => <article className="qc-reference" key={row.criterionId}><h4>{row.criterionId} · {row.score === null ? 'Unscored' : `${row.score} / 5`} · {row.evidenceStatus}</h4>
        <p>{row.rationale}</p><TrialCitations title="Assessment evidence" citations={row.citations} /></article>)}
      <ul className="qc-list">{value.assessment.limitations.map((item, index) => <li key={index}>{item.message}</li>)}</ul></details>}
    {value.rubric && <TrialRubric title={title} value={value.rubric} />}
  </section>
}

function TrialCitations({ title, citations }: { title: string; citations: Citation[] | undefined }) {
  return <section aria-label={title}><h5>{title}</h5>
    {citations === undefined ? <p className="qc-muted">Not recorded in this saved trial.</p>
      : citations.length === 0 ? <p className="qc-muted">No citations recorded.</p>
        : citations.map((citation, index) => <blockquote key={index}><q className="qc-prose">{citation.quote}</q>
          <p className="qc-muted">{citation.documentId} v{citation.documentVersion} · {citation.paragraphId} · p. {citation.page}{citation.heading && ` · ${citation.heading}`}</p>
        </blockquote>)}
  </section>
}

function TrialRubric({ title, value }: { title: string; value: NonNullable<QcTrialResult['rubric']> }) {
  return <details><summary>{title} generated rubric — independent criterion meanings</summary><p>{value.description}</p>
    {value.criteria.map((row, index) => <article className="qc-reference" key={`${row.id}:${index}`}><h4>{row.label} · {row.weight}%</h4>
      <p>{row.description}</p><p className="qc-prose">{row.guidance}</p><p className="qc-muted">Variant-local criterion ID: {row.id}</p>
      {row.competencyId && <p className="qc-muted">Competency: {row.competencyId}</p>}
      {row.support && <p>Source support: {row.support}. This is not a confidence rating.</p>}
      {row.interpretation && <p className="qc-prose">{row.interpretation}</p>}
      <TrialCitations title="Source citations" citations={row.sourceCitations} />
      {row.gradeBasis !== undefined && <TrialCitations title="Grade basis" citations={row.gradeBasis} />}
    </article>)}
    <section aria-label="Unscored qualifications"><h4>Unscored qualifications</h4>
      <p className="qc-muted">These requirements remain separate from scored criteria and numeric agreement metrics.</p>
      {value.qualifications === undefined ? <p>Qualifications were not recorded in this saved trial.</p>
        : value.qualifications.length === 0 ? <p>No unscored qualifications recorded.</p>
          : value.qualifications.map(row => <article className="qc-reference" key={row.id}><h5>{row.text}</h5>
            <p className="qc-muted">Qualification ID: {row.id} · Source support: {row.support}</p><p className="qc-prose">{row.interpretation}</p>
            <TrialCitations title="Qualification evidence" citations={row.citations} />
          </article>)}
    </section>
    <section aria-label="Saved grounding findings"><h4>Saved grounding findings</h4>
      {value.issues === undefined ? <p>Grounding findings were not recorded in this saved trial.</p>
        : value.issues.length === 0 ? <p>No grounding findings recorded.</p>
          : value.issues.map((issue, index) => <article className="qc-reference" key={`${issue.id}:${index}`}>
            <p><Badge tone={issue.severity === 'blocker' ? 'danger' : 'warning'}>{issue.severity}</Badge> {issue.message}</p>
            <p className="qc-muted">{issue.scope} · {issue.code}{issue.sourceId && ` · Source: ${issue.sourceId}`}
              {issue.grade !== undefined && ` · Grade: ${issue.grade}`}{issue.criterionId && ` · Variant-local criterion: ${issue.criterionId}`}</p>
            {issue.citations !== undefined && <TrialCitations title="Grounding finding evidence" citations={issue.citations} />}
          </article>)}
    </section>
    {Boolean(value.warnings?.length) && <section aria-label="Saved trial warnings"><h4>Saved trial warnings</h4>
      <ul className="qc-list">{value.warnings?.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </section>}
  </details>
}

function PlanHistory({ workspaceId, planId, revision }: { workspaceId: string; planId: string; revision: number }) {
  const [cursor, setCursor] = useState<string>()
  const load = useCallback((signal: AbortSignal) => {
    void revision
    return getQcPlanHistory(workspaceId, planId, cursor, signal)
  }, [cursor, planId, revision, workspaceId])
  const history = useQcResource(load)
  return <section className="qc-stack"><h2><History size={18} /> Immutable plan history</h2>
    {history.error && <InlineError>{history.error} <Button onClick={history.reload}>Reload history</Button></InlineError>}
    {history.loading && <p role="status">Loading saved plan revisions…</p>}
    {history.value?.items.map(({ record }) => <details className="qc-card" key={record.id}><summary>Revision {record.revision} · {record.value.status} · {record.createdAt}</summary>
      <p>{record.value.proposal?.summary ?? 'Frozen selection; no proposal generated yet.'}</p>
      <p className="qc-muted">Baseline {record.value.baseline.revision} · {record.value.cases.length} cases · {record.value.createdBy.name}</p>
      {record.value.proposal?.changes.map(change => <section key={change.familyId}><h3>{familyLabels[change.familyId]}</h3><p>{change.reason}</p>
        <div className="qc-diff"><pre>{record.value.baseline.guidance[change.familyId]}</pre><pre>{change.guidance}</pre></div>
        <GuidanceDiff before={record.value.baseline.guidance[change.familyId]} after={change.guidance} /></section>)}
      {record.value.error && <p>{record.value.error}</p>}</details>)}
    <div className="qc-toolbar">{cursor && <Button onClick={() => setCursor(undefined)}>Latest plan history</Button>}
      {history.value?.continuationToken && <Button onClick={() => setCursor(history.value?.continuationToken)}>Older plan history</Button>}</div>
  </section>
}

export function PromptHistory({ workspaceId, capabilities }: QcPageProps) {
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<QcPromptHistoryEntry | null>(null)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const request = useQcRequest()
  const load = useCallback(async (signal: AbortSignal) => {
    const [current, history] = await Promise.all([getQcPrompts(workspaceId, signal), getQcPromptHistory(workspaceId, cursor, signal)])
    return { current, history }
  }, [cursor, workspaceId])
  const resource = useQcResource(load)
  useGradeLeaveGuard(Boolean(reason) || request.unresolved, request.pending, 'Prompt restore rationale')
  const current = resource.value?.current
  const canRestore = Boolean(current && selected && selected.revision !== current.revision && capabilities.applicationAdmin && capabilities.writable && capabilities.admissionEnabled)
  const validReason = qcPromptActivationReasonSchema.safeParse(reason).success
  return <div className="qc-stack"><PageHeader eyebrow="APP-WIDE PROMPT VERSIONS" title="Compare prompt releases"
    description="Inspect immutable guidance and activation attribution. Restoring creates a new audited activation; it never overwrites historical prompt content." />
    <p className="qc-notice">{futureWarning}</p><p className="qc-muted">{fixedNotice}</p>
    {resource.loading && <p role="status">Loading published prompt history…</p>}
    {resource.error && <InlineError>{resource.error} <Button onClick={resource.reload}>Reload prompt history</Button></InlineError>}
    {message && <p role="status">{message}</p>}<QcRequestError request={request} />
    {current && <section className="qc-card qc-stack"><h2>Current release: <code>{current.revision}</code></h2>
      <p className="qc-muted">This ETag is used only after explicit restore confirmation; concurrent activations are not overwritten.</p>
      <div className="qc-prompt-history">{resource.value?.history.items.map(entry => <article className="qc-reference" key={entry.revision}>
        <h3>{entry.revision}</h3><p>{entry.actor} · {entry.createdAt}</p><p className="qc-prose">{entry.reason}</p>
        <Button size="sm" disabled={request.pending || request.unresolved} onClick={() => { setSelected(entry); setReason(''); setConfirmed(false) }}>Compare release {entry.revision}</Button></article>)}</div>
      <div className="qc-toolbar">{cursor && <Button disabled={request.pending || request.unresolved} onClick={() => setCursor(undefined)}>Latest releases</Button>}
        {resource.value?.history.continuationToken && <Button disabled={request.pending || request.unresolved} onClick={() => setCursor(resource.value?.history.continuationToken)}>Older releases</Button>}
        <Button disabled={request.pending || request.unresolved} onClick={resource.reload}>Refresh current pointer</Button></div></section>}
    {current && QC_PROMPT_FAMILIES.map(family => <section className="qc-card qc-stack" key={family}><h2>{familyLabels[family]}</h2><div className="qc-diff">
      <div><h3>Current · {current.revision}</h3><pre>{current.guidance[family]}</pre></div>
      {selected && <div><h3>Selected historical release · {selected.revision}</h3><pre>{selected.guidance[family]}</pre></div>}</div>
      {selected && <GuidanceDiff before={current.guidance[family]} after={selected.guidance[family]} />}</section>)}
    {selected && <section className="qc-card qc-stack"><h2>Explicit restore</h2><p>Selected release: {selected.revision}. Server compatibility and current ETag checks still apply.</p>
      {!capabilities.applicationAdmin && <p>Only a workspace-member application administrator may restore app-wide prompts.</p>}
      <Button variant="primary" disabled={!canRestore || request.pending || request.unresolved} onClick={() => { setConfirmed(false); setOpen(true) }}>Review restore of {selected.revision}</Button></section>}
    <Modal open={open} onOpenChange={setOpen} dismissDisabled={request.pending || request.unresolved} title="Restore compatible guidance for future work?"
      description="An explicit, audited application-wide activation; not an edit to existing work."
      footer={<><Button disabled={request.pending || request.unresolved} onClick={() => setOpen(false)}>Not now</Button>
        <Button variant="primary" disabled={!canRestore || !validReason || !confirmed || request.pending || request.unresolved}
          onClick={() => {
            if (!current || !selected) return
            void request.run(JSON.stringify({ revision: selected.revision, etag: current.etag, reason }), (key, signal) => restoreQcPrompts(workspaceId, selected.revision, current.etag, reason, key, signal),
              next => { setOpen(false); setReason(''); setConfirmed(false); setMessage(`Restore activated release ${next.revision} for future work.`); resource.reload() })
          }}>Confirm app-wide restore</Button></>}>
      <div className="qc-stack"><p className="qc-notice">{futureWarning}</p><p>From {current?.revision} to the compatible content of {selected?.revision} through a new activation record.</p>
        <PromptRationale label="Required restore rationale" value={reason} disabled={request.pending || request.unresolved} onChange={setReason} />
        <label className="qc-check"><input type="checkbox" checked={confirmed} disabled={request.pending || request.unresolved} onChange={event => setConfirmed(event.target.checked)} />I reviewed the guidance comparison and understand this affects FUTURE work app-wide.</label>
        <QcRequestError request={request} /></div>
    </Modal>
  </div>
}
