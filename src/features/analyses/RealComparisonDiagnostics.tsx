import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type { AnalysisAssessmentDiagnostic, AnalysisFailureDiagnostic, RealAnalysisDiagnosticsPage } from '../../domain/analysis-diagnostics'
import type { RealAnalysisComparisonDetail } from '../../domain/real-analyses'
import type { Citation } from '../../domain/types'
import { Badge, Button, InlineError } from '../../components/ui'
import { analysisDiagnosticNotice, analysisDiagnosticReasons, analysisFailureExplanation, analysisFailureStages, currentAnalysisDiagnostic } from './realAnalysisUi'

interface DiagnosticProps {
  detail: RealAnalysisComparisonDetail
  renderCitations: (citations: Citation[], label: string) => ReactNode
}

export function RealComparisonDiagnostics(props: DiagnosticProps) {
  const api = useRealAnalyses()
  const { comparison } = props.detail
  if (!comparison.error && comparison.status !== 'failed' && !comparison.failureDiagnostic && !comparison.diagnosticCapture) return null
  const identity = JSON.stringify([
    api?.workspaceId, comparison.workspaceId, comparison.runId, comparison.id, comparison.status, comparison.attemptId,
    comparison.attempts, comparison.retryCount, comparison.failureDiagnostic, comparison.diagnosticCapture,
  ])
  return <DiagnosticDisclosure key={identity} {...props} />
}

function DiagnosticDisclosure(props: DiagnosticProps) {
  const { comparison } = props.detail
  const [open, setOpen] = useState(() => Boolean((comparison.error || comparison.status === 'failed') && currentAnalysisDiagnostic(comparison)))
  const notice = analysisDiagnosticNotice(comparison)
  return <section className="panel mt-5 p-5 text-[12px]" aria-label="Private failure diagnostics">
    {notice && <p className="mb-3" role="status">{notice}</p>}
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">Failure diagnostics and saved attempt history</summary>
      <p className="mt-3 text-muted">Private processing details, not a candidate result. Only one saved attempt is loaded at a time. Earlier failures do not change the current state or an accepted result.</p>
      {open && <DiagnosticHistory {...props} />}
    </details>
  </section>
}

function DiagnosticHistory({ detail, renderCitations }: DiagnosticProps) {
  const api = useRealAnalyses()
  const context = useRef({ api, detail })
  context.current = { api, detail }
  const request = useRef<AbortController | null>(null)
  const seenCursors = useRef(new Set<string>())
  const seenAttempts = useRef(new Set<string>())
  const pageRef = useRef<RealAnalysisDiagnosticsPage | null>(null)
  const [loaded, setLoaded] = useState<{ page: RealAnalysisDiagnosticsPage; cursor?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ message: string; cursor?: string } | null>(null)

  const load = useCallback(async (cursor?: string) => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setFailure(null)
    try {
      const { api: service, detail: saved } = context.current
      const comparison = saved.comparison
      if (!service || service.workspaceId !== comparison.workspaceId) throw new Error('The authorized diagnostic service for this workspace is unavailable.')
      if (cursor !== undefined && seenCursors.current.has(cursor)) throw new Error('The diagnostic service repeated a history cursor. Reopen the latest saved attempt.')
      const expected = cursor === undefined ? comparison.failureDiagnostic : pageRef.current?.attempts[0]?.previous
      const page = await service.diagnostics(comparison.runId, comparison.id, cursor, controller.signal)
      controller.signal.throwIfAborted()
      if (request.current !== controller) return
      const attempt = page.attempts[0]
      if (attempt && (attempt.workspaceId !== comparison.workspaceId || attempt.runId !== comparison.runId || attempt.comparisonId !== comparison.id
        || attempt.resumeSnapshot.snapshotId !== comparison.resume.snapshotId || attempt.resumeSnapshot.sha256 !== comparison.resume.blob.sha256
        || attempt.targetSnapshot.snapshotId !== comparison.target.snapshotId || attempt.targetSnapshot.sha256 !== comparison.target.blob.sha256)) {
        throw new Error('The diagnostic does not match this comparison’s frozen sources. Reload the saved comparison; no alternate diagnostic was shown.')
      }
      if ((expected && attempt?.attemptId !== expected.attemptId) || (cursor !== undefined && !attempt)) {
        throw new Error('The saved diagnostic history changed or its referenced attempt is unavailable. Reload the saved comparison, then retry diagnostics.')
      }
      if ((page.continuationToken && (page.continuationToken === cursor || seenCursors.current.has(page.continuationToken)))
        || (attempt && seenAttempts.current.has(attempt.attemptId))) {
        throw new Error('The diagnostic service returned a repeated attempt or history cursor. Reopen the latest saved attempt.')
      }
      if (cursor !== undefined) seenCursors.current.add(cursor)
      if (attempt) seenAttempts.current.add(attempt.attemptId)
      pageRef.current = page
      setLoaded({ page, cursor })
    } catch (caught) {
      if (!controller.signal.aborted && request.current === controller) setFailure({
        message: caught instanceof Error ? caught.message : 'The private diagnostic history could not be loaded.', cursor,
      })
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false) }
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { request.current?.abort(); request.current = null }
  }, [load])

  function latest() {
    seenCursors.current.clear()
    seenAttempts.current.clear()
    pageRef.current = null
    setLoaded(null)
    void load()
  }
  const attempt = loaded?.page.attempts[0]
  return <div className="mt-4 space-y-4">
    {loading && <p role="status" className="flex items-center gap-2 text-muted"><LoaderCircle size={14} aria-hidden="true" />Loading one private saved attempt...</p>}
    {failure && <InlineError>{failure.message} <Button size="sm" disabled={loading} onClick={() => void load(failure.cursor)}>Retry diagnostics</Button></InlineError>}
    {attempt && <SavedAttempt key={attempt.attemptId} attempt={attempt} detail={detail} renderCitations={renderCitations} />}
    {loaded && !attempt && <p>No saved diagnostic history is available. Absence of details does not mean validation passed.</p>}
    <div className="flex flex-wrap gap-2">
      {loaded?.page.continuationToken && <Button size="sm" disabled={loading} onClick={() => void load(loaded.page.continuationToken)}>Load earlier saved attempt</Button>}
      {(loaded?.cursor !== undefined || failure) && <Button size="sm" disabled={loading} onClick={latest}>Reopen latest saved attempt</Button>}
    </div>
  </div>
}

