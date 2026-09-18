import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  api, fixture, seedResume, seedJob, seedGrade, createRun, finishInitialization,
  ACTOR, NOW, clone,
} from '../server-tests/real-analyses.test-support.mjs'

const bundle = path.resolve('dist-worker', `analysis-runtime-test-${process.pid}.mjs`)
await mkdir(path.dirname(bundle), { recursive: true })
await build({
  entryPoints: [path.join('worker', 'analyses', 'runtime.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
})
const { runAnalysisWorker, processClaimedComparison } = await import(pathToFileURL(bundle).href)
after(async () => { await unlink(bundle) })

function comparisons(f, runId) {
  return [...f.analysis.store.values.values()].filter(item => item.record.recordType === 'analysis-comparison' &&
    item.record.runId === runId).sort((a, b) => a.record.index - b.record.index).map(clone)
}

function clockFor(f) {
  return {
    now: () => new Date(f.now),
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted) throw signal.reason
      f.now = new Date(Date.parse(f.now) + milliseconds).toISOString()
    },
  }
}

function modelAssessment(input, { limited = false } = {}) {
  const quote = { paragraphId: input.resume.paragraphs[0].id, quote: input.resume.paragraphs[0].text }
  return {
    criteria: input.rubric.criteria.map(criterion => criterion.support === 'not-applicable' ? {
      criterionId: criterion.id, evidenceStatus: 'not-applicable', score: null,
      rationale: 'The saved approved rubric excludes this work from scoring.', citations: [], limitation: null,
    } : limited ? {
      criterionId: criterion.id, evidenceStatus: 'not-assessed', score: null,
      rationale: 'The submitted document does not establish the scope needed to distinguish the saved anchors.',
      citations: [], limitation: { code: 'not-assessable', message: 'The stated responsibility scope needs human review.' },
    } : {
      criterionId: criterion.id, evidenceStatus: 'supported', score: 3,
      rationale: 'The cited document describes independently evaluating engineering systems, matching the saved independent-work anchor.',
      citations: [quote], limitation: null,
    }),
    qualifications: input.qualifications.map(qualification => ({
      qualificationId: qualification.id, evidenceStatus: 'not-assessed',
      rationale: 'The supplied professional evidence does not settle the separate saved qualification alternatives.',
      citations: [], limitation: { code: 'not-assessable', message: 'Separate documentary qualification review is needed; no official eligibility decision was made.' },
    })),
  }
}

function modelFor(f, handler) {
  const calls = []
  const model = {
    endpoint: 'https://score.openai.azure.com', deployment: 'saved-analysis-deployment', modelName: 'gpt-5-mini',
    getToken: async scope => { assert.equal(scope, 'https://cognitiveservices.azure.com/.default'); return 'test-token' },
    async fetch(_url, init) {
      const request = JSON.parse(init.body)
      const body = JSON.parse(request.messages[1].content)
      const kind = request.response_format.json_schema.name
      calls.push({ kind, body, request, signal: init.signal })
      const override = await handler?.({ kind, body, request, signal: init.signal, call: calls.length })
      if (override instanceof Response) return override
      const value = override ?? (kind === 'resume_rubric_assessment'
        ? modelAssessment(body.input) : { outcome: 'supported', issues: [] })
      return Response.json({
        model: `actual-analysis-model-${calls.length}`,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      })
    },
  }
  return { model, calls, deps: { ...f.analysis, model, clock: clockFor(f), owner: 'analysis-test-worker' } }
}

async function until(predicate, message = 'Expected asynchronous worker progress') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(message)
}

async function cancelComparison(f, comparison) {
  return f.service.comparisonAction(f.workspaceId, comparison.record.runId, comparison.record.id, 'cancel', comparison.etag)
}

function azurePollingFor(f) {
  const queries = []
  const parentReads = []
  const container = {
    item(id, workspaceId) {
      return {
        async read() {
          parentReads.push(`${workspaceId}:${id}`)
          const value = await f.analysis.store.get(workspaceId, id)
          return value ? { resource: { ...value.record, _etag: value.etag } } : { statusCode: 404 }
        },
      }
    },
    items: {
      query(specification, options = {}) {
        const parameters = new Map(specification.parameters.map(parameter => [parameter.name, parameter.value]))
        const recordType = parameters.get('@recordType')
        const now = parameters.get('@now')
        const excludesStoppedCancellation = /c\.error\.retryable\s*=\s*true/i.test(specification.query) &&
          /c\.attempts\s*<\s*@maxAttempts/i.test(specification.query)
        queries.push({ recordType, continuationToken: options.continuationToken })
        let rows = [...f.analysis.store.values.values()].filter(({ record }) => {
          if (record.recordType !== recordType) return false
          const cancellation = record.cancellation && !record.cancellation.completedAt &&
            (!excludesStoppedCancellation || !record.error ||
              record.error.retryable && record.attempts < parameters.get('@maxAttempts'))
          const eligible = recordType === 'analysis-run'
            ? record.status === 'initializing' || cancellation
            : record.status === 'queued' || record.status === 'running'
          return eligible && (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now)
        }).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
          .map(item => ({ ...clone(item.record), _etag: item.etag }))
        if (/\bTOP\s+@limit\b/i.test(specification.query)) rows = rows.slice(0, parameters.get('@limit'))
        let offset = Number(options.continuationToken ?? 0)
        const size = options.maxItemCount ?? 100
        const page = () => {
          const resources = rows.slice(offset, offset + size)
          offset += resources.length
          return { resources, ...(offset < rows.length ? { continuationToken: `${offset}` } : {}) }
        }
        return {
          fetchAll: async () => ({ resources: clone(rows) }),
          fetchNext: async () => page(),
          hasMoreResults: () => offset < rows.length,
          async *getAsyncIterator() { while (offset < rows.length) yield page() },
          async *[Symbol.asyncIterator]() { while (offset < rows.length) yield page() },
        }
      },
    },
  }
  return { store: api.createAnalysisStoreFromContainer(container), queries, parentReads }
}

