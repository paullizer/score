import { useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Download, LoaderCircle } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { REPORT_FORMATS, type AnalysisReport, type AnalysisReportFormat } from '../../domain/analysis-reports'
import type { RealAnalysisComparisonSummary, RealAnalysisRunDetail } from '../../domain/real-analyses'
import type { AnalysisRun } from '../../domain/types'
import { Badge, Button, InlineError, Modal } from '../../components/ui'
import { AnalysisSummaryStatus } from './AnalysisSummaries'

type ReportSource =
  | { kind: 'sample'; run: AnalysisRun; available: boolean }
  | { kind: 'real'; workspaceId: string; detail: RealAnalysisRunDetail; comparisons: RealAnalysisComparisonSummary[] | null; available: boolean }

const descriptions: Record<AnalysisReportFormat, string> = {
  csv: 'A spreadsheet-ready row for each completed candidate and job/grade review, with criterion scores, a brief assessment, and links to the saved analysis and sources.',
  pdf: 'A document with linked contents, current job / grade overviews, highlighted candidate assessments, and every completed candidate at a glance, with links to the saved evidence.',
  docx: 'The same content and section order as PDF, with linked contents, saved summaries, featured reviews, and all completed candidates at a glance, in an editable Word document.',
  pptx: 'An editable presentation with linked contents, current job / grade overviews, up to three slides per highlighted match, and every completed candidate at a glance. Oversized scorecards link to the full review.',
}

