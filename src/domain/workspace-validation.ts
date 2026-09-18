import { z } from 'zod'
import type { AnalysisRun, Job, Resume, Rubric, SourceDocument, Workspace } from './types'
import { validateRubric, weightedScore } from '../services/scoring'

// Pure Zod schema + cross-reference validation shared by the browser demo (src/services/persistence.ts)
// and the cloud server (server/repository.ts). Nothing here touches storage, network, or the DOM.

const text = z.string().refine((value) => value.trim().length > 0, 'Must not be blank')
const positiveInteger = z.number().int().positive()
const timestamp = z.iso.datetime({ offset: true })
const criterionScore = z.number().finite().min(0).max(5)
const paragraphSchema = z.strictObject({
  id: text, page: positiveInteger, heading: text, text,
})
const documentSchema = z.strictObject({
  id: text,
  title: text,
  kind: z.enum(['job', 'resume']),
  version: positiveInteger,
  paragraphs: z.array(paragraphSchema).min(1),
  sample: z.literal(true),
})
const criterionSchema = z.strictObject({
  id: text,
  key: z.enum(['technical', 'delivery', 'analysis', 'communication', 'leadership', 'policy', 'custom']),
  label: text,
  description: text,
  weight: z.number().finite().min(0).max(100),
  guidance: text,
  sourceParagraphId: text.optional(),
})
const rubricSchema = z.strictObject({
  id: text,
  groupId: text,
  kind: z.enum(['job', 'grade']),
  jobId: text.optional(),
  ladder: text.optional(),
  grade: text.optional(),
  name: text,
  description: text,
  version: positiveInteger,
  criteria: z.array(criterionSchema).min(1),
  createdAt: timestamp,
})
const jobSchema = z.strictObject({
  id: text,
  title: text,
  organization: text,
  location: text,
  arrangement: text,
  employmentType: text,
  grade: text,
  series: text,
  source: z.enum(['pdf', 'url', 'website']),
  sourceLabel: text,
  batchId: text.optional(),
  documentId: text,
  rubricId: text.nullable(),
  status: z.enum(['parsing', 'generating', 'ready', 'error', 'cancelled']),
  errorStage: z.enum(['parsing', 'rubric']).optional(),
  error: text.optional(),
  createdAt: timestamp,
})
const evidenceSchema = z.strictObject({ score: criterionScore, paragraphId: text }).optional()
const resumeSchema = z.strictObject({
  id: text,
  name: text,
  role: text,
  location: text,
  initials: text,
  experience: text,
  documentId: text,
  sourceLabel: text,
  createdAt: timestamp,
  sample: z.literal(true),
  evidence: z.strictObject({
    technical: evidenceSchema,
    delivery: evidenceSchema,
    analysis: evidenceSchema,
    communication: evidenceSchema,
    leadership: evidenceSchema,
    policy: evidenceSchema,
    custom: evidenceSchema,
  }),
})
const citationSchema = z.strictObject({
  documentId: text,
  documentVersion: positiveInteger,
  paragraphId: text,
  page: positiveInteger,
  heading: text,
  quote: text,
})
const criterionResultSchema = z.strictObject({
  criterionId: text,
  score: criterionScore.nullable(),
  evidenceStatus: z.enum(['supported', 'partial', 'missing', 'not-assessed']),
  rationale: text,
  citations: z.array(citationSchema),
})
const comparisonSchema = z.strictObject({
  id: text,
  resumeId: text,
  targetId: text,
  status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
  score: z.number().finite().min(0).max(100).nullable(),
  criteria: z.array(criterionResultSchema),
  summary: text,
  error: text.optional(),
})
const targetSchema = z.strictObject({
  id: text,
  kind: z.enum(['job', 'grade']),
  label: text,
  sublabel: text,
  rubric: rubricSchema,
  job: jobSchema.optional(),
  document: documentSchema.optional(),
})
const runSchema = z.strictObject({
  id: text,
  name: text,
  createdAt: timestamp,
  targets: z.array(targetSchema).min(1),
  resumes: z.array(z.strictObject({ resume: resumeSchema, document: documentSchema })).min(1),
  comparisons: z.array(comparisonSchema).min(1),
})
const workspaceSchema: z.ZodType<Workspace> = z.strictObject({
  schemaVersion: z.literal(1),
  jobs: z.array(jobSchema),
  resumes: z.array(resumeSchema),
  documents: z.array(documentSchema),
  rubrics: z.array(rubricSchema),
  runs: z.array(runSchema),
})

