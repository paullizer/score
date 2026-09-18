import { latestRubrics } from '../domain/selectors'
import { assertEntityWritable } from '../domain/lifecycle'
import type {
  AnalysisRun, AnalysisTarget, Citation, Comparison, CriterionResult, ResumeSnapshot, Rubric, SourceDocument, Workspace,
} from '../domain/types'

const WEIGHT_TOLERANCE = 0.000001

function assertDemoRubric(rubric: Rubric): void {
  if (rubric.dataKind === 'real') throw new Error('Real job and GS grade rubrics cannot use demo scoring, including mixed or directly preselected inputs.')
}

export function validateRubric(rubric: Rubric): string[] {
  const errors: string[] = []
  if (!rubric.name.trim()) errors.push('Give the rubric a name.')
  if (!rubric.description.trim()) errors.push('Add a rubric description.')
  if (!rubric.criteria.length) errors.push('Add at least one criterion.')

  const ids = new Set<string>()
  rubric.criteria.forEach((criterion, index) => {
    const label = `Criterion ${index + 1}${criterion.label.trim() ? ` (${criterion.label})` : ''}`
    if (!criterion.id.trim()) errors.push(`${label} needs an ID.`)
    if (ids.has(criterion.id)) errors.push(`${label} has a duplicate criterion ID.`)
    ids.add(criterion.id)
    if (!criterion.label.trim()) errors.push(`${label} needs a label.`)
    if (!criterion.description.trim()) errors.push(`${label} needs a description.`)
    if (!criterion.guidance.trim()) errors.push(`${label} needs score guidance.`)
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100) {
      errors.push(`${label} must have a finite weight between 0 and 100.`)
    }
  })

  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (!Number.isFinite(total) || Math.abs(total - 100) > WEIGHT_TOLERANCE) {
    errors.push(`Criterion weights must total 100; the current total is ${Number.isFinite(total) ? Number(total.toFixed(6)) : 'invalid'}.`)
  }
  return errors
}

function assertDocument(document: SourceDocument, kind: SourceDocument['kind']): void {
  if (document.kind !== kind || document.sample !== true) {
    throw new Error(`The ${kind} source must be a synthetic ${kind} document.`)
  }
  if (!Number.isInteger(document.version) || document.version < 1 || !document.paragraphs.length) {
    throw new Error(`Source document "${document.title}" has an invalid version or no paragraphs.`)
  }
  const ids = new Set<string>()
  for (const paragraph of document.paragraphs) {
    if (!paragraph.id.trim() || ids.has(paragraph.id)) {
      throw new Error(`Source document "${document.title}" has missing or duplicate paragraph IDs.`)
    }
    ids.add(paragraph.id)
    if (!paragraph.heading.trim() || !paragraph.text.trim() || !Number.isInteger(paragraph.page) || paragraph.page < 1) {
      throw new Error(`Source paragraph "${paragraph.id}" needs text, a heading, and a positive page number.`)
    }
  }
}

export function assertResumeSnapshot(snapshot: ResumeSnapshot): void {
  const { resume, document } = snapshot
  assertDocument(document, 'resume')
  if (resume.sample !== true || resume.documentId !== document.id) {
    throw new Error(`The synthetic source document for "${resume.name}" is missing or mismatched.`)
  }
  for (const [key, evidence] of Object.entries(resume.evidence)) {
    if (!evidence) continue
    if (!Number.isFinite(evidence.score) || evidence.score < 0 || evidence.score > 5) {
      throw new Error(`The fixed ${key} evidence score for "${resume.name}" must be between 0 and 5.`)
    }
    if (!document.paragraphs.some((paragraph) => paragraph.id === evidence.paragraphId)) {
      throw new Error(`The ${key} evidence for "${resume.name}" references a missing resume paragraph.`)
    }
  }
}

