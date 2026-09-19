import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildGradeTestRuntime, memoryBlobs, startGradeFixture } from './gradeLadders.test-support.mjs'
import { passageSelection } from '../../worker-tests/analysis-selection-test-support.mjs'

const clone = (value) => structuredClone(value)

export async function buildResumeAnalysisTestRuntime(options = {}) {
  return buildGradeTestRuntime({
    ...options,
    serverExports: `
export { parseResumeEntity, validateRealResumeDocument, parseRealResumeProfile } from './server/resumes/validation.ts'
export { parseAnalysisEntity } from './server/analyses/validation.ts'
export { resumeControlId, parseResumeControl, prepareResumeTransaction } from './server/resumes/guards.ts'
export { analysisControlId, parseAnalysisControl, prepareAnalysisGuards } from './server/analyses/guards.ts'
export { assertAnalysisReplacement, analysisWorkIsPending } from './server/analyses/azure-store.ts'
export { analysisRunCanScore } from './src/domain/real-analyses.ts'
export * as resumeWorker from './worker/resumes/runtime.ts'
export * as analysisWorker from './worker/analyses/runtime.ts'
${options.serverExports ?? ''}
`,
  })
}

export function memoryRecords(api, parse, kind, { pageSize = 2 } = {}) {
  assert.equal(typeof parse, 'function', `The ${kind} record validator must be available.`)
  const values = new Map()
  const controls = new Map()
  const transactions = []
  let counter = 0
  let nextFault
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const next = (record) => ({ record: clone(parse(record)), etag: `"${kind}-${++counter}"` })
  const controlId = kind === 'resume' ? api.resumeControlId : api.analysisControlId
  const parseControl = kind === 'resume' ? api.parseResumeControl : api.parseAnalysisControl
  const prepare = kind === 'resume' ? api.prepareResumeTransaction : api.prepareAnalysisGuards
  const store = {
    values,
    controls,
    transactions,
    failNextTransaction(error, afterCommit = false) { nextFault = { error, afterCommit } },
    async get(workspaceId, id) {
      const value = values.get(key(workspaceId, id))
      return value ? clone(value) : undefined
    },
    async list(workspaceId, options) {
      const all = [...values.values()].filter(({ record }) =>
        record.workspaceId === workspaceId && record.recordType === options.recordType &&
        (!options.batchId || record.batchId === options.batchId) &&
        (!options.runId || record.runId === options.runId) &&
        (!options.status || (record.resume?.status ?? record.status) === options.status))
        .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt) ||
          left.record.id.localeCompare(right.record.id))
      const start = Number(options.continuationToken ?? 0)
      assert.ok(Number.isSafeInteger(start) && start >= 0, 'Fixture continuation tokens must be valid offsets.')
      const size = Math.min(options.limit ?? pageSize, pageSize)
      return {
        items: all.slice(start, start + size).map(clone),
        ...(start + size < all.length ? { continuationToken: String(start + size) } : {}),
      }
    },
    async create(record) {
      const current = values.get(key(record.workspaceId, record.id))
      if (current) return { created: false, value: clone(current) }
      await store.transact(record.workspaceId, [{ kind: 'create', record }])
      return { created: true, value: await store.get(record.workspaceId, record.id) }
    },
    async replace(record, etag) {
      await store.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
      return store.get(record.workspaceId, record.id)
    },
    async transact(workspaceId, operations, options = {}) {
      assert.ok((operations.length > 0 || options.controls?.length) && operations.length <= 100, 'Cosmos transaction operation limit.')
      assert.ok(Buffer.byteLength(JSON.stringify(operations)) <= 1_800_000, 'Cosmos transaction payload budget.')
      const prepared = await prepare(store, workspaceId, operations, options)
      const ids = new Set()
      for (const operation of operations) {
        assert.equal(operation.record.workspaceId, workspaceId)
        assert.equal(ids.has(operation.record.id), false, 'A transaction cannot write one record twice.')
        ids.add(operation.record.id)
        parse(operation.record)
        assert.ok(Buffer.byteLength(JSON.stringify(operation.record)) <= 512 * 1024, 'Records cannot contain unbounded source text.')
        const current = values.get(key(workspaceId, operation.record.id))
        if (operation.kind === 'create' ? Boolean(current) : !current || current.etag !== operation.etag) {
          throw new api.StoreConflictError('Concurrent integration publication.')
        }
        if (operation.kind === 'delete') {
          assert.ok(options.lifecycle, 'Only lifecycle cleanup can delete records.')
          assert.deepEqual(operation.record, current.record)
        } else if (kind === 'analysis' && current) api.assertAnalysisReplacement(current.record, operation.record)
        if (operation.kind !== 'delete' && current?.record.recordType === 'analysis-comparison' && current.record.status === 'complete') {
          assert.deepEqual(operation.record, current.record, 'Completed comparison records are immutable.')
        }
      }
      for (const control of prepared) {
        if (controls.get(key(workspaceId, control.record.id))?.etag !== control.etag) throw new api.StoreConflictError('Concurrent integration lifecycle control.')
        parseControl(control.record)
      }
      const fault = nextFault
      nextFault = undefined
      if (fault && !fault.afterCommit) throw fault.error
      for (const control of prepared) controls.set(key(workspaceId, control.record.id), {
        record: clone(parseControl(control.record)), etag: `"${kind}-control-${++counter}"`,
      })
      for (const operation of operations) {
        if (operation.kind === 'delete') values.delete(key(workspaceId, operation.record.id))
        else values.set(key(workspaceId, operation.record.id), next(operation.record))
      }
      if (operations.length) transactions.push(clone(operations))
      if (fault) throw fault.error
    },
    async listPending(now, limit) {
      return [...values.values()].filter(({ record }) => {
        if (record.nextAttemptAt && record.nextAttemptAt > now) return false
        if (record.lease && record.lease.expiresAt > now) return false
        const rootState = controls.get(key(record.workspaceId, controlId()))?.record.state ?? 'active'
        if (record.recordType === 'resume') {
          const own = controls.get(key(record.workspaceId, controlId(record.id)))?.record.state ?? 'active'
          return rootState === 'active' && own === 'active' && !record.lifecycle?.archivedAt && !record.lifecycle?.deletingAt && !record.lifecycle?.deletedAt &&
            ['queued', 'parsing', 'profiling'].includes(record.resume.status)
        }
        if (record.recordType === 'resume-batch') return false
        if (rootState !== 'active' && !(rootState === 'archived' && record.recordType === 'analysis-run' && record.cancellation)) return false
        if (!api.analysisWorkIsPending(record, now)) return false
        return record.recordType === 'analysis-run' || api.analysisRunCanScore(values.get(key(record.workspaceId, record.runId))?.record)
      }).sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt))
        .slice(0, limit).map(clone)
    },
    async getControl(workspaceId, id) { return clone(controls.get(key(workspaceId, controlId(id)))) },
    async listControls(workspaceId, token) {
      const all = [...controls.values()].filter((item) => item.record.workspaceId === workspaceId)
      const start = Number(token ?? 0), items = all.slice(start, start + pageSize).map(clone)
      return { items, ...(start + items.length < all.length ? { continuationToken: String(start + items.length) } : {}) }
    },
    async pendingLifecycleWorkspaces(limit) {
      return [...new Set([...controls.values()].filter(({ record }) => record.state === 'deleting' ||
        (record.operation && record.operation.status !== 'complete')).map(({ record }) => record.workspaceId))].slice(0, limit)
    },
  }
  const blobs = memoryBlobs()
  const page = (all, token) => {
    const start = Number(token ?? 0), items = all.slice(start, start + pageSize)
    return { items, ...(start + items.length < all.length ? { continuationToken: String(start + items.length) } : {}) }
  }
  blobs.putFenced = async (name, bytes, contentType, fence) => {
    fence.signal?.throwIfAborted()
    const writer = fence.writer ?? fence
    assert.equal(name, writer.blobName)
    assert.ok(name.startsWith(`${writer.workspaceId}/${writer.resumeId ?? writer.runId}/`))
    assert.ok(Date.parse(writer.expiresAt) > Date.now())
    await fence.assertActive()
    const result = await blobs.putImmutable(name, bytes, contentType, fence)
    await fence.assertActive()
    return result
  }
  if (kind === 'resume') {
    blobs.listFamilies = async (workspaceId, token) => {
      const result = page([...new Set([...blobs.values.keys()].filter((name) => name.startsWith(`${workspaceId}/`)).map((name) => name.split('/')[1]))], token)
      return { resumeIds: result.items, continuationToken: result.continuationToken }
    }
    blobs.listPage = async (workspaceId, resumeId, token) => {
      const result = page([...blobs.values.keys()].filter((name) => name.startsWith(`${workspaceId}/${resumeId}/`)), token)
      return { names: result.items, continuationToken: result.continuationToken }
    }
    blobs.delete = async (name) => { blobs.values.delete(name) }
  } else {
    blobs.list = async (workspaceId, runId, token) => page([...blobs.values].filter(([name]) =>
      name.startsWith(`${workspaceId}/${runId ? `${runId}/` : ''}`)).map(([name, blob]) => ({ name, etag: blob.etag })), token)
    blobs.delete = async (workspaceId, runId, name, etag) => {
      assert.ok(name.startsWith(`${workspaceId}/${runId}/`))
      const current = blobs.values.get(name)
      if (current && current.etag !== etag) throw new api.StoreConflictError('A retained blob changed during cleanup.')
      blobs.values.delete(name)
    }
  }
  return { store, blobs }
}