test('a durable 500-pair bootstrap is completed in 25-pair transactions before any model call', async () => {
  const f = fixture()
  f.analysis.store._beforeBatch(() => { throw new Error('Interrupted after durable run acceptance') })
  await assert.rejects(createRun(f, 125, 4), /Interrupted/)
  const accepted = [...f.analysis.store.values.values()][0]
  assert.equal(accepted.record.progress.initialized, 0)
  const mock = modelFor(f)
  const claims = []
  const replace = f.analysis.store.replace.bind(f.analysis.store)
  f.analysis.store.replace = async (record, etag) => {
    if (record.lease) claims.push(clone(record))
    return replace(record, etag)
  }
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
  const current = await f.analysis.store.get(f.workspaceId, accepted.record.id)
  assert.equal(current.record.status, 'queued')
  assert.equal(current.record.progress.initialized, 500)
  assert.equal(current.record.progress.queued, 500)
  assert.deepEqual(f.analysis.store.batches.map(batch => batch.length), Array(20).fill(26))
  assert.equal(new Set(comparisons(f, accepted.record.id).map(item => item.record.id)).size, 500)
  assert.ok(claims.length >= 20)
  assert.equal(current.record.attempts, 1)
  assert.ok(claims.every(record => record.lease.owner === mock.deps.owner && record.nextAttemptAt === undefined))
  assert.equal(current.record.lease, undefined)
  assert.equal(mock.calls.length, 0)
})

test('partially initialized work survives a transient chunk failure and an expired initializer lease', async () => {
  const f = fixture()
  const created = await createRun(f, 125, 4)
  const mock = modelFor(f)
  f.analysis.store._beforeBatch(() => {
    f.analysis.store._beforeBatch(() => { throw new Error('Transient chunk outage') })
  })
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  let run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(run.record.progress.initialized, 50)
  assert.equal(run.record.status, 'initializing')
  assert.equal(run.record.error.code, 'storage-error')
  assert.equal(run.record.lease, undefined)
  assert.equal(run.record.attempts, 1)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 0, completed: 0 })
  f.now = run.record.nextAttemptAt
  const leased = clone(run.record)
  leased.attemptId = randomUUID()
  leased.lease = { owner: 'crashed-initializer', heartbeatAt: f.now, expiresAt: new Date(Date.parse(f.now) + 90000).toISOString() }
  delete leased.nextAttemptAt
  f.analysis.store.save(leased)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 0, completed: 0 })
  f.now = new Date(Date.parse(leased.lease.expiresAt) + 1).toISOString()
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(run.record.progress.initialized, 500)
  assert.equal(run.record.attempts, 2)
  assert.equal(run.record.error, undefined)
  assert.equal(mock.calls.length, 0)
})

test('an actual cited assessment and independent review persist a result accepted by API readers', async () => {
  const f = fixture()
  const created = await createRun(f)
  const original = comparisons(f, created.run.id)[0]
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  const mock = modelFor(f)
  const outcome = await runAnalysisWorker(mock.deps, { maxItems: 1 })
  assert.deepEqual(outcome, { claimed: 1, completed: 1 }, JSON.stringify(comparisons(f, created.run.id).map(item => item.record.error)))
  assert.deepEqual(mock.calls.map(call => call.kind), ['resume_rubric_assessment', 'resume_rubric_grounding_review'])
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, original.record.id)
  assert.equal(detail.comparison.status, 'complete')
  assert.deepEqual(detail.result.overall, { status: 'available', score: 60 })
  assert.equal(detail.result.humanReviewRequired, true)
  assert.equal(detail.result.criteria[0].citations[0].documentId, detail.resumeSnapshot.document.id)
  assert.equal(detail.result.criteria[0].citations[0].quote, detail.resumeSnapshot.document.paragraphs[0].text)
  assert.deepEqual(detail.result.criteria[0].requirementCitations, detail.targetSnapshot.requirementEvidence[0].citations)
  assert.equal(detail.result.provenance.manifestSha256, created.run.manifest.sha256)
  assert.equal(detail.result.provenance.assessment.model, 'actual-analysis-model-1')
  assert.equal(detail.result.provenance.groundingReviews[0].provenance.model, 'actual-analysis-model-2')
  assert.equal(detail.result.provenance.calculationVersion, 'weighted-0-100-v1')
  assert.equal(detail.comparison.result.sha256, api.analysisBytesHash(f.analysis.blobs.values.get(detail.comparison.result.blobName).bytes))
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(run.record.status, 'complete')
  assert.equal(run.record.progress.scored, 1)
  assert.equal(run.record.progress.unscored, 0)
})

test('substantive ready resumes with every display metadata field unavailable are assessed without filename substitutions', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const record = clone(resume.record)
  const profile = clone(resume.profile)
  for (const key of ['name', 'role', 'location', 'experience']) {
    record.resume[key] = null
    profile[key] = { status: 'unavailable', value: null, citations: [] }
  }
  const bytes = Buffer.from(JSON.stringify(profile))
  const previousBlob = f.resumes.blobs.values.get(record.profileBlob.blobName)
  const sha256 = api.analysisBytesHash(bytes)
  f.resumes.blobs.values.set(record.profileBlob.blobName, { ...previousBlob, bytes, sha256 })
  record.profileBlob = { ...record.profileBlob, sha256, bytes: bytes.byteLength }
  f.resumeValues.set(`${f.workspaceId}/${record.id}`, { record: api.parseResumeEntity(record), etag: '"unavailable-display-fields"' })
  const job = await seedJob(f)
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Document evidence without display metadata', resumes: [resume.selection], targets: [job.selection],
  }, ACTOR)
  const mock = modelFor(f)
  const outcome = await runAnalysisWorker(mock.deps)
  assert.equal(mock.calls.length, 2)
  assert.deepEqual(mock.calls[0].body.input.resume, resume.document)
  assert.deepEqual(outcome, { claimed: 1, completed: 1 })
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparisons(f, created.run.id)[0].record.id)
  for (const key of ['name', 'role', 'location', 'experience']) {
    assert.equal(detail.resumeSnapshot.resume[key], null)
    assert.equal(detail.resumeSnapshot.profile[key].status, 'unavailable')
  }
  const evidence = detail.result.criteria[0].citations[0]
  assert.equal(evidence.documentVersion, resume.document.version)
  assert.equal(evidence.heading, resume.document.paragraphs[0].heading)
  assert.equal(evidence.page, resume.document.paragraphs[0].page)
  assert.equal(evidence.quote, resume.document.paragraphs[0].text)
})

test('a valid limited assessment withholds the score without becoming a processing failure', async () => {
  const f = fixture()
  const created = await createRun(f)
  const mock = modelFor(f, ({ kind, body }) => kind === 'resume_rubric_assessment' ? modelAssessment(body.input, { limited: true }) : undefined)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  const comparison = comparisons(f, created.run.id)[0]
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.equal(detail.result.completion, 'limited')
  assert.equal(detail.result.overall.status, 'withheld')
  assert.equal(detail.result.overall.score, null)
  assert.equal(comparison.record.error, undefined)
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.deepEqual([run.record.progress.complete, run.record.progress.scored, run.record.progress.unscored, run.record.progress.failed], [1, 0, 1, 0])
})

