import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'

const {
  evaluationHash, executeRubricGeneration, executeRubricRepeatabilitySuite, summarizeRubricRepeatability,
  compareGeneratedRubrics, validateRubricGeneration, RUBRIC_GENERATION_VERSION,
} = await loadWorker('../worker/evals/index.ts')
const { createCompiledPromptBaseline } = await loadWorker('../server/settings/prompts.ts')
const { captureProcessingSettings } = await loadWorker('../src/domain/admin-settings.ts')

const jobId = 'job-0b6f3f1e-7a2c-4d5e-9f10-1a2b3c4d5e6f'
const document = {
  id: 'document-0b6f3f1e-7a2c-4d5e-9f10-1a2b3c4d5e70', title: 'Survey Statistician', kind: 'job', version: 1, sample: false,
  paragraphs: [
    { id: 'p-0001', page: 1, heading: 'Duties', text: 'Designs sample surveys and selects statistical methods for data collection programs.' },
    { id: 'p-0002', page: 1, heading: 'Duties', text: 'Prepares technical reports of findings and methods for program managers.' },
  ],
}
const guidance = 'Score 0: The resume does not document this work. Score 1: Coursework. Score 2: One documented task. Score 3: Documented recurring work. Score 4: Documented complex work. Score 5: Documented leadership of the work.'
const qualifier = 'Score 0: Not documented. Score 1: Needs close supervision. Score 2: Frequent errors. Score 3: Routine work of acceptable quality. Score 4: Independently. Score 5: Expert.'
function modelRubric(criteria) {
  return {
    isJobPosting: true, rejectionReason: null, title: 'Survey Statistician', organization: null, location: null,
    arrangement: null, employmentType: null, grade: null, series: null,
    description: 'Survey statistics duties.', warnings: [], criteria,
  }
}
const designs = { label: 'Survey design', description: 'Designs sample surveys.', guidance, requirementType: 'required', sourceParagraphId: 'p-0001', quote: 'Designs sample surveys' }
const reports = { label: 'Technical reporting', description: 'Prepares technical reports.', guidance: qualifier, requirementType: 'required', sourceParagraphId: 'p-0002', quote: 'Prepares technical reports of findings' }
function fixture() {
  const base = settingsSnapshot(settings => {
    for (const deployment of settings.ai.deployments) deployment.modelVersion = '2025-08-07'
  })
  const snapshot = captureProcessingSettings(base.settings, base.revision, base.capturedAt, createCompiledPromptBaseline())
  const suite = {
    schemaVersion: 1, id: 'rubric-repeat', purpose: 'screening', repetitions: 2,
    configurations: [{ id: 'mini', settingsSha256: evaluationHash(snapshot), algorithmVersion: RUBRIC_GENERATION_VERSION }],
    sources: [{ id: 'gs-13', jobId, sourceDocumentSha256: evaluationHash(document), contentType: 'application/pdf' }],
  }
  const price = { version: 'test-rates', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 }
  return { snapshot, suite, prices: { [snapshot.tasks.jobRubric.deploymentName]: price } }
}
const usage = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 10 } }
const reply = (content, model = 'gpt-5-mini-2025-08-07') => Response.json({
  model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage,
})
function job(data, repetition = 1) {
  return { suiteSha256: evaluationHash(data.suite), source: data.suite.sources[0], configuration: data.suite.configurations[0], repetition }
}
function options(data, responses, overrides = {}) {
  const attempts = [], rubrics = [], failures = []
  let calls = 0
  return {
    attempts, rubrics, failures, calls: () => calls,
    value: {
      document, processingSettings: data.snapshot, prices: data.prices, createdAt: '2026-10-08T00:00:00.000Z',
      model: {
        endpoint: 'https://model.example/', deployment: 'captured-task-only', modelName: 'captured-task-only',
        getToken: async () => 'test-token', fetch: async () => responses[Math.min(calls++, responses.length - 1)](),
      },
      admitPaidWork: async () => {},
      recordAttempt: async (attempt, amount) => { attempts.push({ attempt, amount }) },
      recordPrivateRubric: async generated => { rubrics.push(structuredClone(generated)); generated.rubric.criteria[0].weight = 99 },
      recordPrivateFailure: async failure => { failures.push(failure) },
      ...overrides,
    },
  }
}

