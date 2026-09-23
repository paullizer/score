import assert from 'node:assert/strict'
import test from 'node:test'
import { createLifecycleDependencies } from '../dist-server/app.mjs'
import { legacyStateBody } from './helpers.mjs'

test('seed blockers traverse every ladder page and resolve historical real rubric group identity', async () => {
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
  const dependencies = createLifecycleDependencies(jobs, grades, true)
  const blockers = await dependencies.impact('workspace-one', { kind: 'rubric', id: current.id })
  assert.deepEqual(pages, [undefined, '1', '2'])
  assert.deepEqual(blockers.map(item => item.id), ['ladder-2'])
  assert.equal(blockers[0].kind, 'ladder')
})

test('unavailable real dependency storage and repeated pagination tokens fail closed', async () => {
  await assert.rejects(createLifecycleDependencies(undefined, undefined, true).impact('workspace-one', { kind: 'job', id: 'seed' }), /could not be checked/)
  await assert.rejects(createLifecycleDependencies(undefined, undefined, false, undefined, true).impact('workspace-one', { kind: 'analysis', id: 'analysis' }), /could not be checked/)
  const grades = { store: { async list() { return { items: [], continuationToken: 'same' } } } }
  await assert.rejects(createLifecycleDependencies(undefined, grades).impact('workspace-one', { kind: 'job', id: 'seed' }), /did not advance/)
})

test('legacy state blobs with sample runs are irrelevant to lifecycle dependencies', async () => {
  const state = {
    async getState() { assert.fail('Lifecycle dependencies must not read legacy state.json') },
  }
  const dependencies = createLifecycleDependencies()
  const blockers = await dependencies.impact('workspace-one', { kind: 'job', id: 'seed-job' })
  assert.deepEqual(blockers, [])
  assert.ok({ ...legacyStateBody(), runs: [{ id: 'legacy-sample-run' }] })
  assert.equal(typeof state.getState, 'function')
})