test('approved GS exclusions and qualifications stay separate in frozen model inputs and results', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const grade = await seedGrade(f, await seedJob(f))
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Exact approved grade', resumes: [resume.selection], targets: [grade.selection],
  }, ACTOR)
  f.gradeValues.clear()
  f.grades.blobs.values.clear()
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparisons(f, created.run.id)[0].record.id)
  const input = mock.calls[0].body.input
  assert.deepEqual(input.rubric, grade.version.rubric)
  assert.deepEqual(input.qualifications, grade.version.qualifications)
  assert.equal(input.references, undefined)
  const excluded = detail.result.criteria.find(item => item.evidenceStatus === 'not-applicable')
  assert.equal(excluded.weight, 0)
  assert.equal(excluded.score, null)
  assert.equal(detail.result.qualifications.length, grade.version.qualifications.length)
  assert.ok(detail.result.qualifications.every(item => !Object.hasOwn(item, 'score')))
  assert.equal(detail.result.overall.status, 'available')
  assert.equal(detail.result.completion, 'limited')
})

test('competing claims invoke the model only for the transaction-winning attempt', async () => {
  const f = fixture()
  const created = await createRun(f)
  const mock = modelFor(f)
  const results = await Promise.all([
    runAnalysisWorker({ ...mock.deps, owner: 'worker-a' }, { maxItems: 1 }),
    runAnalysisWorker({ ...mock.deps, owner: 'worker-b' }, { maxItems: 1 }),
  ])
  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 1)
  assert.equal(results.reduce((sum, result) => sum + result.completed, 0), 1)
  assert.equal(mock.calls.length, 2)
  assert.equal(comparisons(f, created.run.id)[0].record.attempts, 1)
})

test('another comparison may change the parent ETag during publication without discarding model work', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const mock = modelFor(f)
  const transact = f.analysis.store.transact.bind(f.analysis.store)
  let raced = false
  f.analysis.store.transact = async (workspaceId, operations) => {
    if (!raced && operations.some(item => item.record.recordType === 'analysis-comparison' && item.record.status === 'complete')) {
      raced = true
      const other = comparisons(f, created.run.id).find(item => item.record.status === 'queued')
      await cancelComparison(f, other)
    }
    return transact(workspaceId, operations)
  }
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
  assert.equal(mock.calls.length, 2, 'A parent progress race must not repeat a long assessment')
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(run.record.status, 'partial')
  assert.deepEqual([run.record.progress.complete, run.record.progress.cancelled, run.record.progress.failed], [1, 1, 0])
})

test('invalid model citations fail only that comparison and never produce a zero fallback', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const invalidRubric = created.targets[0].selection.rubricId
  const mock = modelFor(f, ({ kind, body }) => {
    if (kind !== 'resume_rubric_assessment' || body.input.rubric.id !== invalidRubric) return
    const value = modelAssessment(body.input)
    value.criteria[0].citations[0].quote = 'PRIVATE-MODEL-SENTINEL not in the document'
    return value
  })
  const events = []
  mock.deps.onEvent = event => events.push(event)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 2 }), { claimed: 2, completed: 1 })
  const [failed, complete] = comparisons(f, created.run.id).map(item => item.record)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'invalid-citation')
  assert.equal(failed.attempts, 1)
  assert.equal(failed.result, undefined)
  assert.doesNotMatch(JSON.stringify(failed.error), /PRIVATE-MODEL-SENTINEL/)
  assert.equal(mock.calls.filter(call => call.kind === 'resume_rubric_assessment' && call.body.input.rubric.id === invalidRubric).length, 3)
  assert.match(failed.error.message, /Assessment criterion 1, citation 1/)
  assert.match(failed.error.message, /2-correction limit/)
  assert.equal(failed.error.retryable, false)
  assert.equal(failed.nextAttemptAt, undefined)
  const failures = events.filter(event => event.comparisonId === failed.id)
  assert.ok(failures.every(event => event.workspaceId === f.workspaceId && event.runId === created.run.id && event.attemptId === failed.attemptId))
  assert.deepEqual(failures.filter(event => event.event === 'correction').map(event => event.correctionCount), [1, 2])
  assert.equal(failures.filter(event => event.event === 'validation-failed').length, 3)
  assert.equal(failures.at(-1).event, 'comparison-outcome')
  assert.equal(failures.at(-1).outcome, 'failed')
  assert.equal(failures.at(-1).code, 'invalid-citation')
  assert.equal(failures.at(-1).correctionCount, 2)
  assert.equal(failures.at(-1).stage, 'assessment')
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-MODEL-SENTINEL|test-token/)
  assert.equal(complete.status, 'complete')
  assert.equal(complete.resultSummary.overall.score, 60)
  assert.equal(events.find(event => event.comparisonId === complete.id && event.event === 'comparison-outcome').outcome, 'complete')
})

test('two semantic corrections publish three bound reviews and correlated completion without extra worker attempts', async () => {
  const f = fixture()
  const created = await createRun(f)
  let assessments = 0, reviews = 0
  const mock = modelFor(f, ({ kind, body }) => {
    if (kind === 'resume_rubric_assessment') {
      const value = modelAssessment(body.input)
      assessments++
      for (const row of value.criteria) row.score = assessments
      return value
    }
    if (++reviews <= 2) return {
      outcome: 'needs-correction',
      issues: [{
        code: 'unsupported-score', message: 'Compare the stated responsibility scope with the saved score anchors.',
        criterionId: body.input.rubric.criteria[0].id, qualificationId: null, citations: [],
      }],
    }
  })
  const events = []
  mock.deps.onEvent = event => events.push(event)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  const saved = comparisons(f, created.run.id)[0].record
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, saved.id)
  assert.equal(mock.calls.length, 6)
  assert.equal(saved.attempts, 1)
  assert.equal(saved.retryCount, 0)
  assert.equal(detail.result.provenance.correctionCount, 2)
  assert.equal(detail.result.provenance.groundingReviews.length, 3)
  assert.equal(new Set(detail.result.provenance.groundingReviews.map(review => review.assessmentSha256)).size, 3)
  assert.equal(detail.result.provenance.groundingReviews.at(-1).assessmentSha256, detail.result.provenance.assessmentSha256)
  assert.equal(detail.result.overall.score, 60)
  assert.ok(events.every(event => event.comparisonId === saved.id && event.attemptId === saved.attemptId))
  assert.equal(events.at(-1).outcome, 'complete')
  assert.equal(events.at(-1).stage, 'publication')
  assert.equal(events.at(-1).correctionCount, 2)
})

