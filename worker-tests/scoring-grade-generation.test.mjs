import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  createEvaluationSettings, evaluationHash, executeGradeGeneration, executeGradeGenerationSuite, gradeGenerationSuiteSchema,
  summarizeGradeGeneration, validateGradeGeneration, validateGradeGenerationObservations, GRADE_GENERATION_VERSION,
} = await loadWorker('../worker/evals/index.ts')

const timestamp = '2026-10-08T12:00:00.000Z'
const guidance = '0: No document evidence; 1: Coursework or a listed method; 2: One applied analysis; 3: Repeated program analyses; 4: Selects methods for varied assignments; 5: Leads analyses with described outcomes.'

function citation(document, paragraphId) {
  const paragraph = document.paragraphs.find(value => value.id === paragraphId)
  return {
    documentId: document.id, documentVersion: document.version, paragraphId,
    page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
  }
}

function passageRef(document, paragraphId) {
  const index = document.paragraphs.findIndex(value => value.id === paragraphId)
  return { documentId: document.id, passageIds: [`${document.id}:p${index + 1}`] }
}

function frozenSource(document, overrides = {}) {
  return {
    sourceId: `source-${document.id}`, title: document.title, origin: 'opm', purpose: 'grading',
    publisher: 'Captured publisher', documentId: document.id, documentVersion: document.version,
    documentBlobName: `workspace-test/ladder-test/${document.id}/document-v${document.version}.json`,
    originalBlobName: `workspace-test/ladder-test/${document.id}/original.pdf`,
    sha256: 'a'.repeat(64), authorityStatus: 'current',
    coverage: { series: ['0343'], grades: [9, 11], functions: [], state: 'confirmed', explanation: 'Coverage was confirmed from captured source evidence.' },
    pageCount: document.pageCount, selectedPages: document.selectedPages, completeness: document.completeness,
    issues: [], ...overrides,
  }
}

function ladderFixture() {
  const role = {
    id: 'document-seed', version: 2, kind: 'reference', title: 'Public service analyst', sample: false,
    pageCount: 2, selectedPages: [], completeness: 'complete',
    paragraphs: [{ id: 'p-role', page: 2, heading: 'Work responsibilities', text: 'Analyze public service processes and document findings for program stakeholders.' }],
  }
  const grading = {
    id: 'document-grading', version: 3, kind: 'reference', title: 'Captured analytical work guide', sample: false,
    pageCount: 20, selectedPages: [], completeness: 'complete',
    paragraphs: [
      { id: 'p-scope', page: 1, heading: 'Scope and applicability', text: 'Apply these work-level passages only within their confirmed occupational and functional coverage.' },
      { id: 'p-gs9', page: 9, heading: 'GS-9', text: 'Apply established analytical methods to bounded program assignments, with conclusions reviewed by the supervisor.' },
      { id: 'p-gs11', page: 11, heading: 'GS-11', text: 'Independently select analytical methods for varied program assignments and explain conclusions to program managers.' },
    ],
  }
  const roleSource = frozenSource(role, { origin: 'seed-job', purpose: 'job-context', authorityStatus: 'supplied' })
  const guideSource = frozenSource(grading)
  const selected = source => ({ sourceId: source.sourceId, selected: true, applicability: 'applicable', reason: 'Applicable captured source reviewed.' })
  const context = {
    series: '0343', agency: 'Example federal agency', agencyType: 'other-federal',
    supervision: 'nonsupervisory', functions: [], specialty: 'Public services', confirmed: true, answers: {},
  }
  const sourceSet = {
    id: 'source-set-test', recordType: 'grade-source-set', workspaceId: 'workspace-test', ladderId: 'ladder-test',
    revision: 1, context, grades: [9, 11], seedBlobName: 'workspace-test/ladder-test/seed.json',
    sources: [roleSource, guideSource], decisions: [selected(roleSource), selected(guideSource)], issues: [],
    contentHash: 'source-set-hash', confirmedBy: 'reviewer-test', createdAt: timestamp, updatedAt: timestamp,
  }
  const job = {
    id: 'job-test', title: 'Public service analyst', organization: 'Example federal agency',
    location: 'Not stated', arrangement: 'Not stated', employmentType: 'Not stated', grade: 'GS-11', series: '0343',
    source: 'pdf', sourceLabel: 'Captured role.pdf', documentId: role.id, rubricId: 'job-rubric-test',
    status: 'ready', createdAt: timestamp, dataKind: 'real',
  }
  const seed = {
    job, document: { id: role.id, version: role.version, title: role.title, kind: 'job', sample: false, paragraphs: role.paragraphs },
    rubric: {
      id: job.rubricId, groupId: 'job-rubric-group', kind: 'job', dataKind: 'real', jobId: job.id,
      name: job.title, description: 'A saved rubric for the captured job only.', version: 4, createdAt: timestamp,
      criteria: [{
        id: 'seed-analysis', key: 'analysis', label: 'Program analysis',
        description: role.paragraphs[0].text, weight: 100, guidance, sourceCitations: [citation(role, 'p-role')],
      }],
    },
    source: { kind: 'pdf', displayName: 'Captured role.pdf' }, capturedAt: timestamp,
  }
  const ladder = {
    id: sourceSet.ladderId, recordType: 'grade-ladder', workspaceId: sourceSet.workspaceId, name: 'Public service analysis',
    context, grades: [9, 11], seedJobId: job.id, seedRubricId: seed.rubric.id, seedRubricVersion: seed.rubric.version,
    seedJobTitle: job.title, seedBlobName: sourceSet.seedBlobName, sourceIds: sourceSet.sources.map(value => value.sourceId),
    sourceRevision: 1, sourceSetId: sourceSet.id, generationId: 'generation-test', status: 'generating',
    issues: [], createdAt: timestamp, updatedAt: timestamp, createdBy: 'reviewer-test', inputFingerprint: 'ladder-fingerprint',
  }
  const competencies = [{
    id: 'competency-analysis', label: 'Program analysis', description: role.paragraphs[0].text,
    seedCriterionIds: ['seed-analysis'], citations: [citation(role, 'p-role')],
  }]
  return { fixture: { ladder, seed, sourceSet, documents: [role, grading] }, role, grading, competencies }
}

