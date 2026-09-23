import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FileSearch, Layers3, Pencil, ShieldCheck, Sparkles } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, EmptyState, InlineError } from '../../components/ui'
import type { Citation, Criterion, Rubric } from '../../domain/types'
import { documentPagination, isUploadFormat, UPLOAD_CONTENT_TYPES } from '../../domain/document-formats'
import { RubricEditor } from './RubricEditor'
import { ArchivedBadge, EntityLifecycleActions, LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'
import { workspaceCanEdit } from '../../domain/workspace-permissions'

const scoreLegend = [
  { value: 0, label: 'No support' },
  { value: 1, label: 'Introductory' },
  { value: 2, label: 'Limited' },
  { value: 3, label: 'Independent' },
  { value: 4, label: 'Substantial' },
  { value: 5, label: 'Sustained' },
]

export function RubricPanel({ rubric, onSelectCriterion, onVersionSaved, readOnly = false }: {
  rubric: Rubric
  onSelectCriterion?: (criterion: Criterion, citation?: Citation) => void
  onVersionSaved?: (id: string) => void
  readOnly?: boolean
}) {
  const { workspace, cloud } = useWorkspace()
  const [editing, setEditing] = useState(false)
  const [initialEditorPanel, setInitialEditorPanel] = useState<'assist' | 'source' | 'changes' | null>(null)
  const [initialFocusCriterionId, setInitialFocusCriterionId] = useState<string | null>(null)
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

  return <div className="min-w-0">
    <div className="section-heading">
      <div><h2>Evaluation rubric</h2><p>{readOnly ? 'Saved version · read only' : 'Transparent criteria. Traceable expectations.'}</p></div>
      <Badge>v{rubric.version}</Badge>
    </div>

    <div className="space-y-5 p-5">
      <LifecycleBanner target={{ kind: 'rubric', id: rubric.groupId }} />
      <EntityLifecycleActions target={{ kind: 'rubric', id: rubric.groupId }} name={rubric.name} />
      <div>
        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone="accent">{rubric.provenance?.kind === 'edited' ? 'Reviewer edited' : 'Generated from source'}</Badge>
          {rubric.grade && <Badge>{rubric.grade}</Badge>}
          <ArchivedBadge target={{ kind: 'rubric', id: rubric.groupId }} />
          <Badge tone={balanced ? 'neutral' : 'warning'}>{Number.isFinite(total) ? `${Number(total.toFixed(6))}% total weight` : 'Invalid total weight'}</Badge>
        </div>
        <h3 className="text-[15px] font-semibold leading-snug">{rubric.name}</h3>
        <p className="mt-2 text-[12px] text-muted">{rubric.description}</p>
      </div>

      <div className="rounded-xl border bg-soft p-3.5">
        <div className="flex items-start gap-2.5">
          {rubric.kind === 'job'
            ? <FileSearch size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            : <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />}
          <div className="min-w-0">
            <p className="text-[11px] font-medium">Grounded in the private source document</p>
            <p className="mt-1 text-[11px] text-muted">
              {rubric.provenance?.kind === 'edited' ? 'A reviewer edited this immutable version.' : 'AI generated this draft from the displayed source.'} Exact quotations link every criterion to a parsed paragraph.
            </p>
            {job && <Link to={`/jobs/${job.id}`} className="text-link mt-2">{job.title}</Link>}
            {rubric.kind === 'job' && !job && <p className="mt-2 text-[11px] text-muted">The linked job is unavailable in this workspace.</p>}
          </div>
        </div>
      </div>

      {!readOnly && <div className="flex flex-wrap gap-2">
        <Button icon={Pencil} size="sm" disabled={!editable} onClick={() => { setError(''); setInitialEditorPanel(null); setInitialFocusCriterionId(null); setEditing(true) }}>Edit rubric</Button>
        {assistantAvailable && <Button icon={Sparkles} size="sm" variant="ghost" onClick={() => { setError(''); setInitialEditorPanel('assist'); setInitialFocusCriterionId(null); setEditing(true) }}>Edit with AI</Button>}
      </div>}
      {!readOnly && !realGrade && <p className="text-[11px] text-muted">Edit rubric includes the name and description. Even a name-only save creates a new version; saved analyses keep their original rubric.</p>}
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
          return <article className="criterion-card" key={criterion.id}>
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-soft font-mono text-[10px] text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-[12px] font-semibold leading-5">{criterion.label}</h4>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {assistantAvailable && <Button size="sm" variant="ghost" icon={Sparkles} aria-label={`Ask AI about ${criterion.label}`} onClick={() => {
                      setInitialEditorPanel('assist')
                      setInitialFocusCriterionId(criterion.id)
                      setEditing(true)
                    }}>Ask AI</Button>}
                    <span className="text-[12px] font-semibold tabular-nums text-accent">{criterion.weight}%</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted">{criterion.description}</p>
                <div className="mt-2"><Badge tone={criterion.requirementType === 'preferred' ? 'neutral' : 'accent'}>{criterion.requirementType === 'preferred' ? 'Preferred' : 'Required'}</Badge></div>
              </div>
            </div>
            <details className="mt-3 border-t pt-3 text-[11px]">
              <summary className="cursor-pointer font-medium text-muted">Score guidance <span className="font-normal">(0–5)</span></summary>
              <p className="mt-2 whitespace-pre-line text-muted">{criterion.guidance || 'No score guidance has been provided.'}</p>
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
          {scoreLegend.map((score) => <li key={score.value} className="rounded-lg border bg-soft px-2 py-2 text-center">
            <span className="block text-[12px] font-semibold">{score.value}</span>
            <span className="mt-1 block text-[9px] text-muted">{score.label}</span>
          </li>)}
        </ol>
        <p className="mt-3 text-[10px] text-muted">Criterion weights produce an overall score out of 100. “Not assessed” means no score was assigned, not a zero.</p>
      </section>
      <p className="library-note-text"><ShieldCheck size={16} aria-hidden="true" /><span>Generated and reviewer-edited rubric versions are source-grounded. Analysis freezes the exact selected version and requires human review.</span></p>
    </div>

    {editing && <RubricEditor
      key={rubric.id}
      rubric={rubric}
      onClose={() => setEditing(false)}
      onSaved={(id) => { setEditing(false); onVersionSaved?.(id) }}
      initialPanel={initialEditorPanel}
      initialFocusCriterionId={initialFocusCriterionId}
    />}
  </div>
}
