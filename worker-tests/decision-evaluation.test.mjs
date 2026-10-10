import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorker } from './shared-model-loader.mjs'
import { syntheticDecisionManifest } from '../scripts/decision-evaluation-prepare.mjs'
import { runDecisionEvaluation } from '../scripts/decision-evaluation-run.mjs'
import { AzureCliCredential } from '@azure/identity'

const {
  DECISION_LABELS, DECISION_OPTIONS, DECISION_CONTRACT, validateDecisionResponse,
  invokeDecisionChoice, evaluationHash, validateDecisionManifest, decisionRequest,
  decisionDisposition, summarizeDecisionPanel,
  verifyDecisionDeployment,
} = await loadWorker('../worker/evals/index.ts')

function response() {
  return {
    model: 'microsoft-decision-1',
    answers: { evidence: {
      type: 'choice', choice: 'substantive-support', confidence: 0.99,
      probabilities: Object.fromEntries(DECISION_LABELS.map(label => [label, label === 'substantive-support' ? 0.96 : 0.01])),
    } },
    usage: { input_tokens: 66, output_tokens: 1 },
  }
}

function options(overrides = {}) {
  const started = [], finished = []
  return {
    getToken: async scope => { assert.equal(scope, DECISION_CONTRACT.scope); return 'test-token' },
    fetch: async (url, init) => {
      assert.equal(url, `${DECISION_CONTRACT.endpoint}${DECISION_CONTRACT.path}`)
      assert.equal(init.redirect, 'error')
      assert.equal(JSON.parse(init.body).model, 'Decision-1')
      return Response.json(response())
    },
    timeoutMilliseconds: 100, maxAttempts: 1, maxRequestBytes: 16_000, maxInputTokensPerAttempt: 24_000,
    onStart: async event => { started.push(event) },
    onFinish: async event => { finished.push(event) },
    started, finished, ...overrides,
  }
}

test('verified choice response accepts free-output usage and distinct confidence without renormalization', () => {
  const value = response()
  assert.deepEqual(validateDecisionResponse(value, DECISION_LABELS), value)
  assert.equal(value.answers.evidence.confidence, 0.99)
  assert.equal(value.answers.evidence.probabilities['substantive-support'], 0.96)
})

test('malformed, nonfinite, wrong-option, incomplete, inconsistent and unknown-model responses fail closed', () => {
  for (const value of [NaN, Infinity, -1, 1.1, '0.9', null]) {
    const raw = response()
    raw.answers.evidence.probabilities['substantive-support'] = value
    assert.throws(() => validateDecisionResponse(raw, DECISION_LABELS))
  }
  for (const mutate of [
    raw => { delete raw.answers.evidence.probabilities['mention-only'] },
    raw => { raw.answers.evidence.probabilities.unknown = 0 },
    raw => { raw.answers.evidence.choice = 'unknown' },
    raw => { raw.answers.evidence.choice = 'mention-only' },
    raw => { raw.answers.evidence.probabilities['substantive-support'] = 0.5 },
    raw => { raw.answers.other = raw.answers.evidence },
    raw => { raw.model = 'other-model' },
    raw => { delete raw.usage },
    raw => { raw.usage.input_tokens = -1 },
    raw => { raw.answers.evidence.confidence = Infinity },
  ]) {
    const raw = response(); mutate(raw)
    assert.throws(() => validateDecisionResponse(raw, DECISION_LABELS))
  }
})

test('transport meters attempts, binds request hash and never logs source or credentials', async () => {
  const opts = options()
  const value = await invokeDecisionChoice('synthetic text', 'classify evidence', DECISION_OPTIONS, opts)
  assert.equal(value.usage.input_tokens, 66)
  assert.equal(opts.started.length, 1)
  assert.equal(opts.finished.length, 1)
  assert.equal(opts.finished[0].amountUsdMicros, 3)
  assert.equal(opts.finished[0].requestSha256, opts.started[0].requestSha256)
  assert.doesNotMatch(JSON.stringify(opts.finished), /test-token|synthetic text/)
})