function draftOutput({ role, grading }, grade) {
  const levels = [
    'Lists coursework or methods related to program analysis.',
    'Describes one bounded assignment using an established analytical method.',
    'Shows recurring program analysis with cited methods.',
    'Describes adapting methods across varied program assignments.',
    'Shows leading analytical method work with documented organizational outcomes.',
  ].map((examples, index) => ({ level: index + 1, examples }))
  return {
    description: `Work expectations grounded in the captured GS-${grade} evidence.`,
    criteria: [{
      competencyId: 'competency-analysis', key: 'analysis', description: citation(grading, `p-gs${grade}`).quote,
      weight: 100, guidance: 'Generated by the worker.', levels, support: 'direct',
      sourceCitations: [passageRef(role, 'p-role')], gradeBasis: [passageRef(grading, `p-gs${grade}`)],
      interpretation: `Score interpretation of the cited GS-${grade} work scope; weights and anchors are proposed for human review.`,
    }],
    qualifications: [], issues: [],
  }
}

function harness() {
  const data = ladderFixture()
  const binding = { deploymentName: 'grade-mini', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
  const snapshot = createEvaluationSettings({
    revision: 'grade-test', capturedAt: timestamp, assessor: binding, reviewer: binding,
    tasks: { gradeCompetencies: binding, gradeDraft: binding, gradeReview: binding },
  })
  const suite = gradeGenerationSuiteSchema.parse({
    schemaVersion: 1, id: 'grade-suite', purpose: 'screening', repetitions: 2,
    configurations: [{ id: 'baseline', settingsSha256: evaluationHash(snapshot), algorithmVersion: GRADE_GENERATION_VERSION }],
    sources: [{ id: 'ladder-test', fixtureSha256: evaluationHash(data.fixture), grades: [9, 11] }],
  })
  const job = { suiteSha256: evaluationHash(suite), source: suite.sources[0], configuration: suite.configurations[0], repetition: 1 }
  const prices = { 'grade-mini': { version: 'test-rates', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } }
  return { ...data, snapshot, suite, job, prices }
}

/** Answers like Azure OpenAI, choosing the plan, draft or review payload from the structured-output schema name. */
function fakeAzure(data, { failReviewFor } = {}) {
  const requests = []
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const name = body.response_format.json_schema.name
    const user = body.messages[1].content
    const grade = Number(/"grade":(\d+)/.exec(user)?.[1])
    requests.push({ name, grade, deployment: body.model, reasoning: body.reasoning_effort })
    const content = name === 'score_grade_competencies_v2' ? JSON.stringify({ competencies: data.competencies, issues: [] })
      : name === 'score_grade_draft_v4' ? JSON.stringify(draftOutput(data, grade))
        : grade === failReviewFor ? 'not json' : JSON.stringify({ outcome: 'supported', issues: [] })
    return Response.json({
      model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } },
    })
  }
  return { fetch, requests }
}

