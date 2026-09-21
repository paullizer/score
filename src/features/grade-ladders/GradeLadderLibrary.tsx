import { Link } from 'react-router-dom'
import { ArrowRight, Layers3, LoaderCircle, Plus, RotateCcw } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { clientAdmissionReason, usePublicSettings } from '../../app/public-settings-context'
import { Badge, Button, EmptyState, InlineError } from '../../components/ui'
import { gradeLadderLink } from './gradeUi'
import { GradeDisclaimer, GradeStatus } from './GradeShared'
import { useWorkspace } from '../../app/workspace-context'
import { getEntityLifecycle, isEntityArchived, isEntityRemoved, matchesArchiveFilter, type ArchiveFilter } from '../../domain/lifecycle'
import { ArchivedBadge, EntityLifecycleActions } from '../../components/lifecycle/LifecycleControls'
import { ApprovedGradeAnalysis } from './ApprovedGradeAnalysis'

export function GradeLadderLibrary({ search = '', archiveFilter = 'default' }: { search?: string; archiveFilter?: ArchiveFilter }) {
  const api = useGradeLadders()
  const policy = usePublicSettings()
  const reason = clientAdmissionReason(policy, 'gradeLadders')
  const { workspace } = useWorkspace()
  if (!api) return null
  const visible = api.summaries.filter(({ ladder, levels }) => !ladder.lifecycle?.deletedAt &&
    (matchesArchiveFilter(isEntityArchived(workspace, { kind: 'ladder', id: ladder.id }), search, archiveFilter) ||
      (archiveFilter === 'archived' && levels.some((level) => isEntityArchived(workspace, { kind: 'rubric', id: level.head.id })))) &&
    `${ladder.name} ${ladder.context.series} ${ladder.context.agency} ${ladder.seedJobTitle} ${ladder.grades.map((grade) => `GS-${grade}`).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="grade-library">
    <div className="grade-library-intro"><div><h2>Real, source-grounded GS ladders</h2><p>Each family keeps a frozen seed, captured reference sets, and independent grade versions. Identical names never merge families.</p></div>
      {api.canWrite && api.features?.realGradeLadders && !reason ? <Link to="/grade-ladders/new" className="button button-primary button-md"><Plus size={16} aria-hidden="true" />Create grade ladder</Link>
        : <p className="text-[11px] text-muted">{reason ?? (api.canWrite ? 'New ladder generation is unavailable. Saved families remain readable.' : 'Read-only workspace · an owner or editor can create a ladder.')}</p>}
    </div>
    {api.error && <InlineError>{api.error} <Button size="sm" icon={RotateCcw} onClick={() => void api.refresh()}>Retry service</Button></InlineError>}
    {api.phase === 'loading' && <EmptyState icon={LoaderCircle} title="Loading private grade families" description="Reading every page from the real grade service. No sample content is substituted." />}
    {visible.length > 0 && <div className="grade-family-grid">{visible.map(({ ladder, levels }) => <article className="grade-family-card" key={ladder.id}>
      <div className="flex flex-wrap items-center gap-2"><Layers3 size={17} className="text-accent" aria-hidden="true" /><Badge tone="accent">Real · Series {ladder.context.series}</Badge>
        {getEntityLifecycle(workspace, { kind: 'ladder', id: ladder.id })?.deletingAt ? <Badge tone="warning">Deletion pending</Badge> : <Badge>{ladder.status.replaceAll('-', ' ')}</Badge>}
        <ArchivedBadge target={{ kind: 'ladder', id: ladder.id }} /></div>
      <h3><Link to={gradeLadderLink(ladder.id)}>{ladder.name}</Link></h3>
      <p>{ladder.context.agency || 'Agency context unresolved'} · {ladder.context.supervision}</p>
      <div className="grade-family-seed">Seed: {ladder.seedJobTitle} · rubric v{ladder.seedRubricVersion}</div>
      <ul className="grade-family-levels">{[...levels].filter(({ head }) => matchesArchiveFilter(isEntityArchived(workspace, { kind: 'rubric', id: head.id }), search, archiveFilter)).sort((a, b) => a.head.grade - b.head.grade).map(({ head }) => <li key={head.id}>
        <Link to={gradeLadderLink(ladder.id, head.grade)}>GS-{head.grade}</Link>{head.lifecycle?.deletedAt ? <Badge>No rubric</Badge> : isEntityRemoved(workspace, { kind: 'rubric', id: head.id }) ? <Badge tone="warning">Deletion pending</Badge> : <GradeStatus status={head.status} />}<ArchivedBadge target={{ kind: 'rubric', id: head.id }} />
        <EntityLifecycleActions target={{ kind: 'rubric', id: head.id }} name={`${ladder.name} · GS-${head.grade}`} compact
          restoreOnly={Boolean(head.lifecycle?.deletedAt)} />
      </li>)}</ul>
      <Link to={gradeLadderLink(ladder.id)} className="text-link">{getEntityLifecycle(workspace, { kind: 'ladder', id: ladder.id })?.deletingAt ? 'View cleanup status' : 'Open sources and grade matrix'} <ArrowRight size={14} aria-hidden="true" /></Link>
      <ApprovedGradeAnalysis ladderId={ladder.id} />
      <span className="grade-family-id" title={ladder.id}>Family {ladder.id}</span>
      <EntityLifecycleActions target={{ kind: 'ladder', id: ladder.id }} name={ladder.name} />
    </article>)}</div>}
    {!visible.length && api.phase === 'ready' && <EmptyState icon={Layers3} title={search ? 'No matching real ladders' : 'Prepare your first real GS ladder'}
      description={search ? 'Search a family name, occupational series, agency, seed job, or GS grade.' : 'Choose a ready real job and an exact saved rubric version. Confirm context, review captured sources, then generate distinct supported grade expectations.'}
      action={api.canWrite && api.features?.realGradeLadders && !reason && !search ? <Link to="/grade-ladders/new" className="button button-secondary button-md">Create grade ladder</Link> : undefined} />}
    <GradeDisclaimer />
  </div>
}
