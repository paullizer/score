import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { seedRealJob } from './gradeLadders.test-support.mjs'
import {
  allPages, buildResumeAnalysisTestRuntime, importResumePdf, jsonResponse, processAllAnalyses,
  processAllResumes, processingStubs, resumePdf, resumeSelection, startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'

const output = resolve(`.summary-http-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
let runtime, client
before(async () => {
  await mkdir(output)
  const built = await Promise.all([
    buildResumeAnalysisTestRuntime(),
    build({ entryPoints: [join('src', 'services', 'realAnalyses.ts')], outfile: join(output, 'client.mjs'),
      bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent',
      define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' } }),
  ])
  runtime = built[0]
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
after(async () => {
  globalThis.fetch = originalFetch
  await runtime?.close()
  await rm(output, { recursive: true, force: true })
})

test('frontend summary services consume actual authorized API envelopes and retry exact requests without rescoring', { timeout: 120_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime)
  t.after(async () => { globalThis.fetch = originalFetch; await fixture.close() })
  await seedRealJob(fixture)
  await importResumePdf(fixture, await resumePdf())
  const stubs = processingStubs(fixture, {
    onModelRequest(request) {
      if (request.response_format.json_schema.name !== 'resume_rubric_assessment') return
      const { input } = JSON.parse(request.messages[1].content)
      const passages = input.resume.paragraphs.flatMap((paragraph) => paragraph.passages ?? [])
      if (!passages.length) return
      const work = passages.find((passage) => passage.text.includes('Applied engineering methods independently'))
      assert.ok(work?.passageId, 'The client integration uses exact frozen assessment passages.')
      const assessment = {
        criteria: input.rubric.criteria.map((criterion) => ({
          criterionId: criterion.id, evidenceStatus: 'supported', score: 3,
          rationale: 'The frozen passage documents independent engineering work within defined projects.',
          citations: [{ passageId: work.passageId }], limitation: null,
        })),
        qualifications: [],
      }
      return Response.json({ model: 'gpt-5-mini-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }] })
    },
  })
  await processAllResumes(fixture, stubs)
  const resumes = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
  const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
  const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ name: 'Summary client integration', resumes: resumes.map(resumeSelection), targets: [targets[0].selection] }),
  }), [202])
  const runId = created.run.run.id
  const requests = []
  let foundationFeatures
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      requests.push({ url, init })
      const response = await fixture.request(url, init)
      if (url === '/api/features') foundationFeatures = await response.clone().json()
      return response
    }
    return originalFetch(url, init)
  }
  const initialRecords = fixture.analyses.store.values.size
  const initialModelCalls = stubs.modelCalls.length
  const initializing = await client.getRealAnalysisSummaries(fixture.workspaceId, runId)
  assert.equal(initializing.ready, false)
  assert.equal(initializing.scoring.total, 1)
  assert.ok(initializing.scoring.initialized <= initializing.scoring.total)
  assert.equal(initializing.scoring.queued, 1)
  const initialTarget = await client.getRealAnalysisSummaries(fixture.workspaceId, runId, { targetId: initializing.targets[0].targetId })
  assert.equal(initialTarget.scoring.initialized, initializing.scoring.initialized)
  assert.equal(initialTarget.scoring.queued, 1)
  assert.equal(initialTarget.capture.comparisons.length, 1)
  assert.equal(fixture.analyses.store.values.size, initialRecords, 'Reading pending scoring status does not materialize or enqueue work.')
  assert.equal(stubs.modelCalls.length, initialModelCalls)
  await processAllAnalyses(fixture, stubs)
  assert.equal((await client.fetchAnalysisProcessingFeatures()).analysisSummaryGeneration, true,
    `GET /features exposes the canonical independent summary-generation capability: ${JSON.stringify(foundationFeatures)}`)
  const detail = await client.getRealAnalysis(fixture.workspaceId, runId)
  const comparisons = await client.listAllRealAnalysisComparisons(fixture.workspaceId, runId)
  assert.equal(comparisons.length, 1)
  assert.equal(comparisons[0].comparison.status, 'complete', JSON.stringify(comparisons[0].comparison.error))
  const frozen = await client.getRealAnalysisComparison(fixture.workspaceId, runId, comparisons[0].comparison.id)
  const modelCalls = stubs.modelCalls.length
  const recordCount = fixture.analyses.store.values.size
  const whole = await client.getRealAnalysisSummaries(fixture.workspaceId, runId)
  assert.equal(whole.scope.targetId, null)
  const targetId = detail.targets[0].id
  const selected = await client.getRealAnalysisSummaries(fixture.workspaceId, runId, { targetId })
  assert.equal(selected.capture.scope.targetId, targetId)
  assert.equal(selected.scoring.complete, 1)
  assert.equal(fixture.analyses.store.values.size, recordCount, 'Summary GET never enqueues work.')
  assert.equal(stubs.modelCalls.length, modelCalls)
  const key = randomUUID()
  const result = await client.generateRealAnalysisSummaries(fixture.workspaceId, runId, { mode: 'missing', targetId }, selected.etag, key)
  assert.equal(result.requestId, key)
  const repeated = await client.generateRealAnalysisSummaries(fixture.workspaceId, runId, { mode: 'missing', targetId }, selected.etag, key)
  assert.equal(repeated.requestId, key)
  assert.equal(stubs.modelCalls.length, modelCalls, 'HTTP generation requests schedule durable narrative work, not scoring or inline inference.')
  const unchanged = await client.getRealAnalysisComparison(fixture.workspaceId, runId, comparisons[0].comparison.id)
  assert.deepEqual(unchanged.comparison, frozen.comparison)
  assert.deepEqual(unchanged.result, frozen.result)
  assert.deepEqual(unchanged.resumeSnapshot, frozen.resumeSnapshot)
  assert.deepEqual(unchanged.targetSnapshot, frozen.targetSnapshot)
  assert.equal(unchanged.etag, frozen.etag)
  assert.ok(requests.filter((request) => request.init.method === 'POST').every((request) => request.url.endsWith('/summaries')))
})
