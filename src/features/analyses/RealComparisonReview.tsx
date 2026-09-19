import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, FileText, Layers3, LoaderCircle, Quote, ScanLine, ShieldCheck } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import type { SavedReviewView } from '../../app/saved-review-navigation'
import type { RealAnalysisComparisonDetail, RealAnalysisDocumentResponse, RealCriterionResult } from '../../domain/real-analyses'
import type { Citation } from '../../domain/types'
import { documentPagination, type DocumentPagination } from '../../domain/document-formats'
import { gradeSourcePagination } from '../grade-ladders/gradeUi'
import { Badge, Button, EmptyState, InlineError, Score, SegmentedControl } from '../../components/ui'
import { DocumentViewer } from '../../components/documents/DocumentViewer'
import { citationMatches, targetVersionLabel } from './realAnalysisUi'
import { RealCandidateNarrative } from './AnalysisSummaries'

type EvidenceSelection = { kind: 'resume' | 'requirement'; citation: Citation; label: string }
type SavedDocumentSelection = { kind: EvidenceSelection['kind']; documentId: string; documentVersion: number; label: string }
const evidenceLabels = { supported: 'Supported', partial: 'Partial support', missing: 'Missing evidence', 'not-assessed': 'Not assessed', 'not-applicable': 'Not applicable · unscored' }

function EvidenceStatus({ status }: { status: RealCriterionResult['evidenceStatus'] }) {
  return <Badge tone={status === 'supported' ? 'success' : ['partial', 'not-assessed'].includes(status) ? 'warning' : 'neutral'}>{evidenceLabels[status]}</Badge>
}

function EvidenceButtons({ citations, kind, label, onSelect, active }: {
  citations: Citation[]; kind: EvidenceSelection['kind']; label: string; onSelect: (selection: EvidenceSelection) => void; active: EvidenceSelection | null
}) {
  return <div className="citation-list">{citations.map((citation, index) => <button
    key={`${citation.documentId}-${citation.documentVersion}-${citation.paragraphId}-${index}`}
    className={`citation-button ${active?.kind === kind && active.citation.documentId === citation.documentId && active.citation.documentVersion === citation.documentVersion && active.citation.paragraphId === citation.paragraphId && active.citation.quote === citation.quote ? 'is-active' : ''}`}
    onClick={() => onSelect({ kind, citation, label })}
    aria-label={`View ${kind === 'resume' ? 'resume' : 'requirement'} evidence for ${label}, ${citation.heading}, saved document version ${citation.documentVersion}`}>
    <Quote size={15} aria-hidden="true" /><span><q>{citation.quote}</q><small><FileText size={11} aria-hidden="true" />{citation.heading} · saved v{citation.documentVersion}<ArrowUpRight size={12} aria-hidden="true" /></small></span>
  </button>)}</div>
}

