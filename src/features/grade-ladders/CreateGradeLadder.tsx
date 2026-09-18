import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Layers3, LoaderCircle } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import { Badge, Button, EmptyState, InlineError, Modal, PageHeader } from '../../components/ui'
import type { GradeContext } from '../../domain/real-grades'
import { GradeContextFields } from './GradeContextFields'
import { GradeDisclaimer } from './GradeShared'
import { contextErrors, gradeLadderLink } from './gradeUi'
import { useGradeRequestKey } from './grade-request-hooks'

const blankContext: GradeContext = { series: '', agency: '', agencyType: 'unknown', supervision: 'unknown', functions: [], specialty: '', confirmed: false, answers: {} }

export function CreateGradeLadder() {
  const { workspace, cloud } = useWorkspace()
  const api = useGradeLadders()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [jobId, setJobId] = useState(params.get('job') ?? '')
  const [rubricId, setRubricId] = useState(params.get('rubric') ?? '')
  const [rubricVersion, setRubricVersion] = useState(Number(params.get('rubricVersion')) || 0)
  const [name, setName] = useState('')
  const [context, setContext] = useState<GradeContext>(blankContext)
  const [grades, setGrades] = useState<number[]>([])
  const [seedConfirmed, setSeedConfirmed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const appliedJob = useRef<string | null>(null)
  const submitted = useRef(false)
  const live = useRef(true)
  const guard = useGradeLeaveGuard(dirty, saving, 'Create grade ladder')
  const requestKey = useGradeRequestKey()
  const jobs = workspace.jobs.filter((job) => job.dataKind === 'real' && job.status === 'ready')
  const job = jobs.find((item) => item.id === jobId)
  const detail = cloud?.realJobs.detail(jobId)
  const selectedRubric = detail?.state === 'ready' ? (rubricId ? [...detail.value.rubricVersions].sort((a, b) => b.version - a.version).find((rubric) => rubric.id === rubricId && (!rubricVersion || rubric.version === rubricVersion)) : detail.value.rubric) : null
  const ensureJob = cloud?.realJobs.ensureDetail

  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { if (jobId) void ensureJob?.(jobId) }, [ensureJob, jobId])
  useEffect(() => {
    if (!job || appliedJob.current === job.id) return
    appliedJob.current = job.id
    setName(`${job.title} · GS ladder`.slice(0, 160))
    setContext({ ...blankContext, series: /^\d{4}$/.test(job.series) ? job.series : '', agency: job.organization })
    setSeedConfirmed(false)
  }, [job])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitted.current || !api) return
    const errors = contextErrors(name, context, grades)
    if (!job || !selectedRubric || !seedConfirmed) errors.unshift('Select a ready real job and confirm its exact saved rubric version.')
    if (errors.length) { setError(errors.join(' ')); return }
    submitted.current = true
    setSaving(true)
    setError('')
    const input = { name: name.trim(), jobId, rubricId: selectedRubric!.id, rubricVersion: selectedRubric!.version, context, grades }
    try {
      const detail = await api.create(input, requestKey('create', input))
      if (!live.current) return
      setDirty(false)
      setSaving(false)
      guard.release()
      navigate(gradeLadderLink(detail.ladder.id), { replace: true })
    } catch (caught) {
      if (live.current) setError(`${caught instanceof Error ? caught.message : 'The ladder could not be created.'} Retrying unchanged inputs reuses the same request key; no second family is intentionally created.`)
    } finally {
      submitted.current = false
      if (live.current) setSaving(false)
    }
  }

  if (!api || api.phase === 'unavailable') return <EmptyState icon={Layers3} title="Real grade ladders are unavailable" description="Open an authenticated workspace with grade processing enabled. The Samples view is separate and is not a replacement for real sources." action={<Link className="button button-secondary button-md" to="/rubrics?kind=grade">Back to rubrics</Link>} />
  const disabled = !api.canWrite || saving || api.mutationPending || api.phase !== 'ready'
  const close = () => { void guard.close(() => navigate('/rubrics?kind=grade&data=real', { replace: true })) }
  return <>
    <PageHeader eyebrow="PRIVATE GS GRADE LIBRARY" title="Create a grade ladder" description="Start from a saved real job, not a sample or an inferred occupational series." />
    <GradeDisclaimer />
    <Modal open onOpenChange={(open) => { if (!open) close() }} title="Create grade ladder" description="Capture a seed job and saved rubric version. Automatic OPM discovery continues durably on the server." wide
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="create-grade-ladder" icon={saving ? LoaderCircle : Layers3} disabled={disabled}>{saving ? 'Capturing seed…' : 'Create and discover sources'}</Button></>}>
      {!api.canWrite && <InlineError>This workspace is read-only. An owner or editor can create a ladder.</InlineError>}
      {api.error && <InlineError>{api.error} <button className="underline" onClick={() => void api.refresh()}>Retry availability</button></InlineError>}
      <form id="create-grade-ladder" onSubmit={submit} noValidate className="space-y-5">
        <fieldset disabled={disabled} className="space-y-4">
          <label className="field"><span className="field-label">Ready real job</span><select className="input" aria-label="Ready real job" value={jobId} required onChange={(event) => { setJobId(event.target.value); setRubricId(''); setRubricVersion(0); setSeedConfirmed(false); setDirty(true) }}>
            <option value="">Choose a ready real job</option>{jobs.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.organization}</option>)}
          </select><span className="field-hint">Samples and unfinished imports cannot seed a real grade ladder.</span></label>
          {!jobs.length && <p className="text-[12px] text-muted">{cloud?.realJobs.phase === 'loading' ? 'Loading real jobs…' : 'Import a real job and wait for its source-grounded rubric before starting.'}</p>}
          {jobId && detail?.state === 'error' && <InlineError>{detail.error}<button type="button" className="ml-2 underline" onClick={() => void ensureJob?.(jobId, true)}>Retry seed loading</button></InlineError>}
          {jobId && detail?.state !== 'ready' && detail?.state !== 'error' && <p role="status" className="text-[12px] text-muted">Loading the captured job source and saved rubric versions…</p>}
          {detail?.state === 'ready' && <label className="field"><span className="field-label">Saved seed rubric version</span><select className="input" aria-label="Saved seed rubric version" value={selectedRubric ? `${selectedRubric.id}:${selectedRubric.version}` : ''} onChange={(event) => {
            const selected = detail.value.rubricVersions.find((rubric) => `${rubric.id}:${rubric.version}` === event.target.value)
            if (selected) { setRubricId(selected.id); setRubricVersion(selected.version) }
            setSeedConfirmed(false); setDirty(true)
          }}>
            {[...detail.value.rubricVersions].sort((a, b) => b.version - a.version).map((rubric) => <option key={`${rubric.id}:${rubric.version}`} value={`${rubric.id}:${rubric.version}`}>v{rubric.version} · {rubric.name}</option>)}
          </select></label>}
          {selectedRubric && <div className="grade-seed-summary"><Badge tone="accent">Real seed · v{selectedRubric.version}</Badge><p>{selectedRubric.criteria.length} source-linked criteria. This exact saved version, job, and original evidence are captured without changing the job rubric.</p></div>}
          <label className="check-label"><input type="checkbox" checked={seedConfirmed} disabled={!selectedRubric} onChange={(event) => { setSeedConfirmed(event.target.checked); setDirty(true) }} />I confirm this saved job/rubric version as the seed.</label>
        </fieldset>
        <GradeContextFields name={name} context={context} grades={grades} disabled={disabled}
          onName={(value) => { setName(value); setDirty(true) }} onContext={(value) => { setContext(value); setDirty(true) }} onGrades={(value) => { setGrades(value); setDirty(true) }} />
        {error && <InlineError>{error}</InlineError>}
        <p className="text-[11px] text-muted">Discovery follows real OPM catalog references for any GS series. Missing, retired, ambiguous, and contradictory standards are shown explicitly. Unsupported grades remain drafts; there is no custom approval bypass.</p>
      </form>
    </Modal>
  </>
}
