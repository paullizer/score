import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { History, LoaderCircle } from 'lucide-react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import type { GradeLadderDetail, GradeRubricVersionRecord, GradeSourceSetRecord } from '../../domain/real-grades'
import { Badge, Button, EmptyState, InlineError } from '../../components/ui'
import { GradeCitations, GradeIssues } from './GradeShared'
import { GradeCriterionCell, GradeQualifications } from './GradeMatrix'
import { gradeLadderLink } from './gradeUi'
import type { GradeSourceSelection } from './GradeSourceInspector'

export function GradeVersionHistory({ detail, grade, requestedVersion, onSource }: { detail: GradeLadderDetail; grade: number; requestedVersion?: string; onSource: (selection: GradeSourceSelection) => void }) {
  const api = useGradeLadders()
  const service = useRef(api)
  service.current = api
  const [versions, setVersions] = useState<GradeRubricVersionRecord[] | null>(null)
  const [frozen, setFrozen] = useState<GradeSourceSetRecord | null>(null)
  const [error, setError] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [retry, setRetry] = useState(0)
  const level = detail.levels.find((item) => item.head.grade === grade)
  const headVersion = level?.head.latestVersionId
  useEffect(() => {
    const controller = new AbortController()
    setVersions(null)
    setError('')
    void service.current?.versions(detail.ladder.id, grade, controller.signal).then((items) => {
      if (!controller.signal.aborted) setVersions([...items].sort((a, b) => b.version - a.version))
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'History could not be loaded.') })
    return () => controller.abort()
  }, [detail.ladder.id, grade, headVersion, retry])
  const version = requestedVersion ? versions?.find((item) => item.id === requestedVersion || item.rubric.id === requestedVersion) : versions?.[0]
  useEffect(() => {
    const controller = new AbortController()
    setFrozen(null)
    setSourceError('')
    if (version) void service.current?.sourceSet(detail.ladder.id, version.sourceSetId, controller.signal).then((sourceSet) => {
      if (!controller.signal.aborted) setFrozen(sourceSet)
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setSourceError(caught instanceof Error ? caught.message : 'The historical source set could not be loaded.') })
    return () => controller.abort()
  }, [detail.ladder.id, retry, version])

  return <section className="panel grade-version-history" aria-label={`GS-${grade} immutable version history`}>
    <div className="section-heading"><div><h2>GS-{grade} · immutable history</h2><p>Every saved draft keeps its original context, quotations, and source-set version.</p></div><History size={18} aria-hidden="true" /></div>
    {error && <div className="p-5"><InlineError>{error}<Button size="sm" onClick={() => setRetry((value) => value + 1)}>Retry history</Button></InlineError></div>}
    {!versions && !error && <EmptyState icon={LoaderCircle} title="Opening preserved versions" description="Retrieving every immutable version page from the private service." />}
    {versions?.length === 0 && <EmptyState icon={History} title="No saved versions for this grade yet" description="Generate and save a grade draft first. A processing failure is not an unsupported-content judgment." />}
    {versions && versions.length > 0 && <div className="grade-history-layout">
      <nav aria-label={`GS-${grade} saved versions`} className="grade-history-nav">{versions.map((item) => <Link key={item.id} to={gradeLadderLink(detail.ladder.id, grade, item.id)} aria-current={item.id === version?.id ? 'page' : undefined}>
        <strong>Version {item.version}</strong><span>{item.createdAt}</span>{item.id === headVersion && <Badge>Current head</Badge>}{item.id === level?.head.approvedVersionId && <Badge tone="success">Approved version</Badge>}
        {item.generationId !== detail.ladder.generationId && <span>Prior generation</span>}
      </Link>)}</nav>
      <div className="grade-history-content">
        {!version ? <InlineError>The requested version is not in this grade's authorized history. No current version is substituted.</InlineError> : <>
          <div className="flex flex-wrap gap-2"><Badge tone="accent">Real · GS-{version.grade}</Badge><Badge>Version {version.version} · read only</Badge>{version.id === level?.head.approvedVersionId && <Badge tone="success">Reviewer approved</Badge>}</div>
          <h3 className="mt-4 text-lg font-semibold">{version.rubric.name}</h3><p className="mt-2 text-[12px] text-muted">{version.rubric.description}</p>
          <div className="grade-hash-label"><span>Saved by / at</span><code>{version.createdBy} · {version.createdAt}</code><span>Generation</span><code>{version.generationId}</code><span>Immutable version hash</span><code>{version.contentHash}</code><span>Exact source set</span><code>{version.sourceSetId}</code></div>
          {sourceError && <InlineError>{sourceError}<button className="underline" onClick={() => setRetry((value) => value + 1)}>Retry frozen context</button></InlineError>}
          {frozen && <section className="grade-historical-context"><h4>Frozen position context and sources</h4>
            <p>Series {frozen.context.series} · {frozen.context.agency || 'Agency unknown'} · {frozen.context.agencyType} · {frozen.context.supervision} · {frozen.context.functions.join(', ') || 'No selected functional guide'}</p>
            <p>{frozen.context.specialty}</p><p>Requested grades: {frozen.grades.map((item) => `GS-${item}`).join(', ')} · Source-set revision {frozen.revision}</p>
            <ul>{frozen.sources.map((source) => <li key={source.sourceId}><button className="text-link" onClick={() => onSource({ sourceId: source.sourceId, sourceSetId: frozen.id })}>{source.title} · captured v{source.documentVersion}</button><span>{source.completeness}{source.selectedPages.length ? ` · original pages ${source.selectedPages.join(', ')}` : ''}</span></li>)}</ul>
            <GradeIssues issues={frozen.issues} title="Frozen source-set issues" />
          </section>}
          <GradeIssues issues={version.issues} title="Issues recorded with this version" />
          <div className="space-y-4">{version.rubric.criteria.map((criterion) => <section key={criterion.id} className="grade-history-criterion"><h4>{criterion.label}</h4><GradeCriterionCell criterion={criterion} version={version} onSource={onSource} /></section>)}</div>
          <GradeQualifications version={version} onSource={onSource} />
          {version.issues.some((issue) => issue.citations?.length) && <section><h4>Issue evidence</h4><GradeCitations citations={version.issues.flatMap((issue) => issue.citations ?? [])} onOpen={(citation) => onSource({ citation, sourceSetId: version.sourceSetId })} /></section>}
          <p className="mt-4 text-[11px] text-muted">Historical draft status is not inferred from the current grade head. Approval is an immutable server record tied to exact version and review hashes. History cannot be edited or sent to the fixture scorer.</p>
        </>}
      </div>
    </div>}
  </section>
}
