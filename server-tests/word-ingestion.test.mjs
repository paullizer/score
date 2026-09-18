import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { before, after, test } from 'node:test'
import { build } from 'esbuild'
import {
  buildResumeAnalysisTestRuntime, jsonResponse, processAllAnalyses, processAllResumes,
  processingStubs, resumeParagraphs, resumePdf, resumeSelection, startResumeAnalysisFixture,
} from '../src/services/resumeAnalysis.test-support.mjs'
import { seedRealJob } from '../src/services/gradeLadders.test-support.mjs'
import { docxFile, legacyDocFile } from './word-fixtures.mjs'

const MIME = { pdf: 'application/pdf', markdown: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' }
const resumeText = resumeParagraphs.map(paragraph => paragraph.text).join('\n')
const jobText = 'Engineering specialist\nRequirements\nApply engineering methods to defined projects and communicate findings.'
const file = (format, text) => format === 'docx' ? docxFile(text) : legacyDocFile(text)
let runtime, jobs

before(async () => {
  runtime = await buildResumeAnalysisTestRuntime()
  await build({
    stdin: {
      contents: "export * from './worker/runtime.ts'; export {validateRealRubric, validateRealJobRecord} from './server/jobs/validation.ts';",
      resolveDir: process.cwd(), sourcefile: 'word-job-runtime.ts', loader: 'ts',
    },
    outfile: join(runtime.directory, 'word-job-runtime.mjs'), bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  jobs = await import(pathToFileURL(join(runtime.directory, 'word-job-runtime.mjs')).href)
})
after(async () => { await runtime?.close() })

async function upload(fixture, collection, format, bytes, options = {}) {
  const key = options.key ?? randomUUID(), batch = options.batch ?? randomUUID()
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/${collection}/${options.route ?? 'file'}`, {
    method: 'POST', headers: {
      'Content-Type': options.contentType ?? MIME[format],
      'X-File-Name': encodeURIComponent(options.filename ?? `${collection}.${format}`),
      'Idempotency-Key': key, 'X-Import-Batch': batch, 'X-Import-Count': String(options.count ?? 1),
    }, body: bytes,
  })
  return { response, key, batch }
}

function wordOcr(fixture, bytes, text, calls = [], endpoint = 'https://word-service.example.test') {
  return {
    endpoint, clock: fixture.clock, getToken: async () => 'synthetic-token',
    fetch: async (_url, init = {}) => {
      calls.push(init.method ?? 'GET')
      if (init.method === 'POST') {
        assert.equal(init.headers['content-type'], MIME.docx)
        assert.deepEqual(Buffer.from(init.body), bytes)
        return new Response(null, { status: 202, headers: {
          'operation-location': `${endpoint}/documentintelligence/operations/word`,
        } })
      }
      return Response.json({ status: 'succeeded', analyzeResult: {
        pages: Array.from({ length: 60 }, (_, index) => ({ pageNumber: index + 1 })),
        paragraphs: text ? text.split('\n').map((content, index) => ({
          content, spans: [{ offset: index * 250 }],
          ...(index === 0 ? { role: 'title' } : /^(Requirements|Experience|Education)$/.test(content) ? { role: 'sectionHeading' } : {}),
        })) : [],
      } })
    },
  }
}

function jobModel(fixture) {
  return {
    endpoint: 'https://job-model.example.test', deployment: 'synthetic', modelName: 'gpt-5-mini',
    clock: fixture.clock, getToken: async () => 'synthetic-token',
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      const source = request.messages[1].content
      const match = /<paragraph id="([^"]+)"[^>]*>(Apply engineering methods[^<]*)<\/paragraph>/.exec(source)
      assert.ok(match, 'The generated rubric must quote the actual extracted Word requirement.')
      return Response.json({ model: 'synthetic-model', choices: [{ message: { content: JSON.stringify({
        isJobPosting: true, rejectionReason: null, title: 'Engineering specialist',
        organization: null, location: null, arrangement: null, employmentType: null, grade: null, series: null,
        description: 'Source-grounded engineering work expectations.', warnings: [],
        criteria: [{
          label: 'Engineering methods', description: 'Apply engineering methods within defined projects.',
          weight: 100, requirementType: 'required',
          guidance: '0: none; 1: minimal; 2: limited; 3: independent; 4: advanced; 5: expert.',
          sourceParagraphId: match[1], quote: match[2],
        }],
      }) } }] })
    },
  }
}

async function processJob(fixture, bytes, text, options = {}) {
  fixture.jobs.store.listPending = async (now, limit) => [...fixture.jobs.records.values()]
    .filter(({ record }) => ['queued', 'parsing', 'generating'].includes(record.job.status) &&
      (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now))
    .slice(0, limit).map(value => structuredClone(value))
  await jobs.runWorker({
    ...fixture.jobs, clock: fixture.clock, documentIntelligence: wordOcr(fixture, bytes, text),
    model: jobModel(fixture), validateRealRubric: jobs.validateRealRubric,
    ...options,
  }, { maxJobs: 1 })
}

for (const format of ['docx', 'doc']) {
  test(`${format.toUpperCase()} uploads become real job/resume evidence and frozen manual analysis inputs`, async (t) => {
    const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
    t.after(() => fixture.close())
    assert.equal((await jsonResponse(await fixture.request('/api/features'))).wordDocumentImports, true)
    const resumeBytes = file(format, resumeText), jobBytes = file(format, jobText)
    const resumeUpload = await upload(fixture, 'resumes', format, resumeBytes, { filename: `RESUME.${format.toUpperCase()}` })
    const resume = (await jsonResponse(resumeUpload.response, [202])).resume
    const jobUpload = await upload(fixture, 'jobs', format, jobBytes)
    const job = (await jsonResponse(jobUpload.response, [202])).job
    assert.equal(resume.resume.status, 'queued')
    assert.equal(resume.resume.name, null)
    assert.equal(job.job.status, 'queued')
    assert.equal(fixture.analyses.store.values.size, 0)
    const receipt = JSON.parse(Buffer.from((await fixture.resumes.blobs.read(`${fixture.workspaceId}/${resume.resume.id}/import-receipt.json`)).bytes))
    assert.equal(receipt.schemaVersion, 2)
    assert.equal(receipt.fileSha256, createHash('sha256').update(resumeBytes).digest('hex'))
    assert.equal(receipt.pdfSha256, undefined)

    const stubs = processingStubs(fixture)
    const ocrCalls = []
    stubs.resumes.documentIntelligence = wordOcr(fixture, resumeBytes, resumeText, ocrCalls)
    await processAllResumes(fixture, stubs)
    await processJob(fixture, jobBytes, jobText)
    const resumeDetail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${resume.resume.id}`))
    const jobDetail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/jobs/${job.job.id}`))
    assert.equal(resumeDetail.resume.status, 'ready', JSON.stringify(resumeDetail.error))
    assert.equal(jobDetail.job.status, 'ready', JSON.stringify(jobDetail.error))
    assert.equal(resumeDetail.extraction.method, format === 'doc' ? 'legacy-word' : 'document-intelligence')
    assert.equal(resumeDetail.extraction.pagination, 'captured-sections')
    assert.equal(resumeDetail.extraction.pageCount, null)
    assert.ok(resumeDetail.document.paragraphs.every(paragraph => paragraph.page === 1))
    assert.ok(jobDetail.document.paragraphs.every(paragraph => paragraph.page === 1))
    assert.equal(ocrCalls.length, format === 'doc' ? 0 : 2)
    assert.equal(fixture.analyses.store.values.size, 0, 'Profiling and rubric generation do not start scoring.')

    for (const [collection, id, original] of [['jobs', job.job.id, jobBytes], ['resumes', resume.resume.id, resumeBytes]]) {
      const download = await fixture.request(`/api/workspaces/${fixture.workspaceId}/${collection}/${id}/original`)
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('content-type'), MIME[format])
      assert.match(download.headers.get('content-disposition'), /^attachment;/)
      assert.match(download.headers.get('cache-control'), /no-store/)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), original)
    }
    const replay = await upload(fixture, 'resumes', format, resumeBytes, {
      key: resumeUpload.key, batch: resumeUpload.batch, filename: `RESUME.${format.toUpperCase()}`,
    })
    assert.equal(replay.response.status, 200)
    assert.equal((await replay.response.json()).resume.resume.id, resume.resume.id)
    const changed = await upload(fixture, 'resumes', format, file(format, resumeText + '\nNew content'), {
      key: resumeUpload.key, batch: resumeUpload.batch, filename: `RESUME.${format.toUpperCase()}`,
    })
    assert.equal(changed.response.status, 409)

    const targets = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/targets`))
    const target = targets.targets.find(value => value.selection.jobId === job.job.id)
    assert.ok(target)
    const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Word evidence review', resumes: [resumeSelection(resumeDetail)], targets: [target.selection] }),
    }), [202])
    const runId = created.run.run.id
    await processAllAnalyses(fixture, stubs)
    const comparisons = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons`))
    const comparison = comparisons.comparisons[0].comparison
    assert.equal(comparison.status, 'complete', JSON.stringify(comparison.error))
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${runId}/comparisons/${comparison.id}`))
    assert.equal(detail.resumeSnapshot.extraction.pagination, 'captured-sections')
    assert.equal(detail.targetSnapshot.original.contentType, MIME[format])
    assert.ok(detail.targetSnapshot.original.blobName.endsWith(`.${format}`))
    const frozen = await fixture.analyses.blobs.read(detail.targetSnapshot.original.blobName)
    assert.deepEqual(Buffer.from(frozen.bytes), jobBytes)
    assert.deepEqual(detail.resumeSnapshot.document, resumeDetail.document)
    assert.equal(detail.result.criteria[0].citations[0].quote, resumeParagraphs[4].text)
    assert.equal(fixture.state.saves.length, 0)
  })
}

