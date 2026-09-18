import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: ['server\\cosmos-query.ts'], bundle: true, write: false,
  packages: 'external', platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
)
const { fetchCosmosPage } = module.exports

function iterator(pages) {
  let index = 0
  return {
    calls: () => index,
    async fetchNext() {
      assert.ok(index < pages.length, 'The same iterator must not read past its terminal page.')
      const page = pages[index++]
      if (page instanceof Error) throw page
      return page
    },
  }
}

test('empty ordered queries consume progress responses before returning an exhausted page', async () => {
  const source = iterator([
    { resources: undefined, hasMoreResults: true },
    { resources: undefined, hasMoreResults: false },
  ])
  assert.deepEqual(await fetchCosmosPage(source), { resources: [] })
  assert.equal(source.calls(), 2)
})

test('progress-only responses cannot hide subsequent records or their continuation token', async () => {
  const source = iterator([
    { resources: undefined, hasMoreResults: true },
    { resources: [], hasMoreResults: true },
    { resources: [{ id: 'actual-record' }], hasMoreResults: true, continuationToken: 'next-page' },
  ])
  assert.deepEqual(await fetchCosmosPage(source), { resources: [{ id: 'actual-record' }], continuationToken: 'next-page' })
  assert.equal(source.calls(), 3)
})

test('ordinary empty pages and resumable filtered pages retain their existing semantics', async () => {
  assert.deepEqual(await fetchCosmosPage(iterator([{ resources: [], hasMoreResults: false }])), { resources: [] })
  const resumable = iterator([{ resources: [], hasMoreResults: true, continuationToken: 'next-partition' }])
  assert.deepEqual(await fetchCosmosPage(resumable), { resources: [], continuationToken: 'next-partition' })
  assert.equal(resumable.calls(), 1)
})

test('malformed query responses and service errors are not disguised as empty libraries', async () => {
  for (const page of [
    { resources: null, hasMoreResults: false },
    { resources: {}, hasMoreResults: false },
    { resources: undefined },
    { resources: undefined, hasMoreResults: false, continuationToken: 'contradictory' },
  ]) await assert.rejects(fetchCosmosPage(iterator([page])), /Cosmos returned/)
  const failure = new Error('Controlled service failure')
  await assert.rejects(fetchCosmosPage(iterator([failure])), (error) => error === failure)
})

test('a query that never advances fails explicitly at its bounded progress limit', async () => {
  let calls = 0
  await assert.rejects(fetchCosmosPage({
    async fetchNext() { calls++; return { resources: undefined, hasMoreResults: true } },
  }), /progress-page limit/)
  assert.equal(calls, 100)
})
