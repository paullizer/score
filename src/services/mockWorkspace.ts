import { createFixtureWorkspace, JOB_FIXTURE_COUNT, RESUME_FIXTURE_COUNT } from '../data/fixtures'
import type { AnalysisRun, ImportCandidate, Job, Resume, Rubric, SourceDocument, SourceKind, Workspace } from '../domain/types'
import { snapshotAnalysisRun } from './scoring'

export { evaluateComparison, validateRubric } from './scoring'

function validateCandidate(candidate: ImportCandidate, count: number): void {
  if (!candidate.label.trim()) throw new Error('An import needs a source label. No file contents or URLs will be read.')
  if (!candidate.key.trim()) throw new Error('An import needs a stable preview key.')
  if (!Number.isInteger(candidate.fixtureIndex) || candidate.fixtureIndex < 0 || candidate.fixtureIndex >= count) {
    throw new Error(`The selected synthetic fixture must have an index between 0 and ${count - 1}.`)
  }
}

function cloneSource(document: SourceDocument): { document: SourceDocument; paragraphIds: Map<string, string> } {
  const cloned = structuredClone(document)
  const paragraphIds = new Map(cloned.paragraphs.map((paragraph) => [paragraph.id, crypto.randomUUID()]))
  cloned.id = crypto.randomUUID()
  cloned.version = 1
  cloned.paragraphs = cloned.paragraphs.map((paragraph) => ({
    ...paragraph,
    id: remapParagraph(paragraphIds, paragraph.id),
  }))
  return { document: cloned, paragraphIds }
}

function remapParagraph(paragraphIds: Map<string, string>, id: string): string {
  const remapped = paragraphIds.get(id)
  if (!remapped) throw new Error(`The synthetic fixture references an unavailable source paragraph: ${id}.`)
  return remapped
}

export function createJobImport(candidate: ImportCandidate, source: SourceKind, batchId: string): { job: Job; document: SourceDocument; rubric: Rubric } {
  validateCandidate(candidate, JOB_FIXTURE_COUNT)
  if (source !== 'pdf' && source !== 'url' && source !== 'website') throw new Error('Choose PDF, direct URL, or website as the import source.')
  if (!batchId.trim()) throw new Error('A job import needs a batch ID.')
  const fixtures = createFixtureWorkspace()
  const template = fixtures.jobs[candidate.fixtureIndex]
  const sourceDocument = fixtures.documents.find((document) => document.id === template.documentId)
  const sourceRubric = fixtures.rubrics.find((rubric) => rubric.id === template.rubricId)
  if (!sourceDocument || !sourceRubric) throw new Error('The synthetic job fixture is missing its source document or rubric.')

  const { document, paragraphIds } = cloneSource(sourceDocument)
  const createdAt = new Date().toISOString()
  const jobId = crypto.randomUUID()
  const rubric: Rubric = {
    ...structuredClone(sourceRubric),
    id: crypto.randomUUID(),
    groupId: crypto.randomUUID(),
    jobId,
    version: 1,
    createdAt,
    criteria: sourceRubric.criteria.map((criterion) => ({
      ...structuredClone(criterion),
      id: crypto.randomUUID(),
      ...(criterion.sourceParagraphId === undefined ? {} : {
        sourceParagraphId: remapParagraph(paragraphIds, criterion.sourceParagraphId),
      }),
    })),
  }
  const job: Job = {
    ...structuredClone(template),
    id: jobId,
    documentId: document.id,
    rubricId: rubric.id,
    source,
    sourceLabel: candidate.label,
    batchId,
    status: 'ready',
    createdAt,
  }
  return { job, document, rubric }
}

export function createResumeImport(candidate: ImportCandidate): { resume: Resume; document: SourceDocument } {
  validateCandidate(candidate, RESUME_FIXTURE_COUNT)
  const fixtures = createFixtureWorkspace()
  const template = fixtures.resumes[candidate.fixtureIndex]
  const sourceDocument = fixtures.documents.find((document) => document.id === template.documentId)
  if (!sourceDocument) throw new Error('The fictional resume fixture is missing its source document.')
  const { document, paragraphIds } = cloneSource(sourceDocument)
  const resume: Resume = {
    ...structuredClone(template),
    id: crypto.randomUUID(),
    documentId: document.id,
    sourceLabel: candidate.label,
    createdAt: new Date().toISOString(),
  }
  for (const evidence of Object.values(resume.evidence)) {
    if (evidence) evidence.paragraphId = remapParagraph(paragraphIds, evidence.paragraphId)
  }
  return { resume, document }
}

export function discoverJobs(url: string, scope: 'single' | 'multiple' | 'deep'): ImportCandidate[] {
  let base: URL
  try {
    base = new URL(url.trim())
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new Error('Enter a complete http:// or https:// website URL to preview synthetic sources.')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported. No website will be fetched.')
  }
  if (base.username || base.password) throw new Error('Use a URL without embedded usernames or passwords.')
  const count = scope === 'single' ? 2 : scope === 'multiple' ? 4 : scope === 'deep' ? 6 : undefined
  if (count === undefined) throw new Error('Choose single-page, multiple-page, or deep synthetic discovery.')
  base.hash = ''
  const prefix = base.pathname.replace(/\/+$/, '')
  return createFixtureWorkspace().jobs.slice(0, count).map((job, fixtureIndex) => {
    const discovered = new URL(base.href)
    const slug = job.title.replace(/\s*\(synthetic\)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    discovered.pathname = `${prefix}/score-demo/${slug}`
    return {
      key: discovered.href,
      label: discovered.href,
      title: job.title,
      fixtureIndex,
    }
  })
}

export function createAnalysisRun(workspace: Workspace, resumeIds: string[], rubricIds: string[], name?: string): AnalysisRun {
  return snapshotAnalysisRun(workspace, resumeIds, rubricIds, name, {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    comparisonId: () => crypto.randomUUID(),
  })
}
