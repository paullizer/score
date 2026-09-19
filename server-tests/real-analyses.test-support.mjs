import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after } from 'node:test'
import { build } from 'esbuild'
import express from 'express'
import { PDFDocument } from 'pdf-lib'
import { docxFile, legacyDocFile } from './word-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = path.join(root, 'dist-server', `real-analyses-unit-${process.pid}.mjs`)
await mkdir(path.dirname(bundle), { recursive: true })
await build({
  stdin: {
    resolveDir: root,
    contents: [
      'service', 'routes', 'validation', 'snapshots', 'lifecycle', 'library-lifecycle', 'guards', 'azure-store',
    ].map(name => `export * from './server/analyses/${name}.ts';`).join('\n') +
      "\nexport * from './server/errors.ts'; export * from './server/store.ts';" +
      "\nexport * from './server/ids.ts'; export * from './server/middleware.ts';" +
      "\nexport { analysisRunCanScore } from './src/domain/real-analyses.ts';" +
      "\nexport { WorkspaceRepository } from './server/repository.ts';" +
      "\nexport { parseGradeEntity, parseGradeSeedSnapshot, gradeContentHash, gradeVersionHash, gradeSourceSetHash, validateGradeApproval } from './server/grades/validation.ts';" +
      "\nexport { createGradeBlobStoreFromContainer } from './server/grades/azure-store.ts';" +
      "\nexport { parseResumeEntity } from './server/resumes/validation.ts';" +
      "\nexport * from './src/domain/document-formats.ts';" +
      "\nexport { gradeSourcePagination } from './src/features/grade-ladders/gradeUi.ts';",
  },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle, logLevel: 'silent',
})
export const api = await import(pathToFileURL(bundle).href)
after(async () => { await unlink(bundle).catch(error => { if (error.code !== 'ENOENT') throw error }) })
export const NOW = '2026-09-18T02:00:00.000Z'
export const LATER = '2026-09-18T03:00:00.000Z'
export const WORKSPACE = 'workspace-one'
export const ACTOR = 'analysis-test-owner'
export const clone = value => structuredClone(value)
export const sha = value => createHash('sha256').update(value).digest('hex')
export const jsonBytes = value => Buffer.from(JSON.stringify(value))
export const citation = (document, paragraph = document.paragraphs[0]) => ({
  documentId: document.id, documentVersion: document.version,
  paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
})
export const guidance = [
  '0: No evidence of this work is demonstrated.',
  '1: Recognizes the work with extensive assistance.',
  '2: Completes routine tasks with close supervision.',
  '3: Applies methods independently on typical assignments.',
  '4: Resolves complex assignments with limited guidance.',
  '5: Integrates complex evidence and explains defensible decisions.',
].join('\n')

