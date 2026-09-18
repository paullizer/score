import assert from 'node:assert/strict'
import test from 'node:test'
import { applySampleLifecycle, createAnalysisRun, createLifecycleDependencies } from '../dist-server/app.mjs'
import { authHeaders, sampleWorkspaceBody, startTestServer } from './helpers.mjs'

test('blocker discovery includes archived analyses that captured historical rubric versions', async t => {
  const server = await startTestServer()
  t.after(() => server.close())
  const response = await fetch(`${server.baseUrl}/api/session`, { headers: authHeaders() })
  const id = (await response.json()).workspaces[0].id
  const workspace = JSON.parse((await server.state.getState(id)).content)
  const rubric = workspace.rubrics.find(item => item.kind === 'job' && workspace.jobs.some(job => job.rubricId === item.id && job.status === 'ready'))
  const run = createAnalysisRun(workspace, [workspace.resumes[0].id], [rubric.id], 'Historical input')
  let next = { ...workspace, runs: [run] }
  next = applySampleLifecycle(next, { kind: 'analysis', id: run.id }, 'archive', '2026-09-18T15:00:00.000Z')
  const revised = { ...rubric, id: `${rubric.id}-next`, version: rubric.version + 1 }
  next.rubrics = [...next.rubrics, revised]
  next.jobs = next.jobs.map(job => job.id === rubric.jobId ? { ...job, rubricId: revised.id } : job)
  server.state._setRawContent(id, JSON.stringify(next))
  const dependencies = createLifecycleDependencies(server.state)
  const blockers = await dependencies.impact(id, { kind: 'rubric', id: revised.id })
  assert.deepEqual(blockers.map(item => item.id), [run.id])
  assert.equal(blockers[0].href, `/analyses/${run.id}`)
  assert.equal((await dependencies.impact(id, { kind: 'job', id: rubric.jobId })).length, 1)
  assert.equal((await dependencies.impact(id, { kind: 'resume', id: run.resumes[0].resume.id })).length, 1)
})

test('seed blockers traverse every ladder page and resolve historical real rubric group identity', async () => {
  const state = { async getState() { return { content: JSON.stringify(sampleWorkspaceBody()), etag: '"state"' } } }
  const old = { id: 'old-version-id', groupId: 'stable-group', version: 1 }
  const current = { id: 'new-version-id', groupId: 'stable-group', version: 2 }
  const pages = []
  const jobs = { store: {
    async getRubric(_workspaceId, id) { return id === current.id ? current : undefined },
    async listRubrics(_workspaceId, id) { return id === 'seed-job' ? [old, current] : [] },
  } }
  const grades = { store: {
    async list(workspaceId, options) {
      pages.push(options.continuationToken)
      const page = Number(options.continuationToken ?? 0)
      return {
        items: [{ record: {
          recordType: 'grade-ladder', workspaceId, id: `ladder-${page}`, name: `Ladder ${page}`,
          seedJobId: page === 2 ? 'seed-job' : 'another-job', seedRubricId: old.id, seedRubricVersion: 1,
          lifecycle: { archivedAt: '2026-09-18T15:00:00.000Z' },
        }, etag: '"ladder"' }],
        ...(page < 2 ? { continuationToken: String(page + 1) } : {}),
      }
    },
  } }
  const dependencies = createLifecycleDependencies(state, jobs, grades, true)
  const blockers = await dependencies.impact('workspace-one', { kind: 'rubric', id: current.id })
  assert.deepEqual(pages, [undefined, '1', '2'])
  assert.deepEqual(blockers.map(item => item.id), ['ladder-2'])
  assert.equal(blockers[0].kind, 'ladder')
})

test('unavailable dependency storage and repeated pagination tokens fail closed', async () => {
  const state = { async getState() { return { content: JSON.stringify(sampleWorkspaceBody()), etag: '"state"' } } }
  await assert.rejects(createLifecycleDependencies(state, undefined, undefined, true).impact('workspace-one', { kind: 'job', id: 'seed' }), /could not be checked/)
  await assert.rejects(createLifecycleDependencies({ async getState() {} }).impact('workspace-one', { kind: 'job', id: 'seed' }), /could not be checked/)
  const grades = { store: { async list() { return { items: [], continuationToken: 'same' } } } }
  await assert.rejects(createLifecycleDependencies(state, undefined, grades).impact('workspace-one', { kind: 'job', id: 'seed' }), /did not advance/)
})
