import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const exec = promisify(execFile)
const { scoringSuiteSchema, evaluationHash, createEvaluationSettings, prepareResumeJobEvaluation } = await loadWorker('../worker/evals/index.ts')
const cli = new URL('../scripts/scoring-evaluation.mjs', import.meta.url)

function fixture() {
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'smoke', purpose: 'smoke', sourceVersion: 'fixtures-v1', repetitions: 2,
    configurations: [{ id: 'baseline', settingsSha256: 'a'.repeat(64), algorithmVersion: 'fixtures-v1' }],
    cases: [{
      id: 'case-1', familyId: 'family-1', jobId: 'gs-13', split: 'development',
      inputSha256: 'b'.repeat(64), criterionIds: ['criterion-1'],
    }],
  })
  const observations = [0, 1].map((score, index) => ({
    schemaVersion: 1, suiteSha256: evaluationHash(suite), caseId: 'case-1',
    configurationId: 'baseline', repetition: index + 1, durationMilliseconds: 10,
    result: { status: 'complete', overall: score * 20, criteria: [{ criterionId: 'criterion-1', score }] },
  }))
  return { suite, observations }
}

async function run(...args) {
  return exec(process.execPath, [fileURLToPath(cli), ...args])
}

test('layout integrity CLI binds source annotations without overwriting evidence or claiming semantic recall', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-layout-cli-'))
  try {
    const responsePath = join(folder, 'response.json'), factsPath = join(folder, 'facts.json'), outputPath = join(folder, 'report.json')
    const response = {
      status: 'succeeded', analyzeResult: { content: 'Applied :unselected: regression.', stringIndexType: 'utf16CodeUnit',
        pages: [{ pageNumber: 1, selectionMarks: [{ state: 'unselected', span: { offset: 8, length: 12 } }] }] },
    }
    const facts = [{ id: 'fact', text: 'Applied regression.', critical: true }]
    await Promise.all([writeFile(responsePath, JSON.stringify(response)), writeFile(factsPath, JSON.stringify(facts))])
    assert.match((await run('layout-integrity', responsePath, factsPath, outputPath)).stdout, /not semantic recall/)
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.responseSha256, evaluationHash(response))
    assert.equal(report.facts[0].literalPresent, false)
    assert.equal(report.facts[0].wordSequencePresentIgnoringBoundSelectionMarks, true)
    assert.equal(report.eligibleForRelease, false)
    await assert.rejects(run('layout-integrity', responsePath, factsPath, responsePath), /cannot overwrite/)
    assert.deepEqual(JSON.parse(await readFile(responsePath, 'utf8')), response)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('offline CLI validates and atomically writes a real report without inference', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-eval-cli-'))
  try {
    const suitePath = join(folder, 'suite.json'), observationsPath = join(folder, 'observations.json')
    const reportPath = join(folder, 'report.json')
    const fixtureData = fixture()
    await Promise.all([
      writeFile(suitePath, JSON.stringify(fixtureData.suite)),
      writeFile(observationsPath, JSON.stringify(fixtureData.observations)),
    ])
    assert.match((await run('validate', suitePath)).stdout, /validated/)
    assert.match((await run('report', suitePath, observationsPath, reportPath)).stdout, /does not authorize a release/)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.reports[0].pairwiseDisagreement, 1)
    assert.equal(report.eligibleForRelease, false)
    await assert.rejects(run('report', suitePath, observationsPath, suitePath), /must not overwrite/)
    assert.deepEqual(JSON.parse(await readFile(suitePath, 'utf8')), fixtureData.suite)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('cost CLI persists every crossed milestone and does not generate duplicate receipts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-cost-cli-'))
  try {
    const ledger = join(folder, 'ledger.json'), state = join(folder, 'state.json')
    await writeFile(ledger, JSON.stringify([{
      schemaVersion: 1, id: 'call-1', costItemId: 'call-1', suiteId: 'suite-1', category: 'inference',
      mode: 'estimate', amountUsdMicros: 201_000_000, priceVersion: 'test-prices', usage: null,
    }]))
    await writeFile(state, JSON.stringify({
      schemaVersion: 1, programId: 'score-quality', reportedThroughUsdMicros: 0, pending: [],
    }))
    const first = JSON.parse((await run('costs', ledger, state)).stdout)
    const second = JSON.parse((await run('costs', ledger, state)).stdout)
    assert.equal(first.pendingNotifications.length, 2)
    assert.deepEqual(second, first)
    assert.equal(JSON.parse(await readFile(state, 'utf8')).reportedThroughUsdMicros, 200_000_000)
    await writeFile(`${state}.lock`, 'Another evaluator owns this state.')
    await assert.rejects(run('costs', ledger, state), /EEXIST/)
    assert.equal(JSON.parse(await readFile(state, 'utf8')).pending.length, 2)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('cost acknowledgment CLI archives delivery before clearing only selected pending notices and replays safely', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-cost-ack-'))
  try {
    const statePath = join(folder, 'state.json'), receiptPath = join(folder, 'delivered.json')
    const archives = join(folder, 'receipts')
    const state = {
      schemaVersion: 1, programId: 'score-quality', reportedThroughUsdMicros: 200_000_000,
      pending: [100_000_000, 200_000_000].map(thresholdUsdMicros => ({
        id: `score-quality-${thresholdUsdMicros}`, thresholdUsdMicros,
      })),
    }
    const receipt = {
      schemaVersion: 1, programId: 'score-quality', deliveredAt: '2020-01-01T00:00:00Z',
      channel: 'operator', deliveryReference: 'message-1', milestones: [state.pending[0]],
    }
    await writeFile(statePath, JSON.stringify(state))
    await writeFile(receiptPath, JSON.stringify(receipt))
    const first = JSON.parse((await run('costs-ack', statePath, receiptPath, archives)).stdout)
    assert.deepEqual(first.pendingNotifications, [state.pending[1]])
    assert.deepEqual(JSON.parse(await readFile(first.archivedReceipt, 'utf8')), receipt)
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).reportedThroughUsdMicros, 200_000_000)
    assert.equal((await readdir(archives)).length, 1)
    assert.deepEqual(JSON.parse((await run('costs-ack', statePath, receiptPath, archives)).stdout), first)
    // Simulate a crash after the immutable receipt was saved but before the state was replaced.
    await writeFile(statePath, JSON.stringify(state))
    assert.deepEqual(JSON.parse((await run('costs-ack', statePath, receiptPath, archives)).stdout), first)
    const acknowledgedBytes = await readFile(statePath, 'utf8')
    await writeFile(receiptPath, JSON.stringify({ ...receipt, deliveryReference: 'not-the-delivery' }))
    await assert.rejects(run('costs-ack', statePath, receiptPath, archives), /generated pending/)
    assert.equal(await readFile(statePath, 'utf8'), acknowledgedBytes)
    assert.equal((await readdir(archives)).length, 1)
    await writeFile(receiptPath, JSON.stringify(receipt))
    await writeFile(first.archivedReceipt, JSON.stringify({ ...receipt, deliveryReference: 'corrupted-archive' }))
    await assert.rejects(run('costs-ack', statePath, receiptPath, archives), /archived receipt/)
    assert.equal(await readFile(statePath, 'utf8'), acknowledgedBytes)
    await writeFile(receiptPath, JSON.stringify({ ...receipt, deliveredAt: '2999-01-01T00:00:00Z' }))
    await assert.rejects(run('costs-ack', statePath, receiptPath, archives), /recorded delivery time/)
    await assert.rejects(run('costs-ack', statePath, statePath, archives), /separate/)
    await writeFile(`${statePath}.lock`, 'An evaluator owns the shared program lock.')
    await assert.rejects(run('costs-ack', statePath, receiptPath, archives), /EEXIST/)
    assert.equal(await readFile(`${statePath}.lock`, 'utf8'), 'An evaluator owns the shared program lock.')
    assert.equal(await readFile(statePath, 'utf8'), acknowledgedBytes)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('sharding CLI prepares resumable private manifests with one shared cost ledger and merges exact checkpoint prefixes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-shard-cli-'))
  try {
    const { suite } = fixture()
    const rubric = {
      id: 'rubric', groupId: 'rubric', jobId: 'gs-13', kind: 'job', dataKind: 'real',
      name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
      criteria: [{
        id: 'criterion-1', key: 'custom', label: 'Statistics', description: 'Applied statistics.',
        weight: 100, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
        sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1,
          heading: 'Work', quote: 'Applied statistics.' }],
      }],
    }
    const binding = { deploymentName: 'test-mini', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
    const snapshot = createEvaluationSettings({
      revision: 'test-revision', capturedAt: '2026-10-07T00:00:00Z', assessor: binding, reviewer: binding,
    })
    suite.configurations[0] = { id: 'baseline', settingsSha256: evaluationHash(snapshot), algorithmVersion: 'score-production-v1' }
    suite.cases = []
    const inputs = []
    for (let family = 1; family <= 7; family++) for (let job = 1; job <= 4; job++) {
      const id = `family-${family}.job-${job}`, familyId = `family-${family}`
      const input = prepareResumeJobEvaluation('Applied regression to survey data.', familyId, rubric)
      inputs.push({ id, input })
      suite.cases.push({ id, familyId, jobId: `job-${job}`, split: 'development',
        inputSha256: evaluationHash(input), criterionIds: ['criterion-1'] })
    }
    const manifest = {
      suite, inputs, settings: [{ id: 'baseline', snapshot }], concurrency: 1,
      endpoint: 'https://test-account.openai.azure.com/',
      prices: { 'test-mini': { version: 'test-rates', currency: 'USD',
        inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 } },
    }
    const parent = join(folder, 'parent.json'), output = join(folder, 'shards')
    await writeFile(parent, JSON.stringify(manifest))
    const prepared = JSON.parse((await run('prepare-shards', parent, output)).stdout)
    assert.equal(prepared.shards, 2)
    assert.equal(prepared.cases, 28)
    assert.deepEqual(JSON.parse((await run('prepare-shards', parent, output)).stdout), prepared)
    const index = JSON.parse(await readFile(prepared.index, 'utf8'))
    const shardManifests = await Promise.all(index.shards.map(row =>
      readFile(join(output, `${row.id}.manifest.json`), 'utf8').then(JSON.parse)))
    assert.deepEqual(shardManifests.map(row => row.suite.cases.length), [24, 4])
    assert(shardManifests.every(row => row.programId === suite.id && row.costDirectory === join(output, 'costs')))
    const row = shardManifests[0].suite.cases[0]
    const results = [{
      shardId: index.shards[0].id, suiteSha256: index.shards[0].suiteSha256,
      observations: [{
        schemaVersion: 1, suiteSha256: index.shards[0].suiteSha256, caseId: row.id,
        configurationId: 'baseline', repetition: 1, durationMilliseconds: 1,
        result: { status: 'failed', code: 'timeout' },
      }],
    }]
    const resultsPath = join(folder, 'results.json'), reportPath = join(folder, 'merged.json')
    await writeFile(resultsPath, JSON.stringify(results))
    assert.match((await run('merge-shards', prepared.index, resultsPath, reportPath)).stdout, /failed observations/)
    const merged = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(merged.expected, 56)
    assert.equal(merged.observed, 1)
    assert.equal(merged.complete, false)
    assert.equal(merged.observations[0].suiteSha256, evaluationHash(suite))
    assert.equal(merged.coverage[1].missingShard, true)
    await assert.rejects(run('merge-shards', prepared.index, resultsPath, resultsPath), /cannot overwrite/)
    const firstPath = join(output, `${index.shards[0].id}.manifest.json`)
    const first = shardManifests[0]
    first.programId = 'changed-cost-program'
    await writeFile(firstPath, JSON.stringify(first))
    await assert.rejects(run('prepare-shards', parent, output), /immutable partition/)
    assert.equal(JSON.parse(await readFile(firstPath, 'utf8')).programId, 'changed-cost-program')
    await writeFile(parent, JSON.stringify({ ...manifest, kind: 'fixed-judge' }))
    await assert.rejects(run('prepare-shards', parent, output), /fixed-judge/)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('invariance CLI saves perturbation/noise diagnostics and refuses to overwrite pair inputs', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-invariance-cli-'))
  try {
    const { suite, observations } = fixture()
    suite.cases.push({ ...suite.cases[0], id: 'variant', inputSha256: 'c'.repeat(64) })
    const rubric = {
      id: 'rubric-one', groupId: 'rubric-one', jobId: 'job-one', kind: 'job', dataKind: 'real',
      name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
      criteria: [{
        id: 'criterion-1', key: 'custom', label: 'Statistics', description: 'Applied statistics.',
        weight: 100, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
        sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Applied statistics.' }],
      }],
    }
    const inputs = suite.cases.map(row => ({ id: row.id, input: prepareResumeJobEvaluation('Applied regression to survey data.', row.id, rubric) }))
    suite.cases.forEach(row => { row.inputSha256 = evaluationHash(inputs.find(input => input.id === row.id).input) })
    observations.forEach(row => { row.suiteSha256 = evaluationHash(suite) })
    observations.push(...observations.map(row => ({ ...row, caseId: 'variant' })))
    const pairs = [{ id: 'pair', baselineCaseId: 'case-1', variantCaseId: 'variant', kind: 'identity-only' }]
    const paths = ['suite', 'observations', 'pairs', 'inputs', 'report'].map(name => join(folder, `${name}.json`))
    await Promise.all([suite, observations, pairs, inputs].map((value, index) => writeFile(paths[index], JSON.stringify(value))))
    assert.match((await run('invariance', ...paths)).stdout, /unchanged-input noise/)
    const report = JSON.parse(await readFile(paths[4], 'utf8'))
    assert.equal(report.completePanels, 1)
    assert.equal(report.items[0].criteria[0].crossInput.disagreement, 0.5)
    assert.equal(report.items[0].criteria[0].unchangedBaseline.disagreement, 1)
    assert.equal(report.suiteSha256, evaluationHash(suite))
    assert.equal(report.pairsSha256, evaluationHash(pairs))
    assert.equal(report.noiseFloor[0].metrics[0].familyMeanExcess, -0.5)
    assert.equal(report.noiseFloor[0].metrics[0].uncertainty, null)
    assert.equal(report.noiseFloor[0].completeFamilies, 1)
    await assert.rejects(run('invariance', paths[0], paths[1], paths[2], paths[3], paths[2]), /cannot overwrite/)
    assert.deepEqual(JSON.parse(await readFile(paths[2], 'utf8')), pairs)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('monotonicity CLI checks exact inserted facts and retains a fully missing panel without inventing scores', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-monotonicity-cli-'))
  try {
    const { suite } = fixture()
    const rubric = {
      id: 'rubric', groupId: 'rubric', jobId: 'job', kind: 'job', dataKind: 'real',
      name: 'Statistics', description: 'Applied statistics.', version: 1, createdAt: '2026-10-07T00:00:00Z',
      criteria: [{
        id: 'criterion-1', key: 'custom', label: 'Statistics', description: 'Applied statistics.',
        weight: 100, requirementType: 'required', guidance: '0: Not documented. 1: Coursework. 2: Applied work.',
        sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1,
          heading: 'Work', quote: 'Applied statistics.' }],
      }],
    }
    const weaker = prepareResumeJobEvaluation('Organized a community garden.', 'family', rubric)
    const stronger = structuredClone(weaker)
    const fact = 'Applied regression to survey data.'
    stronger.resume.paragraphs.push({ ...weaker.resume.paragraphs[0], id: 'added', text: fact })
    const inputs = [{ id: 'weaker', input: weaker }, { id: 'stronger', input: stronger }]
    suite.cases = inputs.map(row => ({ ...suite.cases[0], id: row.id,
      inputSha256: evaluationHash(row.input) }))
    const pairs = [{
      id: 'inserted', weakerCaseId: 'weaker', strongerCaseId: 'stronger',
      expectedCriterionIds: ['criterion-1'], addedFacts: [{ id: 'fact', paragraphId: 'added', text: fact }],
      origin: 'planted', author: 'fixture', revision: 'v1', independent: true,
      reason: 'One explicitly documented applied statistical method was inserted.',
    }]
    const paths = ['suite', 'observations', 'pairs', 'inputs', 'report'].map(name => join(folder, `${name}.json`))
    await Promise.all([suite, [], pairs, inputs].map((value, index) => writeFile(paths[index], JSON.stringify(value))))
    assert.match((await run('monotonicity', ...paths)).stdout, /not inferred errors/)
    const report = JSON.parse(await readFile(paths[4], 'utf8'))
    assert.equal(report.expectedPanels, 1)
    assert.equal(report.completePanels, 0)
    assert.equal(report.items[0].weakerCoverage.missing, 2)
    assert.equal(report.items[0].criteria[0].decreaseRate, null)
    assert.equal(report.eligibleForRelease, false)
    await assert.rejects(run('monotonicity', ...paths.slice(0, 4), paths[2]), /cannot overwrite/)
    const annotationsPath = join(folder, 'annotations.json'), assessmentsPath = join(folder, 'assessments.json')
    const evidencePath = join(folder, 'evidence-report.json')
    await writeFile(annotationsPath, JSON.stringify([{
      caseId: 'stronger', criterionId: 'criterion-1', inputSha256: suite.cases[1].inputSha256,
      origin: 'planted', author: 'fixture', revision: 'v1', independent: true,
      reason: 'The controlled paragraph names an applied method.',
      facts: [{ id: 'fact', role: 'supporting', alternatives: [{ paragraphId: 'added', text: fact }] }],
    }]))
    await writeFile(assessmentsPath, '[]')
    const evidenceArgs = [paths[0], paths[1], paths[3], annotationsPath, assessmentsPath]
    assert.match((await run('evidence-selection', ...evidenceArgs, evidencePath)).stdout, /literal coverage/)
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    assert.equal(evidence.items.length, 2)
    assert.equal(evidence.items[0].status, 'missing-observation')
    assert.equal(evidence.items[0].statistics, null)
    assert.equal(evidence.eligibleForRelease, false)
    await assert.rejects(run('evidence-selection', ...evidenceArgs, annotationsPath), /cannot overwrite/)
    pairs[0].addedFacts[0].text = 'A different purported claim.'
    await writeFile(paths[2], JSON.stringify(pairs))
    const prior = await readFile(paths[4], 'utf8')
    await assert.rejects(run('monotonicity', ...paths), /complete newly inserted/)
    assert.equal(await readFile(paths[4], 'utf8'), prior)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('silver export is non-independent, requires exact frozen producer settings and cannot overwrite a label revision', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'score-reference-cli-'))
  try {
    const { suite, observations } = fixture()
    const binding = { deploymentName: 'test-mini', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
    const snapshot = createEvaluationSettings({
      revision: 'test-revision', capturedAt: '2026-10-07T00:00:00Z', assessor: binding, reviewer: binding,
    })
    suite.configurations[0].settingsSha256 = evaluationHash(snapshot)
    observations.forEach(row => { row.suiteSha256 = evaluationHash(suite) })
    const manifest = join(folder, 'manifest.json'), targets = join(folder, 'targets.json')
    const source = join(folder, 'observations.json'), output = join(folder, 'silver.json')
    await Promise.all([
      writeFile(manifest, JSON.stringify({ suite, settings: [{ id: 'baseline', snapshot }] })),
      writeFile(targets, JSON.stringify([{
        id: 'target-1', caseId: 'case-1', criterionId: 'criterion-1',
        inputSha256: suite.cases[0].inputSha256, inclusionProbability: 0.5,
      }])),
      writeFile(source, JSON.stringify(observations)),
    ])
    assert.match((await run('silver-references', manifest, targets, source, output, 'baseline', '1')).stdout, /non-independent/)
    const original = await readFile(output, 'utf8')
    const bundle = JSON.parse(original)
    assert.equal(bundle.references[0].score, 0)
    assert.equal(bundle.references[0].independent, false)
    assert.equal(bundle.provenance.configuration.settingsSha256, evaluationHash(snapshot))
    await assert.rejects(run('silver-references', manifest, targets, source, output, 'baseline', '2'), /EEXIST/)
    assert.equal(await readFile(output, 'utf8'), original)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
