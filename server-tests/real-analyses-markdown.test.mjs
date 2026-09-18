import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, publishResult, ACTOR, NOW, clone,
} from './real-analyses.test-support.mjs'

async function comparison(f, resume, target) {
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Captured Markdown comparison', resumes: [resume.selection], targets: [target.selection],
  }, ACTOR)
  const stored = [...f.analysis.store.values.values()].find(value =>
    value.record.recordType === 'analysis-comparison' && value.record.runId === created.run.id)
  return {
    run: created.run, record: stored.record,
    detail: await f.service.comparisonDetail(f.workspaceId, created.run.id, stored.record.id),
  }
}

for (const extension of ['md', 'markdown']) {
  test(`Markdown .${extension} resume and job snapshots retain exact originals, citations and persisted results`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Jordan Example', randomUUID(), { kind: 'markdown', fileName: `resume.${extension}` })
    const job = await seedJob(f, 'Engineering role', randomUUID(), { kind: 'markdown', fileName: `job.${extension}` })
    assert.deepEqual((await f.service.listTargets(f.workspaceId)).targets[0].selection, job.selection)
    const { run, record, detail } = await comparison(f, resume, job)
    const frozenResume = detail.resumeSnapshot
    const frozenJob = detail.targetSnapshot
    assert.deepEqual(api.parseFrozenResumeSnapshot(JSON.parse(JSON.stringify(frozenResume))), frozenResume)
    assert.deepEqual(api.parseFrozenTargetSnapshot(JSON.parse(JSON.stringify(frozenJob))), frozenJob)
    assert.deepEqual(frozenResume.capture, resume.record.capture)
    assert.equal(frozenResume.extraction.method, 'markdown')
    assert.equal(frozenResume.extraction.pagination, 'markdown-sections')
    assert.equal(frozenResume.extraction.pageCount, null)
    assert.deepEqual(frozenResume.document, resume.document)
    assert.deepEqual(frozenJob.document, job.document)
    assert.deepEqual(frozenJob.rubric, job.rubric)
    assert.equal(frozenJob.original.blobName, `${f.workspaceId}/${run.id}/evidence/${job.original.sha256}.md`)
    assert.equal(frozenJob.original.contentType, 'text/markdown')
    assert.equal(frozenJob.original.bytes, job.original.bytes.byteLength)
    const original = await api.readAnalysisBlob(f.analysis.blobs, frozenJob.original, f.workspaceId, run.id)
    assert.deepEqual(original.bytes, job.original.bytes)
    assert.equal(original.sha256, job.original.sha256)
    assert.deepEqual((await f.resumes.blobs.read(frozenResume.capture.original.blobName)).bytes, resume.original.bytes)
    for (const citation of frozenJob.requirementEvidence[0].citations) {
      assert.equal(api.citationMatchesDocument(citation, frozenJob.document), true)
    }
    const published = await publishResult(f, run.id, record.id)
    const reloaded = new api.RealAnalysisService(f.analysis, {}, () => new Date(NOW))
    const restored = await reloaded.comparisonDetail(f.workspaceId, run.id, record.id)
    assert.deepEqual(restored.resumeSnapshot, frozenResume)
    assert.deepEqual(restored.targetSnapshot, frozenJob)
    assert.deepEqual(restored.result, published.result)
    for (const document of [resume.document, job.document]) {
      assert.deepEqual((await reloaded.document(f.workspaceId, run.id, record.id, document.id, document.version)).document, document)
    }
    const { criteria, qualifications, summary, limitations } = published.result
    const assessment = clone({ criteria, qualifications, summary, limitations })
    assert.deepEqual(api.validateAnalysisAssessment(assessment, resume.document, frozenJob), [])
    assessment.criteria[0].citations[0].quote = 'Uncaptured applicant evidence'
    assert.ok(api.validateAnalysisAssessment(assessment, resume.document, frozenJob).some(message => message.includes('Resume evidence')))
    assessment.criteria[0].citations = clone(criteria[0].citations)
    assessment.criteria[0].requirementCitations[0].heading = 'A different Markdown heading'
    assert.ok(api.validateAnalysisAssessment(assessment, resume.document, frozenJob).some(message => message.includes('exact saved requirement')))
  })
}

