import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { fixtureDeployment, fixtureIdentity, main, privateFixtureDestination, writePrivateGradeFixture } from '../scripts/scoring-grade-fixture.mjs'

const exec = promisify(execFile)
const tenant = '228db43d-371a-49d8-864e-fa202d181ea5'
const oid = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
const now = Date.parse('2026-10-09T00:00:00.000Z')
const env = { COSMOS_ENDPOINT: 'https://score.documents.azure.com', STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net' }
let directory
before(async () => { directory = await mkdtemp(join(tmpdir(), 'score-grade-fixture-')) })
after(async () => { await rm(directory, { recursive: true, force: true }) })

function token(change = {}) {
  const claims = { tid: tenant, oid, aud: 'https://cosmos.azure.com', exp: now / 1000 + 3600, ...change }
  return { token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, expiresOnTimestamp: now + 3600_000 }
}

test('deployment facts target fixed Azure data-plane accounts and separate grade storage', () => {
  const value = fixtureDeployment(env)
  assert.equal(value.cosmos.container, 'workspaces')
  assert.equal(value.grades.container, 'grade-records')
  assert.equal(value.grades.blobContainer, 'grade-sources')
  for (const change of [
    { COSMOS_ENDPOINT: 'http://score.documents.azure.com' },
    { COSMOS_ENDPOINT: 'https://score.documents.azure.com.evil.test' },
    { COSMOS_ENDPOINT: 'https://user:secret@score.documents.azure.com' },
    { STORAGE_ACCOUNT_URL: 'https://score.blob.core.windows.net?token=secret' },
    { GRADE_RECORDS_CONTAINER: 'workspaces' },
    { GRADE_SOURCE_CONTAINER: 'workspace-state' },
    { COSMOS_DATABASE: '../foreign' },
  ]) assert.throws(() => fixtureDeployment({ ...env, ...change }))
})

test('identity comes from a current token for the configured tenant, not caller-supplied roles or object IDs', () => {
  assert.deepEqual(fixtureIdentity(token(), tenant, now), { tenantId: tenant, oid })
  for (const value of [
    token({ tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    token({ tid: 1 }), token({ oid: 'not-an-object-id' }),
    token({ aud: 'https://graph.microsoft.com' }), token({ exp: now / 1000 - 1 }),
    { token: 'not-a-token', expiresOnTimestamp: now + 1000 },
    { ...token(), expiresOnTimestamp: undefined },
  ]) assert.throws(() => fixtureIdentity(value, tenant, now))
})

test('identity accepts only the Cosmos resource URI variants or its first-party application ID', () => {
  for (const aud of [
    'https://cosmos.azure.com', 'https://cosmos.azure.com/',
    'a232010e-820c-4083-83bb-3ace5fc29d0b',
  ]) assert.deepEqual(fixtureIdentity(token({ aud }), tenant, now), { tenantId: tenant, oid })
  for (const aud of [
    'https://graph.microsoft.com', '00000003-0000-0000-c000-000000000000',
    'https://management.azure.com', 'https://storage.azure.com',
    'https://cosmos.azure.com/.default', 'https://graph.microsoft.com/.default',
    'https://cosmos.azure.com.evil.test', 'https://cosmos.windows-ppe.net',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '',
    ['a232010e-820c-4083-83bb-3ace5fc29d0b'], null, 1,
  ]) assert.throws(() => fixtureIdentity(token({ aud }), tenant, now), /current Cosmos token/)
})

test('Cosmos application-ID audience still requires the configured tenant, a valid OID and both expirations', () => {
  const cosmosToken = token({ aud: 'a232010e-820c-4083-83bb-3ace5fc29d0b' })
  for (const change of [
    { tid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { tid: null },
    { oid: 'not-an-object-id' }, { oid: null },
    { exp: now / 1000 }, { exp: now / 1000 - 1 }, { exp: '1791507600' },
  ]) {
    assert.throws(() => fixtureIdentity(token({ aud: 'a232010e-820c-4083-83bb-3ace5fc29d0b', ...change }), tenant, now),
      /current Cosmos token/)
  }
  for (const expiresOnTimestamp of [now, now - 1, undefined, NaN, Infinity, String(now + 3600_000)]) {
    assert.throws(() => fixtureIdentity({ ...cosmosToken, expiresOnTimestamp }, tenant, now), /current Cosmos token/)
  }
})

test('private output paths refuse both this checkout and other Git repositories', async () => {
  await assert.rejects(privateFixtureDestination(resolve('private-grade-fixture.json')), /outside every Git checkout/)
  const other = join(directory, 'other-repo')
  await mkdir(other)
  await exec('git', ['init', '--quiet', other])
  await assert.rejects(privateFixtureDestination(join(other, 'nested', 'fixture.json')), /outside every Git checkout/)
})

test('repository-discovery failures and environment overrides cannot turn a checkout into a private destination', async () => {
  const prior = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = resolve('.')
  try { await assert.rejects(privateFixtureDestination(resolve('nested-private', 'fixture.json')), /outside every Git checkout/) }
  finally {
    if (prior === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = prior
  }
  const broken = join(directory, 'broken-checkout')
  await mkdir(broken)
  await writeFile(join(broken, '.git'), 'gitdir: does-not-exist\n')
  await assert.rejects(privateFixtureDestination(join(broken, 'fixture.json')), /Git could not verify/)
})

test('private fixture files are complete, immutable, hashed for the harness and leave no temporary output', async () => {
  const output = join(directory, 'captures', 'fixture.json')
  const fixture = { ladder: { id: 'ladder-one' }, seed: { captured: true }, sourceSet: { id: 'source-set-one' }, documents: [] }
  const result = await writePrivateGradeFixture(output, fixture)
  assert.equal(result.fixtureSha256, createHash('sha256').update(JSON.stringify(fixture)).digest('hex'))
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), fixture)
  const original = await readFile(output)
  await assert.rejects(writePrivateGradeFixture(output, { ...fixture, documents: [{ changed: true }] }), error => error.code === 'EEXIST')
  assert.deepEqual(await readFile(output), original)
  assert.deepEqual(await readdir(join(directory, 'captures')), ['fixture.json'])
})

test('CLI usage errors do not read cloud data, acquire credentials or admit paid work', async () => {
  await assert.rejects(main([]), /Provide one workspace/)
  await assert.rejects(main(['workspace', 'ladder', resolve('fixture.json')]), /outside every Git checkout/)
})