export async function startResumeAnalysisFixture(runtime, options = {}) {
  const resumes = memoryRecords(runtime.api, runtime.api.parseResumeEntity, 'resume', options)
  const analyses = memoryRecords(runtime.api, runtime.api.parseAnalysisEntity, 'analysis', options)
  const serviceConfig = {
    cosmosEndpoint: 'https://test.documents.azure.com',
    database: 'score',
    storageAccountUrl: 'https://test.blob.core.windows.net',
  }
  const fixture = await startGradeFixture(runtime, {
    ...options,
    resumes,
    analyses,
    configOverrides: {
      realResumes: { ...serviceConfig, container: 'resume-records', blobContainer: 'resume-sources' },
      realAnalyses: { ...serviceConfig, container: 'analysis-records', blobContainer: 'analysis-sources' },
      ...options.configOverrides,
    },
  })
  return {
    ...fixture,
    clock: {
      now: fixture.now,
      async sleep(milliseconds, signal) {
        signal?.throwIfAborted()
        fixture.advanceClock(milliseconds)
      },
    },
  }
}

export const resumeParagraphs = [
  { id: 'p-0001', page: 1, heading: 'Professional profile', text: 'Jordan Example' },
  { id: 'p-0002', page: 1, heading: 'Professional profile', text: 'Engineering specialist' },
  { id: 'p-0003', page: 1, heading: 'Location', text: 'Remote' },
  { id: 'p-0004', page: 1, heading: 'Experience', text: 'Ten years of engineering experience.' },
  { id: 'p-0005', page: 1, heading: 'Experience', text: 'Applied engineering methods independently across defined projects and communicated findings.' },
  { id: 'p-0006', page: 1, heading: 'Education', text: 'Bachelor of Engineering, Example University.' },
]

