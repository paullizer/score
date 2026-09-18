import {
  ANALYSIS_REPORT_SCHEMA_VERSION, REPORT_LIMITS,
  type RealReportBatchResponse, type RealReportComparison, type RealReportTarget,
  type ReportCitation, type ReportCitationSource, type ReportFact,
} from '../../src/domain/analysis-reports'
import { documentPagination } from '../../src/domain/document-formats'
import type {
  FrozenRealAnalysisTargetSnapshot, RealAnalysisComparisonRecord, RealAnalysisResult, RealAnalysisRunRecord,
} from '../../src/domain/real-analyses'
import type { Citation } from '../../src/domain/types'
import { gradeSourcePagination } from '../../src/features/grade-ladders/gradeUi'
import { createReportCitation, parseRealReportBatchResponse } from '../../src/services/analysisReports/model'
import { unavailableOverallScore } from '../../src/services/analysisReports/presentation'
import { invalidRequest } from '../errors'
import { createAnalysisSnapshotReader, type AnalysisSnapshots } from './snapshots'
import type { AnalysisBlobStore } from './store'
import { analysisHash, assertAnalysis, reportComparisonIdsSchema } from './validation'

function targetFacts(target: FrozenRealAnalysisTargetSnapshot): ReportFact[] {
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const facts: ReportFact[] = [
    { label: 'Rubric description', value: rubric.description },
    { label: 'Rubric created', value: rubric.createdAt },
    { label: 'Inputs frozen', value: target.frozenAt },
  ]
  const add = (label: string, value: string | undefined) => { if (value?.trim()) facts.push({ label, value }) }
  if (target.kind === 'job') {
    add('Organization', target.job.organization)
    add('Series', target.job.series)
    add('Grade', target.job.grade)
    add('Source captured', target.source.capturedAt)
    add('Rubric SHA-256', target.selection.rubricHash)
    add('Requirement document SHA-256', target.selection.documentSha256)
  } else {
    const { context } = target.sourceSet
    add('GS grade', `GS-${target.selection.grade}`)
    add('Series', context.series)
    add('Agency', context.agency)
    add('Agency type', context.agencyType)
    add('Supervision', context.supervision)
    add('Specialty', context.specialty)
    add('Functions', context.functions.join(', '))
    add('Approved', target.approval.createdAt)
    add('Approval ID', target.approval.id)
    add('Grade grounding review ID', target.review.id)
    add('Grade version SHA-256', target.selection.versionHash)
    add('Frozen source set ID', target.selection.sourceSetId)
    add('Frozen source set SHA-256', target.selection.sourceSetHash)
    for (const criterion of target.version.rubric.criteria) {
      add(`${criterion.label} (${criterion.id}) — source support`, criterion.support)
      add(`${criterion.label} (${criterion.id}) — interpretation`, criterion.interpretation)
    }
  }
  return facts
}

function reportTarget(comparison: RealAnalysisComparisonRecord, target: FrozenRealAnalysisTargetSnapshot): RealReportTarget {
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  return {
    id: target.summary.id, dataKind: 'real', kind: target.kind,
    label: target.summary.label, sublabel: target.summary.sublabel,
    versionLabel: target.kind === 'grade' ? `Approved GS-${target.selection.grade} · rubric v${rubric.version}`
      : `Rubric v${rubric.version} · source document v${target.document.version}`,
    rubricId: rubric.id, rubricVersion: rubric.version, selection: target.selection,
    snapshot: { snapshotId: comparison.target.snapshotId, sha256: comparison.target.blob.sha256 },
    criteria: rubric.criteria.map(criterion => ({
      id: criterion.id, label: criterion.label, description: criterion.description,
      weight: criterion.weight, guidance: criterion.guidance, requirementType: criterion.requirementType ?? null,
    })),
    facts: targetFacts(target),
  }
}

