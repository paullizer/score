import { useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Download, LoaderCircle } from 'lucide-react'
import { REPORT_FORMATS, type AnalysisReport, type AnalysisReportFormat } from '../../domain/analysis-reports'
import type { RealAnalysisComparisonSummary, RealAnalysisRunDetail } from '../../domain/real-analyses'
import type { AnalysisRun } from '../../domain/types'
import { Badge, Button, InlineError, Modal } from '../../components/ui'

type ReportSource =
  | { kind: 'sample'; run: AnalysisRun }
  | { kind: 'real'; workspaceId: string; detail: RealAnalysisRunDetail; comparisons: RealAnalysisComparisonSummary[] | null; available: boolean }

const descriptions: Record<AnalysisReportFormat, string> = {
  csv: 'A spreadsheet-ready row for each candidate and job/grade, with individual criterion scores, overall assessment, and status metadata.',
  pdf: 'A ready-to-share document with top evidence matches, followed by each candidate\'s full saved assessment and evidence.',
  docx: 'An editable Word document with summary tables and detailed, source-cited candidate reviews.',
  pptx: 'An editable widescreen presentation with top evidence matches, candidate overviews, and evidence detail slides.',
}

export function AnalysisReportExport({ source }: { source: ReportSource }) {
  const location = useLocation()
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<AnalysisReportFormat>('pdf')
  const [targetId, setTargetId] = useState('')
  const [stage, setStage] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const active = useRef<AbortController | null>(null)
  const identity = source.kind === 'sample' ? `sample:${source.run.id}` : `${source.workspaceId}:${source.detail.run.id}`
  const historyAvailable = source.kind === 'sample' || source.available
  useEffect(() => {
    setOpen(false)
    setTargetId('')
    setStage(null)
    setProgress(null)
    setError('')
    setSuccess('')
    return () => { active.current?.abort(); active.current = null }
  }, [identity, location.key])
  useEffect(() => {
    if (historyAvailable || !active.current) return
    active.current.abort()
    active.current = null
    setStage(null)
    setProgress(null)
    setError('Saved analysis access became unavailable. No file was downloaded. Reload the analysis before retrying.')
  }, [historyAvailable])

  const targets = source.kind === 'sample'
    ? source.run.targets.map((target) => ({ id: target.id, label: `${target.label} / rubric v${target.rubric.version}` }))
    : source.detail.targets.map((target) => ({ id: target.id, label: `${target.label} / rubric v${target.rubricVersion}` }))
  const targetLabelCounts = new Map<string, number>()
  for (const target of targets) targetLabelCounts.set(target.label, (targetLabelCounts.get(target.label) ?? 0) + 1)
  const comparisons = source.kind === 'sample' ? source.run.comparisons.map((comparison) => ({ targetId: comparison.targetId, status: comparison.status }))
    : source.comparisons?.map(({ comparison }) => ({ targetId: comparison.target.summary.id, status: comparison.status })) ?? []
  const selected = comparisons.filter((comparison) => !targetId || comparison.targetId === targetId)
  const complete = selected.filter((comparison) => comparison.status === 'complete').length
  const candidateCount = source.kind === 'sample' ? source.run.resumes.length : source.detail.resumes.length
  const ready = source.kind === 'sample' || (source.available && source.comparisons !== null)
  const totalComplete = comparisons.filter((comparison) => comparison.status === 'complete').length
  const disabledReason = !ready ? 'Load the saved analysis and its comparison list before exporting.'
    : totalComplete === 0 ? 'At least one completed comparison is needed. A withheld overall score is still exportable.' : ''
  const busy = stage !== null

  function cancel() {
    active.current?.abort()
    active.current = null
    setStage(null)
    setProgress(null)
  }
  function changeOpen(value: boolean) {
    if (!value) cancel()
    setError('')
    setSuccess('')
    setOpen(value)
  }
  async function exportReport() {
    if (active.current || !ready || complete === 0) return
    const controller = new AbortController()
    active.current = controller
    const { signal } = controller
    const current = () => active.current === controller && !signal.aborted
    setError('')
    setSuccess('')
    setProgress(null)
    setStage('Capturing saved analysis and evidence')
    try {
      let report: AnalysisReport
      if (source.kind === 'sample') {
        const snapshot = structuredClone(source.run)
        const { buildSampleAnalysisReport } = await import('../../services/analysisReports/sample')
        signal.throwIfAborted()
        report = buildSampleAnalysisReport(snapshot, { ...(targetId ? { targetId } : {}) })
      } else {
        const { loadRealAnalysisReport } = await import('../../services/analysisReports/real')
        signal.throwIfAborted()
        report = await loadRealAnalysisReport(source.workspaceId, source.detail.run.id, {
          ...(targetId ? { targetId } : {}), signal,
          onProgress: (completed, total) => {
            if (current()) { setStage('Loading frozen report evidence'); setProgress({ completed, total }) }
          },
        })
      }
      signal.throwIfAborted()
      if (!current()) return
      setProgress(null)
      setStage('Preparing report download')
      const { generateReportInWorker, downloadAnalysisReport } = await import('../../services/analysisReports/client')
      signal.throwIfAborted()
      const bytes = await generateReportInWorker(report, format, {
        signal, onProgress: (message) => { if (current()) setStage(message) },
      })
      if (!current()) return
      const filename = downloadAnalysisReport(bytes, report, format, signal)
      setSuccess(`Download started: ${filename}`)
    } catch (caught) {
      if (current()) setError(caught instanceof Error && caught.name === 'TimeoutError'
        ? 'Report generation exceeded its time limit. Try exporting one job or grade at a time; no incomplete file was downloaded.'
        : caught instanceof Error ? caught.message : 'The report could not be prepared. No file was downloaded.')
    } finally {
      if (active.current === controller) { active.current = null; setStage(null); setProgress(null) }
    }
  }

  return <>
    <Button icon={Download} disabled={Boolean(disabledReason)} title={disabledReason || 'Export this grouped analysis, not just the open comparison.'}
      onClick={() => changeOpen(true)}>Export report</Button>
    <Modal open={open} onOpenChange={changeOpen} title="Export analysis report"
      description="Download the saved scores and evidence. Exporting does not run another AI assessment."
      footer={<>
        <Button onClick={() => changeOpen(false)}>{busy ? 'Cancel export' : 'Close'}</Button>
        <Button variant="primary" icon={busy ? LoaderCircle : Download} disabled={busy || !ready || complete === 0} onClick={() => void exportReport()}>
          {busy ? 'Preparing report...' : `Download ${REPORT_FORMATS[format].label}`}
        </Button>
      </>}>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2"><Badge tone={source.kind === 'sample' ? 'warning' : 'accent'}>
          {source.kind === 'sample' ? 'Fictional sample' : 'Saved real evidence'}
        </Badge>{complete < selected.length && <Badge tone="warning">Partial report</Badge>}</div>
        <div><label className="mb-2 block text-[12px] font-semibold" htmlFor={`${fieldId}-format`}>Report format</label>
          <select id={`${fieldId}-format`} className="filter-select w-full" value={format} disabled={busy} onChange={(event) => {
            const value = event.target.value
            if (value === 'csv' || value === 'pdf' || value === 'docx' || value === 'pptx') { setFormat(value); setError(''); setSuccess('') }
          }}>
            {Object.entries(REPORT_FORMATS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
          </select><p className="mt-2 text-[11px] text-muted">{descriptions[format]}</p></div>
        {targets.length > 1 && <div><label className="mb-2 block text-[12px] font-semibold" htmlFor={`${fieldId}-target`}>Report scope</label>
          <select id={`${fieldId}-target`} className="filter-select w-full" value={targetId} disabled={busy} onChange={(event) => { setTargetId(event.target.value); setError(''); setSuccess('') }}>
            <option value="">Entire analysis - all jobs and grades</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.label}{(targetLabelCounts.get(target.label) ?? 0) > 1 ? ` [${target.id}]` : ''}</option>)}
          </select></div>}
        <div className="rounded-xl border p-4 text-[12px]">
          <p className="font-semibold">{candidateCount} {candidateCount === 1 ? 'candidate' : 'candidates'} / {selected.length} {selected.length === 1 ? 'comparison' : 'comparisons'}</p>
          <p className="mt-1 text-muted">{complete} complete; {selected.length - complete} unfinished, failed, or cancelled. Completed assessments with withheld scores are included.</p>
          {complete > 0 && complete < selected.length && <p className="mt-2 text-muted">This is a partial report. Statuses are captured when export starts; later completions are not added to that same report.</p>}
          {complete === 0 && <p className="mt-2 text-muted">Choose a scope with at least one completed comparison, or wait for an assessment to finish.</p>}
        </div>
        <p className="text-[11px] text-muted">Document summaries highlight the top five evidence matches for each exact job/grade, include cutoff ties up to ten, and note any additional ties. Every candidate in scope stays in the detailed report. CSV includes the same ranks and highlight indicators.</p>
        <p className="text-[11px] text-muted">Scores are evidence-review aids, not hiring recommendations or official GS eligibility findings. Reports contain candidate information; keep downloaded files private and share only with authorized reviewers.</p>
        {stage && <div className="space-y-2" role="status" aria-live="polite"><p className="flex items-center gap-2 text-[12px]"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" />{stage}</p>
          {progress && <><progress className="w-full" max={Math.max(1, progress.total)} value={progress.completed} aria-label="Report comparisons prepared" /><p className="text-[11px] text-muted">{progress.completed} / {progress.total} comparisons prepared</p></>}
        </div>}
        {(error || !ready) && <InlineError>{error || disabledReason}</InlineError>}
        {success && <p className="break-words text-[12px]" role="status">{success}</p>}
      </div>
    </Modal>
  </>
}