export function RealComparisonReview({ detail, actions, initialView }: {
  detail: RealAnalysisComparisonDetail; actions?: ReactNode; initialView?: SavedReviewView | null
}) {
  const { comparison, resumeSnapshot: resume, targetSnapshot: target, result } = detail
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const [expanded, setExpanded] = useState<string[]>(() => rubric.criteria[0] ? [rubric.criteria[0].id] : [])
  const [selected, setSelected] = useState<EvidenceSelection | null>(null)
  const [sourceView, setSourceView] = useState<SavedReviewView>(initialView ?? 'resume')
  const [pane, setPane] = useState<'criteria' | 'evidence'>(initialView ? 'evidence' : 'criteria')
  function showEvidence(selection: EvidenceSelection) {
    setSelected(selection)
    setSourceView(selection.kind === 'resume' ? 'resume' : 'target')
    setPane('evidence')
  }
  if (comparison.status !== 'complete' || !result) return <section className="panel"><EmptyState
    icon={['queued', 'running'].includes(comparison.status) ? LoaderCircle : ScanLine}
    title={comparison.status === 'failed' ? 'This comparison could not be assessed' : comparison.status === 'cancelled' ? 'This comparison was cancelled'
      : comparison.status === 'complete' ? 'The saved result is unavailable' : 'The saved inputs are awaiting assessment'}
    description={comparison.error?.message ?? (comparison.status === 'complete' ? 'No result payload was returned. No score is invented; reload the saved comparison.'
      : 'No score exists yet. Independent server work uses the original frozen inputs; completed pairs in this run are unaffected.')}
    action={actions} />
    <div className="border-t p-5 text-[11px] text-muted">Saved resume: {resume.resume.name ?? 'Name not stated'} · document v{resume.document.version}<br />
      Saved target: {target.summary.label} · {targetVersionLabel(target.selection)}</div>
  </section>

  return <>
    <section className="result-overview panel">
      <div className="result-identity"><span className="target-symbol"><FileText size={18} aria-hidden="true" /></span><div><div className="eyebrow">SAVED REAL RESUME</div><h2>{resume.resume.name ?? 'Name not stated'}</h2><p>{resume.resume.role ?? 'Role not stated'}</p><p className="break-all text-[10px] text-muted">{resume.resume.sourceLabel}</p></div></div>
      <div className="result-target"><div className="eyebrow">{target.kind === 'grade' ? 'EXACT APPROVED GS VERSION' : 'EXACT SAVED JOB RUBRIC'}</div><h3>{target.summary.label}</h3><p>{target.summary.sublabel}</p>
        <div className="mt-2 flex flex-wrap gap-1.5"><Badge>{targetVersionLabel(target.selection)}</Badge><Badge tone={result.completion === 'limited' ? 'warning' : 'success'}>{result.completion === 'limited' ? 'Complete · limited assessment' : 'Complete · assessed'}</Badge></div>
      </div>
      <div className="overall-score"><div className="eyebrow">SERVER-CALCULATED EVIDENCE MATCH</div>
        {result.overall.status === 'available' ? <Score value={result.overall.score} large /> : <><strong className="text-lg">Score withheld</strong><p className="mt-2 text-[11px] text-muted">{result.overall.message}</p></>}
        <span>{result.overall.status === 'available' ? 'Weighted saved criterion scores · not a ranking' : 'Not a zero and not a failed candidate'}</span></div>
      <div className="result-summary"><ShieldCheck size={16} aria-hidden="true" /><div><h3>Evidence-based assessment</h3><p>{result.summary}</p></div></div>
    </section>
    <RealCandidateNarrative runId={comparison.runId} comparisonId={comparison.id} targetId={comparison.target.summary.id} />
    <section className="panel mt-5" aria-label="Evidence coverage and limitations"><div className="section-heading"><div><h2>Completion is separate from evidence coverage</h2>
      <p>{result.coverage.supported} supported · {result.coverage.partial} partial · {result.coverage.missing} missing · {result.coverage.notAssessed} not assessed · {result.coverage.notApplicable} not applicable</p>
      <p>{result.coverage.assessedWeight}% assessed weight / {result.coverage.totalWeight}% total weight. No client-side total or missing-criterion renormalization is used.</p></div></div>
      {result.limitations.length > 0 && <ul className="list-disc space-y-2 px-9 py-4 text-[11px] text-muted">{result.limitations.map((limitation, index) => <li key={index}>{limitation.message}</li>)}</ul>}
    </section>
    <div className="pane-switcher mt-5"><SegmentedControl label="Real result review view" value={pane} onChange={setPane}
      options={[{ value: 'criteria', label: 'Criterion breakdown' }, { value: 'evidence', label: 'Saved source evidence' }]} /></div>
    <div className="evidence-layout">
      <section className={`detail-panel ${pane !== 'criteria' ? 'mobile-pane-hidden' : ''}`} aria-label="Real criterion assessments">
        <div className="section-heading"><div><h2>The evidence, criterion by criterion</h2><p>Scored against unchanged rubric v{rubric.version}; gaps and exclusions remain distinct.</p></div><Layers3 size={16} className="text-muted" aria-hidden="true" /></div>
        <div className="criterion-results">{rubric.criteria.map((criterion, index) => {
          const assessment = result.criteria.find((item) => item.criterionId === criterion.id)
          const isOpen = expanded.includes(criterion.id)
          const id = `real-criterion-${comparison.id}-${index}`
          const status = assessment?.evidenceStatus ?? 'not-assessed'
          const requirementCitations = assessment?.requirementCitations
            ?? target.requirementEvidence.find((entry) => entry.kind === 'criterion' && entry.criterionId === criterion.id)?.citations ?? []
          return <div className={`criterion-result ${isOpen ? 'is-open' : ''}`} key={criterion.id}>
            <button className="criterion-toggle" aria-expanded={isOpen} aria-controls={id}
              onClick={() => setExpanded((current) => isOpen ? current.filter((key) => key !== criterion.id) : [...current, criterion.id])}>
              <span className="criterion-number">{String(index + 1).padStart(2, '0')}</span><span className="criterion-title"><strong>{criterion.label}</strong><span>{criterion.weight}% weight · {evidenceLabels[status]}</span></span>
              <span className="criterion-score">{status === 'not-applicable' ? 'N/A' : assessment?.score === null || assessment?.score === undefined ? 'Not assessed' : <><strong>{assessment.score}</strong><span>/ 5</span></>}</span>
              <ChevronDown size={14} className={isOpen ? 'rotate-180' : ''} aria-hidden="true" />
            </button>
            {isOpen && <div className="criterion-content" id={id}>
              <div className="mb-3 flex flex-wrap gap-2"><EvidenceStatus status={status} /><Badge>{criterion.requirementType === 'required' ? 'Required' : criterion.requirementType === 'preferred' ? 'Preferred' : 'Requirement type not stated'}</Badge></div>
              <p className="criterion-description">{criterion.description}</p>
              <details className="mb-4 text-[11px]"><summary className="cursor-pointer font-medium">Saved rubric guidance / scoring anchors</summary><p className="mt-2 whitespace-pre-line text-muted">{criterion.guidance}</p></details>
              <div className="rationale"><strong>Assessment</strong><p>{assessment?.rationale ?? 'This criterion has no saved assessment. No score is invented.'}</p></div>
              {status === 'not-assessed' && <div className="evidence-gap"><ScanLine size={17} aria-hidden="true" /><p>{assessment?.evidenceStatus === 'not-assessed' ? assessment.limitation.message : 'No assessment is available.'} Not assessed does not mean zero evidence or missing skill.</p></div>}
              {status === 'not-applicable' && <div className="evidence-gap"><p>This approved GS exclusion is unscored and has zero weight. It is not an applicant score of zero.</p></div>}
              {assessment?.citations.length ? <div><div className="citation-heading"><span>SUPPORTING RESUME EVIDENCE</span></div>
                <EvidenceButtons citations={assessment.citations} kind="resume" label={criterion.label} onSelect={showEvidence} active={selected} /></div>
                : status === 'missing' && <div className="evidence-gap"><ScanLine size={17} aria-hidden="true" /><div><strong>No supporting passage located in the processed resume</strong><p>This is an evidence gap and a zero evidence-match score, not proof that the person lacks the skill.</p></div></div>}
              <div className="mt-4 border-t pt-3"><div className="citation-heading"><span>SAVED REQUIREMENT EVIDENCE · NOT APPLICANT EVIDENCE</span></div>
                {requirementCitations.length ? <EvidenceButtons citations={requirementCitations} kind="requirement" label={criterion.label} onSelect={showEvidence} active={selected} />
                  : <p className="text-[11px] text-muted">No saved source quotation was supplied for this requirement. The saved rubric wording above is retained; no citation is invented.</p>}
              </div>
            </div>}
          </div>
        })}</div>
        {target.kind === 'grade' && <section className="grade-qualifications" aria-label="Unscored GS qualifications">
          <h3>GS qualifications <Badge>Separate · unscored · human review</Badge></h3><p>These requirements are not weighted work criteria and cannot be offset by a total score. This is not an official eligibility determination.</p>
          {target.version.qualifications.map((qualification) => {
            const assessment = result.qualifications.find((item) => item.qualificationId === qualification.id)
            return <article key={qualification.id}><p className="font-medium">{qualification.text}</p><EvidenceStatus status={assessment?.evidenceStatus ?? 'not-assessed'} />
              <p>{assessment?.rationale ?? 'This qualification was not assessed. No eligibility conclusion is implied.'}</p>
              {assessment?.limitation && <p className="text-[11px] text-muted">{assessment.limitation.message}</p>}
              {qualification.interpretation && <div className="grade-interpretation"><span className="grade-field-kicker">Saved interpretation — not quotation</span><p>{qualification.interpretation}</p></div>}
              <div className="citation-heading"><span>RESUME EVIDENCE</span></div>
              {assessment?.citations.length ? <EvidenceButtons citations={assessment.citations} kind="resume" label={qualification.text} onSelect={showEvidence} active={selected} />
                : <p className="text-[11px] text-muted">No supporting resume quotation is available. Do not infer an eligibility decision.</p>}
              <div className="citation-heading"><span>SAVED QUALIFICATION REQUIREMENT</span></div>
              <EvidenceButtons citations={assessment?.requirementCitations ?? qualification.citations} kind="requirement" label={qualification.text} onSelect={showEvidence} active={selected} />
            </article>
          })}
          {!target.version.qualifications.length && <p>No qualifications are captured for this version. Do not infer that none apply.</p>}
        </section>}
      </section>
      <section className={`detail-panel evidence-panel ${pane !== 'evidence' ? 'mobile-pane-hidden' : ''}`} aria-label="Saved real source evidence">
        <div className="section-heading"><div><h2>{selected ? 'Inspect the exact saved passage' : sourceView === 'resume' ? 'Full saved resume' : target.kind === 'grade' ? 'Saved approved grade requirements' : 'Full saved job description'}</h2><p>{selected ? `${selected.kind === 'resume' ? 'Resume evidence' : 'Requirement evidence'} · ${selected.label}` : 'Frozen inputs used for this comparison, not newer library records. Select a quotation to highlight an exact passage.'}</p></div><ScanLine size={17} className="text-accent" aria-hidden="true" /></div>
        <div className="border-b px-4 py-3"><SegmentedControl label="Saved evidence source" value={sourceView}
          onChange={(view) => { setSourceView(view); setSelected(null) }}
          options={[{ value: 'resume', label: 'Resume evidence' }, { value: 'target', label: target.kind === 'grade' ? 'Grade requirements' : 'Job description' }]} /></div>
        {selected && <div className="border-b p-3"><Button size="sm" onClick={() => { setSelected(null); setSourceView('resume') }}>View full saved resume</Button></div>}
        {selected || sourceView === 'resume' ? <SavedEvidence detail={detail} selection={selected} /> : <SavedTargetEvidence detail={detail} />}
      </section>
    </div>
    <details className="panel mt-5 p-5 text-[11px]"><summary className="cursor-pointer text-[12px] font-semibold">Processing provenance and immutable identities</summary>
      <dl className="mt-4 space-y-3 break-words">
        <div><dt className="text-muted">Assessment model / deployment</dt><dd>{result.provenance.assessment.model} · {result.provenance.assessment.deployment}</dd></div>
        <div><dt className="text-muted">Prompt / schema / calculation version</dt><dd>{result.provenance.assessment.promptVersion} · {result.provenance.assessment.schemaVersion} · {result.provenance.calculationVersion}</dd></div>
        <div><dt className="text-muted">Independent grounding review</dt><dd>{result.provenance.groundingReviews.map((review) => `${review.outcome} · ${review.provenance.model} · ${review.provenance.promptVersion}`).join('; ') || 'No grounding review record returned. Human review is required.'}</dd></div>
        <div><dt className="text-muted">Corrections / completed</dt><dd>{result.provenance.correctionCount} bounded corrections · {result.createdAt}</dd></div>
        <div><dt className="text-muted">Resume snapshot / SHA-256</dt><dd className="break-all"><code>{result.provenance.resumeSnapshot.snapshotId} · {result.provenance.resumeSnapshot.sha256}</code></dd></div>
        <div><dt className="text-muted">Target snapshot / SHA-256</dt><dd className="break-all"><code>{result.provenance.targetSnapshot.snapshotId} · {result.provenance.targetSnapshot.sha256}</code></dd></div>
        {target.kind === 'grade' && <div><dt className="text-muted">Approved version / review / frozen source set</dt><dd className="break-all">{target.version.id} · {target.approval.id} · {target.review.id} · {target.sourceSet.id}</dd></div>}
      </dl>
    </details>
  </>
}

