import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from '../worker-tests/shared-model-loader.mjs'

const registry = await loadWorker('../server/settings/prompts.ts')
const domain = await loadWorker('../src/domain/admin-settings.ts')
const { ADMIN_SETTINGS_FIELDS } = await loadWorker('../src/domain/admin-settings-fields.ts')
const policies = await loadWorker('../worker/settings.ts')
const renderer = await loadWorker('../worker/prompts.ts')
const { JOB_RUBRIC_COMPILED_PROMPT } = await loadWorker('../worker/runtime.ts')
const { createSettingsStoreFromContainer } = await loadWorker('../server/settings/azure-store.ts')
const { AdminSettingsService } = await loadWorker('../server/settings/service.ts')
const requestSettings = await loadWorker('../server/settings/request-context.ts')
const jobPolicy = await loadWorker('../server/jobs/policy.ts')
const at = '2026-09-22T12:00:00.000Z'
const principal = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  principalKey: 'administrator', name: 'Administrator', email: '',
  applicationRoles: ['Score.Admin'],
}

function cosmos() {
  const documents = new Map(), calls = []
  let version = 0
  let failReads = false, failBatch = false, loseAck = false
  const container = {
    item(id, partition) {
      assert.equal(partition, 'score')
      return { async read() {
        calls.push(['read', id])
        if (failReads) return { statusCode: 503 }
        const value = documents.get(id)
        return value ? { statusCode: 200, resource: structuredClone(value) } : { statusCode: 404 }
      } }
    },
    items: {
      async batch(operations, partition) {
        assert.equal(partition, 'score')
        calls.push(['batch', structuredClone(operations)])
        if (failBatch) return { code: 503, result: operations.map(() => ({ statusCode: 503 })) }
        const staged = new Map(documents), result = []
        for (const [index, op] of operations.entries()) {
          const id = op.id ?? op.resourceBody.id, existing = staged.get(id)
          const failure = op.operationType === 'Create' && existing ? 409
            : op.operationType === 'Replace' && !existing ? 404
              : op.operationType === 'Replace' && existing._etag !== op.ifMatch ? 412 : undefined
          if (failure) return { code: failure, result: operations.map((_, other) => ({ statusCode: other === index ? failure : 424 })) }
          assert.ok(['Create', 'Replace'].includes(op.operationType))
          if (op.operationType === 'Replace') assert.ok(['prompt:current', 'current'].includes(id), 'immutable content must never be replaced')
          const eTag = `"revision-${++version}"`
          staged.set(id, { ...structuredClone(op.resourceBody), _etag: eTag, _rid: 'cosmos-system' })
          result.push({ statusCode: op.operationType === 'Create' ? 201 : 200, eTag })
        }
        documents.clear()
        for (const entry of staged) documents.set(...entry)
        if (loseAck) { loseAck = false; throw new Error('Acknowledgement unavailable after commit') }
        return { code: 200, result }
      },
      query(specification, options) {
        assert.equal(options.partitionKey, 'score')
        return { async fetchAll() {
          const params = new Map(specification.parameters.map(value => [value.name, value.value]))
          return { resources: [...documents.values()].filter(doc => doc.recordType === params.get('@type') &&
            (!params.has('@before') || doc.value.activationId < params.get('@before')))
            .sort((a, b) => b.value.activationId.localeCompare(a.value.activationId))
            .slice(0, params.get('@limit')).map(value => structuredClone(value)) }
        } }
      },
    },
  }
  let sequence = 0
  const store = registry.createPromptStoreFromContainer(container)
  const service = new registry.PromptRegistryService({
    store, now: () => new Date(at), newId: () => `test-${++sequence}`,
    authorizeActivation: actor => actor.oid === principal.oid,
  })
  return {
    container, documents, calls, store, service,
    failReads(value = true) { failReads = value },
    failBatch(value = true) { failBatch = value },
    loseAck() { loseAck = true },
  }
}
async function candidate(f, family = 'assessment', guidance = 'Explain genuine borderline documentary-evidence distinctions under the exact saved anchors.') {
  const baseline = await f.service.current()
  const draft = await f.service.createDraft(principal, {
    baseBundleId: baseline.bundle.bundleId, baseBundleSha256: baseline.bundle.bundleSha256,
    guidance: { [family]: guidance }, generalized: true,
  })
  return { baseline, draft }
}
function activation(baseline, draft) {
  return {
    bundleId: draft.bundle.bundleId, bundleSha256: draft.bundle.bundleSha256,
    reason: 'Activate the reviewed generalized instructions after the bounded comparison.',
    evaluation: {
      workspaceId: 'workspace-one', planId: 'plan-one', planRevisionId: 'plan-revision-one',
      planSha256: 'a'.repeat(64), evaluationId: 'evaluation-one', evaluationSha256: 'b'.repeat(64),
      baselineBundleId: baseline.bundle.bundleId, baselineBundleSha256: baseline.bundle.bundleSha256,
      evaluatedBundleId: draft.bundle.bundleId, evaluatedBundleSha256: draft.bundle.bundleSha256,
    },
  }
}