export async function resumePdf({ name = 'resume.pdf', paragraphs = resumeParagraphs, pages = 1 } = {}) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pages; index++) {
    const page = pdf.addPage([612, 792])
    const lines = paragraphs.filter((paragraph) => paragraph.page === index + 1)
    for (let line = 0; line < lines.length; line++) {
      page.drawText(lines[line].text, { x: 35, y: 745 - line * 25, size: 10, font })
    }
  }
  return new File([await pdf.save()], name, { type: 'application/pdf' })
}

export async function jsonResponse(response, allowedStatuses = [200]) {
  const text = await response.text()
  assert.ok(allowedStatuses.includes(response.status), `Unexpected HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}

export async function importResumePdf(fixture, file, { key = randomUUID(), batchId = randomUUID(), inputCount = 1 } = {}) {
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/pdf`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent(file.name),
      'Idempotency-Key': key,
      'X-Import-Batch': batchId,
      'X-Import-Count': String(inputCount),
    },
    body: Buffer.from(await file.arrayBuffer()),
  })
  const body = await jsonResponse(response, [200, 202])
  return { summary: body.resume, key, batchId }
}

export async function importResumeFile(fixture, file, { key = randomUUID(), batchId = randomUUID(), inputCount = 1 } = {}) {
  const extension = file.name.split('.').at(-1).toLowerCase()
  const format = extension === 'md' ? 'markdown' : extension
  if (format === 'pdf') return importResumePdf(fixture, file, { key, batchId, inputCount })
  const contentType = { markdown: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' }[format]
  assert.ok(contentType, 'Upload fixture needs a supported extension.')
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${format === 'markdown' ? 'markdown' : 'file'}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType, 'X-File-Name': encodeURIComponent(file.name), 'Idempotency-Key': key,
      'X-Import-Batch': batchId, 'X-Import-Count': String(inputCount),
    },
    body: Buffer.from(await file.arrayBuffer()),
  })
  const body = await jsonResponse(response, [200, 202])
  return { summary: body.resume, key, batchId }
}

