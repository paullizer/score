import { z } from 'zod'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, ReportCitation, ReportComparison, ReportFact, ReportTarget, SampleAnalysisReportOptions,
} from '../../domain/analysis-reports'
import type { AnalysisRun, AnalysisTarget, Citation, Criterion, SourceDocument } from '../../domain/types'
import { assertResumeSnapshot, assertTargetSnapshot } from '../scoring'
import { assertReportResourceLimits, buildAnalysisReport, createReportCitation, reportDisplayNameSchema as displayName } from './model'
import { unavailableOverallScore } from './presentation'
import { sampleCandidateNarrative, sampleNarrativeCapture, sampleReportFixtureId, sampleTargetNarrative } from './sample-narratives'
import { reportNarrativeCaptureSchema } from './narrative-schemas'
import { getDisplayName } from '../../domain/displayNames'
import { reportSettingsCaptureSchema } from './policy'

const id = z.string().min(1).max(1024)
const text = z.string().max(REPORT_LIMITS.maxTextCharacters)
const nonempty = text.refine(value => value.trim().length > 0, 'Saved sample text must not be empty.')
const version = z.number().int().min(1)
const timestamp = z.iso.datetime({ offset: true })
const score = z.number().finite().min(0).max(5)
const key = z.enum(['technical', 'delivery', 'analysis', 'communication', 'leadership', 'policy', 'custom'])
const sourceCitation = z.strictObject({
  documentId: id, documentVersion: version, paragraphId: id, page: version, heading: nonempty, quote: nonempty,
})
const documentSchema = z.strictObject({
  id, title: nonempty, kind: z.enum(['job', 'resume']), version, sample: z.literal(true),
  paragraphs: z.array(z.strictObject({ id, page: version, heading: nonempty, text: nonempty })).min(1),
})
const criterionSchema = z.strictObject({
  id, key, label: nonempty, description: nonempty, guidance: nonempty, weight: z.number().finite().min(0).max(100),
  sourceParagraphId: id.optional(), requirementType: z.enum(['required', 'preferred']).optional(),
  sourceCitations: z.array(sourceCitation).max(REPORT_LIMITS.maxCitationsPerAssessment).optional(),
})
const jobSchema = z.strictObject({
  id, title: nonempty, displayName: displayName.optional(), organization: text, location: text, arrangement: text, employmentType: text, grade: text, series: text,
  source: z.enum(['pdf', 'markdown', 'docx', 'doc', 'url', 'website']), sourceLabel: nonempty, batchId: id.optional(),
  documentId: id, rubricId: id.nullable(), status: z.enum(['queued', 'parsing', 'generating', 'ready', 'error', 'cancelled']),
  errorStage: z.enum(['download', 'parsing', 'rubric']).optional(), error: text.optional(), createdAt: timestamp,
  dataKind: z.never().optional(),
})
const sampleRunSchema: z.ZodType<AnalysisRun> = z.strictObject({
  id, name: nonempty, displayName: displayName.optional(), createdAt: timestamp,
  targets: z.array(z.strictObject({
    id, kind: z.enum(['job', 'grade']), label: nonempty, displayName: displayName.optional(), sublabel: text,
    rubric: z.strictObject({
      id, groupId: id, kind: z.enum(['job', 'grade']), jobId: id.optional(), ladder: text.optional(), grade: text.optional(),
      name: nonempty, description: nonempty, version, criteria: z.array(criterionSchema).min(1).max(REPORT_LIMITS.maxCriteriaPerTarget),
      createdAt: timestamp, dataKind: z.never().optional(), provenance: z.never().optional(),
    }),
    job: jobSchema.optional(), document: documentSchema.optional(),
  })).min(1).max(REPORT_LIMITS.maxTargets),
  resumes: z.array(z.strictObject({
    resume: z.strictObject({
      id, name: nonempty, displayName: displayName.optional(), role: text, location: text, initials: text, experience: text, documentId: id,
      sourceLabel: nonempty, createdAt: timestamp, sample: z.literal(true),
      evidence: z.partialRecord(key, z.strictObject({ score, paragraphId: id })),
    }),
    document: documentSchema,
  })).min(1).max(REPORT_LIMITS.maxComparisons),
  comparisons: z.array(z.strictObject({
    id, resumeId: id, targetId: id, status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
    score: z.number().finite().min(0).max(100).nullable(), summary: text, error: text.optional(),
    criteria: z.array(z.strictObject({
      criterionId: id, score: score.nullable(), evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']),
      rationale: nonempty, citations: z.array(sourceCitation).max(REPORT_LIMITS.maxCitationsPerAssessment),
    })).max(REPORT_LIMITS.maxCriteriaPerTarget),
  })).min(1).max(REPORT_LIMITS.maxComparisons),
})