test('registry baseline is atomically initialized only on confirmed absence, beside settings records', async () => {
  const f = cosmos()
  f.documents.set('current', { id: 'current', applicationId: 'score', recordType: 'settings-current', _etag: '"untouched"' })
  const before = structuredClone(f.documents.get('current'))
  const current = await f.service.current()
  assert.equal(f.documents.size, 11)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, 1)
  const operations = f.calls.find(call => call[0] === 'batch')[1]
  assert.equal(operations.length, 10)
  assert.ok(operations.every(op => op.operationType === 'Create' && op.resourceBody.applicationId === 'score'))
  assert.deepEqual(f.documents.get('current'), before)
  const other = new registry.PromptRegistryService({ store: f.store, now: () => new Date('2027-01-01T00:00:00.000Z') })
  assert.deepEqual(await other.current(), current)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, 1)
  const capture = await other.capture()
  assert.equal(Object.keys(capture.revisions).length, 7)
  assert.equal(capture.revisions.assessment.outputSchemaVersion, 'score-analysis-assessment-qc-v1')
})

test('failed reads, dangling pointers and immutable baseline collisions never become default initialization', async () => {
  const failed = cosmos()
  failed.failReads()
  await assert.rejects(failed.service.current(), /invalid document response/)
  assert.equal(failed.calls.some(call => call[0] === 'batch'), false)
  const dangling = cosmos()
  dangling.documents.set('prompt:current', {
    id: 'prompt:current', applicationId: 'score', recordType: 'prompt-current', bundleId: 'missing', activationId: 'missing', _etag: '"saved"',
  })
  await assert.rejects(dangling.service.current(), /missing immutable history/)
  assert.equal(dangling.calls.some(call => call[0] === 'batch'), false)
  const collision = cosmos()
  collision.documents.set('prompt:bundle:pb-baseline-v1', { id: 'prompt:bundle:pb-baseline-v1', _etag: '"collision"' })
  await assert.rejects(collision.service.current(), /transaction did not succeed/)
  assert.equal(collision.documents.has('prompt:current'), false)
})

test('read-only registry consumers cannot initialize or publish and require every exact retained revision', async () => {
  const f = cosmos(), reader = registry.createPromptReaderFromContainer(f.container)
  assert.deepEqual(Object.keys(reader).sort(), ['getBundle', 'getCurrent', 'getRevision'])
  await assert.rejects(registry.readPromptBundleSnapshot(reader), /read-only reader cannot initialize/)
  assert.equal(f.calls.some(call => call[0] === 'batch'), false)
  const captured = await f.service.capture()
  const writes = f.calls.filter(call => call[0] === 'batch').length
  assert.deepEqual(await registry.readPromptBundleSnapshot(reader, captured.bundle.bundleId), captured)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
  f.documents.delete(`prompt:revision:${captured.revisions.gradeReview.revisionId}`)
  await assert.rejects(registry.readPromptBundleSnapshot(reader, captured.bundle.bundleId), /referenced immutable prompt revision/)
})