test('corrupt snapshot bytes fail independently before inference', async () => {
  const f = fixture()
  const created = await createRun(f, 2, 1)
  const [first] = comparisons(f, created.run.id)
  const blob = f.analysis.blobs.values.get(first.record.resume.blob.blobName)
  blob.bytes[0] ^= 1
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 2 }), { claimed: 2, completed: 1 })
  const [failed, complete] = comparisons(f, created.run.id).map(item => item.record)
  assert.equal(failed.error.code, 'snapshot-invalid')
  assert.equal(failed.error.retryable, false)
  assert.equal(failed.result, undefined)
  assert.equal(complete.status, 'complete')
  assert.equal(mock.calls.length, 2)
})

test('missing snapshot retries stop after three attempts; manual retry uses original evidence and leaves completed history intact', async () => {
  const f = fixture()
  const created = await createRun(f, 2, 1)
  const [first, second] = comparisons(f, created.run.id)
  const reference = first.record.resume.blob
  const original = clone(f.analysis.blobs.values.get(reference.blobName))
  f.analysis.blobs.values.delete(reference.blobName)
  const mock = modelFor(f)
  await runAnalysisWorker(mock.deps, { maxItems: 2 })
  const completed = await f.analysis.store.get(f.workspaceId, second.record.id)
  const historical = clone(f.analysis.blobs.values.get(completed.record.result.blobName))
  let failed
  for (let attempts = 1; attempts <= 3; attempts++) {
    failed = (await f.analysis.store.get(f.workspaceId, first.record.id)).record
    assert.equal(failed.attempts, attempts)
    assert.equal(failed.result, undefined)
    assert.equal(failed.error.code, 'snapshot-unavailable')
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 0, completed: 0 })
    if (attempts < 3) {
      assert.equal(failed.status, 'queued')
      assert.equal(Date.parse(failed.nextAttemptAt) - Date.parse(f.now), 30000 * 2 ** (attempts - 1))
      f.now = failed.nextAttemptAt
      await runAnalysisWorker(mock.deps, { maxItems: 1 })
    }
  }
  assert.equal(failed.status, 'failed')
  assert.equal(failed.nextAttemptAt, undefined)
  assert.equal(failed.lease, undefined)
  f.analysis.blobs.values.set(reference.blobName, original)
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  const current = await f.analysis.store.get(f.workspaceId, first.record.id)
  await f.service.comparisonAction(f.workspaceId, created.run.id, first.record.id, 'retry', current.etag)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
  const retried = await f.analysis.store.get(f.workspaceId, first.record.id)
  assert.equal(retried.record.attempts, 1)
  assert.equal(retried.record.retryCount, 1)
  assert.deepEqual(retried.record.resume, first.record.resume)
  assert.deepEqual(retried.record.target, first.record.target)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, second.record.id), completed)
  assert.deepEqual(f.analysis.blobs.values.get(completed.record.result.blobName), historical)
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, first.record.id)
  assert.deepEqual(mock.calls.at(-2).body.input.resume, detail.resumeSnapshot.document)
})

test('worker finishes interrupted cancellation for both initializing and fully initialized 100-pair runs', async () => {
  for (const initialized of [false, true]) {
    const f = fixture()
    const created = await createRun(f, 10, 10)
    if (initialized) {
      const finished = await finishInitialization(f, created.run.id)
      f.analysis.store.save({ ...finished.record, attempts: 3, attemptId: randomUUID() })
    }
    const run = await f.analysis.store.get(f.workspaceId, created.run.id)
    f.analysis.store._beforeBatch(() => { throw new Error('Interrupted after durable cancellation') })
    await assert.rejects(f.service.cancel(f.workspaceId, created.run.id, ACTOR, run.etag), /Interrupted/)
    assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).record.cancellation.nextComparisonIndex, 0)
    const mock = modelFor(f)
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
    const cancelled = await f.analysis.store.get(f.workspaceId, created.run.id)
    assert.equal(cancelled.record.status, 'cancelled')
    assert.equal(cancelled.record.progress.initialized, 100)
    assert.equal(cancelled.record.progress.cancelled, 100)
    assert.equal(cancelled.record.cancellation.nextComparisonIndex, 100)
    assert.ok(cancelled.record.cancellation.completedAt)
    assert.equal(cancelled.record.lease, undefined)
    assert.equal(cancelled.record.attempts, 1, 'Cancellation owns a new attempt cycle, independent of initialization')
    assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26))
    assert.equal(mock.calls.length, 0)
  }
})

