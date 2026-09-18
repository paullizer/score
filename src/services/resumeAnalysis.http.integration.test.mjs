import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import {
  allPages,
  buildResumeAnalysisTestRuntime,
  importResumeFile,
  importResumePdf,
  importResumeUrl,
  jsonResponse,
  processAllAnalyses,
  processAllResumes,
  processingStubs,
  publicProfileHtml,
  resumeParagraphs,
  resumePdf,
  resumeSelection,
  startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'
import { seededLadder, seedRealJob } from './gradeLadders.test-support.mjs'
import { docxFile, legacyDocFile } from '../../server-tests/word-fixtures.mjs'

let runtime
before(async () => { runtime = await buildResumeAnalysisTestRuntime() })
after(async () => { await runtime?.close() })

function importHeaders(batchId = randomUUID(), inputCount = 1, key = randomUUID()) {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': key,
    'X-Import-Batch': batchId,
    'X-Import-Count': String(inputCount),
  }
}

test('Word file HTTP intake matches frontend client routing and keeps private byte-identical originals and stable replay', async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  const restore = fixture.installClientFetch()
  try {
    const features = await jsonResponse(await fixture.request('/api/features'))
    assert.equal(features.wordDocumentImports, true)
    const batchId = randomUUID()
    for (const [format, bytes, contentType] of [
      ['docx', docxFile(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['doc', legacyDocFile(), 'application/msword'],
    ]) {
      const file = new File([bytes], `Rôle résumé.${format.toUpperCase()}`)
      const key = randomUUID()
      const job = await runtime.jobsClient.importRealJobFile(fixture.workspaceId, file, key, batchId)
      assert.equal(job.source.kind, format)
      assert.equal(job.source.originalContentType, contentType)
      assert.equal(job.job.status, 'queued')
      const replay = await runtime.jobsClient.importRealJobFile(fixture.workspaceId, file, key, batchId)
      assert.equal(replay.job.id, job.job.id)
      const resume = await importResumeFile(fixture, file, { batchId, inputCount: 2 })
      assert.equal(resume.summary.source.kind, format)
      assert.equal(resume.summary.resume.status, 'queued')
      assert.equal(resume.summary.capture.original.contentType, contentType)
      const replayResume = await importResumeFile(fixture, file, { key: resume.key, batchId, inputCount: 2 })
      assert.equal(replayResume.summary.resume.id, resume.summary.resume.id)
      for (const path of [
        runtime.jobsClient.realJobOriginalUrl(fixture.workspaceId, job.job.id),
        `/api/workspaces/${fixture.workspaceId}/resumes/${resume.summary.resume.id}/original`,
      ]) {
        const original = await fixture.request(path)
        assert.equal(original.status, 200)
        assert.equal(original.headers.get('content-type'), contentType)
        assert.match(original.headers.get('content-disposition'), /^attachment;/)
        assert.match(original.headers.get('cache-control'), /no-store/)
        assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
        assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
      }
    }
    assert.equal(fixture.analyses.store.values.size, 0, 'Importing Word prepares sources, never starts scoring.')
    assert.equal(fixture.state.saves.length, 0, 'Word bytes and metadata never enter sample autosave.')
    assert.equal(fixture.requests.filter((request) => request.method === 'POST' && /\/jobs\/file$/.test(request.url)).length, 4)
    assert.equal(fixture.requests.filter((request) => request.method === 'POST' && /\/resumes\/file$/.test(request.url)).length, 4)
  } finally { restore(); await fixture.close() }
})

test('Word file HTTP capabilities fail closed while existing PDF wrapper and receipt behavior stays unchanged', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const features = await jsonResponse(await fixture.request('/api/features'))
    assert.equal(features.wordDocumentImports, false)
    const file = new File([docxFile()], 'word.docx')
    for (const kind of ['jobs', 'resumes']) {
      const headers = {
        ...importHeaders(), 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'X-File-Name': encodeURIComponent(file.name),
      }
      const rejected = await fixture.request(`/api/workspaces/${fixture.workspaceId}/${kind}/file`, { method: 'POST', headers, body: Buffer.from(await file.arrayBuffer()) })
      assert.equal(rejected.status, 503)
      assert.match(await rejected.text(), /Word.*not enabled/i)
      const pdfOnly = await fixture.request(`/api/workspaces/${fixture.workspaceId}/${kind}/pdf`, { method: 'POST', headers, body: Buffer.from(await file.arrayBuffer()) })
      assert.equal(pdfOnly.status, 400)
    }
    const pdf = await resumePdf()
    const imported = await importResumePdf(fixture, pdf)
    const replay = await importResumeFile(fixture, pdf, { key: imported.key, batchId: imported.batchId })
    assert.equal(replay.summary.resume.id, imported.summary.resume.id)
    assert.equal(replay.summary.capture.original.contentType, 'application/pdf')
    assert.equal(fixture.requests.filter((request) => request.method === 'POST' && /\/resumes\/pdf$/.test(request.url)).length, 3)
  } finally { await fixture.close() }
})