test('read-only deployment discovery requires the exact account, version, SKU and decision capabilities', async () => {
  const configuration = {
    name: 'Decision-1', sku: { name: 'GlobalStandard' },
    properties: {
      provisioningState: 'Succeeded',
      model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' },
      capabilities: { decision: 'true', chatCompletion: 'false' },
    },
  }
  const getToken = async scope => { assert.equal(scope, 'https://management.azure.com/.default'); return 'test-token' }
  const fetch = async (url, init) => {
    assert.match(url, /^https:\/\/management\.azure\.com\/subscriptions\/9698dd71-9367-49c2-bede-fd0deecfad62\//)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    return Response.json(configuration)
  }
  assert.deepEqual((await verifyDecisionDeployment(getToken, fetch)).configuration, configuration)
  const wrong = structuredClone(configuration); wrong.properties.model.version = '2'
  await assert.rejects(verifyDecisionDeployment(getToken, async () => Response.json(wrong)), /contract-mismatch/)
  await assert.rejects(verifyDecisionDeployment(getToken, async () => new Response('', { status: 403 })), /discovery/)
})

test('auth, context, throttling, unavailable and invalid JSON remain failures with unknown cost', async () => {
  for (const status of [401, 403, 400, 413, 422, 429, 503]) {
    const opts = options({ fetch: async () => new Response('private upstream error', { status }) })
    await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts), error =>
      error.httpStatus === status && !error.message.includes('private'))
    assert.equal(opts.finished[0].amountUsdMicros, null)
    assert.equal(opts.finished[0].usage, null)
  }
  const opts = options({ fetch: async () => new Response('not json') })
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts), /invalid-json/)
  assert.equal(opts.finished[0].amountUsdMicros, null)
})

test('429 cooldown beyond retry window stops, while a bounded retry reserves every attempt', async () => {
  let calls = 0
  const opts = options({
    maxAttempts: 2,
    fetch: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : Response.json(response()),
  })
  await invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts)
  assert.equal(calls, 2)
  assert.equal(opts.started.length, 2)
  assert.equal(opts.finished.length, 2)
  assert.equal(opts.finished[0].amountUsdMicros, null)
  const cooldown = options({
    maxAttempts: 2, fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
  })
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, cooldown), /rate-limit/)
  assert.equal(cooldown.started.length, 1)
})

test('deadline covers stalled token, fetch and body operations even when injected implementation ignores abort', async () => {
  for (const override of [
    { getToken: () => new Promise(() => {}) },
    { fetch: () => new Promise(() => {}) },
    { fetch: async () => new Response(new ReadableStream({ start() {} })) },
  ]) {
    const opts = options({ ...override, timeoutMilliseconds: 10 })
    await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts), /timeout/)
    assert.equal(opts.finished[0].code, 'timeout')
    assert.equal(opts.finished[0].amountUsdMicros, null)
  }
})

test('paid metering survives invalid probabilities and a token-bound breach is an explicit failure', async () => {
  const bad = response(); bad.answers.evidence.probabilities['substantive-support'] = 0.5
  const opts = options({ fetch: async () => Response.json(bad) })
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts), /invalid-option/)
  assert.equal(opts.finished[0].amountUsdMicros, 3)
  const huge = response(); huge.usage.input_tokens = 25_000
  const exceeded = options({ fetch: async () => Response.json(huge) })
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, exceeded), /metering-bound/)
  assert.equal(exceeded.finished[0].amountUsdMicros, 1050)
  huge.answers.evidence.probabilities['substantive-support'] = 0.5
  const malformedExceeded = options({ fetch: async () => Response.json(huge) })
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, malformedExceeded), /metering-bound/)
  assert.equal(malformedExceeded.finished[0].amountUsdMicros, 1050)
})

test('cancellation, reservation failure and local size rejection never admit inference', async () => {
  let calls = 0
  const opts = options({ fetch: async () => { calls++; return Response.json(response()) } })
  const controller = new AbortController(); controller.abort(new Error('cancelled by test'))
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, opts, controller.signal), /cancelled/)
  assert.equal(opts.started.length, 0)
  await assert.rejects(invokeDecisionChoice('x'.repeat(16_000), 'instructions', DECISION_OPTIONS, opts), /local-context/)
  await assert.rejects(invokeDecisionChoice('state', 'instructions', DECISION_OPTIONS, {
    ...opts, onStart: async () => { throw new Error('journal unavailable') },
  }), /journal unavailable/)
  assert.equal(calls, 0)
  assert.equal(opts.finished.length, 0)
})

test('captured option set and retry limits cannot be changed by asynchronous observers', async () => {
  let calls = 0
  const criteria = { ...DECISION_OPTIONS }
  const opts = options({
    fetch: async () => { calls++; return Response.json(response()) },
    onStart: async () => { delete criteria['mention-only']; opts.maxAttempts = 999 },
  })
  assert.equal((await invokeDecisionChoice('state', 'instructions', criteria, opts)).answers.evidence.choice, 'substantive-support')
  assert.equal(calls, 1)
})