test('heartbeat keeps the owned comparison live, detects cancellation, and aborts a pending model request', async t => {
  const f = fixture()
  const created = await createRun(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const mock = modelFor(f, async ({ call }) => { if (call === 1) await blocked })
  const work = runAnalysisWorker(mock.deps, { maxItems: 1 })
  try {
    await until(() => mock.calls.length === 1)
    const claimed = comparisons(f, created.run.id)[0]
    f.now = new Date(Date.parse(NOW) + 25000).toISOString()
    t.mock.timers.tick(25000)
    await until(async () => (await f.analysis.store.get(f.workspaceId, claimed.record.id)).record.lease.heartbeatAt === f.now)
    const renewed = await f.analysis.store.get(f.workspaceId, claimed.record.id)
    assert.equal(renewed.record.attemptId, claimed.record.attemptId)
    assert.equal(Date.parse(renewed.record.lease.expiresAt) - Date.parse(f.now), 90000)
    assert.equal(renewed.record.nextAttemptAt, undefined)
    assert.deepEqual(await runAnalysisWorker({ ...mock.deps, owner: 'competitor' }), { claimed: 0, completed: 0 })
    await cancelComparison(f, renewed)
    f.now = new Date(Date.parse(f.now) + 25000).toISOString()
    t.mock.timers.tick(25000)
    await until(() => mock.calls[0].signal.aborted)
    assert.deepEqual(await work, { claimed: 1, completed: 0 })
    assert.equal(comparisons(f, created.run.id)[0].record.status, 'cancelled')
    assert.equal(comparisons(f, created.run.id)[0].record.result, undefined)
  } finally {
    release()
    await work
    t.mock.timers.reset()
  }
})

test('a bounded processing window aborts inference and durably releases retryable work', async t => {
  const f = fixture()
  const created = await createRun(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const mock = modelFor(f, async () => { await blocked })
  const work = runAnalysisWorker(mock.deps, { maxItems: 1, budgetMilliseconds: 1000 })
  try {
    await until(() => mock.calls.length === 1)
    f.now = new Date(Date.parse(NOW) + 1000).toISOString()
    t.mock.timers.tick(1000)
    assert.deepEqual(await work, { claimed: 1, completed: 0 })
    const current = comparisons(f, created.run.id)[0].record
    assert.equal(current.status, 'queued')
    assert.equal(current.error.code, 'timeout')
    assert.equal(current.error.retryable, true)
    assert.equal(current.lease, undefined)
    assert.ok(current.nextAttemptAt > f.now)
    assert.equal(current.result, undefined)
    assert.equal(mock.calls[0].signal.aborted, true)
  } finally {
    release()
    await work
    t.mock.timers.reset()
  }
})

test('an expired or foreign-owned attempt cannot start inference or resurrect its lease', async () => {
  const f = fixture()
  const created = await createRun(f)
  const queued = comparisons(f, created.run.id)[0]
  const run = await f.analysis.store.get(f.workspaceId, created.run.id)
  const record = {
    ...queued.record, status: 'running', attempts: 1, attemptId: randomUUID(),
    lease: { owner: 'expired-owner', heartbeatAt: NOW, expiresAt: new Date(Date.parse(NOW) + 90000).toISOString() },
  }
  delete record.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record, etag: queued.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, queued.record, record, NOW), etag: run.etag },
  ])
  const claimed = await f.analysis.store.get(f.workspaceId, queued.record.id)
  const mock = modelFor(f)
  assert.equal(await processClaimedComparison(claimed, { ...mock.deps, owner: 'different-worker' }), false)
  assert.equal(mock.calls.length, 0)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, queued.record.id), claimed)
  f.now = new Date(Date.parse(record.lease.expiresAt) + 1).toISOString()
  assert.equal(await processClaimedComparison(claimed, { ...mock.deps, owner: 'expired-owner' }), false)
  assert.equal(mock.calls.length, 0)
  assert.deepEqual(await f.analysis.store.get(f.workspaceId, queued.record.id), claimed)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  assert.equal(comparisons(f, created.run.id)[0].record.attempts, 2)
})

test('a same-owner takeover fences the old attempt ID and preserves the new immutable result', async () => {
  const f = fixture()
  const created = await createRun(f)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const old = modelFor(f, async ({ call }) => { if (call === 1) await blocked })
  const previous = runAnalysisWorker(old.deps, { maxItems: 1 })
  try {
    await until(() => old.calls.length === 1)
    const first = comparisons(f, created.run.id)[0]
    f.now = new Date(Date.parse(first.record.lease.expiresAt) + 1).toISOString()
    const replacement = modelFor(f)
    assert.deepEqual(await runAnalysisWorker(replacement.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
    const completed = comparisons(f, created.run.id)[0]
    const immutable = clone(f.analysis.blobs.values.get(completed.record.result.blobName))
    assert.notEqual(completed.record.attemptId, first.record.attemptId)
    assert.equal(completed.record.attempts, 2)
    release()
    assert.deepEqual(await previous, { claimed: 1, completed: 0 })
    assert.deepEqual(comparisons(f, created.run.id)[0], completed)
    assert.deepEqual(f.analysis.blobs.values.get(completed.record.result.blobName), immutable)
  } finally {
    release()
    await previous
  }
})

test('run cancellation after immutable result upload wins the final publication fence', async () => {
  const f = fixture()
  const created = await createRun(f)
  f.analysis.blobs._afterPut(async name => {
    if (!name.includes('/results/')) return
    const current = await f.analysis.store.get(f.workspaceId, created.run.id)
    await f.service.cancel(f.workspaceId, created.run.id, ACTOR, current.etag)
  })
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 0 })
  const comparison = comparisons(f, created.run.id)[0].record
  assert.equal(comparison.status, 'cancelled')
  assert.equal(comparison.result, undefined)
  assert.equal(comparison.resultSummary, undefined)
  assert.equal([...f.analysis.blobs.values.keys()].filter(name => name.includes('/results/')).length, 1)
  assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).record.progress.complete, 0)
})

test('cancelling and retrying another pair never changes a completed comparison or its result bytes', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 2)
  const mock = modelFor(f)
  await runAnalysisWorker(mock.deps, { maxItems: 1 })
  const completed = comparisons(f, created.run.id)[0]
  const bytes = clone(f.analysis.blobs.values.get(completed.record.result.blobName))
  const parent = await f.analysis.store.get(f.workspaceId, created.run.id)
  await f.service.cancel(f.workspaceId, created.run.id, ACTOR, parent.etag)
  const cancelled = comparisons(f, created.run.id)[1]
  assert.equal(cancelled.record.status, 'cancelled')
  await f.service.comparisonAction(f.workspaceId, created.run.id, cancelled.record.id, 'retry', cancelled.etag)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 1 })
  assert.deepEqual(comparisons(f, created.run.id)[0], completed)
  assert.deepEqual(f.analysis.blobs.values.get(completed.record.result.blobName), bytes)
  assert.equal(comparisons(f, created.run.id)[1].record.retryCount, 1)
})

test('ambiguous claim, immutable-result, and completion commits recover winning bytes without repeating inference', async () => {
  for (const lost of ['claim', 'result', 'complete']) {
    const f = fixture()
    const created = await createRun(f)
    const transact = f.analysis.store.transact.bind(f.analysis.store)
    let interrupted = false
    f.analysis.store.transact = async (workspaceId, operations) => {
      await transact(workspaceId, operations)
      const target = operations.find(item => item.record.recordType === 'analysis-comparison')
      if (!interrupted && ((lost === 'claim' && target?.record.status === 'running') ||
        (lost === 'complete' && target?.record.status === 'complete'))) {
        interrupted = true
        throw new Error('PRIVATE-TRANSACTION-RESPONSE-SENTINEL')
      }
    }
    if (lost === 'result') f.analysis.blobs._afterPut(name => {
      if (name.includes('/results/')) { interrupted = true; throw new Error('PRIVATE-BLOB-RESPONSE-SENTINEL') }
    })
    const mock = modelFor(f)
    assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 }, lost)
    assert.equal(interrupted, true)
    assert.equal(mock.calls.length, 2)
    const comparison = comparisons(f, created.run.id)[0]
    assert.equal(comparison.record.attempts, 1)
    assert.equal(comparison.record.error, undefined)
    const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
    assert.equal(detail.result.overall.score, 60)
  }
})