export function assertTargetSnapshot(target: AnalysisTarget): void {
  assertDemoRubric(target.rubric)
  if (target.job?.dataKind === 'real') throw new Error('Real jobs cannot be evaluated by the fixture scorer.')
  const errors = validateRubric(target.rubric)
  if (errors.length) throw new Error(`"${target.rubric.name}" is not ready: ${errors.join(' ')}`)
  if (target.id !== target.rubric.id || target.kind !== target.rubric.kind) {
    throw new Error('The analysis target does not match its saved rubric.')
  }
  if (target.kind === 'grade') {
    if (!target.rubric.ladder?.trim() || !target.rubric.grade?.trim()) {
      throw new Error('An illustrative grade target needs a ladder and grade label.')
    }
    if (target.job || target.document || target.rubric.jobId || target.rubric.criteria.some((criterion) => criterion.sourceParagraphId !== undefined)) {
      throw new Error('A standalone grade rubric cannot reference a job or job document.')
    }
    return
  }

  const { job, document, rubric } = target
  if (!job || !document || job.id !== rubric.jobId || job.documentId !== document.id) {
    throw new Error('The job target is missing its linked job or source document.')
  }
  if (job.status !== 'ready' || job.rubricId !== rubric.id) {
    throw new Error(`"${job.title}" is not ready with the selected rubric.`)
  }
  assertDocument(document, 'job')
  for (const criterion of rubric.criteria) {
    if (criterion.sourceParagraphId !== undefined && !document.paragraphs.some((paragraph) => paragraph.id === criterion.sourceParagraphId)) {
      throw new Error(`"${criterion.label}" references a missing job requirement paragraph.`)
    }
  }
}

function assertSelection(ids: string[], label: string): void {
  if (!ids.length) throw new Error(`Select at least one ${label}.`)
  if (ids.some((id) => !id.trim())) throw new Error(`Every selected ${label} needs an ID.`)
  if (new Set(ids).size !== ids.length) throw new Error(`Select each ${label} only once; duplicate selections are not allowed.`)
}

interface RunIdentity {
  id: string
  createdAt: string
  comparisonId: (index: number) => string
}

// Seeded examples supply fixed identities; user-created runs supply fresh UUIDs.
export function snapshotAnalysisRun(
  workspace: Workspace,
  resumeIds: string[],
  rubricIds: string[],
  name: string | undefined,
  identity: RunIdentity,
): AnalysisRun {
  assertEntityWritable(workspace, { kind: 'workspace', id: 'sample' })
  assertSelection(resumeIds, 'resume')
  assertSelection(rubricIds, 'rubric target')
  for (const rubric of workspace.rubrics.filter((item) => rubricIds.includes(item.id))) assertDemoRubric(rubric)
  const latest = new Map(latestRubrics(workspace).map((rubric) => [rubric.groupId, rubric.id]))
  const resumes = resumeIds.map((id): ResumeSnapshot => {
    const matches = workspace.resumes.filter((resume) => resume.id === id)
    const resume = matches[0]
    if (!resume || matches.length !== 1) throw new Error(`Selected resume "${id}" is missing or has an ambiguous ID.`)
    assertEntityWritable(workspace, { kind: 'resume', id: resume.id })
    const documents = workspace.documents.filter((document) => document.id === resume.documentId)
    const document = documents[0]
    if (!document || documents.length !== 1) throw new Error(`The source document for "${resume.name}" is missing or ambiguous.`)
    const snapshot = { resume, document }
    assertResumeSnapshot(snapshot)
    return snapshot
  })
  const targets = rubricIds.map((id): AnalysisTarget => {
    const matches = workspace.rubrics.filter((rubric) => rubric.id === id)
    const rubric = matches[0]
    if (!rubric || matches.length !== 1) throw new Error(`Selected rubric "${id}" is missing or has an ambiguous ID.`)
    assertEntityWritable(workspace, { kind: 'rubric', id: rubric.groupId })
    let target: AnalysisTarget
    if (rubric.kind === 'grade') {
      if (latest.get(rubric.groupId) !== rubric.id) {
        throw new Error(`"${rubric.name}" is an older version. Select the latest grade rubric to start a new analysis.`)
      }
      target = {
        id: rubric.id,
        kind: 'grade',
        label: rubric.name,
        sublabel: `${rubric.ladder ?? 'Illustrative ladder'} · ${rubric.grade ?? 'Grade example'} · Not an official GS assessment`,
        rubric,
      }
    } else {
      const jobs = workspace.jobs.filter((job) => job.id === rubric.jobId)
      const job = jobs[0]
      if (!job || jobs.length !== 1) throw new Error(`The job linked to "${rubric.name}" is missing or ambiguous.`)
      assertEntityWritable(workspace, { kind: 'job', id: job.id })
      if (job.rubricDeletedAt) throw new Error(`"${job.title}" has No rubric. Select another job with an active current rubric.`)
      if (job.status !== 'ready') throw new Error(`"${job.title}" is ${job.status}, not analysis-ready. Finish or retry the import first.`)
      if (job.rubricId !== rubric.id) throw new Error(`"${rubric.name}" is not the job's current linked rubric. Select its current version.`)
      const documents = workspace.documents.filter((document) => document.id === job.documentId)
      const document = documents[0]
      if (!document || documents.length !== 1) throw new Error(`The source document for "${job.title}" is missing or ambiguous.`)
      target = {
        id: rubric.id,
        kind: 'job',
        label: job.title,
        sublabel: `${job.organization} · ${job.grade}`,
        rubric,
        job,
        document,
      }
    }
    assertTargetSnapshot(target)
    return target
  })

  const comparisons: Comparison[] = []
  for (const { resume } of resumes) {
    for (const target of targets) {
      comparisons.push({
        id: identity.comparisonId(comparisons.length),
        resumeId: resume.id,
        targetId: target.id,
        status: 'queued',
        score: null,
        criteria: [],
        summary: 'Waiting for the fixed synthetic evidence simulation. No score has been assigned.',
      })
    }
  }
  if (!identity.id.trim() || comparisons.some((comparison) => !comparison.id.trim()) || new Set(comparisons.map((comparison) => comparison.id)).size !== comparisons.length) {
    throw new Error('Analysis and comparison identities must be nonempty and unique.')
  }
  return structuredClone({
    id: identity.id,
    name: name?.trim() || `${resumes.length} ${resumes.length === 1 ? 'resume' : 'resumes'} · ${targets.length === 1 ? targets[0].label : `${targets.length} separate targets`}`,
    createdAt: identity.createdAt,
    targets,
    resumes,
    comparisons,
  })
}

