import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  captureProcessingSettings, createApp, createDefaultAdminSettings,
} from '../dist-server/app.mjs'
import {
  ALLOWED_OID, APP_ORIGIN, OTHER_ALLOWED_OID, authHeaders, baseConfig, createFakeAccessStore, createFakeDirectoryStore,
  createFakeStateStore, membershipFor, seedWorkspace,
} from './helpers.mjs'
import { createFakeRealJobs } from './job-lifecycle-fakes.mjs'

const NOW = '2026-09-24T15:00:00.000Z'
const REAL_JOBS_CONFIG = {
  cosmosEndpoint: 'https://example-cosmos.documents.azure.com:443/',
  database: 'score',
  container: 'job-records',
  storageAccountUrl: 'https://example.blob.core.windows.net',
  blobContainer: 'job-sources',
}
const GUIDANCE = 'Score 0: No evidence. Score 1: Minimal evidence. Score 2: Basic evidence. Score 3: Adequate evidence. Score 4: Strong evidence. Score 5: Exceptional evidence.'

async function startExportServer({ jobs: withJobs = true } = {}) {
  const directory = createFakeDirectoryStore()
  const state = createFakeStateStore()
  const jobs = createFakeRealJobs()
  let settingsValue = createDefaultAdminSettings()
  let outage = false
  const settings = {
    async capture() {
      if (outage) throw new Error('Settings unavailable')
      return captureProcessingSettings(settingsValue, 'export-policy', NOW)
    },
    set(value) { settingsValue = value },
    outage(value) { outage = value },
  }
  const app = createApp({
    config: baseConfig({ ...(withJobs ? { realJobs: REAL_JOBS_CONFIG } : {}), settings: { runtimeEnabled: true } }),
    directory, state, accessStore: createFakeAccessStore(), settings, now: () => new Date(NOW),
    ...(withJobs ? { jobs: { store: jobs.store, blobs: jobs.blobs } } : {}),
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, directory, state, jobs, settings,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** A ready real job with two saved rubric versions: v1 generated, v2 edited. */
async function seedJob(server, workspace) {
  const imported = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/jobs/pdf`, {
    method: 'POST',
    headers: {
      ...authHeaders(), origin: APP_ORIGIN, 'x-score-request': 'workspace', 'content-type': 'application/pdf',
      'x-file-name': 'Principal%20Engineer.pdf', 'idempotency-key': randomUUID(),
    },
    body: Buffer.from('%PDF-1.7\nreal job source\n', 'ascii'),
  })
  assert.equal(imported.status, 202, await imported.clone().text())
  const jobId = (await imported.json()).job.job.id
  const current = await server.jobs.store.get(workspace.id, jobId)
  const document = {
    id: current.record.job.documentId, title: 'Principal Engineer', kind: 'job', version: 1, sample: false,
    paragraphs: [
      { id: 'paragraph-1', page: 1, heading: 'Requirements', text: 'Must lead distributed systems delivery.' },
      { id: 'paragraph-2', page: 2, heading: 'Operations', text: 'Must operate Azure services for production workloads.' },
    ],
  }
  const documentBlobName = `${workspace.id}/${jobId}/source-document.json`
  await server.jobs.blobs.putImmutable(documentBlobName, Buffer.from(JSON.stringify(document)), 'application/json')
  const citation = (paragraph) => ({
    documentId: document.id, documentVersion: 1, paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
  })
  const rubricId = `rubric-${jobId}`
  const first = {
    id: rubricId, groupId: rubricId, kind: 'job', jobId, name: 'Principal Engineer rubric', description: 'Grounded requirements',
    version: 1, createdAt: '2026-09-23T14:00:00.000Z', dataKind: 'real',
    provenance: { kind: 'generated', model: 'gpt-test', promptVersion: 'rubric-v1' },
    criteria: [{
      id: 'criterion-1', key: 'custom', label: 'Distributed systems leadership', description: 'Leads distributed systems delivery.',
      weight: 60, guidance: GUIDANCE, requirementType: 'required', sourceParagraphId: 'paragraph-1', sourceCitations: [citation(document.paragraphs[0])],
    }, {
      id: 'criterion-2', key: 'custom', label: 'Cloud operations', description: 'Operates Azure services in production.',
      weight: 40, guidance: 'Look for production Azure operations.', requirementType: 'preferred',
      sourceCitations: [citation(document.paragraphs[1]), citation(document.paragraphs[0])],
    }],
  }
  const ready = {
    ...current.record, displayName: 'Principal Engineer (shared)',
    job: { ...current.record.job, status: 'ready', rubricId, title: 'Principal Engineer', organization: 'Example Agency', grade: 'GS-14', series: '2210' },
    extractedBlobName: documentBlobName, nextAttemptAt: undefined, updatedAt: '2026-09-23T14:00:00.000Z',
  }
  const published = await server.jobs.store.publish(ready, current.etag, first)
  const second = {
    ...structuredClone(first), version: 2, name: 'Principal Engineer rubric (edited)', createdAt: '2026-09-24T09:00:00.000Z',
    provenance: { kind: 'edited', model: 'reviewer', promptVersion: 'manual-edit-v1' },
  }
  second.criteria[0].label = 'Distributed systems delivery leadership'
  await server.jobs.store.publish({ ...published.record, updatedAt: '2026-09-24T09:00:00.000Z' }, published.etag, second)
  return { jobId, rubricId, first, second }
}

function exportPath(workspaceId, jobId, query) {
  return `/api/workspaces/${workspaceId}/jobs/${jobId}/rubric-export?${new URLSearchParams(query)}`
}

async function get(server, path, oid = ALLOWED_OID) {
  return fetch(`${server.baseUrl}${path}`, { headers: { ...authHeaders({ oid }), 'x-score-request': 'workspace' } })
}

async function features(server) {
  const response = await get(server, '/api/features')
  assert.equal(response.status, 200)
  return response.json()
}

function readOnly(jobs) {
  const fail = async () => { throw new Error('Rubric exports must not write or read job blobs.') }
  for (const name of ['create', 'replace', 'publish', 'transitionLifecycle', 'completeRubricDeletion', 'purgeRubrics', 'purgeJobRecords']) {
    jobs.store[name] = fail
  }
  jobs.blobs.read = jobs.blobs.putImmutable = jobs.blobs.putFenced = jobs.blobs.delete = fail
}

test('rubric export returns exactly one saved job rubric version, the export policy in force and no internal fields', async () => {
  const server = await startExportServer()
  try {
    const workspace = await seedWorkspace(server)
    const { jobId, rubricId, first, second } = await seedJob(server, workspace)
    const stored = (await server.jobs.store.get(workspace.id, jobId)).record
    readOnly(server.jobs)

    const response = await get(server, exportPath(workspace.id, jobId, { rubricId, version: '1', format: 'pdf' }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.deepEqual(payload, {
      schemaVersion: 1,
      dataKind: 'real',
      workspaceId: workspace.id,
      generatedAt: NOW,
      settings: { revision: 'export-policy', policy: createDefaultAdminSettings().reports },
      job: {
        id: jobId, title: 'Principal Engineer', displayName: 'Principal Engineer (shared)', organization: 'Example Agency',
        location: stored.job.location, arrangement: stored.job.arrangement, employmentType: stored.job.employmentType,
        grade: 'GS-14', series: '2210', sourceLabel: stored.job.sourceLabel, pagination: 'pdf-pages',
      },
      rubric: {
        id: rubricId, version: 1, latestVersion: 2, name: first.name, description: first.description, createdAt: first.createdAt,
        provenance: 'generated',
        criteria: [{
          label: 'Distributed systems leadership', description: 'Leads distributed systems delivery.', weight: 60, guidance: GUIDANCE,
          requirementType: 'required',
          citations: [{ page: 1, heading: 'Requirements', quote: 'Must lead distributed systems delivery.' }],
        }, {
          label: 'Cloud operations', description: 'Operates Azure services in production.', weight: 40,
          guidance: 'Look for production Azure operations.', requirementType: 'preferred',
          citations: [
            { page: 2, heading: 'Operations', quote: 'Must operate Azure services for production workloads.' },
            { page: 1, heading: 'Requirements', quote: 'Must lead distributed systems delivery.' },
          ],
        }],
      },
    })
    const text = JSON.stringify(payload)
    for (const internal of ['documentId', 'paragraph-1', 'criterion-1', 'groupId', 'createdBy', 'originalBlobName', 'source-document.json', 'gpt-test', 'rubric-v1']) {
      assert.equal(text.includes(internal), false, `The export payload must not expose ${internal}`)
    }

    const latest = await (await get(server, exportPath(workspace.id, jobId, { rubricId, version: '2', format: 'markdown' }))).json()
    assert.equal(latest.rubric.version, 2)
    assert.equal(latest.rubric.latestVersion, 2)
    assert.equal(latest.rubric.name, second.name)
    assert.equal(latest.rubric.provenance, 'edited')
    assert.equal(latest.rubric.criteria[0].label, 'Distributed systems delivery leadership')
  } finally { await server.close() }
})

test('rubric export validates the exact saved version it is asked for', async () => {
  const server = await startExportServer()
  try {
    const workspace = await seedWorkspace(server)
    const { jobId, rubricId } = await seedJob(server, workspace)
    const other = await seedJob(server, workspace)
    const status = async (query, jobIdOverride = jobId) => (await get(server, exportPath(workspace.id, jobIdOverride, query))).status
    const valid = { rubricId, version: '1', format: 'csv' }

    assert.equal(await status(valid), 200)
    for (const query of [
      { version: '1', format: 'csv' },
      { ...valid, rubricId: '' },
      { ...valid, rubricId: ` ${rubricId}` },
      { ...valid, rubricId: 'r'.repeat(1025) },
      { rubricId, format: 'csv' },
      ...['0', '-1', '1.5', '01', 'abc', '1e2', '1234567890'].map(version => ({ ...valid, version })),
      { rubricId, version: '1' },
      ...['xlsx', 'PDF', 'md', ''].map(format => ({ ...valid, format })),
      { ...valid, extra: 'value' },
    ]) assert.equal(await status(query), 400, JSON.stringify(query))
    const repeated = await get(server, `${exportPath(workspace.id, jobId, valid)}&version=2`)
    assert.equal(repeated.status, 400)

    assert.equal(await status({ ...valid, version: '3' }), 404)
    assert.equal(await status({ ...valid, rubricId: `rubric-${randomUUID()}` }), 404)
    assert.equal(await status({ ...valid, rubricId: other.rubricId }), 404, 'A rubric id from another job is not this job\u2019s rubric')
    assert.equal(await status(valid, `job-${randomUUID()}`), 404)
    assert.equal(await status(valid, 'not a job id'), 404)

    const stranger = await get(server, exportPath(workspace.id, jobId, valid), OTHER_ALLOWED_OID)
    assert.equal(stranger.status, 404, 'People outside the workspace cannot tell that the rubric exists')

    const key = `${workspace.id}/${other.jobId}`
    server.jobs.store._records.get(key).record.job.rubricDeletedAt = NOW
    assert.equal(await status({ ...valid, rubricId: other.rubricId }, other.jobId), 404)
    delete server.jobs.store._records.get(key).record.job.rubricDeletedAt
    assert.equal(await status({ ...valid, rubricId: other.rubricId }, other.jobId), 200)
    server.jobs.store._records.get(key).record.rubricLifecycle = { parentKey: `job:${other.jobId}`, deletingAt: NOW }
    assert.equal(await status({ ...valid, rubricId: other.rubricId }, other.jobId), 404)
    server.jobs.store._records.get(key).record.rubricLifecycle = undefined
    server.jobs.store._records.get(key).record.lifecycle = { deletingAt: NOW }
    assert.equal(await status({ ...valid, rubricId: other.rubricId }, other.jobId), 404)

    const tampered = server.jobs.store._rubrics.get(`${workspace.id}/${jobId}`)[0]
    tampered.criteria[0].weight = 70
    assert.equal(await status(valid), 503, 'A stored rubric that fails validation is never exported')
  } finally { await server.close() }
})

test('rubric export follows the Admin switch, export roles and report formats, but not the new-work pause', async () => {
  const server = await startExportServer()
  try {
    const workspace = await seedWorkspace(server)
    const { jobId, rubricId } = await seedJob(server, workspace)
    server.directory._addMembership(workspace.id, membershipFor(workspace.id, { oid: OTHER_ALLOWED_OID, role: 'viewer' }))
    const request = (format, oid = ALLOWED_OID) => get(server, exportPath(workspace.id, jobId, { rubricId, version: '2', format }), oid)
    const refused = async (response, message) => {
      assert.equal(response.status, 403)
      assert.match(await response.text(), message)
    }

    const defaults = createDefaultAdminSettings()
    assert.equal('rubricExports' in defaults.features, false, 'Defaults keep their earlier shape; an absent key means on')
    const initial = await features(server)
    assert.equal(initial.rubricExports, true, 'On by default with no environment flag')
    assert.equal(initial.publicSettings.features.rubricExports, true)
    assert.equal((await request('pdf', OTHER_ALLOWED_OID)).status, 200, 'Viewers may export by default')

    const off = createDefaultAdminSettings()
    off.features.rubricExports = false
    server.settings.set(off)
    const switchedOff = await features(server)
    assert.equal(switchedOff.rubricExports, false)
    assert.equal(switchedOff.publicSettings.features.rubricExports, false)
    assert.equal(switchedOff.deploymentCapabilities.realJobImports, true, 'The deployment can still offer it')
    await refused(await request('markdown'), /Rubric exports are turned off in Admin settings/)
    off.reports.allowedRoles = []
    await refused(await request('pdf'), /Rubric exports are turned off in Admin settings/)

    const paused = createDefaultAdminSettings()
    paused.maintenance.pauseNewWork = true
    paused.maintenance.explanation = 'Maintenance window.'
    server.settings.set(paused)
    const whilePaused = await features(server)
    assert.equal(whilePaused.realJobImports, false, 'New imports pause')
    assert.equal(whilePaused.rubricExports, true, 'Exports are reads and stay available')
    assert.equal((await request('pdf')).status, 200)

    const roles = createDefaultAdminSettings()
    roles.reports.allowedRoles = ['owner']
    server.settings.set(roles)
    await refused(await request('pdf', OTHER_ALLOWED_OID), /does not allow your workspace role to export rubrics/)
    assert.equal((await request('pdf')).status, 200)

    const formats = createDefaultAdminSettings()
    formats.reports.enabledFormats = ['pdf']
    formats.reports.defaultFormat = 'pdf'
    server.settings.set(formats)
    for (const format of ['docx', 'pptx', 'csv']) await refused(await request(format), /format is disabled by application policy/)
    for (const format of ['pdf', 'markdown']) assert.equal((await request(format)).status, 200, format)
    formats.reports.enabledFormats = []
    formats.reports.defaultFormat = null
    assert.equal((await request('markdown')).status, 200, 'Markdown is not a report format, so Report formats cannot turn it off')

    server.settings.outage(true)
    assert.equal((await request('pdf')).status, 503, 'No defaults are substituted when the current policy cannot be read')
  } finally { await server.close() }

  const withoutJobs = await startExportServer({ jobs: false })
  try {
    const workspace = await seedWorkspace(withoutJobs)
    const available = await features(withoutJobs)
    assert.equal(available.rubricExports, false, 'Real jobs must be deployed to export their rubrics')
    const response = await get(withoutJobs, exportPath(workspace.id, `job-${randomUUID()}`, { rubricId: 'rubric-1', version: '1', format: 'pdf' }))
    assert.equal(response.status, 503)
  } finally { await withoutJobs.close() }
})