test('source tampering, forged passage IDs, duplicate context and heldout data fail before inference', () => {
  const manifest = syntheticDecisionManifest()
  assert.equal(validateDecisionManifest(manifest).requests, 50)
  for (const mutate of [
    raw => { raw.cases[0].input.resume.paragraphs[0].text += ' altered' },
    raw => { raw.cases[0].passageIds = [9999] },
    raw => { raw.cases[0].contextPassageIds = [1] },
    raw => { raw.cases[0].split = 'holdout' },
    raw => { raw.cases[0].expected.origin = 'model-assisted' },
    raw => { raw.endpoint = 'https://attacker.example' },
    raw => { raw.variants.push('baseline') },
    raw => { raw.cases.push(raw.cases[0]) },
  ]) {
    const raw = structuredClone(manifest); mutate(raw)
    assert.throws(() => validateDecisionManifest(raw))
  }
})

test('reorder/paraphrase/format perturbations preserve source and citation identities; repeat is exact', () => {
  const item = syntheticDecisionManifest().cases[0]
  const base = decisionRequest(item, 'baseline')
  const repeat = decisionRequest(item, 'repeat')
  assert.equal(base.state, repeat.state)
  assert.deepEqual(base.criteria, repeat.criteria)
  const reverse = decisionRequest(item, 'reverse-options')
  assert.deepEqual(Object.keys(reverse.criteria), [...DECISION_LABELS].reverse())
  for (const variant of ['reverse-options', 'paraphrase-options', 'formatting']) {
    const other = decisionRequest(item, variant)
    assert.equal(base.provenance.sourceSha256, other.provenance.sourceSha256)
    assert.equal(base.provenance.citationsSha256, other.provenance.citationsSha256)
    assert.deepEqual(JSON.parse(base.state), JSON.parse(other.state))
  }
  assert.notEqual(base.provenance.optionsSha256, decisionRequest(item, 'paraphrase-options').provenance.optionsSha256)
})

test('deferral respects insufficient-context, low probability, small margin and ties', () => {
  const p = response().answers.evidence.probabilities
  assert.equal(decisionDisposition(p, 'substantive-support', 0.9, 0.2).deferred, false)
  assert.equal(decisionDisposition(p, 'insufficient-context', 0, 0).deferred, true)
  assert.equal(decisionDisposition(p, 'substantive-support', 0.99, 0.2).deferred, true)
  assert.equal(decisionDisposition({ a: 0.5, b: 0.5 }, 'a', 0, 0).deferred, true)
})

test('versioned separated prompt keeps requirement citations out of evidence while binding the exact saved criterion', () => {
  const manifest = syntheticDecisionManifest(), item = manifest.cases[0]
  const original = decisionRequest(item, 'baseline')
  const separated = decisionRequest(item, 'baseline', 'score-decision-evidence-v2')
  assert.match(separated.state, /CRITERION \(requirement only, not evidence\)/)
  assert.doesNotMatch(separated.state, /sourceCitations|guidance|synthetic-requirement/)
  assert.match(separated.state, /I repaired the pump/)
  assert.equal(separated.provenance.criterionSha256, original.provenance.criterionSha256)
  assert.equal(separated.provenance.citationsSha256, original.provenance.citationsSha256)
  assert.notEqual(separated.provenance.promptSha256, original.provenance.promptSha256)
  assert.equal(separated.provenance.promptVersion, 'score-decision-evidence-v2')
  const reverse = decisionRequest(item, 'reverse-options', 'score-decision-evidence-v2')
  assert.notEqual(separated.provenance.optionsSha256, reverse.provenance.optionsSha256)
  const plan = { ...manifest, promptVersion: 'score-decision-evidence-v2', variants: ['baseline', 'repeat', 'reverse-options', 'formatting'], maxAttempts: 1 }
  assert.equal(validateDecisionManifest(plan).requests, 40)
  assert.throws(() => decisionRequest(item, 'baseline', 'unknown'))
})