test('Markdown frozen metadata rejects URL provenance, wrong media/extraction/pagination, unsafe names and oversized originals', async () => {
  const f = fixture()
  const resume = await seedResume(f, 'Jordan Example', randomUUID(), { kind: 'markdown' })
  const job = await seedJob(f, 'Engineering role', randomUUID(), { kind: 'markdown' })
  const { detail } = await comparison(f, resume, job)
  const resumeChanges = [
    value => { value.source.fileName = '../resume.md' },
    value => { value.source.fileName = 'resume.pdf' },
    value => { value.source.fileName = 'CON.md' },
    value => { value.source.displayName = 'another.markdown' },
    value => { value.capture.finalUrl = 'https://example.org/resume.md' },
    value => { value.capture.redirects = ['https://example.org/resume.md'] },
    value => { value.capture.original.bytes = 10 * 1024 * 1024 + 1 },
    value => { value.capture.original.contentType = 'text/html'; value.capture.original.blobName = value.capture.original.blobName.replace(/\.md$/, '.html') },
    value => { value.capture.original.blobName = value.capture.original.blobName.replace(/\.md$/, '.markdown') },
    value => { value.extraction.method = 'html' },
    value => { value.extraction.method = 'browser' },
    value => { value.extraction.method = 'document-intelligence' },
    value => { value.extraction.pagination = 'html-sections' },
    value => { value.extraction.pagination = 'pdf-pages' },
    value => { value.extraction.pageCount = 1 },
    value => { value.extraction.normalizedCharacters++ },
    value => { value.profile.name.citations[0].paragraphId = 'unrelated' },
    value => {
      const url = 'https://example.org/resume.md'
      value.source = { kind: 'url', displayName: url, url }
      value.resume.sourceLabel = url
      value.capture.finalUrl = url
    },
  ]
  for (const change of resumeChanges) {
    const snapshot = clone(detail.resumeSnapshot)
    change(snapshot)
    assert.throws(() => api.parseFrozenResumeSnapshot(snapshot), undefined, change.toString())
  }
  const jobChanges = [
    value => { value.source.kind = 'url'; value.source.url = 'https://example.org/job.md'; value.job.source = 'url' },
    value => { value.source.finalUrl = 'https://example.org/job.md' },
    value => { value.source.displayName = '../job.md'; value.job.sourceLabel = '../job.md' },
    value => { value.source.extractionMethod = 'html' },
    value => { delete value.source.extractionMethod },
    value => { delete value.source.capturedAt },
    value => { value.source.sha256 = '0'.repeat(64) },
    value => { value.original.bytes = 10 * 1024 * 1024 + 1; value.source.bytes = value.original.bytes },
    value => { value.original.blobName = value.original.blobName.replace(/\.md$/, '.html') },
    value => { value.original.blobName = value.original.blobName.replace(/\.md$/, '.json') },
    value => { value.original.contentType = 'application/pdf' },
    value => { value.source.originalBlobName = value.source.originalBlobName.replace(/\.md$/, '.pdf') },
    value => { value.rubric.criteria[0].sourceCitations[0].quote = 'Uncaptured job requirement' },
  ]
  for (const change of jobChanges) {
    const snapshot = clone(detail.targetSnapshot)
    change(snapshot)
    assert.throws(() => api.parseFrozenTargetSnapshot(snapshot), undefined, change.toString())
  }
})

test('known job MIME preserves the physical PDF page limit without treating Markdown sections as PDF pages', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const pdf = await seedJob(f, 'PDF role', randomUUID(), { kind: 'pdf', page: 51 })
  await assert.rejects(comparison(f, resume, pdf), /invalid captured evidence/)
  const markdown = await seedJob(f, 'Markdown role', randomUUID(), { kind: 'markdown', page: 51 })
  const { detail } = await comparison(f, resume, markdown)
  assert.equal(detail.targetSnapshot.document.paragraphs[0].page, 51)
  assert.equal(detail.targetSnapshot.requirementEvidence[0].citations[0].page, 51)
  assert.deepEqual(api.parseFrozenTargetSnapshot(detail.targetSnapshot), detail.targetSnapshot)
  const physicalPdf = clone(detail.targetSnapshot)
  physicalPdf.job.source = 'pdf'
  physicalPdf.job.sourceLabel = 'job.pdf'
  Object.assign(physicalPdf.source, {
    kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf', extractionMethod: 'document-intelligence',
    originalBlobName: physicalPdf.source.originalBlobName.replace(/\.md$/, '.pdf'),
  })
  physicalPdf.original.contentType = 'application/pdf'
  physicalPdf.original.blobName = physicalPdf.original.blobName.replace(/\.md$/, '.pdf')
  assert.throws(() => api.parseFrozenTargetSnapshot(physicalPdf), /Invalid frozen job evidence/)
})

