import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { buildGradeTestRuntime, seededLadder, startGradeFixture, tenantId, userId } from '../src/services/gradeLadders.test-support.mjs'

let runtime
before(async () => {
  runtime = await buildGradeTestRuntime({ serverExports: `
    export { evaluationHash } from './worker/evals/statistics.ts'
    export { validateGradeGenerationFixture } from './worker/evals/grade-generation.ts'
  ` })
})
after(async () => { await runtime?.close() })

function principal(api, oid = userId) {
  return { tenantId, oid, principalKey: api.principalKeyFor(tenantId, oid), name: 'Fixture owner', email: '', applicationRoles: [] }
}

function capture(fixture, ladderId, caller = principal(fixture.api)) {
  const repository = new fixture.api.WorkspaceRepository({ directory: fixture.directory, state: fixture.state })
  return fixture.api.captureGradeGenerationFixture(repository, fixture.grades, caller, fixture.workspaceId, ladderId)
}

test('owner fixture capture uses the exact frozen seed and references without reading live jobs or writing application state', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const seeded = await seededLadder(fixture)
  fixture.jobs.records.clear()
  fixture.jobs.rubrics.clear()
  const before = JSON.stringify([...fixture.grades.store.values, ...fixture.grades.blobs.values])
  const output = await capture(fixture, seeded.detail.ladder.id)
  assert.equal(output.sourceSet.id, seeded.detail.sourceSet.id)
  assert.equal(output.seed.rubric.version, seeded.seed.latestRubric.version)
  assert.equal(output.documents.length, seeded.detail.sourceSet.sources.length)
  assert.ok(output.documents.some(document => document.id === seeded.document.id))
  const source = { id: 'private-grade-fixture', fixtureSha256: fixture.api.evaluationHash(output), grades: output.sourceSet.grades }
  assert.deepEqual(fixture.api.validateGradeGenerationFixture(source, output), output, 'The result is a real harness input, not a proxy summary')
  assert.equal(JSON.stringify([...fixture.grades.store.values, ...fixture.grades.blobs.values]), before)
})

for (const role of ['editor', 'viewer', 'reviewer']) {
  test(`${role} cannot export private grade fixtures even with access to the storage adapter`, async t => {
    const fixture = await startGradeFixture(runtime)
    t.after(() => fixture.close())
    const { detail } = await seededLadder(fixture)
    fixture.setRole(role)
    fixture.grades.blobs.read = async () => assert.fail('Unauthorized fixture export reached private source bytes')
    await assert.rejects(capture(fixture, detail.ladder.id), error => error.status === 403)
  })
}

test('non-members cannot export another workspace’s grade fixtures', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  await assert.rejects(capture(fixture, detail.ladder.id, principal(fixture.api, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
    error => error.status === 404)
})

test('a stale confirmed source revision is refused rather than substituting newer live source data', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const current = await fixture.grades.store.get(fixture.workspaceId, detail.ladder.id)
  await fixture.grades.store.replace({ ...current.record, sourceRevision: current.record.sourceRevision + 1 }, current.etag)
  await assert.rejects(capture(fixture, detail.ladder.id), error => error.status === 409)
})

test('a missing captured seed never falls back to a live job or rubric', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  fixture.grades.blobs.values.delete(detail.ladder.seedBlobName)
  await assert.rejects(capture(fixture, detail.ladder.id), /captured ladder seed is unavailable/i)
})

test('corrupt reference bytes are an integrity failure rather than a successful incomplete export', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const name = detail.sourceSet.sources.find(source => source.origin !== 'seed-job').documentBlobName
  fixture.grades.blobs.values.get(name).bytes = Buffer.from('{"changed":true}')
  await assert.rejects(capture(fixture, detail.ladder.id), /invalid content metadata/)
})

test('a ladder mutation during capture invalidates the exported fixture', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const read = fixture.grades.blobs.read.bind(fixture.grades.blobs)
  let changed = false
  fixture.grades.blobs.read = async name => {
    const value = await read(name)
    if (!changed) {
      changed = true
      const current = await fixture.grades.store.get(fixture.workspaceId, detail.ladder.id)
      await fixture.grades.store.replace({ ...current.record, name: 'Changed during export' }, current.etag)
    }
    return value
  }
  await assert.rejects(capture(fixture, detail.ladder.id), /changed while its fixture was being captured/)
})

test('ownership revoked during capture is checked again before private data is returned', async t => {
  const fixture = await startGradeFixture(runtime)
  t.after(() => fixture.close())
  const { detail } = await seededLadder(fixture)
  const read = fixture.grades.blobs.read.bind(fixture.grades.blobs)
  fixture.grades.blobs.read = async name => {
    const value = await read(name)
    fixture.setRole('viewer')
    return value
  }
  await assert.rejects(capture(fixture, detail.ladder.id), error => error.status === 403)
})