test('draft evaluation cannot activate, mutate fixed templates, retain private case content, or silently succeed after failure', async () => {
  const f = cosmos(), baseline = await f.service.current()
  const input = {
    baseBundleId: baseline.bundle.bundleId, baseBundleSha256: baseline.bundle.bundleSha256,
    guidance: { jobRubric: 'Keep distinct role-specific work expectations clear and non-overlapping.' }, generalized: true,
  }
  const evaluated = await f.service.evaluateDraft(principal, input, async snapshot => {
    assert.equal((await f.service.current()).etag, baseline.etag)
    return { evaluatedBundleSha256: snapshot.bundle.bundleSha256 }
  })
  assert.equal(evaluated.evaluation.evaluatedBundleSha256, evaluated.candidate.bundle.bundleSha256)
  assert.equal((await f.service.current()).etag, baseline.etag)
  for (const family of ['gradeReview', 'assessmentGrounding', 'evidenceGapReview', 'resumeProfile', 'candidateSummary']) {
    await assert.rejects(f.service.createDraft(principal, { ...input, guidance: { [family]: 'Never replace fixed policy.' } }))
  }
  for (const guidance of ['{{unresolved}}', 'Use ${privateEvidence}', ' ', 'x'.repeat(4001)]) {
    await assert.rejects(f.service.createDraft(principal, { ...input, guidance: { jobRubric: guidance } }))
  }
  await assert.rejects(f.service.createDraft(principal, { ...input, evidence: 'private source content' }))
  await assert.rejects(f.service.createDraft(principal, { ...input, generalized: false }))
  await assert.rejects(f.service.evaluateDraft(principal, input, async () => { throw new Error('Model evaluation failed') }), /Model evaluation failed/)
  assert.equal((await f.service.current()).etag, baseline.etag)
  assert.ok([...f.documents.values()].every(value => !JSON.stringify(value).includes('private source content')))
})