function checkUnique(ids: string[], context: string, errors: string[]): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${context} contains a duplicate ID: ${id}.`)
    seen.add(id)
  }
}

function checkDocument(document: SourceDocument, context: string, errors: string[]): void {
  checkUnique(document.paragraphs.map((paragraph) => paragraph.id), `${context} paragraphs`, errors)
}

function checkResume(resume: Resume, document: SourceDocument | undefined, context: string, errors: string[]): void {
  if (!document || document.id !== resume.documentId || document.kind !== 'resume') {
    errors.push(`${context} is missing its matching resume document.`)
    return
  }
  checkDocument(document, context, errors)
  for (const [key, evidence] of Object.entries(resume.evidence)) {
    if (evidence && !document.paragraphs.some((paragraph) => paragraph.id === evidence.paragraphId)) {
      errors.push(`${context} has ${key} evidence pointing to a missing paragraph.`)
    }
  }
}

function checkRubric(rubric: Rubric, job: Job | undefined, document: SourceDocument | undefined, context: string, errors: string[]): void {
  errors.push(...validateRubric(rubric).map((error) => `${context}: ${error}`))
  if (rubric.kind === 'grade') {
    if (!rubric.ladder || !rubric.grade) errors.push(`${context} needs a ladder and grade.`)
    if (rubric.jobId !== undefined || rubric.criteria.some((criterion) => criterion.sourceParagraphId !== undefined)) {
      errors.push(`${context} is a standalone grade rubric but references a job source.`)
    }
    return
  }
  if (!job || rubric.jobId !== job.id) errors.push(`${context} is missing its linked job.`)
  if (!document || document.kind !== 'job' || document.id !== job?.documentId) {
    errors.push(`${context} is missing its linked job document.`)
    return
  }
  for (const criterion of rubric.criteria) {
    if (criterion.sourceParagraphId !== undefined && !document.paragraphs.some((paragraph) => paragraph.id === criterion.sourceParagraphId)) {
      errors.push(`${context}, criterion "${criterion.label}", references a missing job paragraph.`)
    }
  }
}

function checkRun(run: AnalysisRun, errors: string[]): void {
  const context = `Analysis "${run.name}"`
  checkUnique(run.targets.map((target) => target.id), `${context} targets`, errors)
  checkUnique(run.resumes.map((snapshot) => snapshot.resume.id), `${context} resumes`, errors)
  checkUnique(run.comparisons.map((comparison) => comparison.id), `${context} comparisons`, errors)
  const targets = new Map(run.targets.map((target) => [target.id, target]))
  const resumes = new Map(run.resumes.map((snapshot) => [snapshot.resume.id, snapshot]))

  // Historical inputs are checked against their own snapshots, never today's live records.
  for (const target of run.targets) {
    if (target.id !== target.rubric.id || target.kind !== target.rubric.kind) errors.push(`${context} has a target/rubric identity mismatch.`)
    checkRubric(target.rubric, target.job, target.document, `${context}, target "${target.label}"`, errors)
    if (target.kind === 'job') {
      if (target.job?.status !== 'ready' || target.job.rubricId !== target.rubric.id) {
        errors.push(`${context} has a job snapshot that is not ready with its saved rubric.`)
      }
      if (target.document) checkDocument(target.document, `${context} job document`, errors)
    } else if (target.job !== undefined || target.document !== undefined) {
      errors.push(`${context} has a grade target containing an unrelated job snapshot.`)
    }
  }
  for (const snapshot of run.resumes) checkResume(snapshot.resume, snapshot.document, `${context}, resume "${snapshot.resume.name}"`, errors)

  const pairs = new Map<string, Set<string>>()
  for (const comparison of run.comparisons) {
    const pairTargets = pairs.get(comparison.resumeId) ?? new Set<string>()
    if (pairTargets.has(comparison.targetId)) errors.push(`${context} repeats a resume/target comparison.`)
    pairTargets.add(comparison.targetId)
    pairs.set(comparison.resumeId, pairTargets)

    const target = targets.get(comparison.targetId)
    const snapshot = resumes.get(comparison.resumeId)
    if (!target || !snapshot) {
      errors.push(`${context} has a comparison without a saved resume or target.`)
      continue
    }
    const resultContext = `${context}, ${snapshot.resume.name} against ${target.label}`
    if (comparison.status !== 'complete') {
      if (comparison.score !== null || comparison.criteria.length) errors.push(`${resultContext}: unfinished or failed work must not contain a completed score.`)
      if ((comparison.status === 'failed' || comparison.status === 'cancelled') && !comparison.error) {
        errors.push(`${resultContext}: failed or cancelled work needs an explanation.`)
      }
      continue
    }

    const criterionIds = new Set(target.rubric.criteria.map((criterion) => criterion.id))
    const resultIds = comparison.criteria.map((result) => result.criterionId)
    checkUnique(resultIds, `${resultContext} criterion results`, errors)
    const hasAllResults = resultIds.length === criterionIds.size && new Set(resultIds).size === resultIds.length && resultIds.every((id) => criterionIds.has(id))
    if (!hasAllResults) errors.push(`${resultContext}: a completed comparison needs exactly one result per saved criterion.`)

    for (const result of comparison.criteria) {
      const criterion = target.rubric.criteria.find((item) => item.id === result.criterionId)
      if (!criterion) continue
      if (result.evidenceStatus === 'not-assessed') {
        if (result.score !== null || result.citations.length) errors.push(`${resultContext}: an unassessed criterion must not contain a score or invented citations.`)
      } else if (result.score === null) {
        errors.push(`${resultContext}: a null criterion score must be labeled not assessed.`)
      }
      if (criterion.key === 'custom' && result.evidenceStatus !== 'not-assessed') {
        errors.push(`${resultContext}: custom criteria cannot be scored by this demo.`)
      }
      if (result.evidenceStatus === 'missing' && (result.score !== 0 || result.citations.length)) {
        errors.push(`${resultContext}: missing evidence must have a zero evidence score and no citations.`)
      }
      if (result.evidenceStatus === 'supported' || result.evidenceStatus === 'partial') {
        const evidence = snapshot.resume.evidence[criterion.key]
        if (!evidence || result.score !== evidence.score || !result.citations.some((citation) => citation.paragraphId === evidence.paragraphId)) {
          errors.push(`${resultContext}: scored support does not match the saved deterministic evidence mapping.`)
        }
        if (result.score !== null && (result.evidenceStatus === 'supported') !== (result.score >= 4)) {
          errors.push(`${resultContext}: the support label disagrees with the fixed demo score.`)
        }
      }
      for (const citation of result.citations) {
        const paragraph = snapshot.document.paragraphs.find((item) => item.id === citation.paragraphId)
        if (citation.documentId !== snapshot.document.id || citation.documentVersion !== snapshot.document.version) {
          errors.push(`${resultContext}: a citation points outside the saved resume document/version.`)
        }
        if (!paragraph || paragraph.page !== citation.page || paragraph.heading !== citation.heading || !paragraph.text.includes(citation.quote)) {
          errors.push(`${resultContext}: a citation does not match an exact passage, page, and heading in the saved resume.`)
        }
      }
    }
    if (hasAllResults && !validateRubric(target.rubric).length) {
      const expected = weightedScore(target.rubric, comparison.criteria)
      if (expected === null ? comparison.score !== null : comparison.score === null || Math.abs(expected - comparison.score) > 0.000001) {
        errors.push(`${resultContext}: the overall score does not match the saved weighted criteria, or an unassessed criterion was treated as zero.`)
      }
    }
  }
  if (run.comparisons.length !== run.resumes.length * run.targets.length) {
    errors.push(`${context} does not contain all selected resume/target comparisons.`)
  }
  for (const snapshot of run.resumes) {
    for (const target of run.targets) {
      if (!pairs.get(snapshot.resume.id)?.has(target.id)) errors.push(`${context} is missing a selected resume/target pair.`)
    }
  }
}

function referenceErrors(workspace: Workspace): string[] {
  const errors: string[] = []
  checkUnique(workspace.jobs.map((job) => job.id), 'Jobs', errors)
  checkUnique(workspace.resumes.map((resume) => resume.id), 'Resumes', errors)
  checkUnique(workspace.documents.map((document) => document.id), 'Documents', errors)
  checkUnique(workspace.rubrics.map((rubric) => rubric.id), 'Rubrics', errors)
  checkUnique(workspace.runs.map((run) => run.id), 'Analyses', errors)
  checkUnique(workspace.runs.flatMap((run) => run.comparisons.map((comparison) => comparison.id)), 'Analysis comparisons', errors)
  checkUnique(workspace.documents.flatMap((document) => document.paragraphs.map((paragraph) => paragraph.id)), 'Document paragraphs', errors)
  const documents = new Map(workspace.documents.map((document) => [document.id, document]))
  const jobs = new Map(workspace.jobs.map((job) => [job.id, job]))
  const rubrics = new Map(workspace.rubrics.map((rubric) => [rubric.id, rubric]))
  const groupVersions = new Map<string, Set<number>>()
  const groups = new Map<string, Rubric>()

  for (const document of workspace.documents) checkDocument(document, `Document "${document.title}"`, errors)
  for (const job of workspace.jobs) {
    if (documents.get(job.documentId)?.kind !== 'job') errors.push(`Job "${job.title}" is missing its source document.`)
    if (job.status === 'ready' && job.rubricId === null) errors.push(`Ready job "${job.title}" has no linked rubric.`)
    if (job.rubricId !== null) {
      const rubric = rubrics.get(job.rubricId)
      if (!rubric || rubric.kind !== 'job' || rubric.jobId !== job.id) errors.push(`Job "${job.title}" has a missing or mismatched linked rubric.`)
    }
    if ((job.status === 'error' || job.status === 'cancelled') && !job.error) errors.push(`Job "${job.title}" needs an explanation for its ${job.status} state.`)
  }
  for (const resume of workspace.resumes) checkResume(resume, documents.get(resume.documentId), `Resume "${resume.name}"`, errors)
  for (const rubric of workspace.rubrics) {
    const versions = groupVersions.get(rubric.groupId) ?? new Set<number>()
    if (versions.has(rubric.version)) errors.push(`Rubric group "${rubric.name}" contains a duplicate version ${rubric.version}.`)
    versions.add(rubric.version)
    groupVersions.set(rubric.groupId, versions)
    const previous = groups.get(rubric.groupId)
    if (previous && (previous.kind !== rubric.kind || previous.jobId !== rubric.jobId)) errors.push(`Rubric group "${rubric.name}" mixes unrelated target identities.`)
    groups.set(rubric.groupId, rubric)
    const job = rubric.jobId === undefined ? undefined : jobs.get(rubric.jobId)
    checkRubric(rubric, job, job ? documents.get(job.documentId) : undefined, `Rubric "${rubric.name}"`, errors)
  }
  for (const run of workspace.runs) checkRun(run, errors)
  return errors
}

/** Raised by {@link validateWorkspace} when a candidate value fails schema or cross-reference checks. */
export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceValidationError'
  }
}

/**
 * Parses and validates an unknown value as a complete, internally consistent {@link Workspace}.
 * Throws {@link WorkspaceValidationError} with a human-readable reason on any failure.
 * Pure: never mutates or "fixes up" its input, and never invents recovery state.
 */
export function validateWorkspace(value: unknown): Workspace {
  const parsed = workspaceSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new WorkspaceValidationError(`${issue.path.map(String).join('.') || 'Workspace'}: ${issue.message}`)
  }
  const errors = referenceErrors(parsed.data)
  if (errors.length) throw new WorkspaceValidationError(errors[0])
  return parsed.data
}

/**
 * Marks jobs and comparisons that were left mid-flight (parsing/generating/queued/running) as cancelled,
 * with an explanatory message. This is a display-time recovery transform, not a storage-time one:
 * callers must not persist the result as if it were the caller's own edit, and server reads must not
 * call this automatically, since another session may still be actively computing the same workspace.
 */
export function recoverInterrupted(workspace: Workspace): Workspace {
  return {
    ...workspace,
    jobs: workspace.jobs.map((job): Job => job.status === 'parsing' || job.status === 'generating' ? {
      ...job,
      status: 'cancelled',
      errorStage: job.status === 'parsing' ? 'parsing' : 'rubric',
      error: `The simulated ${job.status === 'parsing' ? 'import' : 'rubric generation'} was interrupted when the workspace closed. Retry this job to continue with synthetic content; no source was read.`,
    } : job),
    runs: workspace.runs.map((run) => ({
      ...run,
      comparisons: run.comparisons.map((comparison) => comparison.status === 'queued' || comparison.status === 'running' ? {
        ...comparison,
        status: 'cancelled' as const,
        score: null,
        criteria: [],
        summary: 'This comparison was interrupted before assessment when the workspace closed. No score was assigned. Retry the unfinished comparisons to continue the simulation.',
        error: 'Interrupted on reload. Retry this comparison; completed results in the run have been preserved.',
      } : comparison),
    })),
  }
}