function SavedTargetEvidence({ detail }: { detail: RealAnalysisComparisonDetail }) {
  const target = detail.targetSnapshot
  const sourceSelectId = useId()
  const [documentKey, setDocumentKey] = useState('')
  if (target.kind === 'job') return <SavedEvidence detail={detail} selection={{
    kind: 'requirement', documentId: target.document.id, documentVersion: target.document.version, label: target.document.title,
  }} />
  const documents: SavedDocumentSelection[] = [
    { kind: 'requirement', documentId: target.seed.document.id, documentVersion: target.seed.document.version, label: `Seed job context: ${target.seed.document.title}` },
    ...target.references.map(({ source, document }) => ({
      kind: 'requirement' as const, documentId: document.documentId, documentVersion: document.documentVersion, label: source.title,
    })),
  ]
  const selection = documents.find((document) => JSON.stringify([document.documentId, document.documentVersion]) === documentKey)
  return <>
    <section className="space-y-4 border-b p-4 text-[12px]" aria-label="Saved approved grade requirements">
      <div><h3 className="font-semibold">{target.summary.label} · approved version {target.version.version}</h3>
        <p className="mt-1 whitespace-pre-line">{target.version.rubric.description}</p>
        <p className="mt-1 text-muted">These are the exact approved requirements used for this assessment. The seed job is supporting context, not the whole grade standard.</p></div>
      {target.version.rubric.criteria.map((criterion, index) => <article key={criterion.id}>
        <h4 className="font-semibold">{index + 1}. {criterion.label} · {criterion.weight}% weight</h4>
        <p className="mt-1 whitespace-pre-line">{criterion.description}</p>
        <p className="mt-1 text-muted">{criterion.requirementType === 'required' ? 'Required' : criterion.requirementType === 'preferred' ? 'Preferred' : 'Requirement type not stated'} · {criterion.support === 'not-applicable' ? 'Not applicable · unscored' : criterion.support}</p>
        {criterion.interpretation && <p className="mt-1 whitespace-pre-line"><strong>Saved interpretation, not quotation: </strong>{criterion.interpretation}</p>}
        <p className="mt-1 whitespace-pre-line text-muted">{criterion.guidance}</p>
      </article>)}
      <div><h4 className="font-semibold">GS qualifications · separate and unscored</h4>
        {target.version.qualifications.map((qualification) => <article className="mt-3" key={qualification.id}>
          <p className="whitespace-pre-line">{qualification.text}</p>
          {qualification.interpretation && <p className="mt-1 whitespace-pre-line text-muted">Saved interpretation, not quotation: {qualification.interpretation}</p>}
        </article>)}
        {!target.version.qualifications.length && <p className="mt-1 text-muted">No qualifications are captured for this version. Do not infer that none apply.</p>}
      </div>
    </section>
    <div className="border-b p-4"><label htmlFor={sourceSelectId} className="mb-2 block text-[12px] font-semibold">Frozen grade source document</label>
      <select id={sourceSelectId} className="filter-select mb-2 w-full" value={documentKey} onChange={(event) => setDocumentKey(event.target.value)}>
        <option value="">Choose a saved source document</option>
        {documents.map((document) => {
          const key = JSON.stringify([document.documentId, document.documentVersion])
          return <option key={key} value={key}>{document.label} · saved v{document.documentVersion}</option>
        })}
      </select>
    <p className="text-[11px] text-muted">View the full captured document without inventing a quotation. Missing sources remain unavailable; current library versions are never substituted.</p></div>
    {selection && <SavedEvidence detail={detail} selection={selection} />}
  </>
}

