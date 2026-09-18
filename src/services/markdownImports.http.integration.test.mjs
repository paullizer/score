import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import {
  allPages, jsonResponse, processAllAnalyses, processAllResumes, resumeSelection, startResumeAnalysisFixture,
} from './resumeAnalysis.test-support.mjs'
import {
  buildMarkdownRuntime, importMarkdown, jobRequirement, markdownJob, markdownProcessingStubs,
  markdownResume, markdownSeedLadder, processMarkdownJobs,
} from './markdownImports.test-support.mjs'

let runtime
before(async () => { runtime = await buildMarkdownRuntime() })
after(async () => { await runtime?.close() })

test('raw upload authorization and availability precede wrong-MIME JSON parsing in the complete app', async () => {
  for (const enabled of [true, false]) {
    const fixture = await startResumeAnalysisFixture(runtime, enabled ? {} : {
      configOverrides: { realJobs: undefined, realResumes: undefined },
    })
    try {
      for (const kind of ['jobs', 'resumes']) {
        for (const format of ['pdf', 'markdown']) {
          const path = `/api/workspaces/${fixture.workspaceId}/${kind}/${format}/?source=upload`
          const input = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-File-Name': `source.${format === 'pdf' ? 'pdf' : 'md'}`,
              'Idempotency-Key': randomUUID(), 'X-Import-Batch': randomUUID(), 'X-Import-Count': '1',
            },
            body: '{not valid JSON',
          }
          const unauthorized = await fetch(`${fixture.origin}${path}`, input)
          assert.equal(unauthorized.status, 401, `${kind}/${format} must authenticate before parsing JSON`)
          await unauthorized.arrayBuffer()
          const response = await fixture.request(path, input)
          assert.equal(response.status, enabled ? 400 : 503)
          const body = await response.json()
          if (enabled) assert.match(body.error.message, /Content-Type must be/)
          fixture.setRole('viewer')
          const readonly = await fixture.request(path, input)
          assert.equal(readonly.status, 403, 'Workspace write permission precedes every upload parser.')
          await readonly.arrayBuffer()
          fixture.setRole('owner')
        }
      }
      assert.equal(fixture.jobs.records.size, 0)
      assert.equal(fixture.resumes.store.values.size, 0)
    } finally { await fixture.close() }
  }
})

