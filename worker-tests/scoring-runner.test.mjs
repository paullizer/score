import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { loadWorker } from './shared-model-loader.mjs'
import { fixture as scaleFixture } from './scale-candidate-support.mjs'

const exec = promisify(execFile)
const { prepareResumeJobEvaluation, createEvaluationSettings, evaluationHash, scoringSuiteSchema, FIXED_JUDGE_VERSION } = await loadWorker('../worker/evals/index.ts')
const { validateAnalysisAssessmentInput, validateAnalysisAssessmentSelections, hashAnalysisAssessment } = await loadWorker('../worker/analyses/model.ts')
const { createAnalysisEvidenceCatalog } = await loadWorker('../worker/analyses/evidence-passages.ts')
const runner = fileURLToPath(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url))

test('offline scale runner smoke binds all four candidate selectors without inference and rejects mixed-code resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'score-scale-runner-'))
  try {
    const fingerprint = async url => createHash('sha256').update(await readFile(url)).digest('hex')
    for (const candidate of ['b1', 'b2']) for (const mode of ['assessor', 'reviewer']) {
      const version = `score-scale-${candidate}-${mode}-v1`
      const { input, snapshot, prices, job } = scaleFixture(version)
      const suite = scoringSuiteSchema.parse({
        schemaVersion: 1, id: version, purpose: 'smoke', sourceVersion: 'synthetic-scale-smoke-v1',
        repetitions: 1, cases: [job.case], configurations: [job.configuration],
      })
      const manifest = {
        suite, endpoint: 'https://test-account.openai.azure.com/', concurrency: 1,
        inputs: [{ id: 'case', input }], settings: [{ id: 'candidate', snapshot }],
        prices: mode === 'assessor' ? { assessor: prices.assessor } : prices,
      }
      const output = join(root, version), path = join(root, `${version}.json`)
      await mkdir(output)
      const execution = {
        schemaVersion: 1, status: 'bound',
        runnerSha256: await fingerprint(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url)),
        bundleSha256: await fingerprint(new URL('../dist-worker/scoring-evaluation.mjs', import.meta.url)),
        dependencyLockSha256: await fingerprint(new URL('../package-lock.json', import.meta.url)),
        nodeVersion: process.version, suiteSha256: evaluationHash(suite),
        endpoint: manifest.endpoint, pricesSha256: evaluationHash(manifest.prices),
      }
      await Promise.all([
        writeFile(path, JSON.stringify(manifest)),
        writeFile(join(output, 'execution.json'), JSON.stringify(execution)),
        writeFile(join(output, 'observations.json'), JSON.stringify([{
          schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: 'case', configurationId: 'candidate',
          repetition: 1, durationMilliseconds: 1,
          result: { status: 'complete', overall: 40, criteria: [{ criterionId: 'statistics', score: 2 }] },
        }])),
      ])
      const invoke = () => exec(process.execPath, [runner, path, output, '--confirm-paid-inference'])
      assert.match((await invoke()).stdout, /evaluation-complete/)
      assert.deepEqual(JSON.parse(await readFile(join(output, 'execution.json'), 'utf8')), execution)
      await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), { code: 'ENOENT' })
      await writeFile(join(output, 'execution.json'), JSON.stringify({ ...execution, bundleSha256: 'f'.repeat(64) }))
      await assert.rejects(invoke(), /Execution identity changed/)
      await writeFile(join(output, 'execution.json'), JSON.stringify(execution))
      suite.configurations[0].algorithmVersion = `score-scale-${candidate === 'b1' ? 'b2' : 'b1'}-${mode}-v1`
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(invoke(), /different frozen suite/)
      suite.configurations[0].algorithmVersion = 'score-scale-unknown-v1'
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(invoke(), /impersonate/)
      suite.configurations[0].algorithmVersion = version
      delete input.rubric.scaleVersion
      delete input.rubric.criteria[0].levels
      const legacy = validateAnalysisAssessmentInput(input)
      suite.cases[0].inputSha256 = evaluationHash(legacy)
      await writeFile(path, JSON.stringify(manifest))
      await assert.rejects(invoke(), /legacy unscaled/)
      await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), { code: 'ENOENT' })
      await assert.rejects(readFile(join(output, 'evaluation.lock')), { code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

function fixture(id) {
  const input = prepareResumeJobEvaluation('Applied regression to survey data.', 'test-family', {
    id: 'rubric-1', groupId: 'rubric-1', jobId: 'job-1', kind: 'job', dataKind: 'real',
    name: 'Statistical work', description: 'Documented statistical analysis.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: [{
      id: 'statistics', key: 'custom', label: 'Statistics', description: 'Documented statistical analysis.',
      weight: 100, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
      sourceCitations: [{ documentId: 'job-document', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Documented statistical analysis.' }],
    }],
  })
  const binding = { deploymentName: 'test-mini', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
  const snapshot = createEvaluationSettings({ revision: 'test-revision', capturedAt: '2026-10-07T00:00:00Z', assessor: binding, reviewer: binding })
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id, purpose: 'smoke', sourceVersion: 'fixtures-v1', repetitions: 1,
    configurations: [{ id: 'baseline', settingsSha256: evaluationHash(snapshot), algorithmVersion: 'score-production-v1' }],
    cases: [{ id: 'case-1', familyId: 'test-family', jobId: 'job-1', split: 'development', inputSha256: evaluationHash(input), criterionIds: ['statistics'] }],
  })
  return {
    manifest: {
      suite, endpoint: 'https://test-account.openai.azure.com/', programId: 'test-program', concurrency: 1,
      inputs: [{ id: 'case-1', input }], settings: [{ id: 'baseline', snapshot }],
      prices: { 'test-mini': { version: 'test-rates', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } },
    },
    observations: [{
      schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: 'case-1', configurationId: 'baseline',
      repetition: 1, durationMilliseconds: 10, result: { status: 'complete', overall: 40, criteria: [{ criterionId: 'statistics', score: 2 }] },
    }],
  }
}

test('paid runner resumes without inference and shares program-wide accounting and lock with the cost CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'score-runner-'))
  try {
    const runs = join(root, 'runs'), costs = join(runs, 'costs')
    await mkdir(costs, { recursive: true })
    const key = evaluationHash('test-program'), statePath = join(costs, `${key}.state.json`)
    const ledger = [{
      schemaVersion: 1, id: 'prior-request', costItemId: 'prior-request', suiteId: 'prior-suite',
      category: 'inference', mode: 'estimate', amountUsdMicros: 102_000_000, priceVersion: 'test-rates', usage: null,
    }]
    await writeFile(join(costs, `${key}.ledger.json`), JSON.stringify(ledger))
    for (const id of ['suite-one', 'suite-two']) {
      const { manifest, observations } = fixture(id)
      const output = join(runs, id), manifestPath = join(root, `${id}.json`)
      await mkdir(output)
      await Promise.all([
        writeFile(manifestPath, JSON.stringify(manifest)),
        writeFile(join(output, 'observations.json'), JSON.stringify(observations)),
      ])
      const result = await exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference'])
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
      assert.equal(events.filter(event => event.event === 'cost-milestone-pending').length, 1)
      assert.equal(events.at(-1).event, 'evaluation-complete')
      assert.equal(events.some(event => event.event === 'legacy-execution-unverified'), true)
      assert.equal(JSON.parse(await readFile(join(output, 'execution.json'), 'utf8')).status, 'legacy-unverified')
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).pending.length, 1)
      await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
      await assert.rejects(readFile(join(output, 'evaluation.lock')), error => error.code === 'ENOENT')
    }
    assert.deepEqual(JSON.parse(await readFile(join(costs, `${key}.ledger.json`), 'utf8')), ledger)
    const managed = fixture('suite-two').manifest
    managed.identity = { kind: 'managed-identity', clientId: '00000000-0000-0000-0000-000000000001' }
    const managedPath = join(root, 'managed.json')
    await writeFile(managedPath, JSON.stringify(managed))
    assert.match((await exec(process.execPath, [
      runner, managedPath, join(runs, 'suite-two'), '--confirm-paid-inference',
    ])).stdout, /evaluation-complete/)
    managed.identity.clientId = 'not-an-identity'
    await writeFile(managedPath, JSON.stringify(managed))
    await assert.rejects(exec(process.execPath, [
      runner, managedPath, join(runs, 'suite-two'), '--confirm-paid-inference',
    ]), /explicit client UUID/)
    delete managed.identity
    managed.maxComparisonMilliseconds = -1
    await writeFile(managedPath, JSON.stringify(managed))
    await assert.rejects(exec(process.execPath, [
      runner, managedPath, join(runs, 'suite-two'), '--confirm-paid-inference',
    ]), /deadlines/)
    await writeFile(`${statePath}.lock`, 'Another evaluator owns this program.')
    await assert.rejects(exec(process.execPath, [
      runner, join(root, 'suite-two.json'), join(runs, 'suite-two'), '--confirm-paid-inference',
    ]), /EEXIST/)
    assert.equal(await readFile(`${statePath}.lock`, 'utf8'), 'Another evaluator owns this program.')
    await assert.rejects(readFile(join(runs, 'suite-two', 'evaluation.lock')), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runner refuses missing or changed execution bindings before any paid inference and releases its locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'score-runner-binding-'))
  try {
    const { manifest, observations } = fixture('binding-suite')
    manifest.suite.repetitions = 2
    observations[0].suiteSha256 = evaluationHash(manifest.suite)
    const output = join(root, 'run'), manifestPath = join(root, 'manifest.json')
    await mkdir(output)
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(output, 'observations.json'), JSON.stringify(observations))
    const invoke = () => exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference'])
    await assert.rejects(invoke(), /Legacy partial runs/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    await assert.rejects(readFile(join(output, 'evaluation.lock')), error => error.code === 'ENOENT')
    const fingerprint = async url => createHash('sha256').update(await readFile(url)).digest('hex')
    const binding = {
      schemaVersion: 1, status: 'bound',
      runnerSha256: await fingerprint(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url)),
      bundleSha256: await fingerprint(new URL('../dist-worker/scoring-evaluation.mjs', import.meta.url)),
      dependencyLockSha256: await fingerprint(new URL('../package-lock.json', import.meta.url)),
      nodeVersion: process.version, suiteSha256: evaluationHash(manifest.suite),
      endpoint: manifest.endpoint, pricesSha256: evaluationHash(manifest.prices),
    }
    await writeFile(join(output, 'execution.json'), JSON.stringify(binding))
    await writeFile(join(output, 'observations.json'), JSON.stringify([
      observations[0], { ...observations[0], repetition: 2 },
    ]))
    assert.match((await invoke()).stdout, /evaluation-complete/)
    assert.deepEqual(JSON.parse(await readFile(join(output, 'execution.json'), 'utf8')), binding)
    assert.equal(createHash('sha256').update(await readFile(join(output, 'execution-files', 'bundle.mjs'))).digest('hex'), binding.bundleSha256)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    await writeFile(join(output, 'execution-files', 'bundle.mjs'), 'corrupted-archive')
    await assert.rejects(invoke(), /Archived execution files differ/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    await writeFile(join(output, 'execution.json'), JSON.stringify({
      schemaVersion: 1, status: 'bound', runnerSha256: 'wrong-version',
    }))
    await assert.rejects(invoke(), /Execution identity changed/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    await assert.rejects(readFile(join(output, 'evaluation.lock')), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('paid runner reads completed fixed-proposal verdicts without inference and refuses changed proposals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'score-judge-runner-'))
  try {
    const { manifest } = fixture('judge-suite')
    manifest.kind = 'fixed-judge'
    manifest.suite.configurations[0].algorithmVersion = FIXED_JUDGE_VERSION
    const input = manifest.inputs[0].input
    const assessment = validateAnalysisAssessmentSelections({
      criteria: [{
        criterionId: 'statistics', evidenceStatus: 'supported', score: 2, limitation: null,
        rationale: 'The source describes one applied regression example.', citations: [{ passageId: 1 }],
      }], qualifications: [],
    }, input, createAnalysisEvidenceCatalog(input.resume))
    const assessmentSha256 = hashAnalysisAssessment(assessment)
    manifest.proposals = [{ id: 'case-1', assessmentSha256, assessment }]
    const output = join(root, 'run'), manifestPath = join(root, 'manifest.json')
    await mkdir(output)
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(manifest)),
      writeFile(join(output, 'observations.json'), JSON.stringify([{
        schemaVersion: 1, suiteSha256: evaluationHash(manifest.suite), caseId: 'case-1', configurationId: 'baseline',
        repetition: 1, durationMilliseconds: 1, assessmentSha256,
        result: { status: 'complete', issueFound: false, outcome: 'supported', assessmentSha256 },
      }])),
    ])
    const invoke = () => exec(process.execPath, [runner, manifestPath, output, '--confirm-paid-inference'])
    assert.match((await invoke()).stdout, /evaluation-complete/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
    manifest.proposals[0].assessment.criteria[0].score = 5
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(invoke(), /frozen assessment proposal hash/)
    await assert.rejects(readFile(join(output, 'evaluation.lock')), error => error.code === 'ENOENT')
    manifest.proposals[0].assessmentSha256 = hashAnalysisAssessment(manifest.proposals[0].assessment)
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(invoke(), /frozen suite\/proposal/)
    await assert.rejects(readFile(join(output, 'model-attempts.jsonl')), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