test('reports bind raw response and provenance; failures/missing are separate from zero support', () => {
  const manifest = syntheticDecisionManifest(), manifestSha256 = evaluationHash(manifest)
  const base = manifest.cases[0]
  const complete = {
    manifestSha256, caseId: base.id, variant: 'baseline', provenance: decisionRequest(base, 'baseline').provenance,
    durationMilliseconds: 1, result: { status: 'complete', response: response(), responseSha256: evaluationHash(response()) },
  }
  const failed = {
    ...complete, variant: 'repeat', provenance: decisionRequest(base, 'repeat').provenance,
    result: { status: 'failed', code: 'timeout', httpStatus: null },
  }
  const report = summarizeDecisionPanel(manifest, [complete, failed])
  assert.equal(report.complete, 1)
  assert.equal(report.failed, 1)
  assert.equal(report.missing, 48)
  assert.equal(report.referenceReports.find(row => row.origin === 'planted' && !row.independent).available, 1)
  assert.equal(report.perturbations[0].availablePairs, 0)
  assert.equal(report.perturbations[0].flipRate, null)
  assert.throws(() => summarizeDecisionPanel(manifest, [complete, complete]), /unique/)
  assert.throws(() => summarizeDecisionPanel(manifest, [{ ...complete, provenance: {} }]), /provenance/)
  assert.throws(() => summarizeDecisionPanel(manifest, [{
    ...complete, result: { ...complete.result, responseSha256: '0'.repeat(64) },
  }]), /integrity/)
})

test('dry-run archives immutable executable and manifests without credential acquisition or inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'score-decision-test-'))
  try {
    const manifestPath = join(directory, 'manifest.json'), output = join(directory, 'dry-run')
    await writeFile(manifestPath, JSON.stringify(syntheticDecisionManifest()))
    assert.deepEqual(await runDecisionEvaluation(manifestPath, output, '--dry-run'), {
      mode: 'dry-run', requests: 50, inferenceRequests: 0,
    })

    const execution = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'))
    assert.equal(execution.contract.path, '/providers/microsoft/v1/systemone')
    assert.equal(execution.manifestSha256, evaluationHash(syntheticDecisionManifest()))
    await assert.rejects(runDecisionEvaluation(manifestPath, output, '--dry-run'), /EEXIST/)
    const raw = syntheticDecisionManifest(); raw.maxSpendUsdMicros = 1
    await writeFile(manifestPath, JSON.stringify(raw))
    await assert.rejects(runDecisionEvaluation(manifestPath, join(directory, 'over-budget'), '--dry-run'), /spend limit/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('paid runner retains fatal auth and model failures, unknown costs, and missing work without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'score-decision-failure-test-'))
  const originalToken = AzureCliCredential.prototype.getToken, originalFetch = globalThis.fetch
  const deployment = {
    name: 'Decision-1', sku: { name: 'GlobalStandard' },
    properties: {
      provisioningState: 'Succeeded', model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' },
      capabilities: { decision: 'true', chatCompletion: 'false' },
    },
  }
  try {
    AzureCliCredential.prototype.getToken = async () => ({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 })
    const manifest = syntheticDecisionManifest()
    manifest.cases = [manifest.cases[0]]
    manifest.variants = ['baseline', 'repeat']
    manifest.maxAttempts = 1
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest))
    for (const kind of ['authentication', 'unexpected-model', 'metering-bound', 'malformed-metering-bound']) {
      let inferenceCalls = 0
      globalThis.fetch = async url => {
        if (url.startsWith('https://management.azure.com/')) return Response.json(deployment)
        assert.equal(url, `${DECISION_CONTRACT.endpoint}${DECISION_CONTRACT.path}`)
        inferenceCalls++
        if (kind === 'authentication') return new Response('', { status: 403 })
        const value = response()
        if (kind === 'unexpected-model') value.model = 'another-model'
        else value.usage.input_tokens = 25_000
        if (kind === 'malformed-metering-bound') value.answers.evidence.probabilities['substantive-support'] = 0.5
        return Response.json(value)
      }
      const output = join(directory, kind)
      await assert.rejects(runDecisionEvaluation(manifestPath, output, '--confirm-paid-inference'))
      assert.equal(inferenceCalls, 1)
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
      const costs = JSON.parse(await readFile(join(output, 'cost-summary.json'), 'utf8'))
      const ledger = (await readFile(join(output, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(report.complete, 0)
      assert.equal(report.failed, 1)
      assert.equal(report.missing, 1)
      assert.equal(costs.attempts, 1)
      assert.equal(ledger[0].event, 'reserved')
      assert.equal(ledger[1].event, 'finished')
      if (kind === 'authentication') {
        assert.equal(costs.unknownAttempts, 1)
        assert.equal(ledger[1].amountUsdMicros, null)
      }
      if (kind === 'unexpected-model') assert.equal(ledger[1].actualModel, 'another-model')
      await assert.rejects(runDecisionEvaluation(manifestPath, output, '--confirm-paid-inference'), /EEXIST/)
      assert.equal(inferenceCalls, 1)
    }
  } finally {
    AzureCliCredential.prototype.getToken = originalToken
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})
