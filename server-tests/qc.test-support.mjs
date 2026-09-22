import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after } from 'node:test'
import { build } from 'esbuild'
import express from 'express'
import { api as analysisApi, fixture, createRun, publishResult, seedGrade, seedResume, clone, NOW, ACTOR } from './real-analyses.test-support.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist-server', `qc-unit-${process.pid}.mjs`)
await mkdir(path.dirname(output), { recursive: true })
await build({
  stdin: {
    resolveDir: root,
    contents: ['validation', 'azure-store', 'service', 'plans', 'lifecycle', 'artifacts', 'evidence', 'routes']
      .map(name => `export * from './server/qc/${name}.ts';`).join('\n') +
      "\nexport * from './server/settings/prompts.ts'; export * from './server/errors.ts';" +
      "\nexport * from './server/store.ts'; export * from './src/domain/quality-control.ts';" +
      "\nexport * from './src/domain/quality-improvement.ts'; export * from './src/domain/admin-settings.ts';" +
      "\nexport * from './worker/qc/model.ts'; export * from './worker/qc/config.ts'; export * from './worker/qc/runtime.ts';" +
      "\nexport * from './worker/settings.ts';" +
      "\nexport * from './server/repository.ts'; export * from './server/middleware.ts';" +
      "\nexport * from './server/settings/request-context.ts'; export * from './server/ids.ts';" +
      "\nexport { getPrincipal } from './server/request-context.ts';",
  },
  outfile: output, platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent',
})
export const api = await import(pathToFileURL(output).href)
after(async () => { await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error }) })
export { clone, analysisApi }
export const TENANT = '00000000-0000-4000-8000-000000000001'
export const OIDS = {
  owner: '00000000-0000-4000-8000-000000000002',
  reviewer: '00000000-0000-4000-8000-000000000003',
  second: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005',
  viewer: '00000000-0000-4000-8000-000000000006',
  stranger: '00000000-0000-4000-8000-000000000007',
}
export const principal = role => ({
  tenantId: TENANT, oid: OIDS[role], principalKey: `${TENANT}:${OIDS[role]}`, name: `QC ${role}`, email: '',
  applicationRoles: [role === 'admin' || role === 'stranger' ? 'Score.Admin' : 'Score.User'],
})
export function qcMemoryStore() {
  const values = new Map(), transactions = []
  let count = 0
  const store = {
    values, transactions, beforeCommit: undefined, afterCommit: undefined,
    async get(workspaceId, id) { return clone(values.get(`${workspaceId}/${id}`)) },
    save(record) {
      const saved = { record: clone(api.parseQcRecord(record)), etag: `"qc-${++count}"` }
      values.set(`${record.workspaceId}/${record.id}`, saved)
      return clone(saved)
    },
    async list(workspaceId, options) {
      api.qcListOptions(options)
      const all = [...values.values()].filter(value => api.qcRecordMatches(value.record, workspaceId, options))
        .sort((a, b) => a.record.id.localeCompare(b.record.id))
      const offset = Number(api.qcPageCursor(workspaceId, options) ?? '0')
      const limit = options.limit ?? 50, items = clone(all.slice(offset, offset + limit))
      const continuationToken = api.qcPageToken(workspaceId, options, offset + limit < all.length ? `${offset + limit}` : undefined)
      return { items, ...(continuationToken ? { continuationToken } : {}) }
    },
    async transact(workspaceId, operations, options = {}) {
      const prepared = await api.prepareQcTransaction(store, workspaceId, operations, options.lifecycle, options.exposure)
      if (store.beforeCommit) { const hook = store.beforeCommit; store.beforeCommit = undefined; await hook(prepared) }
      options.assertActive?.()
      for (const operation of prepared) {
        const old = values.get(`${workspaceId}/${operation.record.id}`)
        if (operation.kind === 'create' ? Boolean(old) : !old || old.etag !== operation.etag) throw new api.StoreConflictError('ETag changed')
      }
      for (const operation of prepared) {
        if (operation.kind === 'delete') values.delete(`${workspaceId}/${operation.record.id}`)
        else store.save(operation.record)
      }
      transactions.push(clone(prepared))
      if (store.afterCommit) { const hook = store.afterCommit; store.afterCommit = undefined; await hook(prepared) }
    },
    async pending(now, limit) {
      return clone([...values.values()].filter(value => value.record.recordType === 'qc-work' &&
        api.qcWorkPending(value.record, now)).slice(0, limit))
    },
    async pendingLifecycle(limit) {
      return [...new Set([...values.values()].filter(value => value.record.recordType === 'qc-control' &&
        (value.record.cleanupPending || value.record.cancellationPending)).map(value => value.record.workspaceId))].slice(0, limit)
    },
  }
  return store
}
export function qcMemoryBlobs(store, now) {
  const values = new Map()
  let count = 0
  return {
    values, afterPut: undefined, beforeDelete: undefined,
    async read(reference) {
      const value = values.get(reference.name)
      if (!value) throw new Error('Missing QC artifact')
      return Uint8Array.from(value.bytes)
    },
    async put(workspaceId, ownerId, bytes, fence) {
      assert.ok(fence)
      await fence.assertActive()
      const sha256 = api.qcBytesHash(bytes), name = `${workspaceId}/${ownerId}/${sha256}.json`
      const ownerKey = api.qcId('artifacts', ownerId)
      if (!await store.get(workspaceId, ownerKey)) await store.transact(workspaceId, [{ kind: 'create', record: {
        id: ownerKey, recordType: 'qc-artifacts', workspaceId, ownerId, runIds: fence.runIds, createdAt: now(), updatedAt: now(),
      } }])
      if (!values.has(name)) values.set(name, { bytes: Uint8Array.from(bytes), etag: `"blob-${++count}"` })
      if (this.afterPut) { const hook = this.afterPut; this.afterPut = undefined; await hook(name) }
      await fence.assertActive()
      return { name, sha256, bytes: bytes.length }
    },
    async list(workspaceId, ownerId, token) {
      const all = [...values].filter(([name]) => name.startsWith(`${workspaceId}/${ownerId ? `${ownerId}/` : ''}`))
        .map(([name, value]) => ({ name, etag: value.etag }))
      const offset = Number(token ?? 0), items = all.slice(offset, offset + 50)
      return { items, ...(offset + 50 < all.length ? { continuationToken: `${offset + 50}` } : {}) }
    },
    async delete(workspaceId, name, etag) {
      assert.ok(name.startsWith(`${workspaceId}/`))
      if (this.beforeDelete) { const hook = this.beforeDelete; this.beforeDelete = undefined; await hook(name) }
      const current = values.get(name)
      if (!current) return
      if (current.etag !== etag) throw new api.StoreConflictError('Blob changed')
      values.delete(name)
    },
  }
}
export function promptStore() {
  const bundles = new Map(), revisions = new Map(), activations = []
  let current, counter = 0
  return {
    bundles, revisions, activations,
    async getCurrent() { return clone(current) },
    async getBundle(id) { return clone(bundles.get(id)) },
    async getRevision(id) { return clone(revisions.get(id)) },
    async initialize(bundle, prompts, activation) {
      if (current) return false
      bundles.set(bundle.bundleId, clone(bundle))
      for (const prompt of prompts) revisions.set(prompt.revisionId, clone(prompt))
      activations.push(clone(activation))
      current = { bundle: clone(bundle), activation: clone(activation), etag: `"prompts-${++counter}"` }
      return true
    },
    async createDraft(bundle, prompts) {
      const existing = bundles.get(bundle.bundleId)
      if (existing) assert.deepEqual(existing, bundle)
      else bundles.set(bundle.bundleId, clone(bundle))
      for (const prompt of prompts) {
        if (revisions.has(prompt.revisionId)) assert.deepEqual(revisions.get(prompt.revisionId), prompt)
        else revisions.set(prompt.revisionId, clone(prompt))
      }
    },
    async activate(bundle, activation, expected, beforePublish) {
      await beforePublish?.()
      if (current?.etag !== expected) throw new api.StoreConflictError('Prompt pointer changed')
      activations.push(clone(activation))
      current = { bundle: clone(bundle), activation: clone(activation), etag: `"prompts-${++counter}"` }
      return clone(current)
    },
    async history(limit, before) {
      const sorted = [...activations].reverse()
      const index = before ? sorted.findIndex(value => value.activationId === before) + 1 : 0
      const page = sorted.slice(index, index + limit)
      return { activations: clone(page), ...(index + limit < sorted.length ? { nextBefore: page.at(-1).activationId } : {}) }
    },
  }
}
export async function qcFixture(comparisons = 1, publishOptions = {}, targetKind = 'job') {
  const f = fixture()
  let created
  if (targetKind === 'grade') {
    const resumes = []
    for (let index = 0; index < comparisons; index++) resumes.push(await seedResume(f))
    const grade = await seedGrade(f)
    created = await f.service.create(f.workspaceId, randomUUID(), {
      name: 'Frozen grade QC comparison', resumes: resumes.map(value => value.selection), targets: [grade.selection],
    }, ACTOR)
    const configureAssessment = publishOptions.configureAssessment
    publishOptions = { ...publishOptions, configureAssessment(assessment, snapshots) {
      assessment.qualifications = snapshots.targetSnapshot.requirementEvidence.filter(item => item.kind === 'qualification').map(item => ({
        qualificationId: item.qualificationId, evidenceStatus: 'not-assessed', citations: [], requirementCitations: item.citations,
        rationale: 'The captured qualification requires a separate unscored human review.',
        limitation: { code: 'not-assessable', message: 'Qualification alternatives remain unscored.', qualificationId: item.qualificationId },
      }))
      assessment.limitations = assessment.qualifications.map(item => item.limitation)
      configureAssessment?.(assessment, snapshots)
    } }
  } else created = await createRun(f, comparisons, 1)
  const rows = [...f.analysis.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison')
  for (const row of rows) await publishResult(f, created.run.id, row.record.id, false, { scheduleNarratives: false, ...publishOptions })
  f.now = NOW
  const store = qcMemoryStore(), blobs = qcMemoryBlobs(store, () => f.now)
  const qc = { store, blobs, workerEnabled: true }
  const settings = api.captureProcessingSettings(api.createDefaultAdminSettings(), 'qc-settings-v1', f.now)
  const provider = Object.assign(async () => clone(f.settings), { admission: async () => clone(f.settings), pinNewAdmissions: true })
  f.settings = settings
  const base = new api.QcService({ qc, analyses: f.analysis, now: () => new Date(f.now), settings: provider })
  const registryStore = promptStore()
  const prompts = new api.PromptRegistryService({
    store: registryStore, now: () => new Date(f.now), authorizeActivation: value => value.oid === OIDS.admin,
  })
  const plans = new api.QcPlanService(base, prompts)
  const caller = role => ({
    workspaceId: f.workspaceId, actor: { principalId: principal(role).principalKey, name: principal(role).name },
    role: role === 'second' ? 'reviewer' : role === 'admin' ? 'viewer' : role,
    applicationAdmin: role === 'admin',
  })
  const contexts = []
  for (const row of rows) contexts.push(await base.context(caller('reviewer'), created.run.id, row.record.id))
  return Object.assign(f, {
    qc, base, plans, prompts, registryStore, caller, created, contexts,
    clock: { now: () => new Date(f.now), async sleep(ms) { f.now = new Date(Date.parse(f.now) + ms).toISOString() } },
  })
}
export function feedback(context, decision = 'agree', score = 0) {
  return {
    scope: context.scope, feedback: context.analysis.result.criteria.map(row => ({
      criterionId: row.criterionId, decision, reason: decision === 'agree' ? '' : 'Different evidence interpretation for this saved criterion.',
      recommendation: decision === 'disagree' ? { kind: 'score', score } : null,
      issues: decision === 'disagree' ? ['scoring'] : [], evidenceParagraphIds: [],
    })),
  }
}
export async function submittedPlan(f, { role = 'reviewer', holdout = false } = {}) {
  const cases = []
  for (const [index, context] of f.contexts.entries()) {
    let head = await f.base.head(f.caller(role), context.scope)
    head = await f.base.saveReview(f.caller(role), feedback(context), randomUUID(), head?.etag, true)
    cases.push({
      scope: context.scope, reviewIds: [head.record.submittedId], purpose: holdout && index > 0 ? 'holdout' : 'drafting', note: '',
      referenceDecisions: context.analysis.result.criteria.map(row => ({ criterionId: row.criterionId, score: row.score, reason: 'Named curator reference for this exact rubric.' })),
    })
  }
  return f.plans.create(f.caller(role), { name: 'QC hypothesis', objective: 'Improve anchor interpretation without changing the fixed evidence contract.', cases, excludedFeedback: [] }, randomUUID())
}
export function proposal(plan) {
  const reviewId = plan.cases.find(entry => entry.purpose === 'drafting').reviewIds[0]
  return {
    summary: 'Clarify how documented scope maps to the saved anchors.',
    findings: [{ description: 'The selected feedback requests more explicit anchor comparisons.', reviewIds: [reviewId] }],
    disagreements: [], changes: [{ familyId: 'assessment', guidance: 'Describe the decisive documentary scope and responsibility before selecting an existing saved anchor. Keep unsupported assumptions separate from observed evidence.', reason: 'Clarify consistency while retaining all fixed grounding rules.' }],
    expectedEffects: 'More explicit rubric-relative explanations.', risks: 'Selected cases may not generalize.',
  }
}
export function completeAssessmentTrial(entry, family, settings) {
  assert.equal(family, 'assessment')
  const result = entry.analysis.result
  const assessment = { criteria: clone(result.criteria), qualifications: clone(result.qualifications), summary: result.summary, limitations: clone(result.limitations) }
  return {
    trial: {
      status: 'complete', error: null, assessment,
      summary: { completion: result.completion, overall: result.overall, coverage: result.coverage },
      findings: ['Fixed grounding passed in the injected trial adapter.'],
      ...api.qcAssessmentMetrics(entry, assessment.criteria),
    },
    models: { assessment: settings.tasks.assessment.modelName, assessmentReview: settings.tasks.assessmentReview.modelName },
  }
}
export async function queueAssessmentEvaluation(f) {
  let detail = await submittedPlan(f, { holdout: f.contexts.length > 1 })
  detail = await f.plans.edit(f.caller('reviewer'), detail.plan.id, { proposal: proposal(detail.plan) }, randomUUID(), detail.etag)
  return f.plans.request(f.caller('reviewer'), detail.plan.id, 'evaluation', randomUUID(), detail.etag)
}
export async function qcHttp(f, configOverrides = {}) {
  const roles = new Map(Object.keys(OIDS).map(role => [OIDS[role], principal(role).applicationRoles]))
  const activePrincipals = new Set()
  const memberships = new Map(Object.keys(OIDS).filter(role => role !== 'stranger').map(role => {
    const id = api.membershipIdFor(principal(role).principalKey)
    return [id, { id, workspaceId: f.workspaceId, principalId: principal(role).principalKey, principalType: 'user', role: f.caller(role).role }]
  }))
  let metadata = { id: 'workspace', workspaceId: f.workspaceId, tenantId: TENANT, ownerId: principal('owner').principalKey,
    name: 'QC workspace', kind: 'personal', createdAt: f.now, updatedAt: f.now }
  const directory = {
    async getMetadata(workspaceId) { return workspaceId === f.workspaceId ? { metadata: clone(metadata), etag: '"workspace"' } : undefined },
    async getMembership(workspaceId, id) { return workspaceId === f.workspaceId ? clone(memberships.get(id)) : undefined },
  }
  let tail = Promise.resolve(), beforeLease
  const state = {
    async acquireMutationLease() {
      if (beforeLease) { const hook = beforeLease; beforeLease = undefined; await hook() }
      const previous = tail
      let release
      tail = new Promise(resolve => { release = resolve })
      await previous
      return { async renew() {}, async release() { release() } }
    },
  }
  const repository = new api.WorkspaceRepository({ directory, state })
  const config = {
    authMode: 'easyauth', tenantId: TENANT,
    appOrigin: 'https://score.example.test', qcEnabled: true,
    settings: { runtimeEnabled: true },
    ...configOverrides,
  }
  const app = express()
  app.use(express.json())
  app.use('/api', api.createAuthMiddleware(config), api.createCsrfMiddleware(config),
    (req, res, next) => {
      const actor = api.getPrincipal(req)
      activePrincipals.add(actor)
      res.once('close', () => activePrincipals.delete(actor))
      next()
    },
    api.attachSettingsContext(config, { capture: async () => clone(f.settings) }),
    api.createQcRouter({ repository, state, config, qc: f.qc, analyses: f.analysis, prompts: f.prompts, now: () => new Date(f.now) }))
  app.use((error, _req, res, _next) => {
    const safe = error instanceof api.HttpError ? error : api.unavailable()
    res.status(safe.status).json(api.toCloudApiError(safe))
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/workspaces/${f.workspaceId}/qc`
  return {
    memberships, repository, beforeLease: hook => { beforeLease = hook }, archive: () => { metadata.archivedAt = f.now },
    setAdmissionEnabled: enabled => { config.qcEnabled = enabled },
    // Fault injection for final guards; real Entra claim changes require token/session refresh.
    setApplicationRoles(role, applicationRoles) {
      roles.set(OIDS[role], [...applicationRoles])
      for (const actor of activePrincipals) {
        if (actor.oid === OIDS[role]) actor.applicationRoles = [...applicationRoles]
      }
    },
    async close() { await new Promise(resolve => server.close(resolve)) },
    async request(suffix, method = 'GET', data, role = 'reviewer', headers = {}) {
      const identity = { auth_typ: 'aad', claims: [{ typ: 'tid', val: TENANT }, { typ: 'oid', val: OIDS[role] },
        ...roles.get(OIDS[role]).map(value => ({ typ: 'roles', val: value }))] }
      return fetch(`${base}${suffix}`, { method, headers: {
        'x-ms-client-principal': Buffer.from(JSON.stringify(identity)).toString('base64'),
        ...(method === 'GET' ? {} : { origin: config.appOrigin, 'x-score-request': 'workspace', 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }),
        ...headers,
      }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    },
  }
}