export function weightedScore(rubric: Rubric, results: CriterionResult[]): number | null {
  assertDemoRubric(rubric)
  const errors = validateRubric(rubric)
  if (errors.length) throw new Error(errors.join(' '))
  if (results.length !== rubric.criteria.length || new Set(results.map((result) => result.criterionId)).size !== results.length) {
    throw new Error('A weighted total requires exactly one result for every rubric criterion.')
  }
  let sum = 0
  let unassessed = false
  for (const criterion of rubric.criteria) {
    const result = results.find((item) => item.criterionId === criterion.id)
    if (!result) throw new Error(`No result was provided for "${criterion.label}".`)
    if (result.score === null || result.evidenceStatus === 'not-assessed') {
      unassessed = true
      continue
    }
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 5) {
      throw new Error(`The score for "${criterion.label}" must be between 0 and 5.`)
    }
    sum += criterion.weight * result.score / 5
  }
  return unassessed ? null : Math.round((sum + Number.EPSILON) * 10) / 10
}

function describeComparison(snapshot: ResumeSnapshot, target: AnalysisTarget, results: CriterionResult[]): string {
  const labels = new Map(target.rubric.criteria.map((criterion) => [criterion.id, criterion.label]))
  const strongest = [...results].filter((result) => result.score !== null && result.score > 0 && result.citations.length)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
  const missing = results.filter((result) => result.evidenceStatus === 'missing').map((result) => labels.get(result.criterionId)).join(', ')
  const partial = results.filter((result) => result.evidenceStatus === 'partial').map((result) => labels.get(result.criterionId)).join(', ')
  const unassessed = results.filter((result) => result.evidenceStatus === 'not-assessed').map((result) => labels.get(result.criterionId)).join(', ')
  const statements = [`For ${target.label}, ${snapshot.resume.name}'s synthetic resume is compared only with this target's saved criteria.`]
  if (strongest) {
    const citation = strongest.citations[0]
    statements.push(`The strongest illustrated support is ${labels.get(strongest.criterionId)} (${strongest.score}/5), cited in “${citation.heading}” on page ${citation.page}.`)
  } else {
    statements.push('There is no positive cited support in the fixed evidence mapping for this target.')
  }
  if (partial) statements.push(`The mapped support is partial for ${partial}; fuller examples would be needed to establish the requested depth.`)
  if (missing) statements.push(`No cited evidence is mapped for ${missing}. This is a document-evidence gap, not a claim that the person lacks a skill.`)
  if (!partial && !missing && !unassessed) statements.push('Every criterion has cited support in this illustrative mapping; the example does not establish real-world qualifications.')
  if (unassessed) statements.push(`${unassessed} cannot be assessed by the fixed demo mapping, so the overall score is withheld.`)
  statements.push(target.kind === 'grade'
    ? 'These fixed fixture scores are illustrative, not an official GS assessment, eligibility decision, or hiring recommendation.'
    : 'These are fixed fixture scores, not a real matching algorithm or hiring recommendation.')
  return statements.join(' ')
}