function options(data, azure, sink) {
  return {
    fixture: data.fixture, processingSettings: data.snapshot, prices: data.prices, createdAt: timestamp,
    model: { endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini', getToken: async () => 'test-token', fetch: azure.fetch },
    admitPaidWork: async () => { sink.admitted++ },
    recordAttempt: async (attempt, amount) => { sink.attempts.push({ attempt, amount }) },
    recordPrivateGeneration: async generated => { sink.generated.push(generated) },
    recordPrivateFailure: async failure => { sink.failures.push(failure) },
  }
}

const emptySink = () => ({ admitted: 0, attempts: [], generated: [], failures: [] })

test('grade generation plans once, then drafts and independently reviews every grade with exact task bindings and costs', async () => {
  const data = harness(), azure = fakeAzure(data), sink = emptySink()
  const result = await executeGradeGeneration(data.job, options(data, azure, sink))
  assert.deepEqual(result.grades.map(row => [row.grade, row.status, row.reviewOutcome]), [[9, 'complete', 'supported'], [11, 'complete', 'supported']])
  assert.equal(result.competencies, 1)
  assert.deepEqual(azure.requests.map(row => row.name), [
    'score_grade_competencies_v2', 'score_grade_draft_v4', 'score_grade_review_v2', 'score_grade_draft_v4', 'score_grade_review_v2',
  ])
  assert.ok(azure.requests.every(row => row.deployment === 'grade-mini' && row.reasoning === 'low'))
  assert.equal(sink.admitted, 1)
  assert.equal(sink.attempts.length, 5)
  assert.ok(sink.attempts.every(row => row.amount === 200))
  assert.deepEqual(sink.generated[0].grades.map(row => [row.grade, row.draft.rubric.grade, row.review.outcome]), [[9, 'GS-9', 'supported'], [11, 'GS-11', 'supported']])
  assert.equal(result.grades[0].rubricSha256, evaluationHash(sink.generated[0].grades[0].draft.rubric))
  assert.deepEqual(sink.failures, [])
})

test('a failed review fails only that grade, while a broken frozen fixture or missing price stops before paid work', async () => {
  const data = harness(), azure = fakeAzure(data, { failReviewFor: 11 }), sink = emptySink()
  const result = await executeGradeGeneration(data.job, options(data, azure, sink))
  assert.deepEqual(result.grades.map(row => [row.grade, row.status]), [[9, 'complete'], [11, 'failed']])
  assert.deepEqual([result.grades[1].stage, result.grades[1].code], ['review', 'invalid-model-output'])
  assert.deepEqual(sink.failures.map(row => [row.grade, row.stage, row.code]), [[11, 'review', 'invalid-model-output']])
  assert.deepEqual(sink.generated[0].grades.map(row => row.grade), [9])
  const stale = structuredClone(data.fixture)
  stale.documents[1].paragraphs[1].text = 'Changed after freezing.'
  assert.throws(() => validateGradeGeneration(data.job, { fixture: stale, processingSettings: data.snapshot, prices: data.prices }), /frozen ladder fixture/)
  assert.throws(() => validateGradeGeneration(data.job, { fixture: data.fixture, processingSettings: data.snapshot, prices: {} }), /prices/)
  assert.throws(() => validateGradeGeneration({ ...data.job, source: { ...data.job.source, grades: [12] } },
    { fixture: data.fixture, processingSettings: data.snapshot, prices: data.prices }), /requested grades/)
  const broken = structuredClone(data.fixture)
  broken.seed.job.status = 'error'
  const brokenSource = { ...data.job.source, fixtureSha256: evaluationHash(broken) }
  await assert.rejects(executeGradeGeneration({ ...data.job, source: brokenSource }, { ...options(data, fakeAzure(data), emptySink()), fixture: broken }),
    error => error.code === 'invalid-input')
})

test('grade summaries count only reviewed-and-supported drafts as valid and bind every artifact to its observation', () => {
  const data = harness()
  const rubric = grade => ({ id: `rubric-${grade}`, criteria: [{ id: 'competency-analysis', weight: 100, sourceCitations: [citation(data.grading, `p-gs${grade}`)] }] })
  const complete = (repetition, outcome11) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(data.suite), sourceId: 'ladder-test', configurationId: 'baseline', repetition,
    durationMilliseconds: 5, result: {
      status: 'complete', competencies: 1, grades: [
        { grade: 9, status: 'complete', rubricSha256: evaluationHash(rubric(9)), criteria: 1, reviewOutcome: 'supported' },
        { grade: 11, status: 'complete', rubricSha256: evaluationHash(rubric(11)), criteria: 1, reviewOutcome: outcome11 },
      ],
    },
  })
  const observations = [complete(1, 'supported'), complete(2, 'needs-sources')]
  const artifacts = [1, 2].map(repetition => ({
    sourceId: 'ladder-test', configurationId: 'baseline', repetition, grades: [9, 11].map(grade => ({ grade, rubric: rubric(grade) })),
  }))
  const report = summarizeGradeGeneration(data.suite, observations, artifacts)
  assert.deepEqual(report.cells.map(row => [row.sourceId, row.expected, row.completed, row.drafted, row.needsSources, row.failed, row.missing]), [
    ['ladder-test:gs-9', 2, 2, 2, 0, 0, 0], ['ladder-test:gs-11', 2, 1, 2, 1, 0, 0],
  ])
  assert.equal(report.cells[0].meanRepeatAlignmentRate, 1)
  assert.equal(report.eligibleForRelease, false)
  assert.throws(() => summarizeGradeGeneration(data.suite, observations, artifacts.slice(1)), /artifact/)
  const tampered = structuredClone(artifacts)
  tampered[0].grades[0].rubric.criteria[0].weight = 50
  assert.throws(() => summarizeGradeGeneration(data.suite, observations, tampered), /exactly match/)
  assert.throws(() => validateGradeGenerationObservations(data.suite, [{ ...observations[0], result: { ...observations[0].result, grades: observations[0].result.grades.slice(1) } }]), /every requested grade/)
})

