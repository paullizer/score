import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceLifecycleService, WorkspaceRepository, StoreConflictError } from '../dist-server/app.mjs'
import {
  ALLOWED_OID, TENANT_ID, createFakeDirectoryStore, createFakeStateStore, legacyStateBody,
  principalKeyFor,
} from './helpers.mjs'

const timestamp = '2026-09-18T15:00:00.000Z'

function principal() {
  return {
    tenantId: TENANT_ID,
    oid: ALLOWED_OID,
    principalKey: principalKeyFor(TENANT_ID, ALLOWED_OID),
    name: 'Owner',
    email: 'owner@example.test',
    applicationRoles: ['Score.User'],
  }
}

async function fixture(options = {}) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const actor = principal()
  const repository = new WorkspaceRepository({ directory, state, now: () => new Date(timestamp) })
  const workspace = await repository.createWorkspace(actor, 'Lifecycle fixture')
  const calls = []
  const participant = {
    async setState(id, value) { assert.equal(id, workspace.id); calls.push(`setState:${value}`) },
    async cancel(id) { assert.equal(id, workspace.id); calls.push('cancel') },
    async purge(id) { assert.equal(id, workspace.id); calls.push('purge') },
    async counts(id) { assert.equal(id, workspace.id); calls.push('counts'); return options.counts ?? {} },
    async pendingWorkspaces() { return [] },
    async resume() {},
  }
  const service = new WorkspaceLifecycleService({
    repository, directory, state, participants: options.participants ?? [participant],
    lifecycle: options.lifecycle, now: () => new Date(timestamp),
  })
  return { directory, state, actor, workspace, calls, participant, service }
}

test('workspace creation seeds no state document', async () => {
  const { state, workspace } = await fixture()
  assert.equal(await state.getState(workspace.id), undefined)
  assert.deepEqual(state._operations(), ['getState'])
})

test('workspace lifecycle impact is real-only and ignores missing or legacy state blobs', async () => {
  const blockers = [{ kind: 'analysis', id: 'analysis-one', name: 'Retained analysis', href: '/analyses/analysis-one' }]
  const { service, state, actor, workspace } = await fixture({
    counts: { jobs: 2, analyses: 1 },
    lifecycle: { async impact(id, target) {
      assert.equal(id, workspace.id)
      assert.deepEqual(target, { kind: 'workspace', id: workspace.id })
      return blockers
    } },
  })
  state._setRawContent(workspace.id, JSON.stringify({ ...legacyStateBody(), runs: [{ id: 'legacy-sample-run' }] }))
  state._clearOperations()
  const preview = await service.impact(actor, workspace.id)
  assert.deepEqual(preview.impact.counts, { jobs: 2, analyses: 1 })
  assert.deepEqual(preview.impact.blockers, blockers)
  assert.deepEqual(state._operations(), [])

  await state.deleteState(workspace.id)
  state._clearOperations()
  const missing = await service.impact(actor, workspace.id)
  assert.deepEqual(missing.impact.counts, { jobs: 2, analyses: 1 })
  assert.deepEqual(missing.impact.blockers, blockers)
  assert.deepEqual(state._operations(), [])
})

test('analysis counts require real dependency checks before lifecycle management', async () => {
  const { service, actor, workspace } = await fixture({ counts: { analyses: 1 } })
  await assert.rejects(service.impact(actor, workspace.id), error => error.status === 503)
  await assert.rejects(service.change(actor, workspace.id, 'delete', workspace.etag), error => error.status === 503)
})

test('legacy sample runs no longer block deletion and legacy state is removed best-effort', async () => {
  const { service, directory, state, actor, workspace, calls } = await fixture()
  state._setRawContent(workspace.id, JSON.stringify({ ...legacyStateBody(), runs: [{ id: 'legacy-sample-run' }] }))
  const result = await service.change(actor, workspace.id, 'delete', workspace.etag)
  assert.equal(result.deleted, true)
  assert.equal(await state.getState(workspace.id), undefined)
  assert.ok((await directory.getMetadata(workspace.id)).metadata.deletedAt)
  assert.deepEqual(calls, ['counts', 'setState:deleting', 'cancel', 'purge', 'setState:deleted'])
})

test('legacy state cleanup failure is ignored after participants are purged', async t => {
  const { service, directory, state, actor, workspace } = await fixture()
  state._setRawContent(workspace.id, JSON.stringify(legacyStateBody()))
  state.deleteState = async () => { throw new StoreConflictError('Legacy cleanup raced') }
  t.mock.method(console, 'warn', () => {})
  const result = await service.change(actor, workspace.id, 'delete', workspace.etag)
  assert.equal(result.deleted, true)
  assert.ok((await directory.getMetadata(workspace.id)).metadata.deletedAt)
  assert.ok(await state.getState(workspace.id), 'best-effort cleanup failures do not roll back deletion')
})

test('archive and unarchive use directory metadata and participants without reading legacy state', async () => {
  const { service, directory, state, actor, workspace, calls } = await fixture()
  state._clearOperations()
  const archived = await service.change(actor, workspace.id, 'archive', workspace.etag)
  assert.equal(archived.workspace.archivedAt, timestamp)
  assert.equal((await directory.getMetadata(workspace.id)).metadata.archivedAt, timestamp)
  assert.deepEqual(calls, ['setState:archived', 'cancel'])
  assert.deepEqual(state._operations(), ['acquireMutationLease'])

  state._clearOperations()
  calls.length = 0
  const restored = await service.change(actor, workspace.id, 'unarchive', archived.workspace.etag)
  assert.equal(restored.workspace.archivedAt, undefined)
  assert.equal((await directory.getMetadata(workspace.id)).metadata.archivedAt, undefined)
  assert.deepEqual(calls, ['setState:active'])
  assert.deepEqual(state._operations(), ['acquireMutationLease'])
})
