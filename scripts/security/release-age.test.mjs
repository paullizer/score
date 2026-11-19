import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicationStatus, releaseAgeDays, verifyNpmReleaseAges } from './lib/release-age.mjs'
import { verifyNpmInstallation } from '../verify-installations.mjs'

const now = new Date('2026-11-19T12:00:00Z')

test('requires fourteen complete days, including the exact boundary', () => {
  assert.equal(publicationStatus('2026-11-05T12:00:00Z', now), 'old')
  assert.equal(publicationStatus('2026-11-05T12:00:00.001Z', now), 'fresh')
  assert.equal(publicationStatus('2026-11-05T11:59:59Z', now), 'old')
  for (const date of [undefined, null, '', 'not-a-date', '2026-11-01', '2026-02-31T00:00:00Z', 0]) {
    assert.equal(publicationStatus(date, now), 'unverified')
  }
  for (const days of [0, -1, 7, 13.99, NaN, Infinity, 'invalid']) assert.throws(() => releaseAgeDays(days), /at least 14/)
})

test('approved mirror metadata still has to meet the full age policy after a transport failure', async () => {
  const calls = []
  const results = await verifyNpmReleaseAges({
    candidates: [{ name: '@scope/example', version: '1.0.0' }], now,
    fetchImpl: async url => {
      calls.push(url)
      if (url.startsWith('https://registry.npmjs.org/')) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ time: { '1.0.0': '2026-11-18T00:00:00Z' } }))
    },
  })
  assert.equal(results[0].status, 'fresh')
  assert.equal(calls[1], 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/@scope%2Fexample')
})

test('registry failures and malformed publication metadata never qualify', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline') },
    async () => new Response('{}', { status: 503 }),
    async () => new Response(JSON.stringify({ time: { '1.0.0': 'invalid' } })),
  ]) {
    const results = await verifyNpmReleaseAges({ candidates: [{ name: 'example', version: '1.0.0' }], now, fetchImpl })
    assert.equal(results[0].status, 'unverified')
  }
})

test('preinstallation checks unchanged and transitive artifacts and rejects missing integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'score-installation-'))
  const direct = { version: '1.0.0', resolved: 'https://registry.npmjs.org/direct/-/direct-1.0.0.tgz', integrity: 'sha512-fixture' }
  const transitive = { ...direct, resolved: 'https://registry.npmjs.org/transitive/-/transitive-1.0.0.tgz' }
  const manifest = { dependencies: { direct: '1.0.0' } }
  const lock = { lockfileVersion: 3, packages: { '': manifest, 'node_modules/direct': direct, 'node_modules/transitive': transitive } }
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    return new Response(JSON.stringify({ time: { '1.0.0': url.endsWith('/direct') ? '2026-01-01T00:00:00Z' : '2026-11-18T00:00:00Z' } }))
  }
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
    await assert.rejects(verifyNpmInstallation({ root, fetchImpl, now }), /transitive@1.0.0 was published less than 14 days/)
    assert.equal(calls.length, 2)
    delete transitive.integrity
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
    await assert.rejects(verifyNpmInstallation({ root, fetchImpl, now }), /missing an integrity hash/)
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { direct: '^1.0.0' } }))
    await assert.rejects(verifyNpmInstallation({ root, fetchImpl, now }), /disagree/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