test('the grade suite executor resumes only missing generations in repetition-major order', async () => {
  const data = harness()
  const suite = gradeGenerationSuiteSchema.parse({
    ...data.suite, repetitions: 3,
    sources: [data.suite.sources[0], { id: 'ladder-two', fixtureSha256: 'b'.repeat(64), grades: [11] }],
  })
  const failed = (sourceId, repetition) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(suite), sourceId, configurationId: 'baseline', repetition,
    durationMilliseconds: 1, result: { status: 'failed', stage: 'plan', code: 'invalid-model-output' },
  })
  const executed = [], saved = []
  await executeGradeGenerationSuite(suite, {
    concurrency: 1, priorObservations: [failed('ladder-test', 1)],
    execute: async job => { executed.push(`${job.source.id}:${job.repetition}`); return failed(job.source.id, job.repetition).result },
    checkpoint: async observation => { saved.push(observation) },
  })
  assert.deepEqual(executed, ['ladder-two:1', 'ladder-test:2', 'ladder-two:2', 'ladder-test:3', 'ladder-two:3'])
  assert.equal(saved.length, 5)
  assert.throws(() => gradeGenerationSuiteSchema.parse({ ...data.suite, sources: [{ ...data.suite.sources[0], grades: [9, 9] }] }), /unique/)
})