test('activation requires an authorized admin, an exact evaluated bundle and exact unchanged pointer CAS', async () => {
  const f = cosmos(), { baseline, draft } = await candidate(f)
  const input = activation(baseline, draft)
  await assert.rejects(f.service.activate({ ...principal, oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, input, baseline.etag), /administrator/)
  for (const etag of [undefined, '*', 'W/"weak"', '"one","two"', ` ${baseline.etag}`, '"stale"']) {
    await assert.rejects(f.service.activate(principal, input, etag))
  }
  await assert.rejects(f.service.activate(principal, { ...input, bundleSha256: 'f'.repeat(64) }, baseline.etag), /exact evaluated/)
  await assert.rejects(f.service.activate(principal, {
    ...input, evaluation: { ...input.evaluation, planSha256: undefined },
  }, baseline.etag))
  const published = await f.service.activate(principal, input, baseline.etag)
  assert.equal(published.bundle.bundleId, draft.bundle.bundleId)
  assert.equal(published.activation.parentBundleId, baseline.bundle.bundleId)
  assert.deepEqual(published.activation.evaluation, input.evaluation)
  await assert.rejects(f.service.activate(principal, input, baseline.etag), /changed/)
  const writes = f.calls.filter(call => call[0] === 'batch').at(-1)[1]
  assert.equal(writes.length, 2)
  assert.equal(writes[0].operationType, 'Replace')
  assert.equal(writes[0].ifMatch, baseline.etag)
  assert.equal(writes[1].operationType, 'Create')
  const first = await f.service.history(1)
  assert.equal(first.activations[0].bundleId, draft.bundle.bundleId)
  assert.equal((await f.service.history(1, first.nextBefore)).activations[0].bundleId, baseline.bundle.bundleId)
})

test('private QC candidates are deterministic, independent captures with no global writes or mutable fixed revisions', async () => {
  const f = cosmos(), baseline = await f.service.capture(), original = structuredClone(baseline)
  const actor = { tenantId: principal.tenantId, oid: principal.oid }
  const guidance = { jobRubric: 'Keep distinct source-supported responsibilities separate and non-overlapping.' }
  const writes = f.calls.filter(call => call[0] === 'batch').length
  const candidate = registry.createPromptCandidate(baseline, guidance, actor, at, 'pb-private-evaluation')
  assert.deepEqual(registry.createPromptCandidate(baseline, guidance, actor, at, 'pb-private-evaluation'), candidate)
  assert.deepEqual(baseline, original)
  assert.equal(candidate.bundle.parentBundleId, baseline.bundle.bundleId)
  assert.notEqual(candidate.revisions.jobRubric.revisionId, baseline.revisions.jobRubric.revisionId)
  for (const family of Object.keys(baseline.revisions).filter(family => family !== 'jobRubric')) {
    assert.deepEqual(candidate.revisions[family], baseline.revisions[family])
  }
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
  const settings = domain.captureProcessingSettings(domain.createDefaultAdminSettings(), 'settings', at, candidate)
  assert.ok(renderer.resolveAcceptedPrompt(settings, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT).system.includes(guidance.jobRubric))
  for (const invalid of [{ assessmentGrounding: 'Change review policy.' }, { candidateSummary: 'Write summaries.' }, { jobRubric: '{{document}}' }]) {
    assert.throws(() => registry.createPromptCandidate(baseline, invalid, actor, at, 'pb-private-evaluation'))
  }
  assert.throws(() => registry.createPromptCandidate(baseline, guidance, actor, at, baseline.bundle.bundleId), /new immutable/)
  assert.throws(() => registry.createPromptCandidate(baseline, guidance, { system: 'initialization' }, at, 'pb-private-evaluation'), /attributable/)
  assert.throws(() => registry.createPromptCandidate(baseline, { jobRubric: baseline.revisions.jobRubric.guidance }, actor, at, 'pb-unchanged'), /must change/)
})

test('production prompt publication requires same-tenant Score.Admin claims, not retired OID rosters', async () => {
  const f = cosmos(), { baseline, draft } = await candidate(f)
  const service = new registry.PromptRegistryService({
    store: f.store, now: () => new Date(at),
    config: { tenantId: principal.tenantId, allowedUserIds: new Set([principal.oid]), adminUserIds: new Set([principal.oid]) },
  })
  const input = activation(baseline, draft)
  for (const actor of [
    { ...principal, applicationRoles: undefined },
    { ...principal, applicationRoles: ['Score.User'] },
    { ...principal, tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  ]) {
    await assert.rejects(service.activate(actor, input, baseline.etag), /administrator/)
    assert.equal((await service.current()).etag, baseline.etag)
  }
  const published = await service.activate(principal, input, baseline.etag)
  assert.equal(published.bundle.bundleId, draft.bundle.bundleId)
  await assert.rejects(service.restore({ ...principal, applicationRoles: ['Score.User'] },
    baseline.bundle.bundleId, 'Restore the baseline.', published.etag, 'denied-role-restore'), /administrator/)
  const restored = await service.restore(principal, baseline.bundle.bundleId, 'Restore the baseline.',
    published.etag, 'allowed-role-restore')
  assert.equal(restored.bundle.bundleId, baseline.bundle.bundleId)
})

test('candidate processing snapshots change only accepted prompt pins and cannot synthesize a missing baseline', () => {
  const prompts = registry.createCompiledPromptBaseline(at)
  const baseline = domain.captureProcessingSettings(domain.createDefaultAdminSettings(), 'frozen-model-policy', at, prompts)
  const original = structuredClone(baseline)
  const actor = { tenantId: principal.tenantId, oid: principal.oid }
  const guidance = { assessment: 'Explain which saved scoring anchor best matches the submitted documentary evidence.' }
  const createdAt = '2026-09-23T12:00:00.000Z'
  const candidate = registry.createPromptCandidateSettings(baseline, guidance, actor, createdAt, 'pb-private-settings')
  assert.deepEqual(registry.createPromptCandidateSettings(baseline, guidance, actor, createdAt, 'pb-private-settings'), candidate)
  assert.deepEqual(baseline, original)
  assert.deepEqual({ ...candidate, promptBundle: baseline.promptBundle }, baseline)
  assert.notEqual(candidate.settings, baseline.settings)
  assert.equal(candidate.promptBundle.bundle.createdAt, createdAt)
  assert.equal(candidate.promptBundle.bundle.parentBundleId, prompts.bundle.bundleId)
  assert.deepEqual(policies.validateProcessingSettings(candidate), candidate)
  const legacy = domain.captureProcessingSettings(baseline.settings, baseline.revision, baseline.capturedAt)
  assert.throws(() => registry.createPromptCandidateSettings(legacy, guidance, actor, createdAt, 'pb-without-baseline'), /accepted baseline prompt capture/)
})

test('admin activation registers only the exact privately evaluated candidate before pointer CAS', async () => {
  const f = cosmos(), baseline = await f.service.current(), captured = await f.service.capture()
  const actor = { tenantId: principal.tenantId, oid: principal.oid }
  const candidate = registry.createPromptCandidate(captured, { assessment: 'Explain defensible borderline distinctions under the retained rubric anchors.' },
    actor, at, 'pb-private-assessment')
  const input = { ...activation(baseline, candidate), candidate }
  const writes = f.calls.filter(call => call[0] === 'batch').length
  await assert.rejects(f.service.activate({ ...principal, oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, input, baseline.etag), /administrator/)
  await assert.rejects(f.service.activate(principal, { ...input, bundleSha256: 'f'.repeat(64) }, baseline.etag), /exact evaluated/)
  await assert.rejects(f.service.activate(principal, input, '"stale"'), /changed/)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
  assert.equal(f.documents.has(`prompt:bundle:${candidate.bundle.bundleId}`), false)
  f.loseAck()
  const published = await f.service.activate(principal, input, baseline.etag)
  assert.equal(published.bundle.bundleId, candidate.bundle.bundleId)
  assert.deepEqual(await f.service.capture(candidate.bundle.bundleId), candidate)
  assert.deepEqual(published.activation.evaluation, input.evaluation)
  const registration = f.calls.filter(call => call[0] === 'batch').at(-2)[1]
  assert.equal(registration.length, 2, 'only the changed revision and bundle need global registration')
  assert.ok(registration.every(operation => operation.operationType === 'Create'))
  assert.equal(f.calls.filter(call => call[0] === 'batch').at(-1)[1][0].ifMatch, baseline.etag)
})

test('failed private candidate registration cannot change current or rewrite an existing immutable identity', async () => {
  const f = cosmos(), baseline = await f.service.current(), captured = await f.service.capture()
  const actor = { tenantId: principal.tenantId, oid: principal.oid }
  const candidate = registry.createPromptCandidate(captured, { gradeDraft: 'Distinguish the grade anchors using only official source evidence.' },
    actor, at, 'pb-private-grade')
  const input = { ...activation(baseline, candidate), candidate }
  f.failBatch()
  await assert.rejects(f.service.activate(principal, input, baseline.etag), /transaction did not succeed/)
  assert.equal((await f.service.current()).etag, baseline.etag)
  assert.equal(f.documents.has(`prompt:bundle:${candidate.bundle.bundleId}`), false)
  f.failBatch(false)
  await f.store.createDraft({ ...candidate.bundle, createdAt: '2026-09-23T12:00:00.000Z' }, [candidate.revisions.gradeDraft])
  await assert.rejects(f.service.activate(principal, input, baseline.etag), /different immutable content/)
  assert.equal((await f.service.current()).etag, baseline.etag)
})

test('lost acknowledgements are reconciled only against the exact committed immutable draft and activation', async () => {
  const f = cosmos()
  await f.service.current()
  f.loseAck()
  const { baseline, draft } = await candidate(f)
  f.loseAck()
  const published = await f.service.activate(principal, activation(baseline, draft), baseline.etag)
  assert.equal(published.bundle.bundleId, draft.bundle.bundleId)
  const failing = await candidate(f, 'gradeDraft', 'Explain the exact grade-specific documentary evidence expectations clearly.')
  f.failBatch()
  await assert.rejects(f.service.activate(principal, activation(failing.baseline, failing.draft), failing.baseline.etag), /transaction did not succeed/)
  assert.equal((await f.service.current()).bundle.bundleId, draft.bundle.bundleId)
})

test('restoring a compatible historical bundle creates a new audited evaluated activation, never overwriting history', async () => {
  const f = cosmos(), original = await f.service.capture(), { baseline, draft } = await candidate(f)
  const initialBytes = JSON.stringify(f.documents.get(`prompt:bundle:${original.bundle.bundleId}`))
  const published = await f.service.activate(principal, activation(baseline, draft), baseline.etag)
  const restored = await f.service.activate(principal, activation(published, original), published.etag)
  assert.equal(restored.bundle.bundleId, original.bundle.bundleId)
  assert.equal(restored.activation.parentBundleId, draft.bundle.bundleId)
  assert.notEqual(restored.activation.activationId, baseline.activation.activationId)
  assert.equal(JSON.stringify(f.documents.get(`prompt:bundle:${original.bundle.bundleId}`)), initialBytes)
  assert.equal((await f.service.history()).activations.length, 3)
  assert.deepEqual(await f.service.capture(draft.bundle.bundleId), draft)
})

test('explicit rollback is an authorized CAS restoration of published history, never an unevaluated draft or fabricated evaluation', async () => {
  const f = cosmos(), original = await f.service.capture(), { baseline, draft } = await candidate(f)
  await assert.rejects(f.service.published(draft.bundle.bundleId), /previously activated/)
  await assert.rejects(f.service.restore(principal, draft.bundle.bundleId, 'Do not publish an unevaluated draft.', baseline.etag, 'restore-draft'), /previously activated/)
  const published = await f.service.activate(principal, activation(baseline, draft), baseline.etag)
  const source = await f.service.published(draft.bundle.bundleId)
  assert.deepEqual(source.snapshot, draft)
  assert.deepEqual(source.activation, published.activation)
  await assert.rejects(f.service.restore({ ...principal, oid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    original.bundle.bundleId, 'Restore the compiled baseline.', published.etag, 'restore-denied'), /administrator/)
  for (const etag of [undefined, '*', 'W/"weak"', '"stale"']) {
    await assert.rejects(f.service.restore(principal, original.bundle.bundleId, 'Restore the compiled baseline.', etag, 'restore-stale'))
  }
  f.loseAck()
  const restored = await f.service.restore(principal, original.bundle.bundleId, 'Restore the compiled baseline.', published.etag, 'restore-one')
  assert.deepEqual(restored.bundle, original.bundle)
  assert.equal(restored.activation.evaluation, null)
  assert.deepEqual(restored.activation.restoration, {
    requestId: 'restore-one', sourceActivationId: baseline.activation.activationId, expectedEtag: published.etag,
  })
  assert.equal(restored.activation.parentBundleId, draft.bundle.bundleId)
  assert.deepEqual(await f.service.capture(draft.bundle.bundleId), draft)
  const writes = f.calls.filter(call => call[0] === 'batch').length
  assert.deepEqual(await f.service.restore(principal, original.bundle.bundleId, 'Restore the compiled baseline.', published.etag, 'restore-one'), restored)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
  await assert.rejects(f.service.restore(principal, original.bundle.bundleId, 'Different reason.', published.etag, 'restore-one'), /different immutable request/)
  const next = await f.service.activate(principal, activation(restored, draft), restored.etag)
  const replay = await f.service.restore(principal, original.bundle.bundleId, 'Restore the compiled baseline.', published.etag, 'restore-one')
  assert.deepEqual(replay, next, 'a replay confirms prior publication without overwriting a later administrator release')
})

test('a rejected publication guard propagates without attempting CAS or acknowledgement reconciliation', async () => {
  const f = cosmos(), { baseline, draft } = await candidate(f)
  const denied = new Error('Workspace access was revoked before publication.')
  let callsAtFailure = 0
  const writes = f.calls.filter(call => call[0] === 'batch').length
  await assert.rejects(f.service.activate(principal, activation(baseline, draft), baseline.etag, async () => {
    callsAtFailure = f.calls.length
    throw denied
  }), error => error === denied)
  assert.equal(f.calls.length, callsAtFailure, 'a guard rejection must not become a lost-acknowledgement lookup')
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
  assert.equal((await f.service.current()).etag, baseline.etag)
})

for (const operation of ['activate', 'restore']) {
  test(`${operation} rechecks the publication fence after the final Azure bundle read`, async () => {
    const f = cosmos(), { baseline, draft } = await candidate(f)
    const current = operation === 'activate' ? baseline
      : await f.service.activate(principal, activation(baseline, draft), baseline.etag)
    const selected = operation === 'activate' ? draft.bundle : baseline.bundle
    const denied = new Error('Workspace lifecycle changed during the final registry lookup.')
    let allowed = true, checks = 0, callsAtFailure = 0
    const item = f.container.item.bind(f.container)
    f.container.item = (id, partition) => {
      const selectedItem = item(id, partition)
      return { async read() {
        const result = await selectedItem.read()
        if (id === `prompt:bundle:${selected.bundleId}` && checks === 1) allowed = false
        return result
      } }
    }
    const guard = async () => {
      checks++
      if (!allowed) { callsAtFailure = f.calls.length; throw denied }
    }
    const writes = f.calls.filter(call => call[0] === 'batch').length
    const publishing = operation === 'activate'
      ? f.service.activate(principal, activation(baseline, draft), current.etag, guard)
      : f.service.restore(principal, selected.bundleId, 'Restore the reviewed release.', current.etag, 'fenced-restore', guard)
    await assert.rejects(publishing, error => error === denied)
    assert.equal(checks, 2)
    assert.equal(f.calls.length, callsAtFailure, 'failed final checks cannot be reconciled as successful publication')
    assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
    assert.equal((await f.service.current()).etag, current.etag)
  })
}

test('successful guards immediately precede CAS and acknowledged restore replays do not republish', async () => {
  const f = cosmos(), { baseline, draft } = await candidate(f)
  const guard = async () => { f.calls.push(['publication-guard']) }
  f.loseAck()
  const published = await f.service.activate(principal, activation(baseline, draft), baseline.etag, guard)
  let transaction = f.calls.findLastIndex(call => call[0] === 'batch')
  assert.equal(f.calls[transaction - 1][0], 'publication-guard')
  assert.equal(f.calls.filter(call => call[0] === 'publication-guard').length, 2)
  const restored = await f.service.restore(principal, baseline.bundle.bundleId, 'Restore the compiled release.', published.etag, 'guarded-restore', guard)
  transaction = f.calls.findLastIndex(call => call[0] === 'batch')
  assert.equal(f.calls[transaction - 1][0], 'publication-guard')
  assert.equal(f.calls.filter(call => call[0] === 'publication-guard').length, 4)
  const writes = f.calls.filter(call => call[0] === 'batch').length
  assert.deepEqual(await f.service.restore(principal, baseline.bundle.bundleId, 'Restore the compiled release.', published.etag, 'guarded-restore', guard), restored)
  assert.equal(f.calls.filter(call => call[0] === 'publication-guard').length, 4)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, writes)
})

test('new work captures the complete selected revisions, retains pins through worker validation, and retries never consult current', async () => {
  const f = cosmos(), first = await f.service.capture()
  const settings = domain.createDefaultAdminSettings()
  const accepted = domain.captureProcessingSettings(settings, 'settings-one', at, first)
  assert.equal(accepted.schemaVersion, 2)
  assert.deepEqual(policies.validateProcessingSettings(accepted).promptBundle, first)
  const originalPrompt = renderer.resolveAcceptedPrompt(accepted, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT)
  const { baseline, draft } = await candidate(f, 'jobRubric', 'Distinguish documented responsibilities and source-supported optional requirements explicitly.')
  await f.service.activate(principal, activation(baseline, draft), baseline.etag)
  assert.deepEqual(renderer.resolveAcceptedPrompt(accepted, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT), originalPrompt)
  const next = domain.captureProcessingSettings(settings, 'settings-one', at, await f.service.capture())
  assert.notEqual(renderer.resolveAcceptedPrompt(next, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT).provenance.revisionId, originalPrompt.provenance.revisionId)
  assert.equal(originalPrompt.provenance.bundleId, first.bundle.bundleId)
  assert.equal(originalPrompt.provenance.systemSha256, registry.promptTextHash(originalPrompt.system))
  const legacy = domain.captureProcessingSettings(settings, 'legacy-v1', at)
  assert.deepEqual(renderer.resolveAcceptedPrompt(legacy, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT), JOB_RUBRIC_COMPILED_PROMPT)
  assert.equal('promptBundle' in policies.validateProcessingSettings(legacy), false)
})

test('missing revisions, forged hashes, unsupported templates and version-two missing pins fail closed', async () => {
  const f = cosmos(), capture = await f.service.capture()
  const accepted = domain.captureProcessingSettings(domain.createDefaultAdminSettings(), 'accepted', at, capture)
  const missing = structuredClone(accepted)
  delete missing.promptBundle
  assert.throws(() => policies.validateProcessingSettings(missing), /captured processing settings are invalid/)
  assert.throws(() => renderer.resolveAcceptedPrompt({ ...accepted, schemaVersion: 1 }, 'jobRubric', JOB_RUBRIC_COMPILED_PROMPT), /settings version/)
  const corrupt = structuredClone(accepted)
  corrupt.promptBundle.revisions.jobRubric.guidance += ' Unapproved mutation.'
  assert.throws(() => policies.validateProcessingSettings(corrupt), /integrity/)
  assert.throws(() => renderer.resolveAcceptedPrompt(accepted, 'jobRubric', {
    ...JOB_RUBRIC_COMPILED_PROMPT, system: `${JOB_RUBRIC_COMPILED_PROMPT.system}\nChanged policy`,
  }), /missing, changed, or unsupported/)
  f.documents.delete(`prompt:revision:${capture.revisions.jobRubric.revisionId}`)
  await assert.rejects(f.service.capture(), /revision is unavailable/)
  assert.equal(f.calls.filter(call => call[0] === 'batch').length, 1, 'dangling saved pins cannot initialize a new baseline')
})

test('API accepted-work reconstruction retains pins without a current read or legacy-provider downgrade', async () => {
  const capture = registry.createCompiledPromptBaseline(at)
  const accepted = domain.captureProcessingSettings(domain.createDefaultAdminSettings(), 'accepted', at, capture)
  const req = {}
  requestSettings.attachSettingsContext({ settings: { runtimeEnabled: true } }, {
    capture() { assert.fail('accepted retries must not read current') },
    captureLegacy() { assert.fail('a present accepted snapshot must not be replaced') },
  })(req, {}, () => {})
  const resolved = await requestSettings.getSettingsForAcceptedWork(req, accepted)
  assert.deepEqual(resolved, accepted)
  assert.deepEqual(jobPolicy.newProcessingSettings({ pinNewAdmissions: false }, resolved), accepted)
  assert.equal(jobPolicy.preservesProcessingSettings(undefined, { ...accepted, revision: 'legacy-v1' }), false)
})

test('AdminSettingsService captures configured registry pins, but accepted legacy work and unconfigured callers remain unchanged', async () => {
  const f = cosmos(), settingsStore = createSettingsStoreFromContainer(f.container)
  const config = {
    tenantId: principal.tenantId,
    settings: { defaults: domain.createDefaultAdminSettings(), runtimeEnabled: true },
  }
  const service = new AdminSettingsService({ config, store: settingsStore, prompts: f.service, now: () => new Date(at) })
  const captured = await service.capture()
  assert.equal(captured.schemaVersion, 2)
  assert.equal(captured.promptBundle.bundle.bundleId, (await f.service.current()).bundle.bundleId)
  const legacy = await service.captureLegacy()
  assert.equal(legacy.schemaVersion, 1)
  assert.equal('promptBundle' in legacy, false)
  const unconfigured = new AdminSettingsService({ config, store: settingsStore, now: () => new Date(at) })
  assert.equal((await unconfigured.capture()).schemaVersion, 1)
  for (const prompts of [{ capture: async () => undefined }, { capture: async () => { throw new Error('Registry unavailable') } }]) {
    const failed = new AdminSettingsService({ config, store: settingsStore, prompts })
    await assert.rejects(failed.capture(), /unavailable/)
  }
})

test('all four roles are valid policy choices without silently expanding saved export/download allowlists', () => {
  const before = domain.createDefaultAdminSettings()
  assert.ok(!before.documents.originalDownloadRoles.includes('reviewer'))
  assert.ok(!before.reports.allowedRoles.includes('reviewer'))
  const parsed = domain.parseAdminSettings(before)
  assert.deepEqual(parsed.documents.originalDownloadRoles, before.documents.originalDownloadRoles)
  assert.deepEqual(parsed.reports.allowedRoles, before.reports.allowedRoles)
  const next = domain.mergeAdminSettings(before, {
    documents: { originalDownloadRoles: ['owner', 'editor', 'viewer', 'reviewer'] },
    reports: { allowedRoles: ['owner', 'editor', 'viewer', 'reviewer'] },
  })
  assert.equal(next.documents.originalDownloadRoles.length, 4)
  assert.equal(next.reports.allowedRoles.length, 4)
  for (const path of ['documents.originalDownloadRoles', 'reports.allowedRoles']) {
    assert.deepEqual(ADMIN_SETTINGS_FIELDS.find(field => field.path === path).options, ['owner', 'editor', 'viewer', 'reviewer'])
  }
})