test('approved grade targets preserve Markdown seed snapshots without accepting Markdown supporting references', async () => {
  const f = fixture()
  const resume = await seedResume(f, 'Jordan Example', randomUUID(), { kind: 'markdown' })
  const job = await seedJob(f, 'Engineering role', randomUUID(), { kind: 'markdown' })
  const grade = await seedGrade(f, job, { includeContentType: true })
  const { run, record, detail } = await comparison(f, resume, grade)
  assert.deepEqual(detail.targetSnapshot.seed, grade.seed)
  assert.deepEqual(detail.targetSnapshot.sourceSet, grade.sourceSet)
  assert.equal(detail.targetSnapshot.seed.source.originalContentType, 'text/markdown')
  assert.equal(detail.targetSnapshot.sourceSet.sources.find(source => source.origin === 'seed-job').originalContentType, 'text/markdown')
  assert.equal(detail.targetSnapshot.references.find(reference => reference.source.origin === 'seed-job').source.originalContentType, 'text/markdown')
  assert.match(detail.targetSnapshot.seed.source.originalBlobName, /\/original\.md$/)
  const before = api.analysisHash(detail.targetSnapshot)
  const reloaded = new api.RealAnalysisService(f.analysis, {}, () => new Date(NOW))
  const restored = await reloaded.comparisonDetail(f.workspaceId, run.id, record.id)
  assert.equal(api.analysisHash(restored.targetSnapshot), before)
  assert.deepEqual((await reloaded.document(f.workspaceId, run.id, record.id, job.document.id, 1)).document, job.document)
  const invalid = clone(grade.sourceSet)
  const supporting = invalid.sources.find(source => source.origin !== 'seed-job')
  supporting.originalBlobName = supporting.originalBlobName.replace(/\.pdf$/, '.md')
  invalid.contentHash = api.gradeSourceSetHash(invalid)
  assert.throws(() => api.parseGradeEntity(invalid), /Original blob ownership/)
})

test('legacy job PDF basenames survive frozen analysis validation without resume filename restrictions', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const reloaded = new api.RealAnalysisService(f.analysis, {}, () => new Date(NOW))
  for (const fileName of ['Role: engineer.pdf', 'CON.pdf', ' leading.pdf', '"Role".pdf', 'Role*.pdf', 'Role?.pdf']) {
    const job = await seedJob(f, 'Existing PDF role', randomUUID(), { kind: 'pdf', fileName })
    const { run, record, detail } = await comparison(f, resume, job)
    assert.equal(detail.targetSnapshot.source.displayName, fileName)
    assert.equal(detail.targetSnapshot.job.sourceLabel, fileName)
    assert.deepEqual(api.parseFrozenTargetSnapshot(JSON.parse(JSON.stringify(detail.targetSnapshot))), detail.targetSnapshot)
    assert.deepEqual((await reloaded.comparisonDetail(f.workspaceId, run.id, record.id)).targetSnapshot, detail.targetSnapshot)
    const original = await api.readAnalysisBlob(f.analysis.blobs, detail.targetSnapshot.original, f.workspaceId, run.id)
    assert.deepEqual(original.bytes, job.original.bytes)
  }
})

for (const kind of ['pdf', 'url']) {
  test(`legacy ${kind === 'pdf' ? 'PDF' : 'HTML URL'} snapshots round-trip without migration or hash changes`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Jordan Example', randomUUID(), { kind })
    const job = await seedJob(f, 'Engineering role', randomUUID(), { kind })
    const { detail } = await comparison(f, resume, job)
    for (const [snapshot, parse] of [
      [detail.resumeSnapshot, api.parseFrozenResumeSnapshot],
      [detail.targetSnapshot, api.parseFrozenTargetSnapshot],
    ]) {
      const persisted = JSON.parse(JSON.stringify(snapshot))
      assert.deepEqual(parse(persisted), snapshot)
      assert.equal(api.analysisHash(parse(persisted)), api.analysisHash(snapshot))
    }
    assert.equal(detail.resumeSnapshot.extraction.pagination, kind === 'pdf' ? 'pdf-pages' : 'html-sections')
    assert.equal(detail.resumeSnapshot.extraction.pageCount, kind === 'pdf' ? 1 : null)
    assert.equal(detail.targetSnapshot.original.contentType, kind === 'pdf' ? 'application/pdf' : 'text/html')
  })
}
