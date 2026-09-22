import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, createRun, publishResult, startHttp } from './real-analyses.test-support.mjs'

test('reviewers read frozen evidence without production writes, correction access, private summary drafts, or implicit export permission', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 1)
  const comparison = [...f.analysis.store.values.values()].find(item => item.record.recordType === 'analysis-comparison')
  await publishResult(f, created.run.id, comparison.record.id)
  const http = await startHttp(f)
  const root = `/${created.run.id}`
  const pair = `${root}/comparisons/${comparison.record.id}`
  const opts = { role: 'reviewer' }
  try {
    for (const suffix of ['', '/targets', root, `${root}/comparisons`, pair, `${pair}/diagnostics`]) {
      const response = await http.request(suffix, 'GET', undefined, opts)
      assert.equal(response.status, 200, `${suffix}: ${await response.clone().text()}`)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
    }
    const detail = await (await http.request(pair, 'GET', undefined, opts)).json()
    assert.ok(detail.result.criteria.length)
    assert.ok(detail.resumeSnapshot.document.paragraphs.length)
    assert.ok(detail.targetSnapshot.rubric.criteria.length)
    const evidence = await http.request(`${pair}/documents/${detail.resumeSnapshot.document.id}?version=${detail.resumeSnapshot.document.version}`, 'GET', undefined, opts)
    assert.equal(evidence.status, 200)
    assert.deepEqual((await evidence.json()).document, detail.resumeSnapshot.document)
    const summaries = await http.request(`${root}/summaries`, 'GET', undefined, opts)
    assert.equal(summaries.status, 200)
    assert.deepEqual((await summaries.json()).capabilities, { canGenerate: false, reason: 'read-only' })

    for (const suffix of [
      `${root}/report-capture?format=csv`, `${root}/report-comparisons?comparisonId=${comparison.record.id}`,
      `${root}/summaries/candidate/${comparison.record.id}/history`,
      `${root}/summaries/candidate/${comparison.record.id}?resultRevisionId=original`,
      `${pair}/corrections`, `${pair}/corrections/history`, `${pair}/corrections/preview`,
    ]) assert.equal((await http.request(suffix, 'GET', undefined, opts)).status, 403, suffix)
    for (const suffix of ['', `${root}/retry`, `${root}/cancel`, `${root}/summaries`, `${pair}/corrections`, `${pair}/corrections/cancel`]) {
      assert.equal((await http.request(suffix, 'POST', {}, opts)).status, 403, suffix)
    }
    assert.equal(f.mutationLeases.acquired, 0, 'Read-only reviewer requests never enter a production mutation lease')
  } finally { await http.close() }
})