export function blobs() {
  const values = new Map()
  const events = []
  let afterPut
  let beforeDelete
  let beforeFencedPut
  const store = {
    values, events,
    async read(name) { events.push(['read', name]); return clone(values.get(name)) },
    async putImmutable(name, bytes, contentType) {
      events.push(['put', name])
      const old = values.get(name)
      if (old) return { created: false, blob: clone(old) }
      const blob = { bytes: Uint8Array.from(bytes), contentType, sha256: sha(bytes), etag: `"blob-${values.size + 1}"` }
      values.set(name, blob)
      if (afterPut) await afterPut(name, blob)
      return { created: true, blob: clone(blob) }
    },
    async putFenced(name, bytes, contentType, fence) {
      await fence.assertActive()
      if (beforeFencedPut) await beforeFencedPut(name, fence)
      await fence.assertActive()
      const value = await store.putImmutable(name, bytes, contentType)
      await fence.assertActive()
      return value
    },
    async list(workspaceId, runId, continuationToken) {
      const prefix = runId ? `${workspaceId}/${runId}/` : `${workspaceId}/`
      const all = [...values].filter(([name]) => name.startsWith(prefix)).map(([name, blob]) => ({ name, etag: blob.etag }))
      const start = Number(continuationToken ?? 0)
      const items = all.slice(start, start + 100)
      return { items, ...(start + items.length < all.length ? { continuationToken: `${start + items.length}` } : {}) }
    },
    async delete(workspaceId, runId, name, etag) {
      assert.ok(api.analysisBlobInRun(name, workspaceId, runId))
      assert.ok(etag && etag !== '*')
      if (beforeDelete) await beforeDelete(name)
      const current = values.get(name)
      if (!current) return
      if (current.etag !== etag) throw new api.StoreConflictError('Blob ETag changed')
      events.push(['delete', name, etag])
      values.delete(name)
    },
    _afterPut(callback) { afterPut = callback },
    _beforeDelete(callback) { beforeDelete = callback },
    _beforeFencedPut(callback) { beforeFencedPut = callback },
  }
  return store
}
export function analysisStore() {
  const values = new Map()
  const controls = new Map()
  const batches = []
  let counter = 0
  let beforeBatch
  let afterBatch
  let beforeCreate
  let afterCreate
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const save = record => {
    const value = { record: clone(api.parseAnalysisEntity(record)), etag: `"analysis-${++counter}"` }
    values.set(key(record.workspaceId, record.id), value)
    return clone(value)
  }
  const saveControls = prepared => {
    for (const item of prepared) {
      const old = controls.get(key(item.record.workspaceId, item.record.id))
      if (old?.etag !== item.etag) throw new api.StoreConflictError('Analysis control changed')
    }
    for (const item of prepared) {
      controls.set(key(item.record.workspaceId, item.record.id), {
        record: clone(api.parseAnalysisControl(item.record)), etag: `"control-${++counter}"`,
      })
    }
  }
  const store = {
    values, controls, batches, save,
    async get(workspaceId, id) { return clone(values.get(key(workspaceId, id))) },
    async create(record) {
      if (beforeCreate) await beforeCreate(record)
      assert.equal(record.recordType, 'analysis-run')
      const prepared = await api.prepareAnalysisGuards(store, record.workspaceId, [{ kind: 'create', record }])
      const old = values.get(key(record.workspaceId, record.id))
      if (old) return { created: false, value: clone(old) }
      saveControls(prepared)
      const value = save(record)
      if (afterCreate) await afterCreate(record)
      return { created: true, value }
    },
    async replace(record, etag) {
      const old = values.get(key(record.workspaceId, record.id))
      if (!old || old.etag !== etag) throw new api.StoreConflictError()
      api.assertAnalysisReplacement(old.record, record)
      const prepared = await api.prepareAnalysisGuards(store, record.workspaceId, [{ kind: 'replace', record, etag }])
      if (values.get(key(record.workspaceId, record.id))?.etag !== etag) throw new api.StoreConflictError()
      saveControls(prepared)
      return save(record)
    },
    async transact(workspaceId, operations, options = {}) {
      if (operations.length && beforeBatch) { const callback = beforeBatch; beforeBatch = undefined; await callback(operations) }
      assert.ok((operations.length > 0 || options.controls?.length) && operations.length <= 26)
      assert.ok(Buffer.byteLength(JSON.stringify(operations)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES)
      assert.equal(new Set(operations.map(item => item.record.id)).size, operations.length)
      const prepared = await api.prepareAnalysisGuards(store, workspaceId, operations, options)
      if (!operations.length) { saveControls(prepared); return }
      const runs = operations.filter(item => item.record.recordType === 'analysis-run')
      assert.equal(runs.length, 1)
      assert.ok(runs[0].kind === 'replace' || (options.lifecycle && runs[0].kind === 'delete' && operations.length === 1))
      for (const operation of operations) {
        api.parseAnalysisEntity(operation.record)
        assert.equal(operation.record.workspaceId, workspaceId)
        if (operation.record.recordType === 'analysis-comparison') assert.equal(operation.record.runId, runs[0].record.id)
        const old = values.get(key(workspaceId, operation.record.id))
        if (operation.kind === 'create' ? old : !old || old.etag !== operation.etag) throw new api.StoreConflictError()
        if (old) api.assertAnalysisReplacement(old.record, operation.record)
        if (operation.kind === 'delete') {
          assert.ok(options.lifecycle)
          assert.deepEqual(old.record, operation.record)
        }
      }
      const progress = clone(values.get(key(workspaceId, runs[0].record.id)).record.progress)
      for (const operation of operations) {
        if (operation.record.recordType !== 'analysis-comparison' || operation.kind === 'delete') continue
        const previous = values.get(key(workspaceId, operation.record.id))?.record
        if (previous) {
          progress[previous.status]--
          if (previous.status === 'complete') progress[previous.resultSummary.overall.status === 'available' ? 'scored' : 'unscored']--
        } else progress.initialized++
        const next = operation.record
        progress[next.status]++
        if (next.status === 'complete') progress[next.resultSummary.overall.status === 'available' ? 'scored' : 'unscored']++
      }
      assert.deepEqual(runs[0].record.progress, progress)
      saveControls(prepared)
      batches.push(clone(operations))
      for (const operation of operations) {
        if (operation.kind === 'delete') values.delete(key(workspaceId, operation.record.id))
        else save(operation.record)
      }
      if (afterBatch) { const callback = afterBatch; afterBatch = undefined; await callback(operations) }
    },
    async list(workspaceId, options) {
      const offset = Number(options.continuationToken ?? 0)
      assert.ok(Number.isInteger(offset) && offset >= 0)
      const all = [...values.values()].filter(({ record }) => record.workspaceId === workspaceId && record.recordType === options.recordType &&
        (options.runId === undefined || options.runId === record.runId) && (options.status === undefined || record.status === options.status))
        .sort((a, b) => options.recordType === 'analysis-comparison' ? a.record.index - b.record.index :
          b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id))
      const items = all.slice(offset, offset + (options.limit ?? 50)).map(clone)
      return { items, ...(offset + items.length < all.length ? { continuationToken: `${offset + items.length}` } : {}) }
    },
    async listPending(now, limit) {
      return [...values.values()].filter(item => api.analysisWorkIsPending(item.record, now))
        .filter(({ record }) => {
          const state = controls.get(key(record.workspaceId, api.analysisControlId()))?.record.state ?? 'active'
          if (state !== 'active' && !(state === 'archived' && record.recordType === 'analysis-run' && record.cancellation)) return false
          if (record.recordType === 'analysis-run') return true
          const parent = values.get(key(record.workspaceId, record.runId))
          assert.equal(parent?.record.recordType, 'analysis-run')
          return api.analysisRunCanScore(parent.record)
        })
        .sort((a, b) => (a.record.recordType === 'analysis-run' ? 0 : 1) - (b.record.recordType === 'analysis-run' ? 0 : 1))
        .slice(0, limit).map(clone)
    },
    async getControl(workspaceId, runId) { return clone(controls.get(key(workspaceId, api.analysisControlId(runId)))) },
    async listControls(workspaceId, token) {
      const all = [...controls.values()].filter(value => value.record.workspaceId === workspaceId)
      const start = Number(token ?? 0)
      const items = clone(all.slice(start, start + 100))
      return { items, ...(start + items.length < all.length ? { continuationToken: `${start + items.length}` } : {}) }
    },
    async pendingLifecycleWorkspaces(limit) {
      return [...new Set([...controls.values()].filter(({ record }) => record.state === 'deleting' ||
        (record.operation && record.operation.status !== 'complete')).map(value => value.record.workspaceId))].slice(0, limit)
    },
    _beforeBatch(callback) { beforeBatch = callback },
    _afterBatch(callback) { afterBatch = callback },
    _beforeCreate(callback) { beforeCreate = callback },
    _afterCreate(callback) { afterCreate = callback },
  }
  return store
}