function requirementSources(target: FrozenRealAnalysisTargetSnapshot): Map<string, ReportCitationSource> {
  const sources: ReportCitationSource[] = target.kind === 'job' ? [{
    id: target.document.id, version: target.document.version, title: target.document.title,
    pagination: documentPagination(target.original.contentType),
  }] : target.references.map(({ source }) => ({
    id: source.documentId, version: source.documentVersion, title: source.title, pagination: gradeSourcePagination(source),
  }))
  const result = new Map<string, ReportCitationSource>()
  for (const source of sources) {
    const key = JSON.stringify([source.id, source.version])
    const previous = result.get(key)
    assertAnalysis(!previous || analysisHash(previous) === analysisHash(source), 'Ambiguous saved requirement document identity.')
    result.set(key, source)
  }
  return result
}

function provenanceFacts(result: RealAnalysisResult, snapshots: AnalysisSnapshots): ReportFact[] {
  const { provenance } = result
  const facts: ReportFact[] = [
    { label: 'Manifest SHA-256', value: provenance.manifestSha256 },
    { label: 'Assessment SHA-256', value: provenance.assessmentSha256 },
    { label: 'Assessment model', value: provenance.assessment.model },
    { label: 'Assessment deployment', value: provenance.assessment.deployment },
    { label: 'Assessment prompt version', value: provenance.assessment.promptVersion },
    { label: 'Assessment schema version', value: provenance.assessment.schemaVersion },
    { label: 'Assessment started', value: provenance.assessment.startedAt },
    { label: 'Assessment completed', value: provenance.assessment.completedAt },
    { label: 'Output correction count', value: String(provenance.correctionCount) },
    { label: 'Calculation version', value: provenance.calculationVersion },
    { label: 'Resume source captured', value: snapshots.resumeSnapshot.capture.capturedAt },
    { label: 'Resume extraction', value: `${snapshots.resumeSnapshot.extraction.method} · ${snapshots.resumeSnapshot.extraction.version}` },
  ]
  for (const [index, review] of provenance.groundingReviews.entries()) {
    facts.push(
      { label: `Grounding review ${index + 1}`, value: `${review.id} · ${review.outcome}` },
      { label: `Grounding model ${index + 1}`, value: `${review.provenance.model} · ${review.provenance.deployment}` },
      { label: `Grounding prompt ${index + 1}`, value: review.provenance.promptVersion },
      { label: `Grounding completed ${index + 1}`, value: review.provenance.completedAt },
    )
  }
  return facts
}