export async function importResumeUrl(fixture, url, { key = randomUUID(), batchId = randomUUID(), inputCount = 1 } = {}) {
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-Import-Batch': batchId,
      'X-Import-Count': String(inputCount),
    },
    body: JSON.stringify({ url }),
  })
  const body = await jsonResponse(response, [200, 202])
  return { summary: body.resume, key, batchId }
}

export async function allPages(fixture, path, field) {
  const items = []
  const seen = new Set()
  let continuationToken
  do {
    const url = continuationToken ? `${path}?continuationToken=${encodeURIComponent(continuationToken)}` : path
    const page = await jsonResponse(await fixture.request(url))
    assert.ok(Array.isArray(page[field]), `Expected ${field} array.`)
    items.push(...page[field])
    continuationToken = page.continuationToken
    if (continuationToken) {
      assert.equal(seen.has(continuationToken), false, 'Repeated continuation tokens must not loop.')
      seen.add(continuationToken)
    }
  } while (continuationToken)
  return items
}

export function resumeSelection(summary) {
  assert.ok(summary.documentRef, 'A real analysis selection requires an extracted document.')
  return {
    resumeId: summary.resume.id,
    documentId: summary.documentRef.documentId,
    documentVersion: summary.documentRef.documentVersion,
    documentSha256: summary.documentRef.sha256,
  }
}

export const publicProfileHtml = `<html><head><title>Jordan Example - Professional profile</title></head>
<body><main><h1>Jordan Example</h1><p>Engineering specialist</p><p>Remote</p>
<h2>Experience</h2><p>Ten years of engineering experience.</p>
<p>Applied engineering methods independently across defined projects and communicated findings.</p>
<p>Prepared technical plans for defined engineering projects, documented assumptions, reviewed measurements, and explained the results to project reviewers. Maintained traceable methods and recorded the limits of each measurement process.</p>
<p>Worked with project teams to resolve documented implementation problems, maintain reproducible technical procedures, and communicate changes to established engineering methods. Prepared written review materials with supporting observations and clearly stated uncertainties.</p>
<h2>Education</h2><p>Bachelor of Engineering, Example University.</p></main></body></html>`

function quoteFor(paragraphs, text) {
  const paragraph = paragraphs.find((candidate) => candidate.text.includes(text))
  return paragraph ? { paragraphId: paragraph.paragraphId ?? paragraph.id, quote: paragraph.text } : undefined
}