test('combined Markdown and Word file HTTP batches preserve dedicated routes, exact bytes and declared mixed-batch size', async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { configOverrides: { wordDocumentImports: true } })
  try {
    const features = await jsonResponse(await fixture.request('/api/features'))
    assert.equal(features.markdownJobImports, true)
    assert.equal(features.markdownResumeImports, true)
    assert.equal(features.wordDocumentImports, true)
    const batchId = randomUUID()
    const files = [
      new File(['# Jordan Example\n\nEngineering experience.'], 'resume.MD', { type: 'text/plain' }),
      new File([docxFile()], 'resume.DOCX'),
      new File([legacyDocFile()], 'resume.DOC'),
      await resumePdf(),
    ]
    const saved = []
    for (const file of files) {
      const imported = await importResumeFile(fixture, file, { batchId, inputCount: 5 })
      saved.push(imported.summary)
      const original = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}/original`)
      assert.equal(original.status, 200)
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(await file.arrayBuffer()))
    }
    assert.deepEqual(saved.map((item) => item.source.kind), ['markdown', 'docx', 'doc', 'pdf'])
    assert.equal(new Set(saved.map((item) => item.resume.id)).size, 4)
    const batch = [...fixture.resumes.store.values.values()].find(({ record }) => record.recordType === 'resume-batch').record
    assert.equal(batch.inputCount, 5, 'The invalid frontend item still occupies its declared batch slot, but is not uploaded.')
    assert.equal(batch.items.length, 4)
    const posts = fixture.requests.filter((request) => request.method === 'POST')
    assert.deepEqual(posts.map((request) => request.url.split('/').at(-1)), ['markdown', 'file', 'file', 'pdf'])
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('real resume intake preserves actual bytes, same-basename people, duplicate warnings, and idempotent batch receipts', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const batchId = randomUUID()
    const firstFile = await resumePdf()
    const secondFile = await resumePdf({
      paragraphs: resumeParagraphs.map((paragraph, index) => index === 0 ? { ...paragraph, text: 'Morgan Example' } : paragraph),
    })
    const first = await importResumePdf(fixture, firstFile, { batchId, inputCount: 3 })
    const second = await importResumePdf(fixture, secondFile, { batchId, inputCount: 3 })
    const repeatedFile = new File([await firstFile.arrayBuffer()], 'another-label.pdf', { type: 'application/pdf' })
    const duplicate = await importResumePdf(fixture, repeatedFile, { batchId, inputCount: 3 })

    assert.notEqual(first.summary.resume.id, second.summary.resume.id, 'Filenames do not identify people.')
    assert.equal(first.summary.resume.status, 'queued')
    assert.equal(first.summary.resume.name, null, 'An upload filename is never a profile identity.')
    assert.equal(first.summary.documentRef, null, 'Accepted uploads are not yet extracted.')
    assert.equal(first.summary.capture.original.sha256, createHash('sha256').update(Buffer.from(await firstFile.arrayBuffer())).digest('hex'))
    assert.ok(duplicate.summary.duplicates.some((warning) => warning.kind === 'exact-content' && warning.resumeId === first.summary.resume.id))
    assert.notEqual(duplicate.summary.resume.id, first.summary.resume.id, 'A warning does not silently merge or overwrite records.')

    const original = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${first.summary.resume.id}/original`)
    assert.equal(original.status, 200)
    assert.match(original.headers.get('cache-control'), /(?:^|,)\s*no-store(?:,|$)/)
    assert.equal(original.headers.get('content-type'), 'application/pdf')
    assert.match(original.headers.get('content-disposition'), /^attachment;/)
    assert.deepEqual(new Uint8Array(await original.arrayBuffer()), new Uint8Array(await firstFile.arrayBuffer()))

    const replay = await importResumePdf(fixture, firstFile, { key: first.key, batchId, inputCount: 3 })
    assert.equal(replay.summary.resume.id, first.summary.resume.id, 'A full batch still permits an exact idempotent replay.')
    const changed = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/pdf`, {
      method: 'POST',
      headers: {
        ...importHeaders(batchId, 3, first.key),
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent(secondFile.name),
      },
      body: Buffer.from(await secondFile.arrayBuffer()),
    })
    assert.equal(changed.status, 409, 'The same request key cannot acquire different source bytes.')
    const resumes = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
    assert.equal(resumes.length, 3)
    assert.ok(fixture.requests.some((request) => request.url.includes('continuationToken=')), 'Real API paging was exercised.')
    assert.equal(fixture.state.saves.length, 0, 'Real sources never use legacy sample autosave.')
  } finally { await fixture.close() }
})

test('concurrent URL admission accepts ten independent inputs but never an eleventh in the same batch', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const batchId = randomUUID()
    const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => fixture.request(
      `/api/workspaces/${fixture.workspaceId}/resumes/url`,
      {
        method: 'POST',
        headers: importHeaders(batchId, 10),
        body: JSON.stringify({ url: `https://profiles.example.test/person-${index}` }),
      },
    )))
    const accepted = responses.filter((response) => [200, 202].includes(response.status))
    const rejected = responses.filter((response) => ![200, 202].includes(response.status))
    assert.equal(accepted.length, 10)
    assert.equal(rejected.length, 1)
    assert.ok([400, 409].includes(rejected[0].status))
    assert.match(await rejected[0].text(), /batch|10|ten|count|full|limit/i)
    const stored = [...fixture.resumes.store.values.values()]
    assert.equal(stored.filter(({ record }) => record.recordType === 'resume').length, 10)
    const batch = stored.find(({ record }) => record.recordType === 'resume-batch').record
    assert.equal(batch.inputCount, 10)
    assert.equal(batch.items.length, 10)
    assert.equal(new Set(batch.items.map((item) => item.resumeId)).size, 10)

    const oversized = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/url`, {
      method: 'POST',
      headers: importHeaders(randomUUID(), 11),
      body: JSON.stringify({ url: 'https://profiles.example.test/not-admitted' }),
    })
    assert.equal(oversized.status, 400)
    assert.equal((await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')).length, 10)
  } finally { await fixture.close() }
})

test('real resume APIs enforce actual PDF page/byte boundaries and safe public URL input', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const fifty = await resumePdf({ pages: 50, name: 'fifty.pdf' })
    const allowed = await importResumePdf(fixture, fifty)
    assert.equal(allowed.summary.resume.status, 'queued')
    const fiftyOne = await resumePdf({ pages: 51, name: 'fifty-one.pdf' })
    const pages = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/pdf`, {
      method: 'POST',
      headers: {
        ...importHeaders(),
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent(fiftyOne.name),
      },
      body: Buffer.from(await fiftyOne.arrayBuffer()),
    })
    assert.equal(pages.status, 400)
    assert.match(await pages.text(), /50|page/i)

    const pdf = Buffer.from(await (await resumePdf()).arrayBuffer())
    const maxBytes = 10 * 1024 * 1024
    const exactBytes = Buffer.concat([pdf, Buffer.alloc(maxBytes - pdf.length, 0x20)])
    const exact = await importResumePdf(fixture, new File([exactBytes], 'exact-limit.pdf', { type: 'application/pdf' }))
    assert.equal(exact.summary.capture.original.bytes, maxBytes)
    const tooLarge = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/pdf`, {
      method: 'POST',
      headers: { ...importHeaders(), 'Content-Type': 'application/pdf', 'X-File-Name': 'too-large.pdf' },
      body: Buffer.concat([exactBytes, Buffer.from(' ')]),
    })
    assert.equal(tooLarge.status, 413)

    for (const url of [
      'ftp://profiles.example.test/resume.pdf',
      'http://127.0.0.1/profile',
      'http://169.254.169.254/latest/meta-data/',
      'https://name:fixture-password@profiles.example.test/profile',
      'https://profiles.example.test:8443/profile',
      `https://profiles.example.test/${'a'.repeat(4096)}`,
    ]) {
      const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/url`, {
        method: 'POST', headers: importHeaders(), body: JSON.stringify({ url }),
      })
      assert.equal(response.status, 400)
    }
    assert.equal((await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')).length, 2)
  } finally { await fixture.close() }
})

test('real resume access is authorized before raw uploads and every original remains workspace-bound', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const imported = await importResumePdf(fixture, await resumePdf())
    const path = `/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`
    const created = await jsonResponse(await fixture.request('/api/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Another private workspace' }),
    }), [201])
    assert.equal((await fixture.request(`/api/workspaces/${created.workspace.id}/resumes/${imported.summary.resume.id}/original`)).status, 404)

    fixture.setRole('viewer')
    assert.equal((await fixture.request(path)).status, 200)
    assert.equal((await fixture.request(`${path}/original`)).status, 200)
    const denied = await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: 'not a PDF; missing import headers',
    })
    assert.equal(denied.status, 403, 'Role authorization must precede PDF parsing and import validation.')
    const action = await fixture.request(`${path}/cancel`, {
      method: 'POST', headers: { 'If-Match': imported.summary.etag },
    })
    assert.equal(action.status, 403)
    const anonymous = await fetch(`${fixture.origin}${path}`)
    assert.equal(anonymous.status, 401)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('unavailable real services do not substitute sample resumes or accept real work', async () => {
  const fixture = await startResumeAnalysisFixture(runtime, {
    configOverrides: { realResumes: undefined, realAnalyses: undefined },
  })
  try {
    const features = await jsonResponse(await fixture.request('/api/features'))
    assert.equal(features.realResumeImports, false)
    assert.equal(features.realAnalyses, false)
    assert.equal(features.realJobImports, true)
    assert.equal(features.realGradeLadders, true)
    assert.equal((await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes`)).status, 503)
    assert.equal((await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`)).status, 503)
    assert.equal((await fixture.request(`/api/workspaces/${fixture.workspaceId}/state`)).status, 200)
    assert.equal(fixture.resumes.store.values.size, 0)
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('the real resume worker processes PDF, public HTML, PDF links, and rendered profiles while blocked links fail independently', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const file = await resumePdf()
    const bytes = Buffer.from(await file.arrayBuffer())
    const htmlUrl = 'https://profiles.example.test/jordan'
    const pdfUrl = 'https://profiles.example.test/jordan.pdf'
    const scriptUrl = 'https://profiles.example.test/script-profile'
    const deniedUrl = 'https://www.linkedin.com/in/private-fixture'
    const loginUrl = 'https://www.linkedin.com/in/login-fixture'
    const urlPages = new Map([
      [htmlUrl, { body: publicProfileHtml }],
      [pdfUrl, { body: bytes, contentType: 'application/pdf' }],
      [scriptUrl, {
        body: '<html><head><title>Profile</title></head><body><div id="app"></div><script src="profile.js"></script></body></html>',
        renderedHtml: publicProfileHtml,
      }],
      [deniedUrl, { status: 403, body: 'Access requires sign-in.' }],
      [loginUrl, {
        body: '<html><head><title>Sign in | LinkedIn</title></head><body><main><h1>Sign in</h1><p>Sign in to view this profile.</p><form><input type="email"><input type="password"><button>Sign in</button></form></main></body></html>',
      }],
    ])
    const stubs = processingStubs(fixture, { urlPages })
    const batchId = randomUUID()
    const imported = [await importResumePdf(fixture, file, { batchId, inputCount: 6 })]
    for (const url of [htmlUrl, pdfUrl, scriptUrl, deniedUrl, loginUrl]) {
      imported.push(await importResumeUrl(fixture, url, { batchId, inputCount: 6 }))
    }
    assert.equal(stubs.modelCalls.length, 0, 'Accepting imports must not implicitly start an analysis or call a model in the API.')
    await processAllResumes(fixture, stubs)
    const summaries = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')
    assert.equal(summaries.filter((summary) => summary.resume.status === 'ready').length, 4,
      JSON.stringify(summaries.map((summary) => ({ source: summary.source, status: summary.resume.status, error: summary.error }))))
    assert.equal(summaries.filter((summary) => summary.resume.status === 'error').length, 2)
    for (const summary of summaries.filter((summary) => summary.resume.status === 'error')) {
      assert.equal(summary.error.code, 'access-blocked')
      assert.equal(summary.error.retryable, false)
      assert.match(summary.error.message, /not publicly accessible.*could not be processed/i)
      assert.equal(summary.documentRef, null)
      assert.equal(summary.resume.name, null, 'Blocked LinkedIn links never become replacement profiles.')
    }
    for (const summary of summaries.filter((summary) => summary.resume.status === 'ready')) {
      const detail = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${summary.resume.id}`))
      assert.equal(detail.document.kind, 'resume')
      assert.equal(detail.document.sample, false)
      assert.ok(detail.document.paragraphs.some((paragraph) => paragraph.text.includes('Applied engineering methods independently')))
      assert.equal(detail.profile.documentSha256, detail.documentRef.sha256)
      assert.equal(detail.profile.role.value, 'Engineering specialist')
      assert.equal(detail.extraction.pagination, detail.capture.original.contentType === 'application/pdf' ? 'pdf-pages' : 'html-sections')
    }
    assert.equal(stubs.modelCalls.length, 4, 'Only genuine sources reach the profile model.')
    assert.ok(stubs.modelCalls.every((request) => request.response_format.json_schema.name === 'resume_profile'))
    assert.deepEqual(stubs.browserCalls, [scriptUrl])
    assert.equal(stubs.ocrCalls.filter((request) => request.method === 'POST').length, 2)
    assert.equal(fixture.analyses.store.values.size, 0, 'Import does not automatically queue scoring.')

    const denied = summaries.find((summary) => summary.source.kind === 'url' && summary.source.url === deniedUrl)
    urlPages.set(deniedUrl, { body: publicProfileHtml })
    const retried = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${denied.resume.id}/retry`, {
      method: 'POST', headers: { 'If-Match': denied.etag },
    }), [200, 202])
    assert.equal(retried.resume.resume.id, denied.resume.id)
    await processAllResumes(fixture, stubs)
    const recovered = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${denied.resume.id}`))
    assert.equal(recovered.resume.status, 'ready')
    assert.equal(recovered.retryCount, 1)
    assert.equal((await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/resumes`, 'resumes')).length, imported.length)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('real analyses score exact saved job and approved GS versions and retain inspectable citations after later edits', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const seeded = await seededLadder(fixture)
    const supported = seeded.detail.levels.find((level) => level.head.grade === 9)
    const ladderPath = `/api/workspaces/${fixture.workspaceId}/grade-ladders/${seeded.detail.ladder.id}`
    let restore = fixture.installClientFetch()
    let approved
    try {
      const detail = await runtime.client.approveGrade(fixture.workspaceId, seeded.detail.ladder.id, 9, {
        versionId: supported.version.id, reviewId: supported.review.id,
      }, supported.etag)
      approved = detail.levels.find((level) => level.head.grade === 9)
      await runtime.client.saveGradeDraft(fixture.workspaceId, seeded.detail.ladder.id, 9, {
        rubric: { ...approved.version.rubric, name: 'A newer unapproved engineering draft' },
        qualifications: approved.version.qualifications,
      }, approved.etag)
    } finally { restore(); restore = undefined }

    const imported = await importResumePdf(fixture, await resumePdf())
    const stubs = processingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
    const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
    const job = targets.find((target) => target.kind === 'job' && target.selection.jobId === seeded.seed.job.id)
    const grade = targets.find((target) => target.kind === 'grade' && target.selection.grade === 9)
    assert.ok(job)
    assert.ok(grade, 'A newer unapproved draft must not hide or silently replace an exact approved version.')
    assert.equal(grade.selection.versionId, approved.version.id)
    assert.equal(grade.newerDraftAvailable, true)
    assert.equal(targets.some((target) => target.kind === 'grade' && target.selection.grade === 11), false)

    const input = { name: 'Engineering evidence review', resumes: [resumeSelection(resume)], targets: [job.selection, grade.selection] }
    const key = randomUUID()
    const create = () => fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
    })
    const created = (await jsonResponse(await create(), [200, 202])).run
    assert.equal(stubs.modelCalls.length, 1, 'The API creates durable work; only the worker performs analysis.')

    const jobRubrics = fixture.jobs.rubrics.get(`${fixture.workspaceId}/${seeded.seed.job.id}`)
    fixture.jobs.rubrics.set(`${fixture.workspaceId}/${seeded.seed.job.id}`, [
      ...jobRubrics,
      { ...structuredClone(jobRubrics.at(-1)), version: 3, name: 'A later edited job rubric', createdAt: fixture.now().toISOString() },
    ])
    const currentLadder = await jsonResponse(await fixture.request(ladderPath))
    restore = fixture.installClientFetch()
    try {
      await runtime.client.updateGradeSource(fixture.workspaceId, seeded.detail.ladder.id, seeded.source.id, {
        selectedPages: [178],
      }, currentLadder.etag)
    } finally { restore(); restore = undefined }

    await processAllAnalyses(fixture, stubs)
    const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
    const run = await jsonResponse(await fixture.request(runPath))
    assert.equal(run.run.status, 'complete')
    assert.equal(run.run.progress.complete, 2)
    assert.equal(run.run.progress.scored, 2)
    const comparisons = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    assert.equal(comparisons.length, 2)
    for (const { comparison } of comparisons) {
      const detailPath = `${runPath}/comparisons/${comparison.id}`
      const detail = await jsonResponse(await fixture.request(detailPath))
      assert.equal(detail.comparison.status, 'complete')
      assert.equal(detail.result.humanReviewRequired, true)
      assert.deepEqual(detail.result.overall, { status: 'available', score: 60 })
      assert.equal(detail.result.provenance.groundingReviews.at(-1).outcome, 'supported')
      assert.equal(detail.result.provenance.resumeSnapshot.sha256, comparison.resume.blob.sha256)
      assert.equal(detail.result.provenance.targetSnapshot.sha256, comparison.target.blob.sha256)
      const citation = detail.result.criteria[0].citations[0]
      assert.equal(citation.documentId, detail.resumeSnapshot.document.id)
      const document = await jsonResponse(await fixture.request(`${detailPath}/documents/${citation.documentId}?version=${citation.documentVersion}`))
      assert.ok(document.document.paragraphs.find((paragraph) => paragraph.id === citation.paragraphId).text.includes(citation.quote))
      if (detail.targetSnapshot.kind === 'grade') {
        assert.equal(detail.targetSnapshot.version.id, approved.version.id)
        const basis = detail.targetSnapshot.version.rubric.criteria[0].gradeBasis[0]
        const reference = await jsonResponse(await fixture.request(`${detailPath}/documents/${basis.documentId}?version=${basis.documentVersion}`))
        assert.ok(reference.document.paragraphs.some((paragraph) => paragraph.page === 178 && paragraph.text.includes(basis.quote)))
        assert.equal(detail.result.qualifications.length, 1)
        assert.equal('score' in detail.result.qualifications[0], false, 'Qualifications remain unscored human-review notes.')
      } else {
        assert.equal(detail.targetSnapshot.rubric.version, job.selection.rubricVersion)
        assert.notEqual(detail.targetSnapshot.rubric.name, 'A later edited job rubric')
      }
    }
    const modelCalls = stubs.modelCalls.length
    const replayed = (await jsonResponse(await create(), [200, 202])).run
    assert.equal(replayed.run.id, created.run.id, 'A creation replay uses the winning frozen manifest after source edits.')
    const retry = await fixture.request(`${runPath}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': run.etag }, body: '{}',
    })
    assert.ok([400, 409].includes(retry.status), 'Completed comparisons cannot be rewritten by retry.')
    await processAllAnalyses(fixture, stubs)
    assert.equal(stubs.modelCalls.length, modelCalls)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('500 real comparisons finish across bounded chunks and pages; a unique 501st target is rejected without work', async () => {
  const fixture = await startResumeAnalysisFixture(runtime, { pageSize: 50 })
  try {
    const imported = await importResumePdf(fixture, await resumePdf())
    const stubs = processingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
    for (let index = 0; index < 501; index++) await seedRealJob(fixture)
    const targets = (await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets'))
      .filter((target) => target.kind === 'job' && target.selection.rubricVersion === 2)
    assert.equal(targets.length, 501)
    const input = { name: 'Bounded comparison batch', resumes: [resumeSelection(resume)], targets: targets.map((target) => target.selection) }
    const oversized = await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input),
    })
    assert.equal(oversized.status, 400)
    assert.equal(fixture.analyses.store.values.size, 0)
    assert.equal(fixture.analyses.blobs.values.size, 0)

    const created = (await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...input, targets: input.targets.slice(0, 500) }),
    }), [200, 202])).run
    await processAllAnalyses(fixture, stubs)
    const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
    const run = await jsonResponse(await fixture.request(runPath))
    const comparisons = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    assert.equal(run.run.status, 'complete')
    assert.equal(run.run.progress.total, 500)
    assert.equal(run.run.progress.initialized, 500)
    assert.equal(run.run.progress.complete, 500)
    assert.equal(comparisons.length, 500)
    assert.equal(new Set(comparisons.map(({ comparison }) => comparison.id)).size, 500)
    assert.ok(comparisons.every(({ comparison }) => comparison.resultSummary.overall.score === 60))
    const chunks = fixture.analyses.store.transactions.filter((operations) =>
      operations.some((operation) => operation.kind === 'create' && operation.record.recordType === 'analysis-comparison'))
    assert.ok(chunks.length >= 20)
    assert.ok(chunks.every((operations) => operations.filter((operation) => operation.kind === 'create' &&
      operation.record.recordType === 'analysis-comparison').length <= 25))
    assert.equal(stubs.modelCalls.filter((request) => request.response_format.json_schema.name === 'resume_rubric_assessment').length, 500)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('a failed comparison does not rewrite a completed pair, and explicit retry retains its original target snapshot', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const firstJob = await seedRealJob(fixture)
    const secondJob = await seedRealJob(fixture)
    const imported = await importResumePdf(fixture, await resumePdf())
    let interruptSecond = true
    const stubs = processingStubs(fixture, {
      onModelRequest(request) {
        if (request.response_format.json_schema.name === 'resume_rubric_assessment' &&
          JSON.parse(request.messages[1].content).input.rubric.jobId === secondJob.job.id && interruptSecond) {
          return new Response('Fixture inference temporarily unavailable', { status: 503 })
        }
      },
    })
    await processAllResumes(fixture, stubs)
    const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
    const targets = (await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets'))
      .filter((target) => target.kind === 'job' && target.selection.rubricVersion === 2)
    const created = (await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Independent pair recovery', resumes: [resumeSelection(resume)], targets: targets.map((target) => target.selection) }),
    }), [200, 202])).run
    await processAllAnalyses(fixture, stubs)
    const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
    const partial = await jsonResponse(await fixture.request(runPath))
    assert.equal(partial.run.status, 'partial')
    assert.equal(partial.run.progress.complete, 1)
    assert.equal(partial.run.progress.failed, 1)
    const pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    const complete = pairs.find(({ comparison }) => comparison.status === 'complete')
    const failed = pairs.find(({ comparison }) => comparison.status === 'failed')
    assert.equal(complete.comparison.target.summary.selection.jobId, firstJob.job.id)
    assert.equal(failed.comparison.attempts, 3)
    assert.equal(failed.comparison.result, undefined)
    assert.equal(failed.comparison.resultSummary, undefined, 'A service failure is not a zero score.')
    const completeBefore = await jsonResponse(await fixture.request(`${runPath}/comparisons/${complete.comparison.id}`))
    const frozenVersion = failed.comparison.target.summary.selection.rubricVersion
    const liveRubrics = fixture.jobs.rubrics.get(`${fixture.workspaceId}/${secondJob.job.id}`)
    fixture.jobs.rubrics.set(`${fixture.workspaceId}/${secondJob.job.id}`, [
      ...liveRubrics,
      { ...structuredClone(liveRubrics.at(-1)), version: 3, name: 'Later live criteria not used by retry', createdAt: fixture.now().toISOString() },
    ])
    interruptSecond = false
    await jsonResponse(await fixture.request(`${runPath}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': partial.etag },
      body: JSON.stringify({ comparisonIds: [failed.comparison.id] }),
    }), [200, 202])
    await processAllAnalyses(fixture, stubs)
    const finished = await jsonResponse(await fixture.request(runPath))
    assert.equal(finished.run.status, 'complete')
    assert.equal(finished.run.progress.complete, 2)
    assert.deepEqual(await jsonResponse(await fixture.request(`${runPath}/comparisons/${complete.comparison.id}`)), completeBefore)
    const recovered = await jsonResponse(await fixture.request(`${runPath}/comparisons/${failed.comparison.id}`))
    assert.equal(recovered.comparison.retryCount, 1)
    assert.equal(recovered.targetSnapshot.rubric.version, frozenVersion)
    assert.equal(recovered.result.overall.score, 60)
    assert.equal(fixture.state.saves.length, 0)
  } finally { await fixture.close() }
})

test('real lifecycle preserves frozen model evidence, blocks retained dependencies and never restarts restored work', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const base = `/api/workspaces/${fixture.workspaceId}`
    const job = await seedRealJob(fixture)
    const bytes = Buffer.from(resumeParagraphs.map((item) => `## ${item.heading}\n\n${item.text}`).join('\n\n'))
    const imported = await importResumeFile(fixture, new File([bytes], 'retained-profile.md'))
    const stubs = processingStubs(fixture)
    await processAllResumes(fixture, stubs)
    const resumePath = `${base}/resumes/${imported.summary.resume.id}`
    const resume = await jsonResponse(await fixture.request(resumePath))
    const target = (await allPages(fixture, `${base}/analyses/targets`, 'targets'))
      .find((item) => item.kind === 'job' && item.selection.jobId === job.job.id && item.selection.rubricVersion === job.rubric.version)
    assert.ok(target)
    const input = { name: 'Archive-safe real evidence', resumes: [resumeSelection(resume)], targets: [target.selection] }
    const create = async () => (await jsonResponse(await fixture.request(`${base}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input),
    }), [200, 202])).run
    const change = async (path, action, extra = {}) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await jsonResponse(await fixture.request(path))
        const response = await fixture.request(`${path}/lifecycle`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': current.etag }, body: JSON.stringify({ action, ...extra }),
        })
        const result = await jsonResponse(response, [200, 202])
        if (!result.operation || result.operation.status === 'complete') return result
        assert.notEqual(result.deleted, true, 'Pending cleanup must never claim deletion completed.')
      }
      assert.fail('The bounded lifecycle operation did not finish after explicit, fresh-ETag retries.')
    }
    const created = await create()
    const runPath = `${base}/analyses/${created.run.id}`
    const before = await jsonResponse(await fixture.request(runPath))
    const archivedResume = await change(resumePath, 'archive')
    assert.ok(archivedResume.resume.lifecycle.archivedAt)
    await change(`${base}/jobs/${job.job.id}`, 'archive', { scope: 'job' })
    assert.equal((await allPages(fixture, `${base}/analyses/targets`, 'targets')).some((item) => item.kind === 'job' && item.selection.jobId === job.job.id), false)
    await processAllAnalyses(fixture, stubs)
    const finished = await jsonResponse(await fixture.request(runPath))
    assert.equal(finished.run.status, 'complete', 'Archiving inputs does not cancel an already frozen real analysis.')
    assert.deepEqual(finished.resumes, before.resumes)
    assert.deepEqual(finished.targets, before.targets)
    const pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    const detailPath = `${runPath}/comparisons/${pairs[0].comparison.id}`
    const evidence = await jsonResponse(await fixture.request(detailPath))
    assert.equal(evidence.resumeSnapshot.extraction.pagination, 'markdown-sections')
    assert.deepEqual(evidence.result.overall, { status: 'available', score: 60 })
    assert.equal(stubs.modelCalls.filter((request) => request.response_format.json_schema.name === 'resume_rubric_assessment').length, 1)
    const original = await fixture.request(`${resumePath}/original`)
    assert.equal(original.status, 200, 'Archived inputs retain authorized read-only original downloads.')
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    await change(runPath, 'archive')
    assert.deepEqual(await jsonResponse(await fixture.request(detailPath)), evidence)
    const impact = await jsonResponse(await fixture.request(`${resumePath}/lifecycle`))
    assert.ok(impact.impact.blockers.some((item) => item.kind === 'analysis' && item.id === created.run.id))
    const latestResume = await jsonResponse(await fixture.request(resumePath))
    const blocked = await fixture.request(`${resumePath}/lifecycle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': latestResume.etag }, body: JSON.stringify({ action: 'delete' }),
    })
    assert.equal(blocked.status, 409, await blocked.text())
    await change(resumePath, 'unarchive')
    await change(`${base}/jobs/${job.job.id}`, 'unarchive', { scope: 'job' })
    await change(runPath, 'delete')
    assert.equal((await fixture.request(detailPath)).status, 404)
    const second = await create()
    const secondPath = `${base}/analyses/${second.run.id}`
    await change(secondPath, 'archive')
    const cancelled = await jsonResponse(await fixture.request(secondPath))
    assert.equal(cancelled.run.status, 'cancelled', 'Run archive cancels only its own unfinished work.')
    const callsBeforeRestore = stubs.modelCalls.length
    await change(secondPath, 'unarchive')
    await processAllAnalyses(fixture, stubs)
    assert.equal((await jsonResponse(await fixture.request(secondPath))).run.status, 'cancelled')
    assert.equal(stubs.modelCalls.length, callsBeforeRestore, 'Restoring a run never queues automatic model scoring.')
    assert.equal((await jsonResponse(await fixture.request(resumePath))).resume.status, 'ready')
    await change(secondPath, 'delete')
    await change(resumePath, 'delete')
    assert.equal((await fixture.request(`${resumePath}/original`)).status, 404)
    assert.equal((await allPages(fixture, `${base}/resumes`, 'resumes')).length, 0)
    assert.equal(fixture.state.saves.length, 0, 'Real lifecycle never serializes real documents or runs into sample autosave.')
  } finally { await fixture.close() }
})

