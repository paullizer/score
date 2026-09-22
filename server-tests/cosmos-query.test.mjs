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
const { fetchCosmosPage, fetchCosmosCount } = module.exports

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

test('aggregate counts require one finite safe nonnegative integer, including an explicit zero', async () => {
  for (const count of [0, 137, Number.MAX_SAFE_INTEGER]) {
    const source = iterator([{ resources: [count], hasMoreResults: false }])
    assert.equal(await fetchCosmosCount(source), count)
    assert.equal(source.calls(), 1)
  }
})

test('aggregate counts consume progress-only and empty continuation pages on the same iterator', async () => {
  const source = iterator([
    { resources: undefined, hasMoreResults: true },
    { resources: [], hasMoreResults: true },
    { resources: [], hasMoreResults: true, continuationToken: 'first' },
    { resources: undefined, hasMoreResults: true, continuationToken: 'second' },
    { resources: [137], hasMoreResults: false },
  ])
  assert.equal(await fetchCosmosCount(source), 137)
  assert.equal(source.calls(), 5)
})

test('aggregate counts never substitute zero for missing, malformed, partial or ambiguous output', async () => {
  const values = [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '12', null, {}, [], true]
  const pages = [
    ...values.map(value => ({ resources: [value], hasMoreResults: false })),
    { resources: [] }, { resources: undefined, hasMoreResults: false },
    { resources: null }, { resources: {} }, { resources: 12 },
    { resources: [1, 2] }, { resources: [12], hasMoreResults: true },
    { resources: [12], continuationToken: 'partial' },
    { resources: [12], hasMoreResults: false, continuationToken: 'contradictory' },
    { resources: [12], hasMoreResults: 'false' }, { resources: [12], continuationToken: {} },
    { resources: [], hasMoreResults: true, continuationToken: 'a'.repeat(16 * 1024 + 1) },
  ]
  for (const page of pages) await assert.rejects(fetchCosmosCount(iterator([page])), /Cosmos returned/)
  const error = new Error('A controlled aggregate storage failure')
  await assert.rejects(fetchCosmosCount(iterator([error])), value => value === error)
})

test('aggregate progress is bounded and repeated continuation tokens cannot produce a count', async () => {
  for (const resources of [[], undefined]) {
    const source = iterator([
      { resources, hasMoreResults: true, continuationToken: 'repeat' },
      { resources, hasMoreResults: true, continuationToken: 'repeat' },
    ])
    await assert.rejects(fetchCosmosCount(source), /continuation did not advance/)
    assert.equal(source.calls(), 2)
  }
  let calls = 0
  await assert.rejects(fetchCosmosCount({
    async fetchNext() { calls++; return { resources: [], hasMoreResults: true } },
  }), /progress-page limit/)
  assert.equal(calls, 100)
})
