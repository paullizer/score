import { createHash, randomUUID } from 'node:crypto'
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
        export * from './src/services/analysisReports/narratives';
        export * from './src/services/analysisReports/narrative-schemas';
        export * from './src/services/analysisReports/policy';
        export { createDefaultAdminSettings, LEGACY_SETTINGS_REVISION } from './src/domain/admin-settings-defaults';
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

const narrativeHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const narrativePin = narrative => narrative ? { revision: narrative.revision, inputFingerprint: narrative.inputFingerprint } : null

// Test-only publications preserve supplied prose for real report fixtures.
export function withReportNarratives(input, { targetId = null } = {}) {
  const value = structuredClone(input)
  if (value.dataKind !== 'real' ||
    [...value.targets, ...value.comparisons].some(item => item.dataKind !== value.dataKind ||
      (item.narrative?.dataKind !== undefined && item.narrative.dataKind !== value.dataKind))) {
    throw new Error('Narrative test fixtures must use real report provenance.')
  }
  const publicationMetadata = (kind, id, inputFingerprint) =>
    ({ dataKind: 'real', generationId: `${kind}-generation-${id}`, inputFingerprint, publishedAt: REPORT_TEST_TIMESTAMP })
  const publicationRevision = publication => narrativeHash(publication)
  for (const target of value.targets) {
    target.presentation ??= {
      title: target.label, organization: target.sublabel,
      description: 'Captured analytical work requirements and the documented scope of delivery responsibilities.',
      series: target.kind === 'grade' ? '0801' : '',
      grade: target.selection?.kind === 'grade' ? `GS-${target.selection.grade}`
        : target.facts.find(fact => fact.label === 'Illustrative grade')?.value ?? '',
      versionLabel: target.versionLabel,
    }
  }
  for (const comparison of value.comparisons) {
    if (comparison.status !== 'complete') { delete comparison.narrative; continue }
    const inputFingerprint = narrativeHash([comparison.id, comparison.targetId, comparison.candidate.snapshot, comparison.resultSha256])
    const supplied = comparison.narrative
    if (supplied && (typeof supplied.text !== 'string' || typeof supplied.overview !== 'string')) {
      throw new Error('A supplied candidate fixture narrative needs both text and overview.')
    }
    const content = supplied ? { text: supplied.text, overview: supplied.overview } : comparison.overall.status === 'withheld' ? {
      text: 'The saved evidence describes relevant work, but the record does not establish the full scope of the target requirements. Unassessed criteria leave material questions unresolved and prevent a supported overall conclusion. Reviewers should examine the original passages and qualification notes rather than infer undocumented experience.',
      overview: 'Relevant work is documented, but unresolved requirements prevent a supported overall conclusion.',
    } : {
      text: 'The saved resume documents sustained responsibility for investigating operational problems and explaining the resulting findings. Those examples support the analytical and delivery requirements within the scope of the captured evidence. The record does not independently establish every qualification, so reviewers should examine the cited passages and separate limitations.',
      overview: 'The record shows analytical work, but reviewers must verify its scope and unresolved requirements against the saved evidence.',
    }
    const publication = { ...publicationMetadata('candidate', comparison.id, inputFingerprint), ...content,
      ...(supplied?.summaryVersion === undefined ? {} : { summaryVersion: supplied.summaryVersion }),
      ...(supplied?.approval === undefined ? {} : { approval: structuredClone(supplied.approval) }),
    }
    comparison.narrative = { ...publication, revision: publicationRevision(publication) }
  }
  for (const target of value.targets) {
    const comparisons = value.comparisons.filter(comparison => comparison.targetId === target.id)
    if (!comparisons.some(comparison => comparison.status === 'complete')) { delete target.narrative; continue }
    const inputFingerprint = narrativeHash([target.id, target.snapshot, comparisons.map(comparison => [
      comparison.id, comparison.status, comparison.resultSha256, narrativePin(comparison.narrative),
    ])])
    const supplied = target.narrative
    if (supplied && (!Array.isArray(supplied.paragraphs) || supplied.paragraphs.some(paragraph => typeof paragraph !== 'string'))) {
      throw new Error('A supplied target fixture narrative needs saved paragraphs.')
    }
    const publication = {
      ...publicationMetadata('target', target.id, inputFingerprint),
      paragraphs: supplied?.paragraphs ?? ['The reviewed records contain analytical and delivery examples, with differences in the depth of supporting evidence. Incomplete and unassessed requirements remain material limits to comparison, while any failed or cancelled reviews provide no candidate evidence.'],
      ...(supplied?.summaryVersion === undefined ? {} : { summaryVersion: supplied.summaryVersion }),
      ...(supplied?.approval === undefined ? {} : { approval: structuredClone(supplied.approval) }),
    }
    target.narrative = { ...publication, revision: publicationRevision(publication) }
  }
  const comparisons = value.comparisons.filter(comparison => targetId === null || comparison.targetId === targetId).map(comparison => ({
    comparisonId: comparison.id, targetId: comparison.targetId, status: comparison.status,
    resultSha256: comparison.resultSha256, narrative: narrativePin(comparison.narrative),
  }))
  const targets = value.targets.filter(target => targetId === null || target.id === targetId)
    .map(target => ({ targetId: target.id, narrative: narrativePin(target.narrative) }))
  const capture = {
    dataKind: 'real', ready: !comparisons.some(comparison => comparison.status === 'queued' || comparison.status === 'running'),
    scope: { targetId }, comparisons, targets,
  }
  value.capture.summaries = { ...capture, revision: narrativeHash(capture) }
  return value
}