function profileField(paragraphs, text) {
  const quote = quoteFor(paragraphs, text)
  return quote
    ? { status: 'available', value: text, citations: [quote] }
    : { status: 'unavailable', value: null, citations: [] }
}

function analysisCitationFor(input, text) {
  for (const [paragraphIndex, paragraph] of input.resume.paragraphs.entries()) {
    const passageIndex = paragraph.passages.findIndex(passage => passage.text.includes(text))
    if (passageIndex >= 0) return passageSelection(input, paragraphIndex, passageIndex)
  }
}

export function processingStubs(fixture, { urlPages = new Map(), onModelRequest, ocrParagraphs = resumeParagraphs } = {}) {
  const modelCalls = []
  const sourceCalls = []
  const ocrCalls = []
  const browserCalls = []
  const model = {
    endpoint: 'https://fixture-model.example.test',
    deployment: 'fixture-deployment',
    modelName: 'gpt-5-mini',
    reasoningEffort: 'low',
    clock: fixture.clock,
    getToken: async () => 'fixture-model-token',
    fetch: async (url, init) => {
      assert.equal(url, 'https://fixture-model.example.test/openai/v1/chat/completions')
      init.signal?.throwIfAborted()
      const request = JSON.parse(init.body)
      assert.equal(request.response_format.json_schema.strict, true)
      modelCalls.push(request)
      const overridden = await onModelRequest?.(request, init.signal, modelCalls.length)
      if (overridden !== undefined) {
        assert.ok(overridden instanceof Response)
        return overridden
      }
      const schema = request.response_format.json_schema.name
      const user = JSON.parse(request.messages[1].content)
      let output
      if (schema === 'resume_profile') {
        const paragraphs = user.source.paragraphs
        const professionalEvidence = [
          quoteFor(paragraphs, 'Applied engineering methods'),
          quoteFor(paragraphs, 'Bachelor of Engineering'),
        ].filter(Boolean)
        assert.ok(professionalEvidence.length, 'This fixture must contain actual professional source paragraphs.')
        output = {
          classification: 'single-profile',
          professionalEvidence,
          sparse: false,
          name: profileField(paragraphs, 'Jordan Example'),
          role: profileField(paragraphs, 'Engineering specialist'),
          location: profileField(paragraphs, 'Remote'),
          experience: profileField(paragraphs, 'Ten years of engineering experience.'),
        }
      } else if (schema === 'resume_rubric_assessment') {
        const input = user.input
        const work = analysisCitationFor(input, 'Applied engineering methods independently')
        const education = analysisCitationFor(input, 'Bachelor of Engineering')
        assert.ok(work, 'The assessment fixture must quote actual independent engineering work.')
        output = {
          criteria: input.rubric.criteria.map((criterion) => criterion.support === 'not-applicable' ? {
            criterionId: criterion.id,
            evidenceStatus: 'not-applicable',
            score: null,
            rationale: 'The exact approved rubric excludes this work row from scoring.',
            citations: [],
            limitation: null,
          } : {
            criterionId: criterion.id,
            evidenceStatus: 'supported',
            score: 3,
            rationale: 'The cited passage describes independent engineering work within defined projects, matching the saved independent-work anchor.',
            citations: [work],
            limitation: null,
          }),
          qualifications: input.qualifications.map((qualification) => ({
            qualificationId: qualification.id,
            evidenceStatus: education ? 'partial' : 'missing',
            rationale: education
              ? 'The document states an engineering degree. A reviewer must verify the saved requirement and its alternatives; this is not an eligibility decision.'
              : 'No supporting qualification passage was located in the supplied document; human review is required.',
            citations: education ? [education] : [],
            limitation: null,
          })),
        }
      } else if (schema === 'resume_rubric_grounding_review') {
        assert.ok(user.input && user.assessment, 'Grounding must independently receive the input and normalized assessment.')
        output = { outcome: 'supported', issues: [] }
      } else {
        assert.fail(`Unexpected inference schema: ${schema}`)
      }
      return Response.json({
        model: 'gpt-5-mini-fixture',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      })
    },
  }
  const documentIntelligence = {
    endpoint: 'https://fixture-ocr.example.test',
    clock: fixture.clock,
    getToken: async () => 'fixture-ocr-token',
    fetch: async (url, init = {}) => {
      assert.ok(url.startsWith('https://fixture-ocr.example.test/'))
      init.signal?.throwIfAborted()
      ocrCalls.push({ url, method: init.method ?? 'GET' })
      if (init.method === 'POST') {
        const bytes = Buffer.from(init.body)
        assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-')
        return new Response(null, {
          status: 202,
          headers: { 'operation-location': 'https://fixture-ocr.example.test/documentintelligence/operations/fixture' },
        })
      }
      return Response.json({
        status: 'succeeded',
        analyzeResult: {
          pages: [...new Set(ocrParagraphs.map((paragraph) => paragraph.page))].map((pageNumber) => ({ pageNumber })),
          paragraphs: ocrParagraphs.map((paragraph, index) => ({
            content: paragraph.text,
            spans: [{ offset: index * 250 }],
            boundingRegions: [{ pageNumber: paragraph.page }],
          })),
        },
      })
    },
  }
  const safeFetchOptions = {
    resolver: async (hostname) => {
      assert.ok([...urlPages.keys()].some((url) => new URL(url).hostname === hostname), `Unexpected source host: ${hostname}`)
      return ['93.184.216.34']
    },
    transport: async (request) => {
      request.signal?.throwIfAborted()
      const url = request.url.href
      sourceCalls.push(url)
      const page = urlPages.get(url)
      assert.ok(page, `Unexpected public source request: ${url}`)
      return {
        status: page.status ?? 200,
        headers: { 'content-type': page.contentType ?? 'text/html', ...page.headers },
        body: Buffer.from(page.body ?? ''),
      }
    },
  }
  const browser = {
    async render(url, options) {
      options.signal?.throwIfAborted()
      browserCalls.push(url)
      const page = urlPages.get(url)
      assert.ok(page?.renderedHtml, `Unexpected browser-rendering request: ${url}`)
      return { html: page.renderedHtml, finalUrl: page.finalUrl ?? url }
    },
  }
  return {
    modelCalls, sourceCalls, ocrCalls, browserCalls,
    resumes: {
      ...fixture.resumes, documentIntelligence, model, safeFetchOptions, browser, clock: fixture.clock,
      owner: `resume-integration-${randomUUID()}`,
    },
    analyses: {
      ...fixture.analyses, model, clock: fixture.clock,
      owner: `analysis-integration-${randomUUID()}`,
    },
  }
}