export function fixture(workspaceId = WORKSPACE) {
  const analysis = { store: analysisStore(), blobs: blobs() }
  const resumeValues = new Map()
  const jobValues = new Map()
  const rubricValues = new Map()
  const gradeValues = new Map()
  const resumes = {
    blobs: blobs(),
    store: {
      async get(ws, id) { return clone(resumeValues.get(`${ws}/${id}`)) },
      async getControl() { return undefined },
    },
  }
  const jobs = {
    blobs: blobs(),
    store: {
      async get(ws, id) { return clone(jobValues.get(`${ws}/${id}`)) },
      async getWorkspaceLifecycle() { return { state: 'active', updatedAt: NOW } },
      async list(ws, token) {
        const values = [...jobValues.values()].filter(item => item.record.workspaceId === ws)
        const start = Number(token ?? 0)
        return { jobs: clone(values.slice(start, start + 2)), ...(start + 2 < values.length ? { continuationToken: `${start + 2}` } : {}) }
      },
      async listRubrics(ws, id) { return clone(rubricValues.get(`${ws}/${id}`) ?? []) },
      async getRubric() { throw new Error('Do not silently pick the latest job rubric') },
    },
  }
  const grades = {
    blobs: blobs(),
    store: {
      async get(ws, id) { return clone(gradeValues.get(`${ws}/${id}`)) },
      async getControl() { return undefined },
      async list(ws, options) {
        const records = [...gradeValues.values()].filter(item => item.record.workspaceId === ws &&
          item.record.recordType === options.recordType && (!options.ladderId || item.record.ladderId === options.ladderId))
        const start = Number(options.continuationToken ?? 0)
        return { items: clone(records.slice(start, start + 1)), ...(start + 1 < records.length ? { continuationToken: `${start + 1}` } : {}) }
      },
    },
  }
  const value = {
    workspaceId, analysis, resumes, jobs, grades, resumeValues, jobValues, rubricValues, gradeValues,
    now: NOW,
  }
  value.service = new api.RealAnalysisService(analysis, { resumes, jobs, grades }, () => new Date(value.now))
  return value
}
let originalPdf
async function pdf() {
  if (!originalPdf) {
    const document = await PDFDocument.create()
    document.addPage()
    originalPdf = await document.save()
  }
  return originalPdf
}
async function sourceFile(document, options) {
  if (typeof options === 'string') options = { kind: options === 'html' ? 'url' : options }
  const kind = options.kind ?? 'pdf'
  assert.ok([...api.UPLOAD_FORMATS, 'url'].includes(kind))
  const contentType = kind === 'url' ? 'text/html' : api.UPLOAD_CONTENT_TYPES[kind]
  const extension = api.originalExtension(contentType)
  const url = `https://example.org/${document.kind}`
  const text = [document.title, ...document.paragraphs.flatMap(paragraph => [paragraph.heading, paragraph.text])].join('\n')
  return {
    kind, contentType, extension, url, fileName: options.fileName ?? `${document.kind}.${extension}`,
    bytes: kind === 'pdf' ? await pdf() : kind === 'docx' || kind === 'doc' ? evidenceOriginal(kind, text)
      : Buffer.from(kind === 'markdown'
        ? document.paragraphs.map(item => `# ${item.heading}\r\n\r\n${item.text}\r\n`).join('\r\n')
        : `<html><body>${document.paragraphs.map(item => `<h1>${item.heading}</h1><p>${item.text}</p>`).join('')}</body></html>`),
  }
}
async function putJson(store, name, value) {
  const saved = await store.putImmutable(name, jsonBytes(value), 'application/json')
  return { blobName: name, contentType: 'application/json', sha256: saved.blob.sha256, bytes: saved.blob.bytes.byteLength }
}
export function evidenceOriginal(format, text) {
  if (format === 'html') return Buffer.from('<html><body>Synthetic captured evidence.</body></html>')
  if (format === 'docx') return docxFile(text)
  if (format === 'doc') return legacyDocFile(text)
  throw new Error('Unsupported synthetic evidence format.')
}
export async function seedResume(f, name = 'Jordan Example', key = randomUUID(), options = {}) {
  const id = `resume-${key}`
  const document = {
    id: `document-${key}`, kind: 'resume', sample: false, title: 'Professional resume', version: 1,
    paragraphs: [{ id: 'resume-p1', page: 1, heading: 'Engineering experience', text: `${name} is an engineer. Evaluated engineering systems independently and explained evidence-based recommendations.` }],
  }
  const docRef = {
    ...await putJson(f.resumes.blobs, `${f.workspaceId}/${id}/source-document-v1.json`, document),
    documentId: document.id, documentVersion: 1,
  }
  const file = await sourceFile(document, options)
  const originalName = `${f.workspaceId}/${id}/original.${file.extension}`
  const original = (await f.resumes.blobs.putImmutable(originalName, file.bytes, file.contentType)).blob
  const source = file.kind === 'url' ? { kind: 'url', displayName: file.url, url: file.url }
    : { kind: file.kind, displayName: file.fileName, fileName: file.fileName }
  const capture = {
    original: { blobName: originalName, contentType: file.contentType, sha256: original.sha256, bytes: original.bytes.byteLength },
    capturedAt: NOW, redirects: [], ...(file.kind === 'url' ? { finalUrl: file.url } : {}),
  }
  const inputFingerprint = sha(Buffer.from(id))
  const captureManifest = await putJson(f.resumes.blobs, `${f.workspaceId}/${id}/capture.json`, {
    schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId, resumeId: id, inputFingerprint, source, capture,
  })
  const unavailable = { status: 'unavailable', value: null, citations: [] }
  const profile = {
    schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId, resumeId: id, documentId: document.id,
    documentVersion: 1, documentSha256: docRef.sha256,
    name: { status: 'available', value: name, citations: [citation(document)] },
    role: unavailable, location: unavailable, experience: unavailable,
    provenance: { model: 'test-profile-model', promptVersion: 'resume-profile-v1', schemaVersion: '1', extractedAt: NOW },
  }
  const profileBlob = await putJson(f.resumes.blobs, `${f.workspaceId}/${id}/profile-v1.json`, profile)
  const batchId = randomUUID()
  const record = api.parseResumeEntity({
    id, recordType: 'resume', workspaceId: f.workspaceId, dataKind: 'real', createdAt: NOW, updatedAt: NOW,
    resume: {
      id, dataKind: 'real', name, role: null, location: null, experience: null,
      documentId: document.id, documentVersion: 1, sourceLabel: source.displayName, batchId, status: 'ready', createdAt: NOW,
    },
    source, batchId, idempotencyKey: key, inputFingerprint, createdBy: ACTOR, capture, captureManifest,
    extraction: {
      method: file.kind === 'doc' ? 'legacy-word' : file.kind === 'markdown' ? 'markdown'
        : file.kind === 'url' ? 'html' : 'document-intelligence',
      version: file.kind === 'markdown' ? 'markdown-v1' : 'resume-source-v1', extractedAt: NOW,
      pagination: api.documentPagination(file.contentType),
      pageCount: file.kind === 'pdf' ? 1 : null,
      normalizedCharacters: document.paragraphs.reduce((sum, item) => sum + item.heading.length + item.text.length, 0), document: docRef,
    },
    profileBlob, attempts: 1, retryCount: 0, completedAt: NOW, warnings: [], duplicates: [],
  })
  f.resumeValues.set(`${f.workspaceId}/${id}`, { record, etag: '"resume-ready"' })
  return { record, document, profile, original, selection: { resumeId: id, documentId: document.id, documentVersion: 1, documentSha256: docRef.sha256 } }
}
export async function seedJob(f, title = 'Engineering role', key = randomUUID(), options = {}) {
  const id = `job-${key}`
  const document = {
    id: `document-${key}`, kind: 'job', sample: false, title, version: 1,
    paragraphs: [{ id: 'job-p1', page: options.page ?? 1, heading: 'Duties', text: 'Evaluate engineering systems independently and explain evidence-based recommendations.' }],
  }
  const rubric = {
    id: `rubric-${key}`, groupId: `rubric-group-${key}`, kind: 'job', dataKind: 'real', jobId: id,
    name: `${title} requirements`, description: 'Source-grounded engineering expectations.', version: 1, createdAt: NOW,
    provenance: { kind: 'generated', model: 'job-model', promptVersion: 'job-v2' },
    criteria: [{ id: 'engineering', key: 'custom', label: 'Engineering analysis', description: document.paragraphs[0].text,
      weight: 100, guidance, requirementType: 'required', sourceCitations: [citation(document)] }],
  }
  const documentRef = await putJson(f.jobs.blobs, `${f.workspaceId}/${id}/source-document.json`, document)
  const file = await sourceFile(document, options)
  const originalName = `${f.workspaceId}/${id}/original.${file.extension}`
  const original = (await f.jobs.blobs.putImmutable(originalName, file.bytes, file.contentType)).blob
  const displayName = file.kind === 'url' ? file.url : file.fileName
  const record = {
    id, recordType: 'job', workspaceId: f.workspaceId,
    job: {
      id, title, organization: 'Example agency', location: '', arrangement: '', employmentType: '', grade: '', series: '0801',
      source: file.kind, sourceLabel: displayName, documentId: document.id, rubricId: rubric.id, status: 'ready', createdAt: NOW, dataKind: 'real',
    },
    source: {
      kind: file.kind, displayName, originalBlobName: originalName, originalContentType: file.contentType,
      sha256: original.sha256, bytes: original.bytes.byteLength, capturedAt: NOW,
      extractionMethod: file.kind === 'doc' ? 'legacy-word' : file.kind === 'markdown' ? 'markdown'
        : file.kind === 'url' ? 'html' : 'document-intelligence',
      ...(file.kind === 'url' ? { url: file.url, finalUrl: file.url } : {}),
    },
    inputFingerprint: sha(Buffer.from(id)), createdBy: ACTOR, updatedAt: NOW, attempts: 1, warnings: [],
    extractedBlobName: documentRef.blobName,
  }
  f.jobValues.set(`${f.workspaceId}/${id}`, { record, etag: '"job-ready"' })
  f.rubricValues.set(`${f.workspaceId}/${id}`, [rubric])
  return {
    record, document, rubric, original,
    selection: { kind: 'job', jobId: id, rubricId: rubric.id, rubricVersion: 1, rubricHash: api.analysisHash(rubric),
      documentId: document.id, documentVersion: 1, documentSha256: documentRef.sha256 },
  }
}
export async function seedGrade(f, job, options = {}) {
  job ??= await seedJob(f)
  const ladderId = `ladder-${randomUUID()}`
  const seedId = `source-${randomUUID()}`
  const sourceId = `source-${randomUUID()}`
  const context = { series: '0801', agency: 'Historical agency', agencyType: 'other-federal', supervision: 'nonsupervisory',
    functions: [], specialty: 'Original approved engineering context', confirmed: true, answers: {} }
  const base = { workspaceId: f.workspaceId, ladderId, createdAt: NOW, updatedAt: NOW }
  const headId = `grade-head-${ladderId.slice(7)}-9`
  const sourceSetId = `source-set-${randomUUID()}`
  const reference = {
    id: options.referenceDocumentId ?? `reference-${randomUUID()}`, version: 1, title: 'Captured agency engineering requirements', kind: 'reference', sample: false,
    pageCount: 1, selectedPages: [], completeness: 'complete',
    paragraphs: [
      { id: 'work', page: 1, heading: 'GS-9 work', text: 'Evaluate engineering systems independently and explain evidence-based recommendations.' },
      { id: 'exclusion', page: 1, heading: 'GS-9 scope exclusions', text: 'Government-wide policy leadership is outside the GS-9 work covered by this standard.' },
      { id: 'qualification', page: 1, heading: 'Qualification alternatives', text: 'Engineering education or equivalent documented engineering experience can satisfy this qualification path.' },
      ...(options.extraReferenceParagraphs ?? []),
    ],
  }
  const seedDocument = { ...clone(job.document), kind: 'reference', pageCount: 1, selectedPages: [], completeness: 'complete' }
  const jobOriginal = await f.jobs.blobs.read(job.record.source.originalBlobName)
  assert.ok(jobOriginal)
  const seedOriginalName = `${f.workspaceId}/${ladderId}/${seedId}/original.${api.originalExtension(jobOriginal.contentType)}`
  const seedOriginal = (await f.grades.blobs.putImmutable(seedOriginalName, jobOriginal.bytes, jobOriginal.contentType)).blob
  const agencyOriginalName = `${f.workspaceId}/${ladderId}/${sourceId}/original.pdf`
  const agencyOriginal = (await f.grades.blobs.putImmutable(agencyOriginalName, await pdf(), 'application/pdf')).blob
  await putJson(f.grades.blobs, `${f.workspaceId}/${ladderId}/${seedId}/document-v1.json`, seedDocument)
  await putJson(f.grades.blobs, `${f.workspaceId}/${ladderId}/${sourceId}/document-v1.json`, reference)
  const seed = {
    job: clone(job.record.job), rubric: clone(job.rubric), document: clone(job.document),
    source: { ...clone(job.record.source), originalBlobName: seedOriginalName }, capturedAt: NOW,
  }
  const seedBlobName = `${f.workspaceId}/${ladderId}/seed.json`
  await putJson(f.grades.blobs, seedBlobName, seed)
  const coverage = { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Captured applicable engineering work.' }
  const frozen = (id, doc, origin, purpose, original) => ({
    sourceId: id, title: doc.title, origin, purpose, publisher: 'Example agency', documentId: doc.id, documentVersion: 1,
    documentBlobName: `${f.workspaceId}/${ladderId}/${id}/document-v1.json`,
    originalBlobName: `${f.workspaceId}/${ladderId}/${id}/original.${api.originalExtension(original.contentType)}`, sha256: original.sha256,
    ...(options.includeContentType ? { originalContentType: original.contentType } : {}),
    authorityStatus: 'supplied', coverage, pageCount: 1, selectedPages: [], completeness: 'complete', issues: [],
  })
  const sourceSet = {
    ...base, id: sourceSetId, recordType: 'grade-source-set', revision: 1, context, grades: [9], seedBlobName,
    sources: [frozen(seedId, seedDocument, 'seed-job', 'job-context', seedOriginal), frozen(sourceId, reference, 'upload', 'agency', agencyOriginal)],
    decisions: [seedId, sourceId].map(sourceId => ({ sourceId, selected: true, applicability: 'applicable', reason: 'Applicable captured work evidence.' })),
    issues: [], confirmedBy: ACTOR, contentHash: '',
  }
  sourceSet.contentHash = api.gradeSourceSetHash(sourceSet)
  const versionId = `grade-version-${randomUUID()}`
  const version = {
    ...base, id: versionId, recordType: 'grade-version', grade: 9, version: 1, generationId: 'approved-generation', sourceSetId,
    rubric: {
      id: versionId, groupId: headId, kind: 'grade', dataKind: 'real', ladder: 'Approved ladder title', grade: 'GS-9',
      name: 'Approved GS-9 engineering', description: 'Exact historical grade expectations.', version: 1, createdAt: NOW,
      provenance: { kind: 'generated', model: 'grade-model', promptVersion: 'grade-v1' },
      criteria: [
        { id: 'engineering', competencyId: 'engineering', key: 'custom', label: 'Engineering analysis', description: reference.paragraphs[0].text,
          weight: 100, guidance, support: 'direct', interpretation: 'Captured agency-scoped work expectation.',
          sourceCitations: [citation(reference)], gradeBasis: [citation(reference)] },
        { id: 'excluded', competencyId: 'excluded', key: 'leadership', label: 'Government-wide policy leadership',
          description: 'Government-wide policy leadership is outside this work scope.', weight: 0, support: 'not-applicable',
          interpretation: 'The captured agency work standard excludes government-wide policy leadership for this grade.',
          guidance: 'Unscored: exact work-level exclusion evidence establishes this competency is not applicable.',
          sourceCitations: [citation(reference, reference.paragraphs[1])], gradeBasis: [] },
      ],
    },
    qualifications: [{ id: 'education', text: reference.paragraphs[2].text, citations: [citation(reference, reference.paragraphs[2])],
      interpretation: 'Review the education and experience alternatives separately, without a score.', support: 'direct' }],
    issues: [], createdBy: ACTOR, contentHash: '',
  }
  options.configureVersion?.(version, reference)
  version.contentHash = api.gradeVersionHash(version)
  const review = { ...base, id: `grade-review-${randomUUID()}`, recordType: 'grade-review', grade: 9,
    versionId, versionHash: version.contentHash, sourceSetId, outcome: 'supported', issues: [], model: 'grade-review-model', promptVersion: 'review-v1' }
  const approval = { ...base, id: `grade-approval-${randomUUID()}`, recordType: 'grade-approval', grade: 9,
    versionId, versionHash: version.contentHash, sourceSetId, reviewId: review.id, approvedBy: ACTOR }
  const newerSet = { ...clone(sourceSet), id: `source-set-${randomUUID()}`, revision: 2,
    context: { ...context, agency: 'New draft agency', specialty: 'New unapproved context' } }
  newerSet.contentHash = api.gradeSourceSetHash(newerSet)
  const newerId = `grade-version-${randomUUID()}`
  const newer = { ...clone(version), id: newerId, version: 2, generationId: 'unapproved-generation', sourceSetId: newerSet.id,
    rubric: { ...clone(version.rubric), id: newerId, version: 2, name: 'Unapproved draft GS-9', ladder: 'New draft ladder title' } }
  newer.contentHash = api.gradeVersionHash(newer)
  const head = { ...base, id: headId, recordType: 'grade-head', grade: 9, status: 'draft', sourceSetId: newerSet.id,
    generationId: 'unapproved-generation', latestVersionId: newerId, approvedVersionId: versionId, approvalId: approval.id, issues: [] }
  const ladder = {
    id: ladderId, workspaceId: f.workspaceId, recordType: 'grade-ladder', createdAt: NOW, updatedAt: NOW,
    name: 'Approved engineering ladder', context, grades: [9], seedJobId: job.record.id,
    seedRubricId: job.rubric.id, seedRubricVersion: job.rubric.version, seedJobTitle: job.record.job.title,
    seedBlobName, sourceIds: [seedId, sourceId], sourceRevision: 2, status: 'draft', issues: [], createdBy: ACTOR,
    inputFingerprint: 'a'.repeat(64),
  }
  for (const record of [sourceSet, version, review, approval, newerSet, newer, head, ladder]) {
    api.parseGradeEntity(record)
    f.gradeValues.set(`${f.workspaceId}/${record.id}`, { record: clone(record), etag: '"grade-frozen"' })
  }
  assert.deepEqual(api.validateGradeApproval(version, sourceSet, [seedDocument, reference]), [])
  return { head, ladder, version, review, approval, sourceSet, newer, newerSet, reference, seed, selection: {
    kind: 'grade', ladderId, grade: 9, versionId, version: 1, versionHash: version.contentHash,
    approvalId: approval.id, reviewId: review.id, sourceSetId, sourceSetHash: sourceSet.contentHash,
  } }
}

export async function createRun(f, resumeCount = 1, targetCount = 1) {
  const resumes = []
  const targets = []
  for (let i = 0; i < resumeCount; i++) resumes.push(await seedResume(f, `Person Example ${i}`))
  for (let i = 0; i < targetCount; i++) targets.push(await seedJob(f, `Role ${i}`))
  const request = { name: 'Evidence comparison', resumes: resumes.map(value => value.selection), targets: targets.map(value => value.selection) }
  const key = randomUUID()
  const created = await f.service.create(f.workspaceId, key, request, ACTOR)
  return { ...created, request, key, resumes, targets }
}
export async function finishInitialization(f, id) {
  return api.advanceAnalysisRun(f.analysis, f.workspaceId, id, { now: () => new Date(f.now), maxChunks: 4 })
}
export async function publishResult(f, runId, comparisonId, withheld = false) {
  let run = await f.analysis.store.get(f.workspaceId, runId)
  let comparison = await f.analysis.store.get(f.workspaceId, comparisonId)
  const attemptId = randomUUID()
  const running = { ...comparison.record, status: 'running', attempts: 1, attemptId, updatedAt: f.now,
    lease: { owner: 'test-worker', heartbeatAt: f.now, expiresAt: LATER } }
  delete running.nextAttemptAt
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: running, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, running, f.now), etag: run.etag },
  ])
  run = await f.analysis.store.get(f.workspaceId, runId)
  comparison = await f.analysis.store.get(f.workspaceId, comparisonId)
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, run.record, comparison.record)
  const target = snapshots.targetSnapshot
  const rubric = target.kind === 'job' ? target.rubric : target.version.rubric
  const criteria = rubric.criteria.map(criterion => {
    const base = { criterionId: criterion.id, weight: criterion.weight, rationale: 'The saved document supports the engineering evidence described.',
      requirementCitations: target.requirementEvidence.find(item => item.kind === 'criterion' && item.criterionId === criterion.id).citations }
    if (criterion.support === 'not-applicable') return { ...base, evidenceStatus: 'not-applicable', score: null, citations: [] }
    return withheld
      ? { ...base, evidenceStatus: 'not-assessed', score: null, citations: [], limitation: { code: 'not-assessable', message: 'The available scope is unclear.', criterionId: criterion.id } }
      : { ...base, evidenceStatus: 'supported', score: 4, citations: [citation(snapshots.resumeSnapshot.document)] }
  })
  const assessment = { criteria, qualifications: [], summary: 'Evidence in the submitted document, for human review only.', limitations: [] }
  const assessmentSha256 = api.analysisHash(assessment)
  const model = { model: 'test-assessor', deployment: 'test-deployment', promptVersion: 'assessment-v1', schemaVersion: '1',
    startedAt: f.now, completedAt: f.now, inputCharacters: 1000 }
  const result = api.parseAnalysisResult({
    ...assessment, ...api.calculateAnalysisSummary(criteria), schemaVersion: 1, dataKind: 'real', workspaceId: f.workspaceId,
    runId, comparisonId, createdAt: f.now, humanReviewRequired: true, provenance: {
      attemptId, manifestSha256: run.record.manifest.sha256, assessmentSha256, assessment: model,
      resumeSnapshot: { snapshotId: comparison.record.resume.snapshotId, sha256: comparison.record.resume.blob.sha256 },
      targetSnapshot: { snapshotId: comparison.record.target.snapshotId, sha256: comparison.record.target.blob.sha256 },
      groundingReviews: [{
        id: `review-${randomUUID()}`, outcome: 'supported', issues: [], assessmentSha256,
        resumeSnapshotSha256: comparison.record.resume.blob.sha256, targetSnapshotSha256: comparison.record.target.blob.sha256,
        provenance: { ...model, model: 'test-reviewer' },
      }],
      correctionCount: 0, calculationVersion: 'weighted-0-100-v1',
    },
  })
  const reference = await api.putAnalysisJson(f.analysis.blobs, `${f.workspaceId}/${runId}/results/${comparisonId}/${attemptId}.json`, result)
  const completed = { ...comparison.record, status: 'complete', completedAt: f.now, result: reference,
    resultSummary: { completion: result.completion, overall: result.overall, coverage: result.coverage } }
  delete completed.lease
  await f.analysis.store.transact(f.workspaceId, [
    { kind: 'replace', record: completed, etag: comparison.etag },
    { kind: 'replace', record: api.applyAnalysisComparisonTransition(run.record, comparison.record, completed, f.now), etag: run.etag },
  ])
  return { result, completed, reference }
}