test('rubric adapter uses the production generator, validator, captured settings and exact citations', async () => {
  const data = fixture()
  const run = options(data, [() => reply(modelRubric([{ ...designs, weight: 60 }, { ...reports, weight: 40 }]))])
  const result = await executeRubricGeneration(job(data), run.value)
  assert.equal(result.status, 'complete')
  assert.equal(result.criteria, 2)
  assert.equal(run.attempts.length, 1)
  assert.equal(run.attempts[0].amount, 200)
  assert.equal(result.rubricSha256, evaluationHash(run.rubrics[0].rubric))
  assert.equal(run.rubrics[0].rubric.jobId, jobId)
  assert.equal(run.rubrics[0].rubric.criteria[0].weight, 60)
  assert.equal(run.rubrics[0].rubric.criteria[0].sourceCitations[0].quote, 'Designs sample surveys')
  assert.equal(run.rubrics[0].rubric.createdAt, '2026-10-08T00:00:00.000Z')
})

test('invalid model rubrics fail explicitly after captured corrections without creating a rubric', async () => {
  const data = fixture()
  const run = options(data, [() => reply(modelRubric([{ ...designs, weight: 50 }]))])
  const result = await executeRubricGeneration(job(data), run.value)
  assert.deepEqual(result, { status: 'failed', code: 'invalid-rubric' })
  assert.equal(run.calls(), 2)
  assert.equal(run.attempts.length, 2)
  assert.equal(run.rubrics.length, 0)
  assert.equal(run.failures[0].stage, 'rubric')
  assert.match(run.failures[0].reason, /weights total 50, not 100/)
})

test('a different responding model stops the run and keeps its cost unknown', async () => {
  const data = fixture()
  const run = options(data, [() => reply(modelRubric([{ ...designs, weight: 100 }]), 'gpt-6-luna-2026-09-22')])
  await assert.rejects(executeRubricGeneration(job(data), run.value), /responding model differs/)
  assert.equal(run.attempts[0].amount, null)
  assert.equal(run.rubrics.length, 0)
})

test('preflight rejects stale documents, settings, prices, algorithms and timestamps before paid admission', async () => {
  const data = fixture()
  const base = { document, processingSettings: data.snapshot, prices: data.prices }
  assert.throws(() => validateRubricGeneration(job(data), { ...base, document: { ...document, title: 'Changed' } }), /exact frozen job document/)
  assert.throws(() => validateRubricGeneration(job(data), { ...base, prices: {} }), /prices/)
  assert.throws(() => validateRubricGeneration({ ...job(data), configuration: { ...job(data).configuration, settingsSha256: 'a'.repeat(64) } }, base), /frozen configuration/)
  assert.throws(() => validateRubricGeneration({ ...job(data), configuration: { ...job(data).configuration, algorithmVersion: 'other' } }, base), /impersonate/)
  let admitted = 0
  const run = options(data, [() => reply(modelRubric([{ ...designs, weight: 100 }]))], { createdAt: 'not-a-time', admitPaidWork: async () => { admitted++ } })
  await assert.rejects(executeRubricGeneration(job(data), run.value), /timestamp/)
  assert.equal(admitted, 0)
})

test('suite execution checkpoints each repetition and resumes only missing generations', async () => {
  const data = fixture()
  const observations = [], executed = []
  const execute = async item => {
    executed.push(item.repetition)
    return item.repetition === 1 ? { status: 'complete', rubricSha256: 'b'.repeat(64), criteria: 2 } : { status: 'failed', code: 'invalid-rubric' }
  }
  await executeRubricRepeatabilitySuite(data.suite, { concurrency: 1, execute, checkpoint: async row => { observations.push(row) } })
  assert.deepEqual(executed, [1, 2])
  executed.length = 0
  await executeRubricRepeatabilitySuite(data.suite, { concurrency: 1, priorObservations: observations.slice(0, 1), execute, checkpoint: async () => {} })
  assert.deepEqual(executed, [2])
  await assert.rejects(executeRubricRepeatabilitySuite(data.suite, {
    concurrency: 1, priorObservations: [observations[0], observations[0]], execute, checkpoint: async () => {},
  }), /unique frozen source/)
})

