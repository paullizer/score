import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import React, { act } from 'react'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const output = resolve(`.entity-name-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
const originals = new Map()
let api, dom, createRoot, root, engine
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { useWorkspaceEngine } from './src/app/useWorkspaceEngine';
      export { projectRealJobs } from './src/app/realJobsProjection';
      export { createInitialWorkspace } from './src/data/fixtures';
      export { createAnalysisRun } from './src/services/mockWorkspace';
      export { evaluateComparison } from './src/services/scoring';
      export { renameRealAnalysis } from './src/services/realAnalyses';
      export { renameRealJob } from './src/services/realJobs';
      export { renameRealResume } from './src/services/realResumes';
    ` },
    outfile: join(output, 'names.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"' },
  })
  api = await import(pathToFileURL(join(output, 'names.mjs')).href)
})
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null }
  globalThis.fetch = originalFetch
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

async function mount(initial, persist) {
  function Host() { engine = api.useWorkspaceEngine(initial, persist); return null }
  root = createRoot(document.getElementById('root'))
  await act(async () => root.render(React.createElement(Host)))
}

test('sample renames persist only display metadata and never rewrite captured evidence or scores', async () => {
  const initial = api.createInitialWorkspace()
  const before = structuredClone(initial)
  const saves = []
  await mount(initial, next => { saves.push(structuredClone(next)); return 'saved' })
  const run = initial.runs[0], job = initial.jobs.find(item => item.status === 'ready'), resume = initial.resumes[0]
  await act(async () => {
    engine.renameEntity({ kind: 'analysis', id: run.id }, '  Team shortlist  ')
    engine.renameEntity({ kind: 'job', id: job.id }, 'Engineering hiring round')
    engine.renameEntity({ kind: 'resume', id: resume.id }, 'Portfolio A')
  })
  assert.equal(saves.length, 3)
  assert.equal(engine.workspace.runs[0].displayName, 'Team shortlist')
  assert.equal(engine.workspace.runs[0].name, before.runs[0].name)
  assert.deepEqual(engine.workspace.runs[0].targets, before.runs[0].targets)
  assert.deepEqual(engine.workspace.runs[0].resumes, before.runs[0].resumes)
  assert.deepEqual(engine.workspace.runs[0].comparisons, before.runs[0].comparisons)
  assert.equal(engine.workspace.jobs.find(item => item.id === job.id).title, job.title)
  assert.equal(engine.workspace.resumes[0].name, resume.name)
  assert.deepEqual(engine.workspace.documents, before.documents)
  assert.deepEqual(initial, before)
  const restored = saves.at(-1)
  await act(async () => root.unmount()); root = null
  await mount(restored, () => 'saved')
  assert.equal(engine.workspace.runs[0].displayName, 'Team shortlist')

  const next = api.createAnalysisRun(engine.workspace, [resume.id], [job.rubricId])
  assert.equal(next.resumes[0].resume.displayName, 'Portfolio A')
  assert.equal(next.targets[0].displayName, 'Engineering hiring round')
  assert.equal(next.targets[0].label, job.title)
  assert.equal(next.name, 'Engineering hiring round - 1 resume')
  const originalInputs = structuredClone(next)
  delete originalInputs.resumes[0].resume.displayName
  delete originalInputs.targets[0].displayName
  delete originalInputs.targets[0].job.displayName
  assert.deepEqual(api.evaluateComparison(next, next.comparisons[0].id), api.evaluateComparison(originalInputs, originalInputs.comparisons[0].id))
})

test('sample name saves surface failures, reject invalid edits, and retain archive restrictions', async () => {
  const initial = api.createInitialWorkspace()
  const run = initial.runs[0]
  let calls = 0
  await mount(initial, () => { calls++; return 'failed' })
  await act(async () => {
    assert.throws(() => engine.renameEntity({ kind: 'analysis', id: run.id }, 'Keep my draft'), /could not be saved/)
  })
  assert.equal(engine.workspace.runs[0].displayName, 'Keep my draft')
  assert.match(engine.notice, /only in this tab/)
  for (const name of ['', '   ', 'x'.repeat(161), 'bad\nname']) {
    assert.throws(() => engine.renameEntity({ kind: 'analysis', id: run.id }, name), /Display name/)
  }
  assert.equal(calls, 1)
  assert.throws(() => engine.renameEntity({ kind: 'analysis', id: 'missing' }, 'Valid'), /no longer available/)
  engine.setExternalArchive(true)
  assert.throws(() => engine.renameEntity({ kind: 'analysis', id: run.id }, 'Valid'), /archived/)
  assert.equal(calls, 1)
})