test('a winning immutable result is read and validated using its actual bytes, not the attempted serialization', async () => {
  const f = fixture()
  const created = await createRun(f)
  const put = f.analysis.blobs.putImmutable.bind(f.analysis.blobs)
  f.analysis.blobs.putImmutable = async (name, bytes, contentType) => {
    if (name.includes('/results/')) {
      await put(name, Buffer.from(JSON.stringify(JSON.parse(Buffer.from(bytes).toString('utf8')), null, 2)), contentType)
      throw new Error('Lost response after storing equivalent immutable JSON bytes')
    }
    return put(name, bytes, contentType)
  }
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  const comparison = comparisons(f, created.run.id)[0]
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.equal(comparison.record.result.sha256, api.analysisBytesHash(f.analysis.blobs.values.get(comparison.record.result.blobName).bytes))
  assert.equal(detail.result.provenance.assessmentSha256, api.analysisHash({
    criteria: detail.result.criteria, qualifications: detail.result.qualifications,
    summary: detail.result.summary, limitations: detail.result.limitations,
  }))
})

test('an immutable result from a different attempt is never published as this attempt', async () => {
  const f = fixture()
  const created = await createRun(f)
  const put = f.analysis.blobs.putImmutable.bind(f.analysis.blobs)
  let attemptedWrite = false
  f.analysis.blobs.putImmutable = async (name, bytes, contentType) => {
    if (name.includes('/results/')) {
      attemptedWrite = true
      const wrongAttempt = JSON.parse(Buffer.from(bytes).toString('utf8'))
      wrongAttempt.provenance.attemptId = randomUUID()
      return put(name, Buffer.from(JSON.stringify(wrongAttempt)), contentType)
    }
    return put(name, bytes, contentType)
  }
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 0 })
  assert.equal(attemptedWrite, true, 'The rejection must validate the winning artifact, not fail before publication')
  const failed = comparisons(f, created.run.id)[0].record
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.stage, 'publication')
  assert.equal(failed.result, undefined)
})

test('transient model failures back off and stop after three automatic attempts without exposing service responses', async () => {
  const f = fixture()
  const created = await createRun(f)
  const mock = modelFor(f, () => Response.json({ error: 'PRIVATE-UPSTREAM-SENTINEL' }, { status: 500 }))
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 0 })
    const current = comparisons(f, created.run.id)[0].record
    assert.equal(current.attempts, attempt)
    assert.equal(current.error.code, 'service-unavailable')
    assert.equal(current.result, undefined)
    assert.doesNotMatch(JSON.stringify(current.error), /PRIVATE-UPSTREAM-SENTINEL/)
    if (attempt < 3) {
      assert.equal(current.status, 'queued')
      f.now = current.nextAttemptAt
    } else {
      assert.equal(current.status, 'failed')
      assert.equal(current.nextAttemptAt, undefined)
      assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 0, completed: 0 })
    }
  }
  assert.equal(mock.calls.length, 3)
})

test('expired third attempts are terminalized without a fourth inference, even after a stale pending read', async () => {
  const f = fixture()
  const created = await createRun(f)
  const queued = comparisons(f, created.run.id)[0]
  const pending = f.analysis.store.listPending.bind(f.analysis.store)
  let changed = false
  f.analysis.store.listPending = async (now, limit) => {
    const items = await pending(now, limit)
    if (!changed) {
      changed = true
      const run = await f.analysis.store.get(f.workspaceId, created.run.id)
      const expired = {
        ...queued.record, status: 'running', attempts: 3, attemptId: randomUUID(),
        lease: { owner: 'crashed-worker', heartbeatAt: new Date(Date.parse(NOW) - 90001).toISOString(), expiresAt: new Date(Date.parse(NOW) - 1).toISOString() },
      }
      delete expired.nextAttemptAt
      await f.analysis.store.transact(f.workspaceId, [
        { kind: 'replace', record: expired, etag: queued.etag },
        { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, queued.record, expired, NOW), etag: run.etag },
      ])
    }
    return items
  }
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 0 })
  assert.equal(mock.calls.length, 0)
  assert.equal(comparisons(f, created.run.id)[0].record.status, 'failed')
  assert.equal(comparisons(f, created.run.id)[0].record.attempts, 3)
})

test('an initializer integrity failure is durable and does not poison another workspace comparison', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const manifest = f.analysis.blobs.values.get(created.run.manifest.blobName)
  manifest.bytes[0] ^= 1
  const other = fixture('workspace-other')
  const healthy = await createRun(other)
  for (const item of other.analysis.store.values.values()) f.analysis.store.save(item.record)
  for (const [name, blob] of other.analysis.blobs.values) f.analysis.blobs.values.set(name, blob)
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 2 }), { claimed: 2, completed: 1 })
  const failed = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(failed.record.status, 'failed')
  assert.equal(failed.record.error.code, 'snapshot-invalid')
  assert.equal(failed.record.error.stage, 'initialization')
  assert.equal(failed.record.lease, undefined)
  assert.equal((await f.analysis.store.get(other.workspaceId, healthy.run.id)).record.status, 'complete')
})

test('Azure polling reaches healthy workspace work beyond a full page of failed-initializer children', async () => {
  const f = fixture()
  const blockedRunIds = []
  for (let index = 0; index < 2; index++) {
    const created = await createRun(f, 10, 10)
    blockedRunIds.push(created.run.id)
    const partial = await api.advanceAnalysisRun(f.analysis, f.workspaceId, created.run.id, {
      now: () => new Date(f.now), maxChunks: 2,
    })
    assert.equal(partial.record.progress.initialized, 75)
    const failed = {
      ...partial.record, status: 'failed', attempts: 1,
      error: { code: 'snapshot-invalid', stage: 'initialization', message: 'The frozen initialization input could not be validated.', retryable: false },
    }
    delete failed.nextAttemptAt
    await f.analysis.store.replace(failed, partial.etag)
  }
  const other = fixture('workspace-after-blocked-page')
  const healthy = await createRun(other)
  for (const item of other.analysis.store.values.values()) f.analysis.store.save(item.record)
  for (const [name, blob] of other.analysis.blobs.values) f.analysis.blobs.values.set(name, blob)
  const polling = azurePollingFor(f)
  const mock = modelFor(f)
  const deps = { ...mock.deps, store: { ...f.analysis.store, listPending: polling.store.listPending } }
  assert.deepEqual(await runAnalysisWorker(deps, { maxItems: 1, pendingLimit: 100 }), { claimed: 1, completed: 1 })
  assert.equal((await f.analysis.store.get(other.workspaceId, healthy.run.id)).record.status, 'complete')
  assert.equal(mock.calls.length, 2)
  assert.ok(polling.queries.some(query => query.recordType === 'analysis-comparison' && query.continuationToken))
  for (const id of blockedRunIds) assert.equal(polling.parentReads.filter(key => key === `${f.workspaceId}:${id}`).length, 1)
})