const TENANT = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-000000000002'
const VIEWER = '00000000-0000-4000-8000-000000000003'
const STRANGER = '00000000-0000-4000-8000-000000000004'
const ORIGIN = 'https://score.example.test'
export async function startHttp(f, enabled = true) {
  const memberships = new Map([['owner', OWNER], ['viewer', VIEWER]].map(([role, oid]) => {
    const principalId = api.principalKeyFor(TENANT, oid)
    const member = { id: api.membershipIdFor(principalId), workspaceId: f.workspaceId, principalId, principalType: 'user', role }
    return [member.id, member]
  }))
  const directory = {
    async getMetadata(workspaceId) {
      return workspaceId === f.workspaceId ? {
        metadata: { id: 'workspace', workspaceId, tenantId: TENANT, ...f.workspaceMetadata }, etag: '"workspace"',
      } : undefined
    },
    async getMembership(workspaceId, id) { return workspaceId === f.workspaceId ? memberships.get(id) : undefined },
  }
  let tail = Promise.resolve()
  f.mutationLeases = { active: 0, acquired: 0 }
  const state = {
    async acquireMutationLease(workspaceId) {
      assert.equal(workspaceId, f.workspaceId)
      const previous = tail
      let unlock
      tail = new Promise(resolve => { unlock = resolve })
      await previous
      f.mutationLeases.active++
      f.mutationLeases.acquired++
      return {
        async renew() { if (f.failMutationRenewal) throw new api.StoreConflictError('Mutation lease renewal failed') },
        async release() { f.mutationLeases.active--; unlock() },
      }
    },
  }
  const repository = new api.WorkspaceRepository({ directory, state, now: () => new Date(f.now) })
  const config = { authMode: 'easyauth', tenantId: TENANT, allowedUserIds: new Set([OWNER, VIEWER, STRANGER]), appOrigin: ORIGIN }
  const app = express()
  app.use(express.json())
  const router = express.Router()
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.use(api.createAuthMiddleware(config), api.createCsrfMiddleware(config))
  router.use(api.createRealAnalysesRouter({
    repository, analyses: enabled ? f.analysis : undefined, resumes: f.resumes, jobs: f.jobs, grades: f.grades, now: () => new Date(f.now),
  }))
  app.use('/api', router)
  app.use((error, _req, res, _next) => {
    const safe = error instanceof api.HttpError ? error
      : error?.type === 'entity.parse.failed' ? api.invalidRequest('The request body is not valid JSON.') : api.unavailable()
    res.status(safe.status).json(api.toCloudApiError(safe))
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/workspaces/${f.workspaceId}/analyses`
  return {
    base,
    async close() { await new Promise(resolve => server.close(resolve)) },
    async request(suffix = '', method = 'GET', body, options = {}) {
      const oid = options.role === 'viewer' ? VIEWER : options.role === 'stranger' ? STRANGER : OWNER
      const principal = { auth_typ: 'aad', claims: [{ typ: 'tid', val: TENANT }, { typ: 'oid', val: oid }], name_typ: 'name', role_typ: 'roles' }
      return fetch(`${base}${suffix}`, {
        method, headers: {
          ...(options.noAuth ? {} : { 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64') }),
          ...(method === 'GET' ? {} : {
            origin: ORIGIN, 'x-score-request': 'workspace',
            ...(body === undefined && options.rawBody === undefined ? {} : { 'content-type': 'application/json' }),
          }),
          ...options.headers,
        },
        ...(options.rawBody !== undefined
          ? { body: options.rawBody, ...(options.rawBody instanceof ReadableStream ? { duplex: 'half' } : {}) }
          : body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
}