test('all real metadata clients use narrow conditional writes and validate the acknowledged name', async () => {
  const workspaceId = 'workspace-one'
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    const { displayName } = JSON.parse(init.body)
    if (url.includes('/analyses/')) return json({ run: { run: { id: 'run-one', workspaceId, dataKind: 'real', displayName }, etag: '"new"' } })
    if (url.includes('/jobs/')) return json({ job: { job: { id: 'job-one', dataKind: 'real' }, displayName, etag: '"new"' } })
    return json({ resume: { resume: { id: 'resume-one', dataKind: 'real' }, workspaceId, displayName, etag: '"new"' } })
  }
  await api.renameRealAnalysis(workspaceId, 'run-one', '  Analysis label  ', '"base"')
  await api.renameRealJob(workspaceId, 'job-one', 'Job label', '"base"')
  await api.renameRealResume(workspaceId, 'resume-one', 'Resume label', '"base"')
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(request => request.url), [
    '/api/workspaces/workspace-one/analyses/run-one/metadata',
    '/api/workspaces/workspace-one/jobs/job-one/metadata',
    '/api/workspaces/workspace-one/resumes/resume-one/metadata',
  ])
  requests.forEach(({ init }) => {
    assert.equal(init.method, 'PATCH')
    assert.equal(init.headers.get('If-Match'), '"base"')
    assert.equal(init.headers.get('X-Score-Request'), 'workspace')
    assert.equal(init.cache, 'no-store')
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['displayName'])
  })
  assert.equal(JSON.parse(requests[0].init.body).displayName, 'Analysis label')
  await assert.rejects(api.renameRealAnalysis(workspaceId, 'run-one', 'Valid', ''), /Reload/)
  await assert.rejects(api.renameRealJob(workspaceId, 'job-one', ' ', '"base"'), /Display name/)
  await assert.rejects(api.renameRealResume(workspaceId, 'resume-one', 'x'.repeat(161), '"base"'), /160/)
  assert.equal(requests.length, 3)

  globalThis.fetch = async () => json({ job: { job: { id: 'other', dataKind: 'real' }, displayName: 'Job label', etag: '"new"' } })
  await assert.rejects(api.renameRealJob(workspaceId, 'job-one', 'Job label', '"base"'), /did not acknowledge/)
  globalThis.fetch = async () => json({ resume: { resume: { id: 'resume-one', dataKind: 'real' }, workspaceId, displayName: 'Different', etag: '"new"' } })
  await assert.rejects(api.renameRealResume(workspaceId, 'resume-one', 'Resume label', '"base"'), /did not acknowledge/)
})

test('a concurrent real rename is not automatically retried with a different ETag', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return json({ error: { code: 'conflict', message: 'The name changed in another session.' } }, 409)
  }
  await assert.rejects(api.renameRealAnalysis('workspace-one', 'run-one', 'My title', '"stale"'), { name: 'CloudConflictError' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.headers.get('If-Match'), '"stale"')
})

test('real job projections expose custom display titles without rewriting source job records', () => {
  const legacy = api.createInitialWorkspace()
  const job = { ...legacy.jobs[0], id: 'real-job', dataKind: 'real' }
  const summary = { job, displayName: 'Reviewer title', source: { displayName: 'posting.pdf' }, etag: '"saved"', rubric: null }
  const before = structuredClone(summary)
  const projected = api.projectRealJobs(legacy, [summary], [])
  assert.equal(projected.jobs[0].displayName, 'Reviewer title')
  assert.equal(projected.jobs[0].title, job.title)
  assert.equal(projected.jobs[0].sourceLabel, job.sourceLabel)
  assert.deepEqual(summary, before)
  assert.equal(legacy.jobs.some(item => item.id === 'real-job'), false)
})
