import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.entity-name-tests-${randomUUID()}`)
const originalFetch = globalThis.fetch
let api
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

before(async () => {
  await mkdir(output)
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { projectRealJobs } from './src/app/realJobsProjection';
      export { renameRealAnalysis } from './src/services/realAnalyses';
      export { renameRealJob } from './src/services/realJobs';
      export { renameRealResume } from './src/services/realResumes';
    ` },
    outfile: join(output, 'names.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent',
  })
  api = await import(pathToFileURL(join(output, 'names.mjs')).href)
})
afterEach(() => { globalThis.fetch = originalFetch })
after(async () => { await rm(output, { recursive: true, force: true }) })

function realJob(fields = {}) {
  return { id: 'real-job', title: 'Original source title', organization: 'Agency', location: 'Remote', grade: '', series: '', arrangement: '', employmentType: '',
    source: 'pdf', sourceLabel: 'posting.pdf', status: 'ready', rubricId: 'rubric-one', documentId: 'document-one', createdAt: '2026-09-18T00:00:00.000Z', dataKind: 'real', ...fields }
}

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
  const base = { jobs: [], documents: [], rubrics: [], lifecycle: { entities: { 'resume:legacy': { archivedAt: '2026-09-18T00:00:00.000Z' } } } }
  const job = realJob()
  const summary = { job, displayName: 'Reviewer title', source: { displayName: 'posting.pdf' }, etag: '"saved"', rubric: null }
  const before = structuredClone(summary)
  const projected = api.projectRealJobs(base, [summary], [])
  assert.equal(projected.jobs.length, 1)
  assert.equal(projected.jobs[0].displayName, 'Reviewer title')
  assert.equal(projected.jobs[0].title, job.title)
  assert.equal(projected.jobs[0].sourceLabel, job.sourceLabel)
  assert.deepEqual(projected.documents, [])
  assert.deepEqual(projected.rubrics, [])
  assert.equal(projected.lifecycle.entities['resume:legacy'].archivedAt, base.lifecycle.entities['resume:legacy'].archivedAt)
  assert.deepEqual(summary, before)
  assert.deepEqual(base.jobs, [])
})