test('cancelling an in-flight real run fences late assessment publication', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  let release
  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  const heldResponse = new Promise((resolve) => { release = resolve })
  let enteredModel = false
  let processing
  try {
    await seedRealJob(fixture)
    const imported = await importResumePdf(fixture, await resumePdf())
    const stubs = processingStubs(fixture, {
      async onModelRequest(request) {
        if (request.response_format.json_schema.name === 'resume_rubric_assessment') {
          enteredModel = true
          entered()
          await heldResponse
        }
      },
    })
    await processAllResumes(fixture, stubs)
    const resume = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/resumes/${imported.summary.resume.id}`))
    const targets = await allPages(fixture, `/api/workspaces/${fixture.workspaceId}/analyses/targets`, 'targets')
    const created = (await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Cancel running assessment', resumes: [resumeSelection(resume)], targets: [targets[0].selection] }),
    }), [200, 202])).run
    const runPath = `/api/workspaces/${fixture.workspaceId}/analyses/${created.run.id}`
    processing = (async () => {
      for (let pass = 0; pass < 5; pass++) {
        await runtime.api.analysisWorker.runAnalysisWorker(stubs.analyses, { maxItems: 20 })
        if (enteredModel) return
        fixture.advanceClock(120_000)
      }
    })()
    const outcome = await Promise.race([
      enteredPromise.then(() => 'entered-model'),
      processing.then(() => 'worker-returned'),
    ])
    assert.equal(outcome, 'entered-model', 'The worker must start the pending comparison before cancellation.')
    const running = await jsonResponse(await fixture.request(runPath))
    assert.equal(running.run.progress.running, 1)
    const cancelled = await jsonResponse(await fixture.request(`${runPath}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': running.etag }, body: '{}',
    }), [200, 202])
    assert.equal(cancelled.run.run.status, 'cancelled')
    release()
    await processing
    await processAllAnalyses(fixture, stubs)
    const final = await jsonResponse(await fixture.request(runPath))
    const pairs = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    assert.equal(final.run.status, 'cancelled')
    assert.equal(final.run.progress.complete, 0)
    assert.equal(final.run.progress.cancelled, 1)
    assert.equal(pairs[0].comparison.status, 'cancelled')
    assert.equal(pairs[0].comparison.result, undefined)
    const detail = await jsonResponse(await fixture.request(`${runPath}/comparisons/${pairs[0].comparison.id}`))
    assert.equal(detail.result, null)
  } finally {
    release()
    await processing
    await fixture.close()
  }
})
