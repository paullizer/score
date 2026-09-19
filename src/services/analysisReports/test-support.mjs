import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const REPORT_TEST_TIMESTAMP = '2026-09-18T18:00:00.000Z'
export const REPORT_TEST_HASH = 'a'.repeat(64)

export async function loadReportFoundation() {
  const output = resolve(`.analysis-report-tests-${randomUUID()}`)
  await mkdir(output)
  try {
    await build({
      stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
        export * from './src/domain/analysis-reports';
        export * from './src/services/analysisReports/model';
        export * from './src/services/analysisReports/presentation';
        export * from './src/services/analysisReports/readable';
        export * from './src/services/analysisReports/sample';
        export { createInitialWorkspace, createFixtureWorkspace } from './src/data/fixtures';
        export { snapshotAnalysisRun, evaluateComparison } from './src/services/scoring';
      ` },
      outfile: join(output, 'foundation.mjs'), bundle: true, packages: 'external',
      format: 'esm', platform: 'node', logLevel: 'silent',
    })
    return {
      api: await import(pathToFileURL(join(output, 'foundation.mjs')).href),
      cleanup: () => rm(output, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

export function reportFixtureCitation(documentId, {
  version = 2, paragraphId = 'paragraph-one', page = 3, heading = 'Saved evidence',
  quote = 'Documented evidence with café, naïve, Ω, and Кириллица.', sourceTitle = 'Captured source',
  pagination = 'html-sections',
} = {}) {
  const designation = pagination === 'pdf-pages' ? `PDF page ${page}` :
    pagination === 'html-sections' ? `Captured HTML section ${page}` :
      pagination === 'markdown-sections' ? `Markdown section ${page}` : `Captured source section ${page} (not a printed page)`
  return {
    documentId, documentVersion: version, paragraphId, page, heading, quote, sourceTitle, pagination,
    locator: `${sourceTitle} · ${documentId} · version ${version} · ${designation} · ${heading} · paragraph ${paragraphId}`,
  }
}

export function realReportFixture({
  scores = [92.75, 87, 82], targetCount = 1, criterionCount = 2, kind = 'job', statuses = [],
} = {}) {
  const targets = Array.from({ length: targetCount }, (_, index) => {
    const id = `target-${index}`
    return {
      id, dataKind: 'real', kind, label: 'Same saved target label', sublabel: 'Frozen organizational scope',
      versionLabel: `Approved rubric v${index + 1}`, rubricId: `rubric-${index}`, rubricVersion: index + 1,
      selection: kind === 'job' ? {
        kind, jobId: `job-${index}`, rubricId: `rubric-${index}`, rubricVersion: index + 1,
        rubricHash: REPORT_TEST_HASH, documentId: `requirement-${id}`, documentVersion: 2, documentSha256: REPORT_TEST_HASH,
      } : {
        kind, ladderId: `ladder-${index}`, grade: 9, versionId: `version-${index}`, version: index + 1,
        versionHash: REPORT_TEST_HASH, approvalId: `approval-${index}`, reviewId: `review-${index}`,
        sourceSetId: `source-set-${index}`, sourceSetHash: REPORT_TEST_HASH,
      },
      snapshot: { snapshotId: `snapshot-${id}`, sha256: REPORT_TEST_HASH },
      criteria: Array.from({ length: criterionCount }, (_, criterion) => ({
        id: `criterion-${criterion}`, label: 'Duplicate criterion label', description: `Frozen criterion wording ${criterion}.`,
        weight: 100 / criterionCount, guidance: '0: No evidence.\n3: Documented application.\n5: Sustained ownership.',
        requirementType: criterion % 2 ? 'preferred' : 'required',
      })),
      facts: [{ label: 'Approval', value: `Saved approval ${index}; reviewer record retained.` }],
    }
  })
  const comparisons = scores.flatMap((score, candidateIndex) => targets.map(target => {
    const index = candidateIndex * targets.length + targets.indexOf(target)
    const status = statuses[candidateIndex] ?? 'complete'
    const complete = status === 'complete'
    const limited = complete && score === null
    const resumeCitation = reportFixtureCitation(`resume-document-${candidateIndex}`)
    const requirementCitation = reportFixtureCitation(`requirement-${target.id}`, { pagination: 'pdf-pages', page: 178, sourceTitle: 'Frozen requirements' })
    return {
      id: `comparison-${index}`, index, dataKind: 'real', targetId: target.id,
      candidate: {
        id: `candidate-${candidateIndex}`, name: `Candidate ${candidateIndex}`, role: 'Recorded role',
        sourceLabel: 'Saved résumé.docx', documentId: `resume-document-${candidateIndex}`, documentVersion: 2,
        documentSha256: REPORT_TEST_HASH, snapshot: { snapshotId: `resume-snapshot-${candidateIndex}`, sha256: REPORT_TEST_HASH },
      },
      status, completion: complete ? (limited ? 'limited' : 'assessed') : null,
      overall: !complete ? { status: 'unavailable', score: null, reason: 'not-complete', message: 'No completed assessment was captured.' }
        : limited ? { status: 'withheld', score: null, reason: 'unassessed-weighted-criteria', message: 'Weighted criteria were not assessed.' }
          : { status: 'available', score },
      summary: complete ? 'Full saved overall assessment. This is evidence, not a hiring recommendation.' : null,
      coverage: complete ? {
        totalCriteria: criterionCount, supported: limited ? 0 : criterionCount, partial: 0, missing: 0,
        notAssessed: limited ? criterionCount : 0, notApplicable: 0, assessedWeight: limited ? 0 : 100, totalWeight: 100,
      } : null,
      criteria: complete ? target.criteria.map(criterion => ({
        criterionId: criterion.id, weight: criterion.weight, score: limited ? null : 3, evidenceStatus: limited ? 'not-assessed' : 'supported',
        rationale: `Exact saved rationale for ${criterion.id}.`,
        citations: limited ? [] : [structuredClone(resumeCitation)], requirementCitations: [structuredClone(requirementCitation)],
        limitation: limited ? { code: 'not-assessable', message: 'The captured source could not establish this criterion.', criterionId: criterion.id } : null,
      })) : [],
      qualifications: [],
      limitations: [],
      error: status === 'failed' ? { code: 'storage-error', message: 'Saved source could not be read.', stage: 'assessment', retryable: true } : null,
      analyzedAt: complete ? REPORT_TEST_TIMESTAMP : null,
      resultSha256: complete ? REPORT_TEST_HASH : null,
      provenance: complete ? [
        { label: 'Assessment model', value: 'saved-model-version' },
        { label: 'Grounding review', value: 'supported; saved-grounding-review' },
        { label: 'Calculation version', value: 'weighted-0-100-v1' },
      ] : [],
    }
  }))
  return {
    dataKind: 'real', workspaceId: 'workspace-one',
    run: { id: 'run-one', name: 'Saved evidence review', createdAt: '2026-09-17T18:00:00.000Z' },
    capture: { startedAt: REPORT_TEST_TIMESTAMP, completedAt: '2026-09-18T18:00:02.000Z' },
    generatedAt: '2026-09-18T18:00:03.000Z', targets, comparisons,
  }
}

export function realReportBatchFixture(input = realReportFixture()) {
  return { schemaVersion: 1, dataKind: 'real', workspaceId: input.workspaceId, runId: input.run.id, targets: input.targets, comparisons: input.comparisons }
}