function issueLabel(detail: RealAnalysisComparisonDetail, value: { criterionId?: string; qualificationId?: string }): string {
  const target = detail.targetSnapshot
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const labels: string[] = []
  if (value.criterionId) labels.push(`${rubric.criteria.find((criterion) => criterion.id === value.criterionId)?.label ?? 'Unrecognized saved criterion'} (${value.criterionId})`)
  if (value.qualificationId) labels.push(`${(target.kind === 'grade' ? target.version.qualifications.find((qualification) => qualification.id === value.qualificationId)?.text : undefined)
    ?? 'Unrecognized saved qualification'} (${value.qualificationId})`)
  return labels.join(' · ') || 'Whole assessment'
}

function SavedAttempt({ attempt, detail, renderCitations }: DiagnosticProps & { attempt: AnalysisFailureDiagnostic }) {
  const { comparison } = detail
  const sameAttempt = comparison.attemptId === attempt.attemptId
  const explanation = analysisFailureExplanation(attempt.error)
  return <article className="space-y-4" aria-label={`Saved diagnostic attempt ${attempt.attemptId}`}>
    <div><Badge tone="warning">Unpublished diagnostic · not an accepted result</Badge>
      <p className="mt-2 font-semibold">{sameAttempt && (comparison.error || comparison.status === 'failed')
        ? `Recorded error for the current attempt · comparison ${comparison.status}`
        : `Historical failure · current comparison ${comparison.status}. This is not the current assessment.`}</p>
      <h3 className="mt-3 font-semibold">{explanation.title}</h3>
      <p className="mt-1">{explanation.explanation}</p>
      <p className="mt-2 whitespace-pre-wrap"><strong>{attempt.error.code}:</strong> {attempt.error.message}</p>
      {attempt.reason && <p className="mt-2"><strong>{attempt.reason}:</strong> {analysisDiagnosticReasons[attempt.reason]}</p>}
      <p className="mt-2"><strong>Next action: </strong>{explanation.nextAction}</p>
    </div>
    <dl className="space-y-2 break-words text-[11px]">
      <div><dt className="text-muted">Failure stage</dt><dd>{analysisFailureStages[attempt.error.stage]} ({attempt.error.stage})</dd></div>
      <div><dt className="text-muted">Processing attempt / manual retries / bounded corrections</dt><dd>{attempt.processingAttempt} / {attempt.retryCount} / {attempt.correctionCount}</dd></div>
      <div><dt className="text-muted">Attempt ID / recorded at</dt><dd className="break-all">{attempt.attemptId} · {attempt.createdAt}</dd></div>
      <div><dt className="text-muted">Pipeline version</dt><dd>{attempt.pipelineVersion}</dd></div>
      <div><dt className="text-muted">Diagnostic events</dt><dd>{attempt.events.length} recorded · {attempt.omittedEvents} omitted by the capture limit</dd></div>
    </dl>
    {attempt.citationDiagnostics && <div className="space-y-2"><h4 className="font-semibold">Recorded citation checks</h4>
      {attempt.citationDiagnostics.findings.map((finding, index) => <p key={index}>
        <strong>{issueLabel(detail, finding)}:</strong> {finding.reason}
        {finding.paragraphId && <> · paragraph {finding.paragraphId}</>}
        {finding.passageId !== undefined && <> · passage {finding.passageId}</>}
        {finding.citationIndex !== undefined && <> · citation {finding.citationIndex + 1}</>}
      </p>)}
      {attempt.citationDiagnostics.omittedFindings > 0 && <p className="text-muted">{attempt.citationDiagnostics.omittedFindings} additional citation findings were omitted by the capture limit.</p>}
    </div>}
    {attempt.schemaDiagnostics && <div className="space-y-2"><h4 className="font-semibold">Recorded response-schema checks</h4>
      {attempt.schemaDiagnostics.findings.map((finding, index) => <p key={index}><code>{finding.code}</code> · {finding.path.join(' / ') || 'Response root'}</p>)}
      {attempt.schemaDiagnostics.omittedFindings > 0 && <p className="text-muted">{attempt.schemaDiagnostics.omittedFindings} additional schema findings were omitted by the capture limit.</p>}
    </div>}
    {!attempt.assessments.length && <p>No validated draft assessment was captured before this failure. No review or score is inferred.</p>}
    {attempt.assessments.map((cycle, index) => <AssessmentCycle key={cycle.modelCallId} cycle={cycle} detail={detail}
      renderCitations={renderCitations} initiallyOpen={index === attempt.assessments.length - 1} />)}
  </article>
}

