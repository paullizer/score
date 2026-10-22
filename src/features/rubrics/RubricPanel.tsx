import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, FileSearch, Layers3, Pencil, Sparkles } from 'lucide-react'
import { useAiTerminology } from '../../app/public-settings-context'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, EmptyState, InlineError } from '../../components/ui'
import { EVIDENCE_SCALE_V1 } from '../../domain/evidence-scale'
import { buildRubricFixInstruction, criterionNames, findingCategoryLabel, type RubricCheckState } from '../../domain/rubric-approval'
import type { RubricQaFinding } from '../../domain/rubric-qa'
import type { Citation, Criterion, Rubric } from '../../domain/types'
import { documentPagination, isUploadFormat, UPLOAD_CONTENT_TYPES } from '../../domain/document-formats'
import { RubricEditor } from './RubricEditor'
import { ArchivedBadge, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { workspaceCanEdit } from '../../domain/workspace-permissions'
import { SCORE_LEGEND } from '../../domain/rubric-exports'
import { RubricExport } from './RubricExport'
import { RubricApprovalCard, RubricStatusBadge } from './RubricApproval'
import { useRubricApproval } from './useRubricApproval'

export function RubricPanel({ rubric, onSelectCriterion, onVersionSaved, readOnly = false }: {
  rubric: Rubric
  onSelectCriterion?: (criterion: Criterion, citation?: Citation) => void
  onVersionSaved?: (id: string) => void
  readOnly?: boolean
}) {
  const { workspace, cloud } = useWorkspace()
  const terms = useAiTerminology()
  const [editing, setEditing] = useState(false)
  const [initialEditorPanel, setInitialEditorPanel] = useState<'assist' | 'source' | 'changes' | null>(null)
  const [initialFocusCriterionId, setInitialFocusCriterionId] = useState<string | null>(null)
  const [initialAssistInstruction, setInitialAssistInstruction] = useState<string | null>(null)
  const [loadedChecks, setLoadedChecks] = useState<RubricCheckState | null>(null)
  const [error, setError] = useState('')
  const { canEdit } = useLifecycleAccess({ kind: 'rubric', id: rubric.groupId })
  const job = workspace.jobs.find((item) => item.id === rubric.jobId)
  const document = workspace.documents.find((item) => item.id === job?.documentId)
  const pagination = job ? documentPagination(cloud.realJobs.source(job.id)?.originalContentType
    ?? (isUploadFormat(job.source) ? UPLOAD_CONTENT_TYPES[job.source] : undefined)) : 'pdf-pages'
  const sourceLocation = (page: number) => pagination === 'pdf-pages' ? `p. ${page}`
    : `${pagination === 'markdown-sections' ? 'Markdown' : pagination === 'html-sections' ? 'HTML' : 'Captured'} section ${page}`
  const realGrade = rubric.kind === 'grade'
  const roleReadOnly = !workspaceCanEdit(cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.role)
  const editable = canEdit && !readOnly && !realGrade && !roleReadOnly && job?.status === 'ready' && !job.rubricDeletedAt && Boolean(document)
  const detail = job ? cloud.realJobs.detail(job.id) : undefined
  const assistantAvailable = Boolean(editable && job && detail?.state === 'ready' && document && cloud.realJobs.features?.rubricAssistant)
  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const balanced = Number.isFinite(total) && Math.abs(total - 100) <= 0.000001
  const { status: approvalStatus, qaSummary } = useRubricApproval(rubric)
  const activeFindings: RubricQaFinding[] = approvalStatus === 'draft'
    ? (loadedChecks && loadedChecks.rubricId === rubric.id && loadedChecks.version === rubric.version && loadedChecks.checks
      ? [...loadedChecks.checks.checks, ...loadedChecks.checks.review.findings]
      : qaSummary?.findings ?? [])
    : []

  function openManualEdit(focusCriterionId: string | null = null) {
    setError('')
    setInitialEditorPanel(null)
    setInitialFocusCriterionId(focusCriterionId)
    setInitialAssistInstruction(null)
    setEditing(true)
  }

  function openAiFix(findings: readonly RubricQaFinding[], focusCriterionId: string | null = null) {
    setError('')
    setInitialEditorPanel('assist')
    setInitialFocusCriterionId(focusCriterionId ?? findings[0]?.criterionIds[0] ?? null)
    setInitialAssistInstruction(buildRubricFixInstruction(rubric, findings))
    setEditing(true)
  }

  return <div className="min-w-0">
    <div className="section-heading">
      <div><h2>Evaluation rubric</h2>{readOnly && <p>Saved version · read only</p>}</div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2"><RubricExport rubric={rubric} /><Badge>v{rubric.version}</Badge></div>
    </div>

    <div className="space-y-5 p-5">
      <LifecycleBanner target={{ kind: 'rubric', id: rubric.groupId }} />
      <EntityLifecycleActions target={{ kind: 'rubric', id: rubric.groupId }} name={rubric.name} />

      <RubricApprovalCard
        rubric={rubric}
        readOnly={readOnly}
        assistantAvailable={assistantAvailable}
        editable={editable}
        onFixWithAi={openAiFix}
        onEditManually={openManualEdit}
        onChecksLoaded={setLoadedChecks}
      />

      <div>
        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone="accent">{rubric.provenance?.kind === 'edited' ? 'Reviewer edited' : 'Generated from source'}</Badge>
          {rubric.kind === 'job' && <RubricStatusBadge status={approvalStatus} />}
          {rubric.grade && <Badge>{rubric.grade}</Badge>}
          <ArchivedBadge target={{ kind: 'rubric', id: rubric.groupId }} />
          <Badge tone={balanced ? 'neutral' : 'warning'}>{Number.isFinite(total) ? `${Number(total.toFixed(6))}% total weight` : 'Invalid total weight'}</Badge>
        </div>
        <h3 className="text-[15px] font-semibold leading-snug">{rubric.name}</h3>
        <p className="mt-2 text-[12px] text-muted">{rubric.description}</p>
      </div>

      {rubric.kind === 'job' && (job ? <p className="text-[12px] text-muted">Linked job: <Link to={`/jobs/${job.id}`} className="text-link">{job.title}</Link></p> : <p className="text-[12px] text-muted">The linked job is unavailable in this workspace.</p>)}

      {!readOnly && <div className="flex flex-wrap gap-2">
        <Button icon={Pencil} size="sm" disabled={!editable} onClick={() => openManualEdit(null)}>Edit rubric</Button>
        {assistantAvailable && <Button icon={Sparkles} size="sm" variant="ghost" onClick={() => { setError(''); setInitialEditorPanel('assist'); setInitialFocusCriterionId(null); setInitialAssistInstruction(null); setEditing(true) }}>{terms.editWithAi}</Button>}
      </div>}
      {!readOnly && !editable && <p className="text-[11px] text-muted">{realGrade ? 'Open the real grade family to edit a draft with its separate grounding-review and approval safeguards.' : roleReadOnly ? 'This workspace is read-only. An owner or editor can change real rubrics.' : 'Finish the linked job import and load its source before editing this rubric.'}</p>}
      {error && <InlineError>{error}</InlineError>}
      {!balanced && <InlineError>These criterion weights do not total 100%. {readOnly ? 'Open the current version to review the rubric.' : 'Edit the rubric to correct its weights before analysis.'}</InlineError>}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Scoring criteria</h3>
          <span className="text-[10px] text-muted">{rubric.criteria.length} {rubric.criteria.length === 1 ? 'criterion' : 'criteria'}</span>
        </div>
        {rubric.criteria.map((criterion, index) => {
          const citations = criterion.sourceCitations?.length ? criterion.sourceCitations : []
          const source = document?.paragraphs.find((paragraph) => paragraph.id === (citations[0]?.paragraphId ?? criterion.sourceParagraphId))
          const criterionFindings = activeFindings.filter((finding) => finding.criterionIds.includes(criterion.id))
          return <article className={`criterion-card ${criterionFindings.length > 0 ? 'is-flagged' : ''}`} key={criterion.id}>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-soft font-mono text-[10px] text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-[12px] font-semibold leading-5">{criterion.label}</h4>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {criterionFindings.length > 0 && <Badge tone={criterionFindings.some((item) => item.severity === 'blocker') ? 'danger' : 'warning'}>{findingCategoryLabel(criterionFindings[0]!.code)}</Badge>}
                    {assistantAvailable && <Button size="sm" variant="ghost" icon={Sparkles} aria-label={`${terms.askAi} about ${criterion.label}`} onClick={() => {
                      setInitialEditorPanel('assist')
                      setInitialFocusCriterionId(criterion.id)
                      setInitialAssistInstruction(null)
                      setEditing(true)
                    }}>{terms.askAi}</Button>}
                    <span className="text-[12px] font-semibold tabular-nums text-accent">{criterion.weight}%</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted">{criterion.description}</p>
                <div className="mt-2"><Badge tone={criterion.requirementType === 'preferred' ? 'neutral' : 'accent'}>{criterion.requirementType === 'preferred' ? 'Preferred' : 'Required'}</Badge></div>
                {criterionFindings.map((finding, findingIndex) => (
                  <div className="criterion-finding-callout" key={`${finding.code}-${findingIndex}`}>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 font-medium">
                        <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
                        <span>{findingCategoryLabel(finding.code)}</span>
                        {finding.criterionIds.length > 1 && <span className="text-[10px]">({criterionNames(rubric, finding)})</span>}
                      </p>
                      <p className="mt-1">{finding.message}</p>
                    </div>
                    {assistantAvailable && (
                      <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => openAiFix([finding], criterion.id)}>
                        {terms.fixWithAi}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <details className="mt-3 border-t pt-3 text-[11px]">
              <summary className="cursor-pointer font-medium text-muted">Score guidance <span className="font-normal">(0–5)</span></summary>
              {rubric.scaleVersion && criterion.levels ? <div className="mt-2 space-y-2 text-muted">
                <p><strong>0 · {EVIDENCE_SCALE_V1.levels[0].label}.</strong> {EVIDENCE_SCALE_V1.levels[0].description}</p>
                {criterion.levels.map((level, levelIndex) => <p key={level.level}><strong>{level.level} · {EVIDENCE_SCALE_V1.levels[levelIndex + 1].label}.</strong> {EVIDENCE_SCALE_V1.levels[levelIndex + 1].description} Examples: {level.examples}</p>)}
                <p>{EVIDENCE_SCALE_V1.tieRule} {EVIDENCE_SCALE_V1.basis}</p>
              </div> : <p className="mt-2 whitespace-pre-line text-muted">{criterion.guidance || 'No score guidance has been provided.'}</p>}
            </details>
            {citations.length > 0 && job && <div className="mt-3 space-y-3">{citations.map((citation, citationIndex) => {
              const citationSource = document?.paragraphs.find((paragraph) => paragraph.id === citation.paragraphId)
              return <div className="space-y-2" key={`${citation.paragraphId}-${citationIndex}`}>
                <blockquote className="source-quote">“{citation.quote}”</blockquote>
                {citationSource && (onSelectCriterion
                  ? <button type="button" className="link-button inline-flex items-start gap-1.5 text-[10px]" onClick={() => onSelectCriterion(criterion, citation)}>
                    <FileSearch size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>View exact source · {sourceLocation(citationSource.page)} · {citationSource.heading}</span>
                  </button>
                  : <Link to={`/jobs/${job.id}`} className="text-link text-[10px]">
                    <FileSearch size={13} aria-hidden="true" />Job source · {sourceLocation(citationSource.page)} · {citationSource.heading}
                  </Link>)}
                {!citationSource && <p className="text-[10px] text-muted">This cited source paragraph is unavailable.</p>}
              </div>
            })}</div>}
            {!citations.length && source && job && <div className="mt-3">
              {onSelectCriterion
                ? <button type="button" className="link-button inline-flex items-start gap-1.5 text-[10px]" onClick={() => onSelectCriterion(criterion)}>
                  <FileSearch size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>View source · {sourceLocation(source.page)} · {source.heading}</span>
                </button>
                : <Link to={`/jobs/${job.id}`} className="text-link text-[10px]">
                  <FileSearch size={13} aria-hidden="true" />Job source · {sourceLocation(source.page)} · {source.heading}
                </Link>}
            </div>}
            {!citations.length && <div className="mt-3"><InlineError>This criterion has no exact source citation. Review the generated rubric before saving edits.</InlineError></div>}
            {criterion.sourceParagraphId && !source && <p className="mt-3 text-[10px] text-muted">The linked source paragraph is unavailable.</p>}
          </article>
        })}
        {!rubric.criteria.length && <EmptyState icon={Layers3} title="No criteria in this version" description="A rubric needs criteria and weights before it can be used for comparison." />}
      </div>

      <section className="border-t pt-4" aria-label="Criterion score legend">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-medium">The 0–5 score scale</h3>
          <span className="text-[10px] text-muted">Per criterion</span>
        </div>
        <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {SCORE_LEGEND.map((score) => <li key={score.value} className="rounded-lg border bg-soft px-2 py-2 text-center">
            <span className="block text-[12px] font-semibold">{score.value}</span>
            <span className="mt-1 block text-[9px] text-muted">{score.label}</span>
          </li>)}
        </ol>
        <p className="mt-3 text-[10px] text-muted">Criterion weights produce an overall score out of 100. “Not assessed” means no score was assigned, not a zero.</p>
      </section>
    </div>

    {editing && <RubricEditor
      key={rubric.id}
      rubric={rubric}
      onClose={() => setEditing(false)}
      onSaved={(id) => { setEditing(false); onVersionSaved?.(id) }}
      initialPanel={initialEditorPanel}
      initialFocusCriterionId={initialFocusCriterionId}
      initialAssistInstruction={initialAssistInstruction}
    />}
  </div>
}