function reportComparison(
  comparison: RealAnalysisComparisonRecord, snapshots: AnalysisSnapshots, result: RealAnalysisResult | null,
): RealReportComparison {
  const { resumeSnapshot: resume, targetSnapshot: target } = snapshots
  if (comparison.status === 'complete') assertAnalysis(result && comparison.result, 'The completed comparison is missing its saved result.')
  const normalized: RealReportComparison = {
    id: comparison.id, index: comparison.index, dataKind: 'real', targetId: target.summary.id,
    candidate: {
      id: resume.selection.resumeId, name: resume.resume.name, role: resume.resume.role,
      sourceLabel: resume.resume.sourceLabel, documentId: resume.document.id, documentVersion: resume.document.version,
      documentSha256: resume.selection.documentSha256,
      snapshot: { snapshotId: comparison.resume.snapshotId, sha256: comparison.resume.blob.sha256 },
    },
    status: comparison.status, completion: null,
    overall: comparison.status === 'complete' ? result!.overall : unavailableOverallScore(comparison.status),
    summary: null, coverage: null, criteria: [], qualifications: [], limitations: [],
    error: comparison.error ? { ...comparison.error } : null, analyzedAt: null, resultSha256: null, provenance: [],
  }
  if (comparison.status !== 'complete') {
    assertAnalysis(!result, 'An unfinished comparison cannot contain a saved result.')
    return normalized
  }
  assertAnalysis(result && comparison.result, 'The completed comparison is missing its saved result.')
  const sources = requirementSources(target)
  const resumeSource: ReportCitationSource = {
    id: resume.document.id, version: resume.document.version, title: resume.document.title, pagination: resume.extraction.pagination,
  }
  const requirementCitation = (citation: Citation): ReportCitation => {
    const source = sources.get(JSON.stringify([citation.documentId, citation.documentVersion]))
    assertAnalysis(source, 'The saved requirement citation has no frozen source.')
    return createReportCitation(citation, source)
  }
  return {
    ...normalized, completion: result.completion, overall: result.overall, summary: result.summary, coverage: result.coverage,
    criteria: result.criteria.map(criterion => ({
      criterionId: criterion.criterionId, weight: criterion.weight, score: criterion.score,
      evidenceStatus: criterion.evidenceStatus, rationale: criterion.rationale,
      citations: criterion.citations.map(citation => createReportCitation(citation, resumeSource)),
      requirementCitations: criterion.requirementCitations.map(requirementCitation),
      limitation: 'limitation' in criterion ? criterion.limitation : null,
    })),
    qualifications: result.qualifications.map(assessment => {
      const definition = target.kind === 'grade' ? target.version.qualifications.find(item => item.id === assessment.qualificationId) : undefined
      assertAnalysis(definition, 'The saved qualification has no frozen definition.')
      return {
        qualificationId: assessment.qualificationId, text: definition.text,
        interpretation: definition.interpretation, support: definition.support,
        evidenceStatus: assessment.evidenceStatus, rationale: assessment.rationale,
        citations: assessment.citations.map(citation => createReportCitation(citation, resumeSource)),
        requirementCitations: assessment.requirementCitations.map(requirementCitation),
        limitation: assessment.limitation ?? null,
      }
    }),
    limitations: result.limitations, analyzedAt: result.createdAt,
    resultSha256: comparison.result.sha256, provenance: provenanceFacts(result, snapshots),
  }
}

export async function readAnalysisReportComparisons(
  blobs: Pick<AnalysisBlobStore, 'read'>, run: RealAnalysisRunRecord,
  comparisons: readonly RealAnalysisComparisonRecord[], signal?: AbortSignal,
): Promise<RealReportBatchResponse> {
  assertAnalysis(reportComparisonIdsSchema.safeParse(comparisons.map(comparison => comparison.id)).success,
    'A report batch requires distinct, bounded comparison IDs.')
  const reader = createAnalysisSnapshotReader(blobs, run, {
    maxComparisons: REPORT_LIMITS.batchComparisons, maxBytes: REPORT_LIMITS.maxOutputBytes, signal,
  })
  const targets = new Map<string, RealReportTarget>()
  const response: RealReportBatchResponse = {
    schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION, dataKind: 'real', workspaceId: run.workspaceId, runId: run.id,
    targets: [], comparisons: [],
  }
  let outputBytes = Buffer.byteLength(JSON.stringify(response))
  // Sequential pairs cap live result/source allocations; the two snapshot reads can overlap.
  for (const comparison of comparisons) {
    signal?.throwIfAborted()
    const snapshots = await reader.snapshots(comparison)
    const result = await reader.result(comparison, snapshots)
    const target = reportTarget(comparison, snapshots.targetSnapshot)
    const previous = targets.get(target.id)
    assertAnalysis(!previous || analysisHash(previous) === analysisHash(target), 'Conflicting frozen report target definitions.')
    if (!previous) {
      targets.set(target.id, target)
      response.targets.push(target)
      outputBytes += Buffer.byteLength(JSON.stringify(target)) + 1
    }
    const normalized = reportComparison(comparison, snapshots, result)
    outputBytes += Buffer.byteLength(JSON.stringify(normalized)) + 1
    if (outputBytes > REPORT_LIMITS.maxBatchBytes) {
      throw invalidRequest('The saved evidence exceeds the report batch output limit. Narrow the export to one exact job/grade target; no comparisons or quotations were omitted.')
    }
    response.comparisons.push(normalized)
  }
  signal?.throwIfAborted()
  return parseRealReportBatchResponse(response)
}