function SavedEvidence({ detail, selection }: { detail: RealAnalysisComparisonDetail; selection: EvidenceSelection | SavedDocumentSelection | null }) {
  const api = useRealAnalyses()
  const service = useRef(api)
  service.current = api
  const [loaded, setLoaded] = useState<{ key: string; document: RealAnalysisDocumentResponse['document']; pagination: DocumentPagination } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const key = selection ? JSON.stringify(selection) : ''
  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    setLoaded(null)
    setFailure(null)
    void (async () => {
      const { kind } = selection
      const reference = 'citation' in selection ? selection.citation : selection
      const resume = detail.resumeSnapshot
      const target = detail.targetSnapshot
      let document: RealAnalysisDocumentResponse['document']
      let pagination: DocumentPagination
      if (kind === 'resume') {
        if (resume.document.id !== reference.documentId || resume.document.version !== reference.documentVersion) {
          throw new Error('This quotation does not belong to this comparison’s saved resume. No other applicant or requirement source can substitute for it.')
        }
        document = resume.document
        pagination = resume.extraction.pagination
      } else if (target.kind === 'job' && target.document.id === reference.documentId && target.document.version === reference.documentVersion) {
        document = target.document
        pagination = documentPagination(target.original.contentType)
      } else if (target.kind === 'grade' && target.seed.document.id === reference.documentId && target.seed.document.version === reference.documentVersion) {
        document = target.seed.document
        pagination = documentPagination(target.seed.source.originalContentType)
      } else {
        const source = target.kind === 'grade' ? target.references.find((item) => item.document.documentId === reference.documentId && item.document.documentVersion === reference.documentVersion) : undefined
        if (!source) throw new Error('This requirement source is not part of this comparison’s frozen target sources.')
        if (!service.current) throw new Error('The private analysis document service is unavailable.')
        document = await service.current.document(detail.comparison.runId, detail.comparison.id, reference.documentId, reference.documentVersion, controller.signal)
        pagination = gradeSourcePagination(source.source)
      }
      if (document.id !== reference.documentId || document.version !== reference.documentVersion) throw new Error('The returned document does not match the frozen source identity. No alternate version is shown.')
      if ('citation' in selection && !citationMatches(document, selection.citation)) throw new Error('The quotation, paragraph, or version does not exactly match the saved source. Treat this evidence as unresolved; no alternate passage is highlighted.')
      if (!controller.signal.aborted) setLoaded({ key, document, pagination })
    })().catch((caught: unknown) => {
      if (!controller.signal.aborted) setFailure({ key, message: caught instanceof Error ? caught.message : 'The saved evidence could not be loaded.' })
    })
    return () => controller.abort()
  }, [detail, key, retry, selection])

  const value = !selection ? { document: detail.resumeSnapshot.document, pagination: detail.resumeSnapshot.extraction.pagination }
    : loaded?.key === key ? loaded : null
  const error = failure?.key === key ? failure.message : null
  const citation = selection && 'citation' in selection ? selection.citation : undefined
  return <>
    {error && <div className="p-4"><InlineError>{error} <Button size="sm" onClick={() => setRetry((value) => value + 1)}>Retry saved source</Button></InlineError></div>}
    {!value && !error && <EmptyState icon={LoaderCircle} title="Opening the exact saved evidence" description="Copied GS references use the authorized analysis-document endpoint. No live source or browser login is used." />}
    {value && <><DocumentViewer document={value.document} highlightedId={citation?.paragraphId} quote={citation?.quote} pagination={value.pagination} compact />
      <div className="source-footer"><span>Frozen analysis document · v{value.document.version}</span><span className="break-all">{value.document.id}</span></div></>}
  </>
}