test('Azure polling skips a full page of permanent or exhausted cancellation failures', async () => {
  const f = fixture()
  const stopped = []
  for (let index = 0; index < 100; index++) {
    const created = await createRun(f)
    const exhausted = index % 2 === 0
    const cancelled = {
      ...created.run, status: 'cancelled', attempts: exhausted ? 3 : 1,
      cancellation: { requestedAt: NOW, requestedBy: ACTOR, nextComparisonIndex: 0 },
      error: {
        code: exhausted ? 'snapshot-unavailable' : 'snapshot-invalid', stage: 'initialization',
        message: 'The cancellation input could not be processed.', retryable: exhausted,
      },
    }
    delete cancelled.nextAttemptAt
    stopped.push(await f.analysis.store.replace(cancelled, created.etag))
  }
  const other = fixture('workspace-after-stopped-cancellations')
  const healthy = await createRun(other)
  for (const item of other.analysis.store.values.values()) f.analysis.store.save(item.record)
  for (const [name, blob] of other.analysis.blobs.values) f.analysis.blobs.values.set(name, blob)
  const polling = azurePollingFor(f)
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker({
    ...mock.deps, store: { ...f.analysis.store, listPending: polling.store.listPending },
  }, { maxItems: 1, pendingLimit: 100 }), { claimed: 1, completed: 1 })
  assert.equal((await f.analysis.store.get(other.workspaceId, healthy.run.id)).record.status, 'complete')
  for (const before of stopped) {
    assert.equal(api.analysisWorkIsPending(before.record, f.now), false)
    assert.deepEqual(await f.analysis.store.get(f.workspaceId, before.record.id), before)
  }
  assert.equal(mock.calls.length, 2)
})

test('Azure polling retains due cancellation retries that have not exhausted their attempts', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const retrying = {
    ...created.run, status: 'cancelled', attempts: 1,
    cancellation: { requestedAt: NOW, requestedBy: ACTOR, nextComparisonIndex: 0 },
    error: { code: 'storage-error', stage: 'initialization', message: 'Cancellation was temporarily unavailable.', retryable: true },
    nextAttemptAt: NOW,
  }
  await f.analysis.store.replace(retrying, created.etag)
  assert.equal(api.analysisWorkIsPending(retrying, f.now), true)
  const polling = azurePollingFor(f)
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker({
    ...mock.deps, store: { ...f.analysis.store, listPending: polling.store.listPending },
  }, { maxItems: 1 }), { claimed: 1, completed: 0 })
  const current = await f.analysis.store.get(f.workspaceId, created.run.id)
  assert.equal(current.record.progress.cancelled, 30)
  assert.equal(current.record.attempts, 2)
  assert.ok(current.record.cancellation.completedAt)
  assert.equal(current.record.error, undefined)
  assert.equal(mock.calls.length, 0)
})

test('initialization backoff stops after three failures and explicit retry keeps the accepted manifest and snapshots', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const initialized = comparisons(f, created.run.id)
  const manifest = clone(f.analysis.blobs.values.get(created.run.manifest.blobName))
  f.analysis.blobs.values.delete(created.run.manifest.blobName)
  const mock = modelFor(f)
  let current
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
    current = await f.analysis.store.get(f.workspaceId, created.run.id)
    assert.equal(current.record.attempts, attempt)
    assert.equal(current.record.error.code, 'snapshot-unavailable')
    assert.equal(current.record.error.stage, 'initialization')
    assert.equal(current.record.progress.initialized, 25)
    if (attempt < 3) {
      assert.equal(current.record.status, 'initializing')
      assert.ok(current.record.nextAttemptAt > f.now)
      f.now = current.record.nextAttemptAt
    }
  }
  assert.equal(current.record.status, 'failed')
  assert.equal(current.record.lease, undefined)
  assert.equal(current.record.nextAttemptAt, undefined)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 0, completed: 0 })
  f.analysis.blobs.values.set(created.run.manifest.blobName, manifest)
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  const retried = await f.service.retry(f.workspaceId, created.run.id, {}, current.etag)
  assert.equal(retried.run.status, 'queued')
  assert.equal(retried.run.progress.initialized, 30)
  assert.equal(retried.run.retryCount, 1)
  assert.deepEqual(retried.run.manifest, created.run.manifest)
  assert.deepEqual(comparisons(f, created.run.id).slice(0, 25), initialized)
  assert.equal(mock.calls.length, 0)
})

test('a cancellation continuation failure is durable and stops automatic retries instead of poisoning the poller', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const current = await f.analysis.store.get(f.workspaceId, created.run.id)
  f.analysis.store._beforeBatch(() => { throw new Error('Interrupted cancellation') })
  await assert.rejects(f.service.cancel(f.workspaceId, created.run.id, ACTOR, current.etag))
  f.analysis.blobs.values.delete(created.run.manifest.blobName)
  const mock = modelFor(f)
  let cancelled
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
    cancelled = (await f.analysis.store.get(f.workspaceId, created.run.id)).record
    assert.equal(cancelled.attempts, attempt)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.error.code, 'snapshot-unavailable')
    assert.equal(cancelled.lease, undefined)
    if (attempt < 3) f.now = cancelled.nextAttemptAt
  }
  assert.equal(cancelled.nextAttemptAt, undefined)
  assert.equal(cancelled.cancellation.completedAt, undefined)
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 0, completed: 0 })
  assert.equal(mock.calls.length, 0)
})