function AssessmentCycle({ cycle, detail, renderCitations, initiallyOpen }: DiagnosticProps & { cycle: AnalysisAssessmentDiagnostic; initiallyOpen: boolean }) {
  return <details className="rounded-lg border p-4" open={initiallyOpen}>
    <summary className="cursor-pointer font-semibold">Unpublished assessment cycle {cycle.correctionCount + 1} · not an accepted result</summary>
    <p className="mt-3 text-muted">This draft was retained only to explain processing. Its proposed scores are not displayed, totalled, or used as a result.</p>
    <dl className="mt-3 space-y-2 break-words text-[11px]">
      <div><dt className="text-muted">Model call ID / corrections</dt><dd className="break-all">{cycle.modelCallId} · {cycle.correctionCount}</dd></div>
      <div><dt className="text-muted">Assessment model / deployment</dt><dd>{cycle.provenance.model} · {cycle.provenance.deployment}</dd></div>
      <div><dt className="text-muted">Assessment prompt / schema</dt><dd>{cycle.provenance.promptVersion} · {cycle.provenance.schemaVersion}</dd></div>
      <div><dt className="text-muted">Assessment SHA-256</dt><dd className="break-all">{cycle.assessmentSha256}</dd></div>
    </dl>
    {cycle.review ? <section className="mt-4 space-y-3" aria-label={`Private review reasons for cycle ${cycle.correctionCount + 1}`}>
      <h4 className="font-semibold">Recorded grounding review: {cycle.review.outcome}</h4>
      <p className="break-all text-[11px]">Review ID: {cycle.review.id}</p>
      <p className="text-[11px]">Review model / prompt / schema: {cycle.review.provenance.model} · {cycle.review.provenance.promptVersion} · {cycle.review.provenance.schemaVersion}</p>
      {cycle.review.issues.map((issue, index) => {
        const label = issueLabel(detail, issue)
        return <div key={index} className="border-t pt-3">
          <h5 className="font-semibold">{label}</h5>
          <p className="mt-1"><code>{issue.code}</code></p>
          <p className="mt-1 whitespace-pre-wrap">{issue.message}</p>
          {issue.citations.length > 0 && renderCitations(issue.citations, `unpublished review: ${label}`)}
        </div>
      })}
      {!cycle.review.issues.length && <p>The saved review recorded no issues. That alone does not publish or accept this draft.</p>}
    </section> : <p className="mt-4">A validated grounding review was not recorded for this cycle. That does not mean the review passed.</p>}
    <details className="mt-4 text-[11px]">
      <summary className="cursor-pointer font-semibold">Unpublished draft text · not an accepted assessment</summary>
      <p className="mt-3 whitespace-pre-wrap">{cycle.assessment.summary}</p>
      {cycle.assessment.criteria.map((criterion) => <div key={criterion.criterionId} className="mt-3">
        <h5 className="font-semibold">{issueLabel(detail, criterion)}</h5><p className="mt-1 whitespace-pre-wrap">{criterion.rationale}</p>
      </div>)}
      {cycle.assessment.qualifications.map((qualification) => <div key={qualification.qualificationId} className="mt-3">
        <h5 className="font-semibold">{issueLabel(detail, qualification)}</h5><p className="mt-1 whitespace-pre-wrap">{qualification.rationale}</p>
      </div>)}
      {cycle.assessment.limitations.map((limitation, index) => <p className="mt-2 whitespace-pre-wrap" key={index}>Draft limitation: {limitation.message}</p>)}
    </details>
  </details>
}