export function AnalysisReportExport({ source, onManageSummaries }: { source: ReportSource; onManageSummaries?: (targetId?: string) => void }) {
  const location = useLocation()
  const { cloud } = useWorkspace()
  const analyses = useRealAnalyses()
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<AnalysisReportFormat>('pdf')
  const [targetId, setTargetId] = useState('')
  const [stage, setStage] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const active = useRef<AbortController | null>(null)
  const identity = source.kind === 'sample' ? `${cloud?.currentWorkspaceId ?? 'standalone'}:sample:${source.run.id}` : `${source.workspaceId}:${source.detail.run.id}`
  const historyAvailable = source.available
  const requiresSummaries = format !== 'csv'
  const runId = source.kind === 'real' ? source.detail.run.id : null
  const workspaceId = source.kind === 'real' ? source.workspaceId : null
  const summaryEntry = runId ? analyses?.narratives?.(runId, targetId || undefined) : undefined
  const ensureSummaries = analyses?.ensureNarratives
  const [checkingSummaries, setCheckingSummaries] = useState(false)
  useEffect(() => {
    if (!open || !requiresSummaries || !runId || !historyAvailable || !ensureSummaries) return
    let current = true
    setCheckingSummaries(true)
    void ensureSummaries(runId, targetId || undefined, true).finally(() => { if (current) setCheckingSummaries(false) })
    return () => { current = false }
  }, [ensureSummaries, format, historyAvailable, open, requiresSummaries, runId, targetId, workspaceId])
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
  const unfinished = selected.filter((comparison) => comparison.status === 'queued' || comparison.status === 'running').length
  const failed = selected.filter((comparison) => comparison.status === 'failed').length
  const cancelled = selected.filter((comparison) => comparison.status === 'cancelled').length
  const countLabel = !targetId && targets.length > 1 ? 'candidate-job reviews' : selected.length === 1 ? 'candidate' : 'candidates'
  const ready = historyAvailable && (source.kind === 'sample' || source.comparisons !== null)
  const totalComplete = comparisons.filter((comparison) => comparison.status === 'complete').length
  const disabledReason = !historyAvailable ? 'This analysis is not currently available to read or export.'
    : !ready ? 'Load the saved analysis and its comparison list before exporting.'
    : totalComplete === 0 ? 'At least one completed comparison is needed. A withheld overall score is still exportable.' : ''
  const busy = stage !== null
  const summaries = summaryEntry?.state === 'ready' ? summaryEntry.value : null
  const summaryError = summaryEntry?.state === 'ready' || summaryEntry?.state === 'error' ? summaryEntry.error : undefined
  const narrativeReady = source.kind === 'sample' ? unfinished === 0
    : !checkingSummaries && !summaryError && Boolean(summaries?.ready && summaries.capture.ready &&
      summaries.scoring.total === source.detail.resumes.length * (targetId ? 1 : source.detail.targets.length) &&
      summaries.scoring.complete === complete && summaries.scoring.initialized === summaries.scoring.total &&
      summaries.scoring.queued === 0 && summaries.scoring.running === 0)
  const narrativeBlocked = requiresSummaries && !narrativeReady

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
    if (active.current || !ready || complete === 0 || narrativeBlocked) return
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
          ...(targetId ? { targetId } : {}), ...(requiresSummaries ? { requireSummaries: true } : {}), signal,
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
        links: { origin: window.location.origin, workspaceId: source.kind === 'real' ? source.workspaceId : cloud?.currentWorkspaceId },
      })
      if (!current()) return
      if (source.kind === 'real' && requiresSummaries) {
        setStage('Verifying current summary versions')
        const { assertRealAnalysisReportNarrativesCurrent } = await import('../../services/analysisReports/real')
        signal.throwIfAborted()
        await assertRealAnalysisReportNarrativesCurrent(source.workspaceId, source.detail.run.id, report, signal)
        if (!current()) return
      }
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
        <Button variant="primary" icon={busy ? LoaderCircle : Download} disabled={busy || !ready || complete === 0 || narrativeBlocked} onClick={() => void exportReport()}>
          {busy ? 'Preparing report...' : `Download ${REPORT_FORMATS[format].label}`}
        </Button>
      </>}>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2"><Badge tone={source.kind === 'sample' ? 'warning' : 'accent'}>
          {source.kind === 'sample' ? 'Fictional sample' : 'Saved real evidence'}
        </Badge></div>
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
          <p className="font-semibold">Reporting on {complete} of {selected.length} {countLabel}</p>
          {complete < selected.length && <p className="mt-1 text-muted">{unfinished} still processing; {failed} could not be assessed; {cancelled} cancelled. Later completions are not added to this download.</p>}
          <p className="mt-1 text-muted">Completed assessments with withheld overall scores are included.</p>
          {complete === 0 && <p className="mt-2 text-muted">Choose a scope with at least one completed comparison, or wait for an assessment to finish.</p>}
        </div>
        {requiresSummaries && <section className="space-y-4 rounded-xl border p-4" aria-label="PDF, Word, and PowerPoint summary requirements">
          <p className="text-[12px] font-semibold">PDF, Word, and PowerPoint require current, ready summaries and settled scoring in the selected scope.</p>
          {source.kind === 'real' ? <>
            {summaries && <AnalysisSummaryStatus summaries={summaries} />}
            {(checkingSummaries || (!summaryError && !summaries)) && <p className="text-[12px]" role="status">Checking selected summary readiness...</p>}
            {summaryError && <InlineError>{summaryError}</InlineError>}
            {narrativeBlocked && <p className="text-[12px]" role="status">Missing, outdated, failed, waiting, or generating summaries block this download, even if previous text is still available. CSV remains available under its usual rules. Export never starts summary generation.</p>}
            {narrativeBlocked && <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void (runId && ensureSummaries?.(runId, targetId || undefined, true))}>Refresh summary readiness</Button>
              {onManageSummaries && <Button size="sm" disabled={busy} onClick={() => {
                changeOpen(false); onManageSummaries(targetId || undefined)
              }}>Manage summaries</Button>}
            </div>}
          </> : <p className="text-[12px] text-muted">{unfinished > 0
            ? `${unfinished} fictional comparisons are still processing. Wait for this selected scope to finish; CSV keeps its existing eligibility.`
            : 'Fictional samples use fixture summaries only. No real summary service or model is called.'}</p>}
        </section>}
        <p className="text-[11px] text-muted">{format === 'csv' ? 'Only completed reviews are included. C1, C2, and later columns follow the linked scorecard order; criterion scores use a 0-5 scale. The assessment explains unavailable overall scores. Links open the saved review and sources.'
            : 'The overview includes every completed review. Individual sections feature highlighted matches for each job or grade. Use the links for the full saved analysis and source documents.'}</p>
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