test('Markdown job/resume uploads reach ready, freeze exact analysis evidence, and seed a private grade source set', async () => {
  const fixture = await startResumeAnalysisFixture(runtime)
  try {
    const base = `/api/workspaces/${fixture.workspaceId}`
    const jobInput = await importMarkdown(fixture, 'jobs', markdownJob, 'engineering.MARKDOWN')
    const resumeInput = await importMarkdown(fixture, 'resumes', markdownResume, 'profile.md')
    assert.equal(jobInput.summary.job.status, 'queued')
    assert.equal(resumeInput.summary.resume.status, 'queued')
    assert.equal(resumeInput.summary.resume.name, null)
    const stubs = markdownProcessingStubs(fixture)
    await processMarkdownJobs(fixture, stubs)
    await processAllResumes(fixture, stubs)
    const job = await jsonResponse(await fixture.request(`${base}/jobs/${jobInput.summary.job.id}`))
    const resume = await jsonResponse(await fixture.request(`${base}/resumes/${resumeInput.summary.resume.id}`))
    assert.equal(job.job.status, 'ready', JSON.stringify(job.error))
    assert.equal(resume.resume.status, 'ready', JSON.stringify(resume.error))
    assert.equal(job.source.extractionMethod, 'markdown')
    assert.equal(resume.extraction.pagination, 'markdown-sections')
    assert.equal(resume.extraction.pageCount, null)
    assert.equal(resume.resume.name, 'Jordan Example')
    assert.deepEqual(stubs.ocrCalls, [])
    assert.deepEqual(stubs.browserCalls, [])
    assert.deepEqual(stubs.sourceCalls, [])
    assert.equal(fixture.analyses.store.values.size, 0, 'Imports never start an analysis.')

    for (const [kind, id, bytes, filename] of [
      ['jobs', job.job.id, markdownJob, 'engineering.MARKDOWN'],
      ['resumes', resume.resume.id, markdownResume, 'profile.md'],
    ]) {
      const original = await fixture.request(`${base}/${kind}/${id}/original`)
      assert.equal(original.status, 200)
      assert.match(original.headers.get('content-type'), /^text\/markdown(?:;|$)/)
      assert.ok(original.headers.get('content-disposition').includes(filename))
      assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    }

    const targets = await allPages(fixture, `${base}/analyses/targets`, 'targets')
    const target = targets.find(item => item.kind === 'job' && item.selection.jobId === job.job.id)
    assert.ok(target, 'A ready Markdown job is an eligible real target.')
    const created = (await jsonResponse(await fixture.request(`${base}/analyses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: 'Markdown evidence review', resumes: [resumeSelection(resume)], targets: [target.selection] }),
    }), [200, 202])).run
    await processAllAnalyses(fixture, stubs)
    const runPath = `${base}/analyses/${created.run.id}`
    const run = await jsonResponse(await fixture.request(runPath))
    assert.equal(run.run.status, 'complete')
    const comparisons = await allPages(fixture, `${runPath}/comparisons`, 'comparisons')
    assert.equal(comparisons.length, 1)
    const detailPath = `${runPath}/comparisons/${comparisons[0].comparison.id}`
    const detail = await jsonResponse(await fixture.request(detailPath))
    assert.deepEqual(detail.result.overall, { status: 'available', score: 60 })
    assert.equal(detail.resumeSnapshot.source.kind, 'markdown')
    assert.equal(detail.resumeSnapshot.extraction.pagination, 'markdown-sections')
    assert.equal(detail.targetSnapshot.source.kind, 'markdown')
    assert.equal(detail.targetSnapshot.original.contentType, 'text/markdown')
    assert.ok(detail.targetSnapshot.original.blobName.endsWith('.md'))
    assert.deepEqual(Buffer.from((await fixture.analyses.blobs.read(detail.targetSnapshot.original.blobName)).bytes), markdownJob)
    const quotation = detail.result.criteria[0].citations[0]
    const evidence = await jsonResponse(await fixture.request(`${detailPath}/documents/${quotation.documentId}?version=${quotation.documentVersion}`))
    assert.ok(evidence.document.paragraphs.find(paragraph => paragraph.id === quotation.paragraphId).text.includes(quotation.quote))
    assert.equal(detail.targetSnapshot.rubric.criteria[0].sourceCitations[0].quote, jobRequirement)
    assert.deepEqual(await jsonResponse(await fixture.request(detailPath)), detail, 'Reload uses the frozen Markdown evidence.')

    const ladder = await markdownSeedLadder(fixture, job)
    const seed = ladder.sources.find(source => source.origin === 'seed-job')
    assert.equal(seed.originalContentType, 'text/markdown')
    assert.equal(seed.extractionMethod, 'seed-snapshot')
    assert.ok(seed.originalBlobName.endsWith('/original.md'))
    assert.deepEqual(Buffer.from((await fixture.grades.blobs.read(seed.originalBlobName)).bytes), markdownJob)
    const frozenSeed = ladder.sourceSet.sources.find(source => source.sourceId === seed.id)
    assert.ok(frozenSeed.originalBlobName.endsWith('/original.md'))
    assert.equal(frozenSeed.originalContentType, 'text/markdown')
    const original = await fixture.request(`${base}/grade-ladders/${ladder.ladder.id}/sources/${seed.id}/original?sourceSetId=${ladder.sourceSet.id}`)
    assert.equal(original.status, 200)
    assert.match(original.headers.get('content-type'), /^text\/markdown(?:;|$)/)
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), markdownJob)
    assert.equal(fixture.state.saves.length, 0, 'Markdown sources are never saved to the sample workspace.')
  } finally { await fixture.close() }
})