export const withReadyReportNarratives = withReportNarratives

export function version2ReportFixture({ long = false, manual = true } = {}) {
  const input = realReportFixture({ scores: [92.75, null] })
  const approval = (subject, field, paragraphIndex) => manual ? {
    kind: 'manual', approvedAt: REPORT_TEST_TIMESTAMP, approvedBy: 'workspace-editor', reviewOutcome: 'needs-correction',
    issues: [{
      code: 'unsupported-claim', message: `${subject}: independent national responsibility was not established.${long
        ? ` ${'The supplied assessment records narrower scope and should be checked by a human reviewer. '.repeat(15)}` : ''}`,
      field, paragraphIndex,
    }],
  } : { kind: 'automatic' }
  for (const comparison of input.comparisons) comparison.narrative = {
    summaryVersion: 2, approval: approval(comparison.id, 'text', null),
    text: `The saved assessment mentions 1,000 samples as 1000, 12.0 as 12, and a rated 480-volt system${long
      ? `, ${'within the documented engineering scope, '.repeat(65)}without changing the assessment` : ''}. Its original score and limits are unchanged.`,
    overview: `Saved overview for ${comparison.id}: ${long ? 'Documented methods and limited context; '.repeat(65) : 'two sentences are allowed. The recorded limits remain.'}`,
  }
  input.targets[0].narrative = {
    summaryVersion: 2, approval: approval(input.targets[0].id, 'paragraphs', 0),
    paragraphs: Array.from({ length: long ? 4 : 1 }, (_, index) =>
      `Saved target paragraph ${index + 1} covers the supplied assessments${long ? `, ${'retaining recorded strengths and limits, '.repeat(30)}without a new assessment` : ''}. It preserves the scores and frozen evidence.`),
  }
  return withReportNarratives(input)
}

export function reportSummariesFixture(input, options) {
  if (input.dataKind !== 'real') throw new Error('Only a real-shaped test fixture can simulate the real summaries endpoint.')
  const value = withReportNarratives(input, options)
  const capture = value.capture.summaries
  const baseState = {
    waitingFor: null, attempts: 1, retryCount: 0, nextAttemptAt: null, updatedAt: REPORT_TEST_TIMESTAMP, error: null,
  }
  const state = publication => ({
    ...baseState, status: publication ? 'ready' : 'not-required',
    generationId: publication?.generationId ?? null, inputFingerprint: publication?.inputFingerprint ?? null,
    published: publication ?? null,
  })
  const comparisons = capture.comparisons.map(pin => {
    const comparison = value.comparisons.find(comparison => comparison.id === pin.comparisonId)
    return {
      ...state(comparison.narrative), kind: 'candidate', comparisonId: pin.comparisonId, targetId: pin.targetId,
      comparisonStatus: pin.status, resultSha256: pin.resultSha256,
    }
  })
  const targets = capture.targets.map(pin => {
    const target = value.targets.find(target => target.id === pin.targetId)
    return { ...state(target.narrative), kind: 'target', targetId: target.id }
  })
  const counts = entries => {
    const result = { total: entries.length, missing: 0, waiting: 0, queued: 0, running: 0, ready: 0, stale: 0, failed: 0, cancelled: 0, notRequired: 0 }
    for (const entry of entries) result[entry.status === 'not-required' ? 'notRequired' : entry.status]++
    return result
  }
  const scoring = { total: comparisons.length, initialized: comparisons.length, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0 }
  for (const comparison of comparisons) scoring[comparison.comparisonStatus]++
  return {
    schemaVersion: 1, dataKind: 'real', workspaceId: value.workspaceId, runId: value.run.id,
    scope: capture.scope, revision: capture.revision, etag: `"${capture.revision}"`, ready: capture.ready, capture,
    scoring, counts: { candidates: counts(comparisons), targets: counts(targets) },
    capabilities: { canGenerate: true, reason: null }, comparisons, targets,
  }
}