function assertUnique(ids: string[], description: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate sample ${description} are not allowed.`)
}

function sampleCitation(citation: Citation, document: SourceDocument): ReportCitation {
  const paragraph = document.paragraphs.find(item => item.id === citation.paragraphId)
  if (citation.documentId !== document.id || citation.documentVersion !== document.version || !paragraph ||
    paragraph.page !== citation.page || paragraph.heading !== citation.heading || !paragraph.text.includes(citation.quote)) {
    throw new Error('A saved sample citation is missing or mismatched with its exact frozen source passage.')
  }
  return createReportCitation(citation, { id: document.id, version: document.version, title: document.title, pagination: 'captured-sections' })
}

function requirementCitations(criterion: Criterion, target: AnalysisTarget): ReportCitation[] {
  if (criterion.sourceCitations?.length) {
    if (!target.document) throw new Error('A sample requirement citation is missing its frozen source document.')
    return criterion.sourceCitations.map(citation => sampleCitation(citation, target.document!))
  }
  if (!criterion.sourceParagraphId) return []
  const document = target.document
  const paragraph = document?.paragraphs.find(item => item.id === criterion.sourceParagraphId)
  if (!document || !paragraph) throw new Error('A sample criterion is missing its frozen requirement passage.')
  return [sampleCitation({
    documentId: document.id, documentVersion: document.version, paragraphId: paragraph.id,
    page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
  }, document)]
}

function targetFacts(target: AnalysisTarget): ReportFact[] {
  const facts: ReportFact[] = [{ label: 'Rubric description', value: target.rubric.description }]
  const append = (label: string, value: string | undefined) => { if (value?.trim()) facts.push({ label, value }) }
  if (target.job) {
    append('Job ID', target.job.id)
    append('Organization', target.job.organization)
    append('Location', target.job.location)
    append('Work arrangement', target.job.arrangement)
    append('Employment type', target.job.employmentType)
    append('Grade', target.job.grade)
    append('Series', target.job.series)
    append('Requirement source', target.job.sourceLabel)
    if (target.document) append('Requirement document', `${target.document.id} · version ${target.document.version}`)
  } else {
    append('Illustrative ladder', target.rubric.ladder)
    append('Illustrative grade', target.rubric.grade)
  }
  return facts
}

export function buildSampleAnalysisReport(run: AnalysisRun, options: SampleAnalysisReportOptions = {}): AnalysisReport {
  assertReportResourceLimits(run)
  const saved = sampleRunSchema.parse(run)
  assertUnique(saved.resumes.map(snapshot => snapshot.resume.id), 'resume IDs')
  assertUnique(saved.targets.map(target => target.id), 'target IDs')
  assertUnique(saved.comparisons.map(comparison => comparison.id), 'comparison IDs')
  assertUnique(saved.comparisons.map(comparison => JSON.stringify([comparison.resumeId, comparison.targetId])), 'candidate/target pairs')
  if (saved.comparisons.length !== saved.resumes.length * saved.targets.length) {
    throw new Error('The sample run is missing saved candidate/target pairs; an incomplete inventory cannot be exported.')
  }
  for (const snapshot of saved.resumes) assertResumeSnapshot(snapshot)
  for (const target of saved.targets) assertTargetSnapshot(target)
  const resumesById = new Map(saved.resumes.map(snapshot => [snapshot.resume.id, snapshot]))
  const targetsById = new Map(saved.targets.map(target => [target.id, target]))
  const requirements = new Map(saved.targets.map(target => [target.id,
    new Map(target.rubric.criteria.map(criterion => [criterion.id, requirementCitations(criterion, target)])),
  ]))
  const targets: ReportTarget[] = saved.targets.map(target => ({
    id: target.id, dataKind: 'sample', kind: target.kind, label: target.label, sublabel: target.sublabel,
    ...(target.displayName === undefined ? {} : { displayName: target.displayName }),
    versionLabel: `Saved ${target.kind === 'grade' ? 'illustrative grade' : 'job'} rubric v${target.rubric.version}`,
    rubricId: target.rubric.id, rubricVersion: target.rubric.version, selection: null, snapshot: null,
    criteria: target.rubric.criteria.map(criterion => ({
      id: criterion.id, label: criterion.label, description: criterion.description, weight: criterion.weight,
      guidance: criterion.guidance, requirementType: criterion.requirementType ?? null,
    })),
    facts: targetFacts(target),
    presentation: {
      title: target.job?.title ?? target.rubric.name,
      organization: target.job?.organization ?? '',
      description: target.rubric.description,
      series: target.job?.series ?? '',
      grade: target.job?.grade ?? target.rubric.grade ?? '',
      versionLabel: `Saved ${target.kind === 'grade' ? 'illustrative grade' : 'job'} rubric v${target.rubric.version}`,
    },
  }))
  const comparisons: ReportComparison[] = saved.comparisons.map((comparison, index) => {
    const resume = resumesById.get(comparison.resumeId)
    const target = targetsById.get(comparison.targetId)
    if (!resume || !target) throw new Error('A sample comparison is missing its frozen resume or exact target snapshot.')
    const complete = comparison.status === 'complete'
    if (!complete && (comparison.score !== null || comparison.criteria.length)) throw new Error('An unfinished sample comparison cannot contain an assessment or score.')
    const definitions = new Map(target.rubric.criteria.map(criterion => [criterion.id, criterion]))
    return {
      id: comparison.id, index, dataKind: 'sample', targetId: target.id,
      candidate: {
        id: resume.resume.id, name: resume.resume.name, role: resume.resume.role, sourceLabel: resume.resume.sourceLabel,
        ...(resume.resume.displayName === undefined ? {} : { displayName: resume.resume.displayName }),
        documentId: resume.document.id, documentVersion: resume.document.version, documentSha256: null, snapshot: null,
      },
      status: comparison.status,
      completion: complete ? (comparison.score === null || comparison.criteria.some(criterion => criterion.evidenceStatus === 'not-assessed') ? 'limited' : 'assessed') : null,
      overall: comparison.status !== 'complete' ? unavailableOverallScore(comparison.status) : comparison.score === null
        ? { status: 'withheld', score: null, reason: 'saved-score-withheld', message: 'The saved sample comparison has no overall score. It has not been recalculated for this report.' }
        : { status: 'available', score: comparison.score },
      summary: complete ? comparison.summary : null,
      coverage: null,
      criteria: complete ? comparison.criteria.map(assessment => {
        const definition = definitions.get(assessment.criterionId)
        if (!definition) throw new Error('A sample assessment refers to a criterion outside its frozen rubric.')
        return {
          criterionId: assessment.criterionId, weight: definition.weight, score: assessment.score,
          evidenceStatus: assessment.evidenceStatus, rationale: assessment.rationale,
          citations: assessment.citations.map(citation => sampleCitation(citation, resume.document)),
          requirementCitations: requirements.get(target.id)!.get(definition.id)!,
          limitation: null,
        }
      }) : [],
      qualifications: [],
      limitations: [],
      error: comparison.error === undefined ? null : { code: 'sample-processing-error', message: comparison.error, stage: null, retryable: null },
      analyzedAt: null,
      resultSha256: null,
      provenance: complete ? [
        { label: 'Assessment method', value: 'Saved fixed synthetic evidence mapping; scores were not recalculated.' },
        { label: 'Analysis timestamp', value: 'Not recorded in this saved sample.' },
      ] : [],
    }
  })
  const parsedOptions = z.strictObject({
    targetId: id.optional(), generatedAt: timestamp.optional(),
    capture: z.strictObject({
      startedAt: timestamp, completedAt: timestamp,
      summaries: reportNarrativeCaptureSchema.optional(), settings: reportSettingsCaptureSchema.optional(),
    }).optional(),
  }).parse(options)
  const generatedAt = parsedOptions.generatedAt ?? new Date().toISOString()
  const fixtureId = sampleReportFixtureId(saved.id)
  for (const target of targets) {
    const selected = comparisons.filter(comparison => comparison.targetId === target.id)
    for (const comparison of selected) {
      if (comparison.status === 'complete') comparison.narrative = sampleCandidateNarrative(fixtureId, target, comparison)
    }
    if (selected.some(comparison => comparison.status === 'complete')) target.narrative = sampleTargetNarrative(fixtureId, target, selected)
  }
  const summaries = sampleNarrativeCapture(fixtureId, targets, comparisons, parsedOptions.targetId ?? null)
  const previous = parsedOptions.capture?.summaries
  if (previous && (previous.dataKind !== 'sample' || previous.fixtureId !== fixtureId ||
    previous.revision !== summaries.revision || previous.scope.targetId !== summaries.scope.targetId)) {
    throw new Error('The sample summary capture does not match this frozen fixture run and selected target scope.')
  }
  return buildAnalysisReport({
    dataKind: 'sample',
    run: { id: saved.id, name: getDisplayName(saved, saved.name), createdAt: saved.createdAt },
    capture: {
      ...(parsedOptions.capture ?? { startedAt: generatedAt, completedAt: generatedAt }),
      summaries,
    },
    generatedAt,
    targets,
    comparisons,
  }, parsedOptions.targetId === undefined ? {} : { targetId: parsedOptions.targetId })
}
