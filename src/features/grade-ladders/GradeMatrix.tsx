import { useState } from 'react'
import { Check, History, Pencil } from 'lucide-react'
import type { GradeCriterion, GradeLadderDetail, GradeLevelDetail, GradeRubricVersionRecord } from '../../domain/real-grades'
import { Badge, Button, Modal } from '../../components/ui'
import { GradeCitations, GradeIssues, GradeStatus } from './GradeShared'
import { gradeApprovalBlockers, relevantIssues } from './gradeUi'
import type { GradeSourceSelection } from './GradeSourceInspector'
import { useWorkspace } from '../../app/workspace-context'
import { getEntityLifecycle, isEntityArchived, isEntityRemoved, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, ArchiveStateFilter, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'

interface GradeMatrixActions {
  onSource: (selection: GradeSourceSelection) => void
  onEdit: (level: GradeLevelDetail) => void
  onHistory: (grade: number) => void
  onApprove: (level: GradeLevelDetail) => Promise<void>
}

export function GradeMatrix({ detail, selectedGrade, onGrade, canWrite, pending, unsavedSources, ...actions }: {
  detail: GradeLadderDetail
  selectedGrade: number
  onGrade: (grade: number) => void
  canWrite: boolean
  pending: boolean
  unsavedSources: boolean
} & GradeMatrixActions) {
  const [approving, setApproving] = useState<number | null>(null)
  const { workspace } = useWorkspace()
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>(() => isEntityArchived(workspace, { kind: 'ladder', id: detail.ladder.id }) || detail.levels.some((level) => level.head.grade === selectedGrade && isEntityArchived(workspace, { kind: 'rubric', id: level.head.id })) ? 'all' : 'default')
  const levels = [...detail.levels]
    .filter((level) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'rubric', id: level.head.id }), '', archiveFilter))
    .map((level) => isEntityRemoved(workspace, { kind: 'rubric', id: level.head.id }) ? { ...level, version: null, review: null, approval: null } : level)
    .sort((a, b) => a.head.grade - b.head.grade)
  const competencyRows = new Map<string, { label: string; generations: Set<string> }>()
  for (const level of levels) for (const criterion of level.version?.rubric.criteria ?? []) {
    const current = competencyRows.get(criterion.competencyId)
    if (current) current.generations.add(level.version!.generationId)
    else competencyRows.set(criterion.competencyId, { label: criterion.label, generations: new Set([level.version!.generationId]) })
  }
  const active = levels.find((level) => level.head.grade === selectedGrade) ?? levels[0]
  const approveLevel = levels.find((level) => level.head.grade === approving)

  function header(level: GradeLevelDetail) {
    const target = { kind: 'rubric' as const, id: level.head.id }
    const archived = isEntityArchived(workspace, target)
    const removed = isEntityRemoved(workspace, target)
    const deleting = Boolean(getEntityLifecycle(workspace, target)?.deletingAt || getEntityLifecycle(workspace, { kind: 'ladder', id: detail.ladder.id })?.deletingAt)
    const editable = canWrite && !archived && !removed
    const reasons = gradeApprovalBlockers(detail, level)
    if (!canWrite) reasons.unshift('Only an owner or editor can approve a grade.')
    if (archived) reasons.unshift('Archived grades are read-only. Unarchive the parent and grade first.')
    if (removed) reasons.unshift('This rubric is being deleted or was removed. Finish cleanup before starting new work.')
    if (unsavedSources) reasons.unshift('Finish or discard unsaved source decisions before approval.')
    return <div className="grade-column-header">
      <h3>GS-{level.head.grade}</h3>{deleting ? <Badge tone="warning">Deletion pending</Badge> : level.head.lifecycle?.deletedAt ? <Badge>No rubric</Badge> : <GradeStatus status={level.head.status} />}<ArchivedBadge target={{ kind: 'rubric', id: level.head.id }} />
      <p>{level.head.lifecycle?.deletedAt ? 'Permanently removed. A deliberate new generation is required; history does not fall back to an older version.' : level.version ? `Saved version ${level.version.version}` : 'Draft not generated yet'}{level.approval && level.approval.versionId !== level.version?.id ? ' · older approved version retained' : ''}</p>
      {(archived || removed) && <LifecycleBanner target={target} />}
      <EntityLifecycleActions target={{ kind: 'rubric', id: level.head.id }} name={`${detail.ladder.name} · GS-${level.head.grade}`}
        restoreOnly={Boolean(level.head.lifecycle?.deletedAt)} />
      {level.version?.generationId !== detail.ladder.generationId && level.version && <Badge tone="warning">Previous generation retained</Badge>}
      <div className="flex flex-wrap gap-2"><Button size="sm" icon={Pencil} disabled={!editable || pending || unsavedSources || !level.version || ['queued', 'processing'].includes(level.head.status) || level.version.sourceSetId !== detail.ladder.sourceSetId}
        title={!canWrite ? 'Viewer access is read-only.' : !level.version ? 'Generate a draft first.' : level.version.sourceSetId !== detail.ladder.sourceSetId ? 'Confirm current sources and generate a new version before editing.' : 'Saving appends a version and requests fresh grounding review.'} onClick={() => actions.onEdit(level)}>Edit draft</Button>
        <Button size="sm" variant="ghost" icon={History} onClick={() => actions.onHistory(level.head.grade)}>History</Button></div>
      <Button size="sm" variant="primary" icon={Check} disabled={pending || reasons.length > 0} title={reasons[0]} onClick={() => setApproving(level.head.grade)}>
        {level.head.approvedVersionId === level.version?.id && level.version ? 'Version approved' : 'Approve supported version'}
      </Button>
      {reasons.length > 0 && <details className="grade-approval-reasons"><summary>{level.head.approvedVersionId === level.version?.id && level.version ? 'Immutable approval' : 'Why approval is unavailable'}</summary><ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></details>}
      {level.head.error && <p className="grade-processing-error">{level.head.error.code}: {level.head.error.message}</p>}
    </div>
  }

  function cell(criterion: GradeCriterion | undefined, version: GradeRubricVersionRecord | null) {
    return criterion && version ? <GradeCriterionCell criterion={criterion} version={version} onSource={actions.onSource} />
      : <div className="grade-empty-cell"><Badge tone="warning">No supported expectation yet</Badge><p>This competency has no generated cell for this grade. Nothing is interpolated or assigned a zero score.</p></div>
  }

  return <section className="panel grade-matrix-section" aria-label="Side-by-side GS grade expectations">
    <div className="section-heading"><div><h2>Common competencies, distinct grade expectations</h2><p>Rows align by stable competency IDs, never just names. Older generation results are identified, not silently replaced.</p></div><ArchiveStateFilter value={archiveFilter} onChange={setArchiveFilter} label="Grade archive state" /></div>
    {!levels.length && <p className="p-5 text-[12px] text-muted">No grades match this archive filter. Choose Active and archived to inspect retained grades.</p>}
    <div className="grade-mobile-tabs" role="tablist" aria-label="Choose a GS grade">{levels.map((level) => <button key={level.head.id} id={`grade-tab-${level.head.grade}`} type="button" role="tab" aria-selected={active?.head.grade === level.head.grade} aria-controls="grade-mobile-panel" tabIndex={active?.head.grade === level.head.grade ? 0 : -1}
      onClick={() => onGrade(level.head.grade)} onKeyDown={(event) => {
        const index = levels.findIndex((item) => item.head.grade === level.head.grade)
        const target = event.key === 'ArrowRight' ? (index + 1) % levels.length : event.key === 'ArrowLeft' ? (index - 1 + levels.length) % levels.length : event.key === 'Home' ? 0 : event.key === 'End' ? levels.length - 1 : -1
        if (target < 0) return
        event.preventDefault()
        onGrade(levels[target].head.grade)
        document.getElementById(`grade-tab-${levels[target].head.grade}`)?.focus()
      }}>GS-{level.head.grade}<span>{level.head.status === 'needs-sources' ? 'Needs sources' : level.head.status === 'approved' ? 'Approved' : level.head.status === 'error' ? 'Error' : 'Review'}</span></button>)}</div>
    <div className="grade-matrix-scroll"><table className="grade-matrix"><caption className="sr-only">GS grades aligned by common competency identity. Qualifications are unscored and shown separately below each grade.</caption>
      <thead><tr><th scope="col" className="grade-row-label">Competency / evidence</th>{levels.map((level) => <th scope="col" key={level.head.id}>{header(level)}</th>)}</tr></thead>
      <tbody>{[...competencyRows].map(([id, row]) => <tr key={id}><th scope="row" className="grade-row-label"><strong>{row.label}</strong><code title={id}>{id}</code></th>
        {levels.map((level) => <td key={level.head.id}>{cell(level.version?.rubric.criteria.find((criterion) => criterion.competencyId === id), level.version)}</td>)}</tr>)}
        {!competencyRows.size && <tr><td colSpan={levels.length + 1}><p className="p-6 text-[12px] text-muted">Confirm sources and generate drafts to populate common competency rows. Independent grade progress and evidence gaps will appear here.</p></td></tr>}
        <tr><th scope="row" className="grade-row-label">Minimum qualifications<Badge>Unscored</Badge></th>{levels.map((level) => <td key={level.head.id}><GradeQualifications version={level.version} onSource={actions.onSource} /></td>)}</tr>
        <tr><th scope="row" className="grade-row-label">Grounding review / remaining issues</th>{levels.map((level) => <td key={level.head.id}><GradeLevelReview level={level} /></td>)}</tr>
      </tbody></table></div>
    {active && <div className="grade-mobile-panel" id="grade-mobile-panel" role="tabpanel" aria-labelledby={`grade-tab-${active.head.grade}`}>
      {header(active)}
      {[...competencyRows].map(([id, row]) => <section key={id} className="grade-mobile-competency"><h3>{row.label}</h3>{cell(active.version?.rubric.criteria.find((criterion) => criterion.competencyId === id), active.version)}</section>)}
      <GradeQualifications version={active.version} onSource={actions.onSource} /><GradeLevelReview level={active} />
    </div>}
    {approveLevel && <Modal open onOpenChange={(open) => { if (!open && !pending) setApproving(null) }} title={`Approve GS-${approveLevel.head.grade}, version ${approveLevel.version?.version}?`}
      description="Approval appends an immutable record for this exact reviewed content hash and source set. It does not certify an official classification or candidate eligibility."
      footer={<><Button disabled={pending} onClick={() => setApproving(null)}>Keep reviewing</Button><Button variant="primary" disabled={pending || gradeApprovalBlockers(detail, approveLevel).length > 0 || !canWrite || unsavedSources} onClick={() => { void actions.onApprove(approveLevel).then(() => setApproving(null)).catch(() => setApproving(null)) }}>{pending ? 'Awaiting approval…' : 'Approve this supported version'}</Button></>}>
      <p>Confirm that you reviewed the grade expectations, separate qualifications, exact supporting quotations, and interpretations. Unsupported grades must stay drafts until evidence supports them.</p>
      <div className="grade-hash-label"><span>Exact version</span><code>{approveLevel.version?.id}</code><span>Content hash</span><code>{approveLevel.version?.contentHash}</code><span>Frozen source set</span><code>{approveLevel.version?.sourceSetId}</code></div>
    </Modal>}
  </section>
}