test('repeatability summary binds rubric artifacts, aligns cited requirements and keeps failures and lexical markers separate', async () => {
  const data = fixture()
  const generated = []
  for (const criteria of [[{ ...designs, weight: 60 }, { ...reports, weight: 40 }], [{ ...designs, weight: 100 }]]) {
    const run = options(data, [() => reply(modelRubric(criteria))])
    await executeRubricGeneration(job(data), run.value)
    generated.push(run.rubrics[0].rubric)
  }
  const observations = [1, 2].map(repetition => ({
    schemaVersion: 1, suiteSha256: evaluationHash(data.suite), sourceId: 'gs-13', configurationId: 'mini', repetition,
    durationMilliseconds: 1, result: { status: 'complete', rubricSha256: evaluationHash(generated[repetition - 1]), criteria: generated[repetition - 1].criteria.length },
  }))
  const rubrics = generated.map((rubric, index) => ({ sourceId: 'gs-13', configurationId: 'mini', repetition: index + 1, rubric }))
  const report = summarizeRubricRepeatability(data.suite, [{ sourceId: 'gs-13', document }], observations, rubrics,
    [{ sourceId: 'gs-13', rubric: generated[0] }])
  const cell = report.cells[0]
  assert.equal(cell.completed, 2)
  assert.deepEqual(cell.criteriaCounts, [2, 1])
  assert.equal(cell.repeats.pairs, 1)
  assert.equal(cell.repeats.meanAlignmentRate, 0.5)
  assert.equal(cell.repeats.meanCitedParagraphJaccard, 0.5)
  assert.equal(cell.repeats.meanAbsoluteAlignedWeightDifference, 40)
  assert.equal(cell.referenceAgreement.pairs, 2)
  assert.deepEqual(cell.markers.map(row => row.performanceQualifierCriteria), [1, 0])
  assert.deepEqual(cell.markers.map(row => row.documentaryEvidenceCriteria), [2, 1])
  assert.equal(report.eligibleForRelease, false)
  assert.equal(compareGeneratedRubrics(generated[0], generated[0]).alignmentRate, 1)

  const failed = [observations[0], { ...observations[1], result: { status: 'failed', code: 'invalid-rubric' } }]
  const partial = summarizeRubricRepeatability(data.suite, [{ sourceId: 'gs-13', document }], failed, rubrics.slice(0, 1))
  assert.equal(partial.cells[0].failed, 1)
  assert.deepEqual(partial.cells[0].failureCodes, ['invalid-rubric'])
  assert.equal(partial.cells[0].repeats.pairs, 0)
  assert.equal(partial.cells[0].repeats.meanAlignmentRate, null)
  assert.throws(() => summarizeRubricRepeatability(data.suite, [{ sourceId: 'gs-13', document }], observations, rubrics.slice(0, 1)), /requires its private rubric artifact/)
  const tampered = structuredClone(rubrics)
  tampered[1].rubric.criteria[0].weight = 99
  assert.throws(() => summarizeRubricRepeatability(data.suite, [{ sourceId: 'gs-13', document }], observations, tampered), /exactly match/)
})

test('the paid runner resumes rubric-generation manifests without inference, the report binds artifacts, and stale documents are refused', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const exec = promisify(execFile)
  const runner = fileURLToPath(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url))
  const cli = fileURLToPath(new URL('../scripts/scoring-evaluation.mjs', import.meta.url))
  const data = fixture()
  const root = await mkdtemp(join(tmpdir(), 'score-rubric-runner-'))
  try {
    const generated = []
    for (const repetition of [1, 2]) {
      const run = options(data, [() => reply(modelRubric([{ ...designs, weight: 60 }, { ...reports, weight: 40 }]))])
      generated.push({ repetition, result: await executeRubricGeneration(job(data, repetition), run.value), artifact: run.rubrics[0] })
    }
    const manifest = {
      kind: 'rubric-generation', suite: data.suite, endpoint: 'https://test-account.openai.azure.com/', programId: 'rubric-program',
      concurrency: 1, createdAt: '2026-10-08T00:00:00.000Z', documents: [{ sourceId: 'gs-13', document }],
      settings: [{ id: 'mini', snapshot: data.snapshot }], prices: data.prices,
    }
    const output = join(root, 'run'), manifestPath = join(root, 'manifest.json')
    await mkdir(output)
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(manifest)),
      writeFile(join(output, 'observations.json'), JSON.stringify(generated.map(({ repetition, result }) => ({
        schemaVersion: 1, suiteSha256: evaluationHash(data.suite), sourceId: 'gs-13', configurationId: 'mini',
        repetition, durationMilliseconds: 1, result,
      })))),
      ...generated.map(({ repetition, artifact }) => writeFile(join(output, `${evaluationHash(['gs-13', 'mini', repetition])}.rubric.json`),
        JSON.stringify({ sourceId: 'gs-13', configurationId: 'mini', repetition, ...artifact }))),
    ])
    const run = await exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference'])
    assert.match(run.stdout, /legacy-execution-unverified/)
    assert.match(run.stdout, /evaluation-complete/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    const reportPath = join(root, 'rubric-report.json')
    assert.match((await exec(process.execPath, [cli, 'rubric-report', manifestPath, output, reportPath])).stdout, /not semantic equivalence/)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.completed, 2)
    assert.equal(report.cells[0].repeats.meanAlignmentRate, 1)
    await assert.rejects(exec(process.execPath, [cli, 'rubric-report', manifestPath, output, join(output, 'report.json')]), /outside the private run directory/)
    manifest.documents[0].document = { ...document, title: 'Changed after freezing' }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference']), /exact frozen job document/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