test('PDF, Markdown, DOCX, and DOC share one durable batch and retain distinct evidence in a mixed analysis', async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  t.after(() => fixture.close())
  const features = await jsonResponse(await fixture.request('/api/features'))
  assert.equal(features.markdownJobImports, true)
  assert.equal(features.markdownResumeImports, true)
  assert.equal(features.wordDocumentImports, true)
  assert.equal(features.analysisLimits.maxComparisons, 500)
  const pdf = await resumePdf()
  const inputs = [
    { format: 'pdf', bytes: Buffer.from(await pdf.arrayBuffer()), route: 'pdf', filename: 'resume.pdf' },
    { format: 'markdown', bytes: Buffer.from(`# Jordan Example\n\n${resumeParagraphs.slice(1).map(paragraph => paragraph.text).join('\n\n')}`), route: 'markdown', filename: 'resume.MARKDOWN' },
    { format: 'docx', bytes: docxFile(resumeText), route: 'file', filename: 'resume.docx' },
    { format: 'doc', bytes: legacyDocFile(resumeText), route: 'file', filename: 'resume.doc' },
  ]
  const batch = randomUUID()
  const accepted = []
  for (const input of inputs) {
    const request = await upload(fixture, 'resumes', input.format, input.bytes, { ...input, batch, count: inputs.length })
    accepted.push({ input, request, summary: (await jsonResponse(request.response, [202])).resume })
  }
  const full = await upload(fixture, 'resumes', 'markdown', Buffer.from('# Another resume'), {
    route: 'markdown', filename: 'extra.md', batch, count: inputs.length,
  })
  assert.equal(full.response.status, 409)
  const stubs = processingStubs(fixture)
  const pdfFetch = stubs.resumes.documentIntelligence.fetch
  const docx = inputs.find(input => input.format === 'docx')
  const docxOcr = wordOcr(fixture, docx.bytes, resumeText, [], stubs.resumes.documentIntelligence.endpoint)
  let wordOperation = false
  stubs.resumes.documentIntelligence.fetch = (url, init = {}) => {
    if (init.method === 'POST') wordOperation = init.headers['content-type'] === MIME.docx
    return wordOperation ? docxOcr.fetch(url, init) : pdfFetch(url, init)
  }
  await processAllResumes(fixture, stubs)
  const details = []
  for (const { input, request, summary } of accepted) {
    const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${summary.resume.id}`))
    assert.equal(detail.resume.status, 'ready', JSON.stringify(detail.error))
    assert.equal(detail.source.kind, input.format)
    assert.equal(detail.capture.original.contentType, MIME[input.format])
    assert.equal(detail.extraction.pagination, input.format === 'pdf' ? 'pdf-pages' : input.format === 'markdown' ? 'markdown-sections' : 'captured-sections')
    const receipt = JSON.parse(Buffer.from((await fixture.resumes.blobs.read(`${fixture.workspaceId}/${summary.resume.id}/import-receipt.json`)).bytes))
    const digest = createHash('sha256').update(input.bytes).digest('hex')
    if (input.format === 'pdf' || input.format === 'markdown') {
      assert.equal(receipt.schemaVersion, 1)
      assert.equal(receipt[input.format === 'pdf' ? 'pdfSha256' : 'markdownSha256'], digest)
      assert.equal(receipt.fileSha256, undefined)
    } else {
      assert.equal(receipt.schemaVersion, 2)
      assert.equal(receipt.fileSha256, digest)
      assert.equal(receipt.markdownSha256, undefined)
    }
    assert.equal((await upload(fixture, 'resumes', input.format, input.bytes, {
      ...input, key: request.key, batch, count: inputs.length,
    })).response.status, 200)
    details.push(detail)
  }
  assert.equal([...fixture.resumes.store.values.values()].find(value => value.record.recordType === 'resume-batch').record.items.length, 4)
  const jobDocx = docxFile(jobText)
  await jsonResponse((await upload(fixture, 'jobs', 'docx', jobDocx)).response, [202])
  await jsonResponse((await upload(fixture, 'jobs', 'markdown', Buffer.from('# Engineering specialist\n\n## Requirements\n\nApply engineering methods to defined projects and communicate findings.'), {
    route: 'markdown', filename: 'job.md',
  })).response, [202])
  await processJob(fixture, jobDocx, jobText)
  await processJob(fixture, jobDocx, jobText)
  const targets = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/targets`))
  assert.equal(targets.targets.length, 2)
  assert.equal(fixture.analyses.store.values.size, 0)
  const created = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ name: 'Merged format evidence', resumes: details.map(resumeSelection), targets: targets.targets.map(target => target.selection) }),
  }), [202])
  await processAllAnalyses(fixture, stubs)
  const comparisons = [...fixture.analyses.store.values.values()].filter(value => value.record.recordType === 'analysis-comparison')
  assert.equal(comparisons.length, 8)
  assert.ok(comparisons.every(value => value.record.status === 'complete'), JSON.stringify(comparisons.map(value => value.record.error)))
  const run = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/${created.run.run.id}`))
  assert.equal(run.run.progress.total, 8)
  assert.equal(fixture.state.saves.length, 0)
})

test('Word admissions are gated, actual formats are checked, and membership is checked before parsing', async (t) => {
  const disabled = await startResumeAnalysisFixture(runtime)
  t.after(() => disabled.close())
  assert.equal((await jsonResponse(await disabled.request('/api/features'))).wordDocumentImports, false)
  for (const collection of ['jobs', 'resumes']) {
    assert.equal((await upload(disabled, collection, 'docx', docxFile())).response.status, 503)
  }
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  t.after(() => fixture.close())
  for (const collection of ['jobs', 'resumes']) {
    assert.equal((await upload(fixture, collection, 'docx', docxFile(), { route: 'pdf' })).response.status, 400)
    assert.equal((await upload(fixture, collection, 'docx', docxFile(), { filename: 'docx' })).response.status, 400)
    assert.equal((await upload(fixture, collection, 'doc', docxFile())).response.status, 400)
    assert.equal((await upload(fixture, collection, 'docx', Buffer.from('Not Word'))).response.status, 400)
    const encrypted = await upload(fixture, collection, 'doc', legacyDocFile('hidden', { encrypted: true }))
    assert.equal(encrypted.response.status, 400)
    assert.match(await encrypted.response.text(), /protection|protected/i)
  }
  assert.equal(fixture.jobs.records.size, 0)
  assert.equal(fixture.resumes.store.values.size, 0)
  fixture.setRole('viewer')
  for (const collection of ['jobs', 'resumes']) {
    assert.equal((await upload(fixture, collection, 'docx', Buffer.from('invalid'))).response.status, 403)
    assert.equal((await upload(fixture, collection, 'docx', Buffer.from('{invalid JSON'), {
      contentType: 'application/json',
    })).response.status, 403, 'Workspace authorization must precede JSON parsing for /file uploads too.')
  }
})

test('legacy Word provenance cannot label an existing PDF or HTML job', async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime)
  t.after(() => fixture.close())
  const pdf = await resumePdf()
  await jsonResponse((await upload(fixture, 'jobs', 'pdf', Buffer.from(await pdf.arrayBuffer()), {
    route: 'pdf', contentType: 'application/pdf',
  })).response, [202])
  await seedRealJob(fixture)
  assert.equal(fixture.jobs.records.size, 2)
  for (const { record } of fixture.jobs.records.values()) {
    assert.equal(jobs.validateRealJobRecord(record), true)
    assert.equal(jobs.validateRealJobRecord({
      ...record, source: { ...record.source, extractionMethod: 'legacy-word' },
    }), false)
  }
})

test('Word extraction is preserved across a failed profiling attempt and an explicit retry', async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  t.after(() => fixture.close())
  const bytes = docxFile(resumeText)
  const imported = await upload(fixture, 'resumes', 'docx', bytes)
  const summary = (await jsonResponse(imported.response, [202])).resume
  const stubs = processingStubs(fixture), calls = []
  stubs.resumes.documentIntelligence = wordOcr(fixture, bytes, resumeText, calls)
  const validModel = stubs.resumes.model
  stubs.resumes.model = { ...validModel, fetch: async () => Response.json({
    choices: [{ message: { content: 'invalid structured output' } }],
  }) }
  await processAllResumes(fixture, stubs)
  const path = `/api/workspaces/${fixture.workspaceId}/resumes/${summary.resume.id}`
  const failed = await jsonResponse(await fixture.request(path))
  assert.equal(failed.resume.status, 'error')
  assert.ok(failed.document)
  const savedExtraction = structuredClone(failed.extraction)
  assert.equal(calls.length, 2)
  await jsonResponse(await fixture.request(`${path}/retry`, {
    method: 'POST', headers: { 'If-Match': failed.etag },
  }))
  stubs.resumes.model = validModel
  await processAllResumes(fixture, stubs)
  const ready = await jsonResponse(await fixture.request(path))
  assert.equal(ready.resume.status, 'ready', JSON.stringify(ready.error))
  assert.deepEqual(ready.extraction, savedExtraction)
  assert.equal(calls.length, 2, 'Retry uses the immutable normalized source instead of OCR again.')
})

test('cancelling an in-flight Word extraction preserves the original and prevents late publication', { timeout: 30_000 }, async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  t.after(() => fixture.close())
  const bytes = docxFile(resumeText)
  const imported = (await jsonResponse((await upload(fixture, 'resumes', 'docx', bytes)).response, [202])).resume
  const stubs = processingStubs(fixture)
  stubs.resumes.documentIntelligence = wordOcr(fixture, bytes, resumeText)
  const fetchResult = stubs.resumes.documentIntelligence.fetch
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  stubs.resumes.documentIntelligence.fetch = async (url, init) => {
    const result = await fetchResult(url, init)
    if (init.method !== 'POST') { entered(); await held }
    return result
  }
  const work = runtime.api.resumeWorker.runResumeWorker(stubs.resumes, { maxItems: 1 })
  const path = `/api/workspaces/${fixture.workspaceId}/resumes/${imported.resume.id}`
  try {
    await started
    const active = await jsonResponse(await fixture.request(path))
    assert.equal(active.resume.status, 'parsing')
    const cancelled = await jsonResponse(await fixture.request(`${path}/cancel`, {
      method: 'POST', headers: { 'If-Match': active.etag },
    }))
    assert.equal(cancelled.resume.resume.status, 'cancelled')
  } finally {
    release()
    await work
  }
  const detail = await jsonResponse(await fixture.request(path))
  assert.equal(detail.resume.status, 'cancelled')
  assert.equal(detail.document, null)
  assert.equal(detail.profile, null)
  assert.equal(stubs.modelCalls.length, 0)
  assert.deepEqual(Buffer.from((await fixture.resumes.blobs.read(detail.capture.original.blobName)).bytes), bytes)
})

test('Word URLs stay unsupported and image-only Word uploads fail explicitly without profiling', async (t) => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  t.after(() => fixture.close())
  const url = 'https://documents.example.test/resume.docx'
  const stubs = processingStubs(fixture, { urlPages: new Map([[url, { body: docxFile(), contentType: MIME.docx }]]) })
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Import-Batch': randomUUID(), 'X-Import-Count': '1' },
    body: JSON.stringify({ url }),
  })
  const linked = (await jsonResponse(response, [202])).resume
  await processAllResumes(fixture, stubs)
  const rejected = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${linked.resume.id}`))
  assert.equal(rejected.resume.status, 'error')
  assert.equal(rejected.error.code, 'unsupported-content')
  assert.match(rejected.error.message, /uploaded as files/)
  assert.equal(stubs.browserCalls.length, 0)
  const jobResponse = await fixture.request(`/api/workspaces/${fixture.workspaceId}/jobs/url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ url }),
  })
  const linkedJob = (await jsonResponse(jobResponse, [202])).job
  await processJob(fixture, docxFile(), jobText, { safeFetchOptions: stubs.resumes.safeFetchOptions })
  const rejectedJob = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/jobs/${linkedJob.job.id}`))
  assert.equal(rejectedJob.job.status, 'error')
  assert.equal(rejectedJob.error.code, 'unsupported-content')
  assert.match(rejectedJob.error.message, /uploaded as files/)

  const bytes = docxFile('')
  const imported = (await jsonResponse((await upload(fixture, 'resumes', 'docx', bytes)).response, [202])).resume
  stubs.resumes.documentIntelligence = wordOcr(fixture, bytes, '')
  await processAllResumes(fixture, stubs)
  const empty = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.resume.id}`))
  assert.equal(empty.resume.status, 'error')
  assert.equal(empty.error.code, 'unreadable-document')
  assert.match(empty.error.message, /images|OCR/)
  assert.equal(stubs.modelCalls.length, 0)
})