export async function processAllResumes(fixture, stubs) {
  for (let pass = 0; pass < 30; pass++) {
    const pending = [...fixture.resumes.store.values.values()].some(({ record }) =>
      record.recordType === 'resume' && ['queued', 'parsing', 'profiling'].includes(record.resume.status))
    if (!pending) return
    await fixture.runtime.api.resumeWorker.runResumeWorker(stubs.resumes, { maxItems: 20 })
    fixture.advanceClock(120_000)
  }
  assert.fail('Resume processing did not reach a terminal state within its bounded integration fixture.')
}

export async function processAllAnalyses(fixture, stubs) {
  for (let pass = 0; pass < 40; pass++) {
    const pending = [...fixture.analyses.store.values.values()].some(({ record }) =>
      record.recordType === 'analysis-run'
        ? record.status === 'initializing' || Boolean(record.cancellation && !record.cancellation.completedAt)
        : record.recordType === 'analysis-comparison' && ['queued', 'running'].includes(record.status))
    if (!pending) return
    await fixture.runtime.api.analysisWorker.runAnalysisWorker(stubs.analyses, { maxItems: 20 })
    fixture.advanceClock(120_000)
    // In-memory work must yield so the HTTP fixture can service idle socket timers.
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Analysis processing did not reach a terminal state within its bounded integration fixture.')
}
