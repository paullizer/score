import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadReportFoundation, realReportFixture } from './test-support.mjs'

const output = resolve(`.report-links-tests-${randomUUID()}`)
let foundation, api
before(async () => {
  await mkdir(output)
  foundation = await loadReportFoundation()
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export * from './src/services/analysisReports/links';
      export * from './src/app/saved-review-navigation';
    ` },
    outfile: join(output, 'links.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
  })
  api = await import(pathToFileURL(join(output, 'links.mjs')).href)
})
after(async () => { await foundation?.cleanup(); await rm(output, { recursive: true, force: true }) })
function real() { return foundation.api.buildAnalysisReport(realReportFixture({ scores: [88] })) }
function first(report) { return report.groups[0].comparisons[0] }

test('real review links use the originating workspace and saved-result route', () => {
  const report = real()
  const links = api.reportReviewLinks(report, first(report), { links: { origin: 'https://score.test/', workspaceId: report.workspaceId } })
  assert.equal(links.analysis, 'https://score.test/workspaces/workspace-one/analyses/run-one?result=comparison-0')
  assert.equal(links.resume, `${links.analysis}&view=resume`)
  assert.equal(links.target, `${links.analysis}&view=target`)
  assert.ok(Object.values(links).every((link) => !link.includes('/analyses/new')))
  assert.deepEqual(api.reportReviewLinks(report, first(report), { links: { origin: 'https://score.test', workspaceId: report.workspaceId } }), links)
})

test('workspace, run and result identities are encoded without changing the saved destination', () => {
  const report = real(), pair = first(report)
  report.workspaceId = 'workspace /雪?&=#%'
  report.run.id = 'run /résumé?&=#%'
  pair.id = 'comparison /Ω?&=#%'
  const url = new URL(api.reportReviewLinks(report, pair, { links: { origin: 'https://score.test:8443', workspaceId: report.workspaceId } }).target)
  assert.equal(url.pathname, `/workspaces/${encodeURIComponent(report.workspaceId)}/analyses/${encodeURIComponent(report.run.id)}`)
  assert.equal(url.searchParams.get('result'), pair.id)
  assert.equal(url.searchParams.get('view'), 'target')
  assert.equal(url.searchParams.get('data'), null)
  assert.equal(url.hash, '')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
})

test('missing or invalid origin configuration is explicit and never fabricates an application host', () => {
  const report = real(), pair = first(report)
  assert.throws(() => api.reportReviewLinks(report, pair), /trusted application origin/)
  assert.throws(() => api.reportReviewLinks(report, pair, {}), /trusted application origin/)
  for (const origin of [
    undefined, '', 'score.test', '//score.test', 'file:///score', 'blob:https://score.test/id',
    'javascript:alert(1)', 'ftp://score.test', 'https://user:secret@score.test', 'https://@score.test',
    'https://score.test/analyses', 'https://score.test//', 'https://score.test/.', 'https://score.test/%2e/',
    'https://score.test?token=secret', 'https://score.test/?', 'https://score.test#source', 'https://score.test/#',
    ' https://score.test', 'https://score.test ', 'https://score.test\\elsewhere', 'https://[invalid',
  ]) assert.throws(() => api.reportReviewLinks(report, pair, { links: { origin, workspaceId: report.workspaceId } }), /valid HTTP\(S\) application origin/, String(origin))
})

test('real workspace mismatches, missing identities, and unrelated comparisons fail closed', () => {
  const report = real(), pair = first(report), options = { links: { origin: 'https://score.test', workspaceId: report.workspaceId } }
  assert.throws(() => api.reportReviewLinks(report, pair, { links: { ...options.links, workspaceId: 'another-workspace' } }), /must match/)
  assert.throws(() => api.reportReviewLinks({ ...report, workspaceId: undefined }, pair, options), /must match/)
  assert.throws(() => api.reportReviewLinks(report, pair, { links: { ...options.links, workspaceId: '' } }), /workspace identity/)
  assert.throws(() => api.reportReviewLinks(report, { ...pair, id: 'unrelated' }, options), /comparison in this saved analysis/)
  for (const value of ['', '.', '..', '\u0000']) {
    assert.throws(() => api.reportReviewLinks({ ...report, run: { ...report.run, id: value } }, pair, options), /identity/)
    assert.throws(() => api.savedReviewPath({ workspaceId: value, runId: 'run', comparisonId: 'pair' }), /identity/)
  }
})

test('only one recognized source view on one selected result is honored', () => {
  assert.equal(api.savedReviewView(new URLSearchParams('data=real&result=pair&view=resume')), 'resume')
  assert.equal(api.savedReviewView(new URLSearchParams(`data=${'samples'}&result=pair&view=target`)), 'target')
  for (const query of [
    '', 'view=resume', 'result=&view=target', 'result=pair', 'result=pair&view=job',
    'result=pair&view=Resume', 'result=pair&view=https://other.test', 'result=pair&view=resume&view=target',
    'result=pair&result=another&view=target',
  ]) assert.equal(api.savedReviewView(new URLSearchParams(query)), null, query)
  assert.throws(() => api.savedReviewPath({ runId: 'run', comparisonId: 'pair' }), /workspace/)
  assert.throws(() => api.savedReviewPath({ workspaceId: 'workspace', runId: 'run', comparisonId: 'pair', view: 'job' }), /resume or target/)
})