export function GradeCriterionCell({ criterion, version, onSource }: { criterion: GradeCriterion; version: GradeRubricVersionRecord; onSource: (selection: GradeSourceSelection) => void }) {
  const exclusion = criterion.support === 'not-applicable'
  return <article className={`grade-criterion-cell ${criterion.support === 'gap' ? 'is-gap' : ''}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><Badge tone={criterion.support === 'gap' ? 'warning' : 'neutral'}>{criterion.support === 'gap' ? 'Evidence gap · draft' : exclusion ? 'Not applicable · exclusion' : `${criterion.support} support`}</Badge><strong>{exclusion && criterion.weight === 0 ? 'Unscored' : `${criterion.weight}%`}</strong></div>
    <p>{criterion.description}</p>
    <details><summary>{exclusion ? 'Exclusion guidance (unscored)' : 'Evaluation guidance'}</summary><p>{criterion.guidance || 'Guidance remains incomplete.'}</p><p className="text-[10px] text-muted">{exclusion ? 'Excluded from weighting and scoring, not an applicant score of zero.' : 'Reviewer weighting, not OPM classification points.'}</p></details>
    <div className="grade-interpretation"><span className="grade-field-kicker">{exclusion ? 'Exclusion interpretation — not quotation' : 'Interpretation / grade distinction — not quotation'}</span><p>{criterion.interpretation || 'No supported interpretation provided.'}</p></div>
    <GradeCitations citations={[...criterion.gradeBasis, ...(criterion.sourceCitations ?? [])]} onOpen={(citation) => onSource({ citation, sourceSetId: version.sourceSetId })} />
  </article>
}

export function GradeQualifications({ version, onSource }: { version: GradeRubricVersionRecord | null; onSource: (selection: GradeSourceSelection) => void }) {
  return <section className="grade-qualifications"><h3>Minimum qualifications <Badge>Unscored</Badge></h3><p>Required qualifications cannot be offset by weighted work criteria. This is not an eligibility determination.</p>
    {version?.qualifications.map((item) => <article key={item.id}><Badge tone={item.support === 'gap' ? 'warning' : 'neutral'}>{item.support} support</Badge><p>{item.text}</p>
      <div className="grade-interpretation"><span className="grade-field-kicker">Interpretation — not quotation</span><p>{item.interpretation}</p></div><GradeCitations citations={item.citations} onOpen={(citation) => onSource({ citation, sourceSetId: version.sourceSetId })} /></article>)}
    {!version?.qualifications.length && <p>No qualification requirements are captured for this version. Do not infer that none apply.</p>}
  </section>
}

function GradeLevelReview({ level }: { level: GradeLevelDetail }) {
  return <div className="grade-review-result">
    <p>{level.review ? `${level.review.outcome === 'supported' ? 'Grounding review supports' : 'Grounding review needs additional sources for'} version ${level.version?.version ?? '—'}.` : 'No matching grounding review has finished yet.'}</p>
    {level.review && <p className="text-[10px] text-muted">Review {level.review.id} · {level.review.model} · {level.review.promptVersion}</p>}
    {level.approval && <p className="text-[11px] text-muted">Immutable approval {level.approval.id} · {level.approval.createdAt} · reviewer {level.approval.approvedBy}</p>}
    <GradeIssues issues={relevantIssues([...level.head.issues, ...(level.version?.issues ?? []), ...(level.review?.issues ?? [])], level.head.grade)} title="Grade support blockers" />
  </div>
}