export function evaluateComparison(run: AnalysisRun, comparisonId: string): Comparison {
  for (const target of run.targets) {
    assertDemoRubric(target.rubric)
    if (target.job?.dataKind === 'real') throw new Error('Mixed real and sample analysis runs cannot use fixture scoring.')
  }
  const matches = run.comparisons.filter((comparison) => comparison.id === comparisonId)
  const comparison = matches[0]
  if (!comparison || matches.length !== 1) throw new Error(`Comparison "${comparisonId}" is missing or ambiguous in this run.`)
  const resumeMatches = run.resumes.filter((snapshot) => snapshot.resume.id === comparison.resumeId)
  const targetMatches = run.targets.filter((target) => target.id === comparison.targetId)
  const snapshot = resumeMatches[0]
  const target = targetMatches[0]
  if (!snapshot || !target || resumeMatches.length !== 1 || targetMatches.length !== 1) {
    throw new Error('The comparison is missing a unique saved resume or target.')
  }
  assertResumeSnapshot(snapshot)
  assertTargetSnapshot(target)

  const criteria = target.rubric.criteria.map((criterion): CriterionResult => {
    if (criterion.key === 'custom') {
      return {
        criterionId: criterion.id,
        score: null,
        evidenceStatus: 'not-assessed',
        rationale: `"${criterion.label}" is a custom criterion with no deterministic fixture mapping. It has not been assessed; a real assessment service would be needed. No score or supporting quotation has been invented.`,
        citations: [],
      }
    }
    const evidence = snapshot.resume.evidence[criterion.key]
    if (!evidence) {
      return {
        criterionId: criterion.id,
        score: 0,
        evidenceStatus: 'missing',
        rationale: `No cited evidence for "${criterion.label}" is mapped in this synthetic resume for ${target.label}. The demo uses 0 for missing document support, not as a claim that the fictional candidate lacks this skill.`,
        citations: [],
      }
    }
    const paragraph = snapshot.document.paragraphs.find((item) => item.id === evidence.paragraphId)
    if (!paragraph) throw new Error(`The saved source paragraph for "${criterion.label}" is unavailable.`)
    const citation: Citation = {
      documentId: snapshot.document.id,
      documentVersion: snapshot.document.version,
      paragraphId: paragraph.id,
      page: paragraph.page,
      heading: paragraph.heading,
      quote: paragraph.text,
    }
    const supported = evidence.score >= 4
    return {
      criterionId: criterion.id,
      score: evidence.score,
      evidenceStatus: supported ? 'supported' : 'partial',
      rationale: `For "${criterion.label}" in ${target.label}, the fixed ${criterion.key} fixture anchor assigns ${evidence.score}/5 to the passage in "${paragraph.heading}". ${supported ? 'It provides substantial illustrated support for this criterion.' : 'It provides limited illustrated support; the passage does not establish the full requested scope.'} This is a predefined demo score, not an inferred judgment.`,
      citations: [citation],
    }
  })
  return {
    id: comparison.id,
    resumeId: comparison.resumeId,
    targetId: comparison.targetId,
    status: 'complete',
    score: weightedScore(target.rubric, criteria),
    criteria,
    summary: describeComparison(snapshot, target, criteria),
  }
}