test('the paid runner resumes grade-generation manifests without inference, the report binds artifacts, and stale fixtures are refused', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const exec = promisify(execFile)
  const runner = fileURLToPath(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url))
  const cli = fileURLToPath(new URL('../scripts/scoring-evaluation.mjs', import.meta.url))
  const data = harness()
  const root = await mkdtemp(join(tmpdir(), 'score-grade-runner-'))
  try {
    const generated = []
    for (const repetition of [1, 2]) {
      const sink = emptySink()
      const result = await executeGradeGeneration({ ...data.job, repetition }, options(data, fakeAzure(data), sink))
      generated.push({ repetition, result, artifact: sink.generated[0] })
    }
    const prices = data.prices
    const manifest = {
      kind: 'grade-generation', suite: data.suite, endpoint: 'https://test-account.openai.azure.com/', programId: 'grade-program',
      concurrency: 1, createdAt: timestamp, fixtures: [{ sourceId: 'ladder-test', fixture: data.fixture }],
      settings: [{ id: 'baseline', snapshot: data.snapshot }], prices,
    }
    const output = join(root, 'run'), manifestPath = join(root, 'manifest.json')
    await mkdir(output)
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(manifest)),
      writeFile(join(output, 'observations.json'), JSON.stringify(generated.map(({ repetition, result }) => ({
        schemaVersion: 1, suiteSha256: evaluationHash(data.suite), sourceId: 'ladder-test', configurationId: 'baseline',
        repetition, durationMilliseconds: 1, result,
      })))),
      ...generated.map(({ repetition, artifact }) => writeFile(join(output, `${evaluationHash(['ladder-test', 'baseline', repetition])}.grades.json`),
        JSON.stringify({ sourceId: 'ladder-test', configurationId: 'baseline', repetition, ...artifact }))),
    ])
    const run = await exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference'])
    assert.match(run.stdout, /evaluation-complete/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    const reportPath = join(root, 'grade-report.json')
    await exec(process.execPath, [cli, 'grade-report', manifestPath, output, reportPath])
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.deepEqual(report.cells.map(row => [row.sourceId, row.completed, row.meanRepeatAlignmentRate]), [
      ['ladder-test:gs-9', 2, 1], ['ladder-test:gs-11', 2, 1],
    ])
    manifest.fixtures[0].fixture.documents[1].paragraphs[0].text = 'Changed after freezing.'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference']), /frozen ladder fixture/)
    delete manifest.createdAt
    manifest.fixtures[0].fixture = data.fixture
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference']), /createdAt/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grade-target scoring inputs mirror production and bind to suite cases with targetKind grade', async () => {
  const { prepareResumeGradeEvaluation, prepareResumeJobEvaluation, evaluationExcludedCriterionIds, validateEvaluationCaseInput, scoringSuiteSchema } =
    await loadWorker('../worker/evals/index.ts')
  const data = harness(), sink = emptySink()
  await executeGradeGeneration(data.job, options(data, fakeAzure(data), sink))
  const { draft } = sink.generated[0].grades[0]
  const text = '# Profile\n\nApplied established analytical methods to bounded program assignments.'
  const input = prepareResumeGradeEvaluation(text, 'family-1', draft.rubric, draft.qualifications)
  assert.equal(input.rubric.kind, 'grade')
  assert.deepEqual(input.requirementEvidence.map(row => row.kind), ['criterion'])
  assert.deepEqual(input.requirementEvidence[0].citations.map(row => row.paragraphId), ['p-role', 'p-gs9'])
  assert.deepEqual(evaluationExcludedCriterionIds(input), [])
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'grade-targets', purpose: 'smoke', sourceVersion: 'fixtures-v1', repetitions: 1,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'score-production-v1' }],
    cases: [{
      id: 'family-1-gs-9', familyId: 'family-1', jobId: 'ladder-test-gs-9', targetKind: 'grade', split: 'development',
      inputSha256: evaluationHash(input), criterionIds: input.rubric.criteria.map(row => row.id),
    }],
  })
  assert.deepEqual(validateEvaluationCaseInput(suite.cases[0], input), input)
  const jobRubric = { ...data.fixture.seed.rubric, kind: 'job' }
  assert.throws(() => prepareResumeGradeEvaluation(text, 'family-1', jobRubric, []), /grade rubric/)
  assert.equal(prepareResumeJobEvaluation(text, 'family-1', jobRubric).rubric.kind, 'job')
})
