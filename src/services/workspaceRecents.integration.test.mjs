import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.workspace-recents-tests-${randomUUID()}`)
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalWarn = console.warn
const storage = new Map()
const key = (tenant = 'tenant', user = 'user') => `score-cloud-recent-workspaces:${tenant}:${user}`
let recents, warnings

before(async () => {
  await mkdir(output)
  await build({
    entryPoints: ['src/services/workspaceRecents.ts'], outfile: join(output, 'recents.mjs'),
    bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent',
    define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  recents = await import(pathToFileURL(join(output, 'recents.mjs')).href)
})
beforeEach(() => {
  storage.clear(); warnings = []
  console.warn = (...args) => warnings.push(args)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => storage.set(name, value),
  } })
})
after(async () => {
  console.warn = originalWarn
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else delete globalThis.localStorage
  await rm(output, { recursive: true, force: true })
})

test('old selection seeds an untimed preference without pretending a home visit opened it', () => {
  storage.set('score-cloud-last-workspace:tenant:user', 'workspace-one')
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'user'), [{ id: 'workspace-one', lastOpenedAt: null }])
  assert.equal(storage.has(key()), false)
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'another-user'), [])
  assert.deepEqual(recents.readRecentWorkspaces('another-tenant', 'user'), [])
})

test('visits are newest first, deduplicated, bounded, and persist only IDs and times', () => {
  let entries = []
  for (let index = 0; index < 15; index++) entries = recents.recordWorkspaceVisit(entries, `workspace-${index}`, new Date(1_700_000_000_000 + index * 1000).toISOString())
  assert.equal(entries.length, 10)
  assert.equal(entries[0].id, 'workspace-14')
  entries = recents.recordWorkspaceVisit(entries, 'workspace-7', '2026-01-01T00:00:00.000Z')
  assert.equal(entries[0].id, 'workspace-7')
  assert.equal(entries.filter((entry) => entry.id === 'workspace-7').length, 1)
  recents.writeRecentWorkspaces('tenant', 'user', entries.map((entry) => ({ ...entry, name: 'PRIVATE NAME', count: 99 })))
  assert.doesNotMatch(storage.get(key()), /PRIVATE NAME|count/)
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'user'), entries)
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'other'), [])
})

test('successful directory pruning removes only unavailable IDs, while archived visits remain recoverable', () => {
  const entries = [
    { id: 'active', lastOpenedAt: '2026-01-03T00:00:00.000Z' },
    { id: 'archived', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'deleted', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'inaccessible', lastOpenedAt: null },
  ]
  const directory = [{ id: 'active' }, { id: 'archived', archivedAt: '2026-01-03' }, { id: 'deleted', deletedAt: '2026-01-03' }]
  assert.deepEqual(recents.pruneRecentWorkspaces(entries, directory).map((entry) => entry.id), ['active', 'archived'])
  assert.equal(recents.isActiveWorkspace(directory[0]), true)
  assert.equal(recents.isActiveWorkspace(directory[1]), false)
  assert.equal(recents.isActiveWorkspace(directory[2]), false)
  assert.equal(recents.isActiveWorkspace({ id: 'pending', lifecycleOperation: { status: 'running' } }), false)
})

test('malformed and invalid preferences are reported, not used as navigation or content', () => {
  for (const raw of ['invalid json', '{"version":2,"entries":[]}', 'x'.repeat(17000)]) {
    storage.set(key(), raw)
    assert.deepEqual(recents.readRecentWorkspaces('tenant', 'user'), [])
  }
  storage.set(key(), JSON.stringify({ version: 1, entries: [
    { id: 'valid', lastOpenedAt: null },
    { id: 'valid', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'bad/time', lastOpenedAt: null },
    { id: 'bad-date', lastOpenedAt: 'not a date' },
  ] }))
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'user'), [{ id: 'valid', lastOpenedAt: '2026-01-01T00:00:00.000Z' }])
  assert.equal(warnings.length, 4)
})

test('blocked storage leaves in-memory recents usable and surfaces preference warnings', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError') } })
  assert.deepEqual(recents.readRecentWorkspaces('tenant', 'user'), [])
  const entries = recents.recordWorkspaceVisit([], 'workspace-one', '2026-01-01T00:00:00.000Z')
  recents.writeRecentWorkspaces('tenant', 'user', entries)
  assert.equal(entries.length, 1)
  assert.equal(warnings.length, 2)
})
