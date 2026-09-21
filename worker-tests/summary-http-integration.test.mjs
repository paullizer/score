import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  allPages, buildResumeAnalysisTestRuntime, importResumePdf, jsonResponse,
  processAllAnalyses, processAllResumes, processingStubs, resumePdf, resumeSelection, startResumeAnalysisFixture,
} from '../src/services/resumeAnalysis.test-support.mjs'
import { seedRealJob } from '../src/services/gradeLadders.test-support.mjs'

test('HTTP-admitted comparisons publish ready summaries through the shared strict persistence fixture', { timeout: 120_000 }, async () => {
  const runtime = await buildResumeAnalysisTestRuntime()
  let fixture
  try {
    fixture = await startResumeAnalysisFixture(runtime)
    const failures = []
    for (const [target, name] of [
      [fixture.analyses.store, 'transact'],
      [fixture.analyses.blobs, 'putImmutable'],
      [fixture.analyses.blobs, 'putFenced'],
    ]) {
      const original = target[name].bind(target)
      target[name] = async (...args) => {
        try { return await original(...args) } catch (error) {
          failures.push({ operation: name, message: error.message, stack: error.stack })
          throw error
        }
      }
    }
    await seedRealJob(fixture)
    for (let index = 0; index < 2; index++) await importResumePdf(fixture, await resumePdf({ name: `summary-${index}.pdf` }))
    const stubs = processingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resumes = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
    const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
    const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Summary persistence regression', resumes: resumes.map(resumeSelection), targets: [targets[0].selection] }),
    }), [202])
    await processAllAnalyses(fixture, stubs)
    const runId = created.run.run.id
    const summaries = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/summaries`))
    assert.equal(summaries.ready, true, JSON.stringify({
      failures,
      narratives: [...fixture.analyses.store.values.values()].filter(({ record }) => record.recordType.includes('narrative'))
        .map(({ record }) => ({ type: record.recordType, status: record.status, error: record.error })),
    }))
    assert.equal(summaries.counts.candidates.ready, 2)
    assert.equal(summaries.counts.targets.ready, 1)
    for (const { record } of fixture.analyses.store.values.values()) {
      if (!record.recordType.endsWith('-narrative')) continue
      assert.equal(record.processingSettings, undefined)
      const blob = await fixture.analyses.blobs.read(record.published.blob.blobName)
      assert.equal(JSON.parse(Buffer.from(blob.bytes).toString('utf8')).processingSettings, undefined)
    }
    assert.deepEqual(failures, [])
  } finally {
    await fixture?.close()
    await runtime.close()
  }
})