test('a same-owner takeover before helper loading fences the obsolete worker before reading its manifest', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  const mock = modelFor(f)
  const get = f.analysis.store.get.bind(f.analysis.store)
  const replace = f.analysis.store.replace.bind(f.analysis.store)
  const read = f.analysis.blobs.read.bind(f.analysis.blobs)
  let leaseWrites = 0
  let takeOverOnRead = false
  let replacement
  let manifestReads = 0
  f.analysis.store.replace = async (record, etag) => {
    const saved = await replace(record, etag)
    if (record.id === created.run.id && record.lease && ++leaseWrites === 2) takeOverOnRead = true
    return saved
  }
  f.analysis.store.get = async (workspaceId, id) => {
    const current = await get(workspaceId, id)
    if (takeOverOnRead && workspaceId === f.workspaceId && id === created.run.id) {
      takeOverOnRead = false
      f.now = new Date(Date.parse(current.record.lease.expiresAt) + 1).toISOString()
      replacement = f.analysis.store.save({
        ...current.record, updatedAt: f.now, attemptId: randomUUID(), attempts: current.record.attempts + 1,
        lease: { owner: current.record.lease.owner, heartbeatAt: f.now, expiresAt: new Date(Date.parse(f.now) + 90000).toISOString() },
      })
      return clone(replacement)
    }
    return current
  }
  f.analysis.blobs.read = async name => {
    if (name === created.run.manifest.blobName) manifestReads++
    return read(name)
  }
  assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
  assert.ok(replacement)
  assert.equal(manifestReads, 0)
  assert.deepEqual(await get(f.workspaceId, created.run.id), replacement)
  assert.equal(replacement.record.progress.initialized, 25)
  assert.equal(mock.calls.length, 0)
})

test('same-owner initializer takeover cannot be overwritten by an obsolete manifest read', async () => {
  const f = fixture()
  const created = await createRun(f, 3, 10)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const mock = modelFor(f)
  let reading = false
  const old = runAnalysisWorker({
    ...mock.deps,
    blobs: {
      ...f.analysis.blobs,
      async read(name) {
        if (name === created.run.manifest.blobName && !reading) { reading = true; await blocked }
        return f.analysis.blobs.read(name)
      },
    },
  }, { maxItems: 1 })
  try {
    await until(() => reading)
    const claimed = await f.analysis.store.get(f.workspaceId, created.run.id)
    f.now = new Date(Date.parse(claimed.record.lease.expiresAt) + 1).toISOString()
    assert.deepEqual(await runAnalysisWorker(mock.deps, { maxItems: 1 }), { claimed: 1, completed: 0 })
    const completed = await f.analysis.store.get(f.workspaceId, created.run.id)
    assert.equal(completed.record.progress.initialized, 30)
    assert.notEqual(completed.record.attemptId, claimed.record.attemptId)
    const records = comparisons(f, created.run.id)
    release()
    assert.deepEqual(await old, { claimed: 1, completed: 0 })
    assert.deepEqual(await f.analysis.store.get(f.workspaceId, created.run.id), completed)
    assert.deepEqual(comparisons(f, created.run.id), records)
    assert.equal(mock.calls.length, 0)
  } finally {
    release()
    await old
  }
})

test('a heartbeat storage outage aborts inference and retains only a safe retryable failure', async t => {
  const f = fixture()
  const created = await createRun(f)
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const mock = modelFor(f, async ({ call }) => { if (call === 1) await blocked })
  const transact = f.analysis.store.transact.bind(f.analysis.store)
  let interrupted = false
  f.analysis.store.transact = async (workspaceId, operations) => {
    if (!interrupted && operations.some(item => item.record.recordType === 'analysis-comparison' &&
      item.record.status === 'running' && item.record.lease.heartbeatAt !== NOW)) {
      interrupted = true
      throw new Error('PRIVATE-STORAGE-SENTINEL https://private.example.test/resume')
    }
    return transact(workspaceId, operations)
  }
  const work = runAnalysisWorker(mock.deps, { maxItems: 1 })
  try {
    await until(() => mock.calls.length === 1)
    f.now = new Date(Date.parse(NOW) + 25000).toISOString()
    t.mock.timers.tick(25000)
    assert.deepEqual(await work, { claimed: 1, completed: 0 })
    assert.equal(interrupted, true)
    assert.equal(mock.calls[0].signal.aborted, true)
    const current = comparisons(f, created.run.id)[0].record
    assert.equal(current.status, 'queued')
    assert.equal(current.error.code, 'storage-error')
    assert.equal(current.error.retryable, true)
    assert.equal(current.lease, undefined)
    assert.doesNotMatch(JSON.stringify(current.error), /PRIVATE-STORAGE|private\.example/)
  } finally {
    release()
    await work
    t.mock.timers.reset()
  }
})

test('time spent reading pending claims cannot start new work beyond the budget', async () => {
  for (const initializing of [false, true]) {
    const f = fixture()
    const created = await createRun(f, initializing ? 3 : 1, initializing ? 10 : 1)
    const mock = modelFor(f)
    const get = f.analysis.store.get.bind(f.analysis.store)
    f.analysis.store.get = async (workspaceId, id) => {
      const value = await get(workspaceId, id)
      f.now = new Date(Date.parse(NOW) + 1000).toISOString()
      return value
    }
    assert.deepEqual(await runAnalysisWorker(mock.deps, { budgetMilliseconds: 1000 }), { claimed: 0, completed: 0 })
    assert.equal((await get(f.workspaceId, created.run.id)).record.lease, undefined)
    assert.equal(mock.calls.length, 0)
  }
})

test('worker options are bounded and an already-aborted worker does not claim work', async () => {
  const f = fixture()
  await createRun(f)
  const mock = modelFor(f)
  for (const options of [
    { maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 }, { pendingLimit: 101 },
    { budgetMilliseconds: 0 }, { budgetMilliseconds: 660001 },
  ]) await assert.rejects(runAnalysisWorker(mock.deps, options), /integer between/)
  const stopping = new AbortController()
  stopping.abort()
  assert.deepEqual(await runAnalysisWorker(mock.deps, { signal: stopping.signal }), { claimed: 0, completed: 0 })
  assert.equal(mock.calls.length, 0)
})

test('the default worker claim budget matches the two-item deployment default', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 3)
  const mock = modelFor(f)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 2, completed: 2 })
  assert.equal(comparisons(f, created.run.id).filter(item => item.record.status === 'queued').length, 1)
  assert.equal(mock.calls.length, 4)
  assert.deepEqual(await runAnalysisWorker(mock.deps), { claimed: 1, completed: 1 })
  assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).record.status, 'complete')
})
