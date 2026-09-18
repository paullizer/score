import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, ACTOR, NOW, clone,
} from './real-analyses.test-support.mjs'

const request = (resume, target) => ({ name: 'Explicit Word comparison', resumes: [resume.selection], targets: [target.selection] })
async function freeze(f, resume, target) {
  const created = await f.service.create(f.workspaceId, randomUUID(), request(resume, target), ACTOR)
  const comparison = [...f.analysis.store.values.values()].find(value =>
    value.record.recordType === 'analysis-comparison' && value.record.runId === created.run.id).record
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.id)
  return { ...created, comparison, detail }
}
const snapshotBase = f => ({
  schemaVersion: 1, snapshotId: `analysis-snapshot-${randomUUID()}`, workspaceId: f.workspaceId, dataKind: 'real', frozenAt: NOW,
})

for (const format of ['docx', 'doc']) {
  test(`${format.toUpperCase()} frozen real inputs retain exact originals, citations and captured sections without live historical reads`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Renée Example', randomUUID(), format)
    const job = await seedJob(f, 'Engineering role', randomUUID(), format)
    const admittedOriginal = await f.jobs.blobs.read(job.record.source.originalBlobName)
    assert.equal(f.analysis.store.values.size, 0, 'Importing or discovering inputs never starts scoring.')
    const targets = await f.service.listTargets(f.workspaceId)
    assert.deepEqual(targets.targets[0].selection, job.selection)
    assert.equal(f.analysis.store.values.size, 0)
    const { run, comparison, detail } = await freeze(f, resume, job)
    assert.equal(comparison.status, 'queued')
    assert.equal(detail.result, null)
    const original = detail.targetSnapshot.original
    assert.equal(original.contentType, api.UPLOAD_CONTENT_TYPES[format])
    assert.equal(original.blobName, `${f.workspaceId}/${run.id}/evidence/${admittedOriginal.sha256}.${format}`)
    assert.deepEqual(Buffer.from((await f.analysis.blobs.read(original.blobName)).bytes), Buffer.from(admittedOriginal.bytes))
    assert.deepEqual(detail.resumeSnapshot.capture, resume.record.capture)
    assert.deepEqual(detail.resumeSnapshot.profile, resume.profile)
    assert.deepEqual(detail.targetSnapshot.rubric.criteria[0].sourceCitations, job.rubric.criteria[0].sourceCitations)
    assert.equal(detail.resumeSnapshot.extraction.pagination, 'captured-sections')
    assert.equal(detail.resumeSnapshot.extraction.pageCount, null)
    assert.equal(detail.resumeSnapshot.extraction.method, format === 'doc' ? 'legacy-word' : 'document-intelligence')
    assert.equal(api.documentPagination(original.contentType), 'captured-sections')
    assert.ok([...f.analysis.blobs.values.keys()].every(name => !name.includes(resume.record.id)),
      'Private resume originals remain referenced, not copied into the analysis store.')
    f.resumeValues.clear()
    f.resumes.blobs.values.clear()
    f.jobValues.clear()
    f.jobs.blobs.values.clear()
    const historical = await f.service.comparisonDetail(f.workspaceId, run.id, comparison.id)
    assert.deepEqual(historical.resumeSnapshot, detail.resumeSnapshot)
    assert.deepEqual(historical.targetSnapshot, detail.targetSnapshot)
    assert.deepEqual((await f.service.document(f.workspaceId, run.id, comparison.id, job.document.id, 1)).document, job.document)
    await assert.rejects(f.service.comparisonDetail('other-workspace', run.id, comparison.id))
    await assert.rejects(f.service.document(f.workspaceId, run.id, comparison.id, job.document.id, 2))
    const stored = f.analysis.blobs.values.get(original.blobName)
    f.analysis.blobs.values.set(original.blobName, { ...stored, bytes: Buffer.from('changed private original') })
    await assert.rejects(f.service.comparisonDetail(f.workspaceId, run.id, comparison.id), /digest|captured|unavailable/i)
  })

  test(`${format.toUpperCase()} frozen resume rejects foreign, mismatched, URL and synthetic-page provenance`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Renée Example', randomUUID(), format)
    const valid = {
      ...snapshotBase(f), selection: resume.selection, resume: resume.record.resume, source: resume.record.source,
      capture: resume.record.capture, extraction: resume.record.extraction, profile: resume.profile, document: resume.document,
    }
    assert.deepEqual(api.parseFrozenResumeSnapshot(valid), valid)
    for (const mutate of [
      value => { value.workspaceId = 'foreign-workspace' },
      value => { value.capture.original.blobName = value.capture.original.blobName.replace(f.workspaceId, 'foreign-workspace') },
      value => { value.capture.original.contentType = 'application/pdf' },
      value => { value.source.kind = format === 'doc' ? 'docx' : 'doc' },
      value => { value.source.fileName = value.source.displayName = 'misnamed.pdf' },
      value => { value.source.fileName = value.source.displayName = format; value.resume.sourceLabel = format },
      value => { value.extraction.method = format === 'doc' ? 'document-intelligence' : 'legacy-word' },
      value => { value.extraction.method = 'html' },
      value => { value.extraction.pagination = 'pdf-pages'; value.extraction.pageCount = 1 },
      value => { value.extraction.pagination = 'html-sections' },
      value => { value.extraction.pageCount = 1 },
      value => { value.document.paragraphs[0].page = 2; value.profile.name.citations[0].page = 2 },
      value => { value.capture.original.bytes = api.WORD_DOCUMENT_LIMITS.maxFileBytes + 1 },
      value => { value.capture.finalUrl = 'https://example.gov/resume' },
      value => { value.capture.redirects = ['https://example.gov/resume'] },
      value => { value.profile.name.citations[0].quote = 'An invented quotation' },
      value => { value.document.sample = true },
      value => { value.extraction.document.sha256 = '0'.repeat(64) },
      value => {
        value.source = { kind: 'url', displayName: 'https://example.gov/resume', url: 'https://example.gov/resume' }
        value.resume.sourceLabel = value.source.displayName
        value.capture.finalUrl = value.source.url
      },
    ]) {
      const invalid = clone(valid)
      mutate(invalid)
      assert.throws(() => api.parseFrozenResumeSnapshot(invalid))
    }
  })

  test(`${format.toUpperCase()} frozen job rejects mismatched kind, extension, extraction, hash and workspace`, async () => {
    const f = fixture()
    const resume = await seedResume(f)
    const job = await seedJob(f, 'Engineering role', randomUUID(), format)
    const { detail } = await freeze(f, resume, job)
    for (const mutate of [
      value => { value.workspaceId = 'foreign-workspace' },
      value => { value.source.kind = format === 'doc' ? 'docx' : 'doc' },
      value => { value.source.originalContentType = 'text/html' },
      value => { value.source.displayName = value.job.sourceLabel = 'incorrect.pdf' },
      value => { value.source.displayName = value.job.sourceLabel = format },
      value => { delete value.source.capturedAt },
      value => { value.source.extractionMethod = format === 'doc' ? 'document-intelligence' : 'legacy-word' },
      value => { value.source.url = 'https://example.gov/job' },
      value => { value.original.blobName = value.original.blobName.replace(`.${format}`, '.html') },
      value => { value.original.blobName = value.original.blobName.replace(value.original.sha256, '0'.repeat(64)) },
      value => { value.original.sha256 = '0'.repeat(64) },
      value => { value.original.bytes++ },
      value => { value.document.paragraphs[0].page = 2 },
      value => { value.document.sample = true },
      value => {
        value.source.kind = value.job.source = 'url'
        value.source.url = value.source.displayName = value.job.sourceLabel = 'https://example.gov/job'
      },
    ]) {
      const invalid = clone(detail.targetSnapshot)
      mutate(invalid)
      assert.throws(() => api.parseFrozenTargetSnapshot(invalid))
    }
  })

  test(`${format.toUpperCase()} approved GS seeds freeze independently with unchanged role-context authority and exact source-set bindings`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Renée Example', randomUUID(), format)
    const job = await seedJob(f, 'Engineering role', randomUUID(), format)
    const gs = await seedGrade(f, job)
    const { run, comparison, detail } = await freeze(f, resume, gs)
    const seed = detail.targetSnapshot.sourceSet.sources.find(source => source.origin === 'seed-job')
    assert.equal(seed.originalBlobName.endsWith(`/original.${format}`), true)
    assert.equal(seed.sha256, job.record.source.sha256)
    assert.equal(seed.pageCount, 1, 'The existing reference count denotes one captured section, not a physical Word page.')
    assert.equal(seed.purpose, 'job-context')
    assert.equal(seed.authorityStatus, 'supplied')
    assert.equal(api.gradeSourcePagination(seed), 'captured-sections')
    assert.deepEqual(detail.targetSnapshot.seed.document, job.document)
    assert.deepEqual(detail.targetSnapshot.seed.source, gs.seed.source)
    assert.deepEqual(detail.targetSnapshot.sourceSet, gs.sourceSet)
    for (const mutate of [
      value => { value.seed.source.originalContentType = 'text/html' },
      value => { value.seed.source.kind = 'url'; value.seed.job.source = 'url'; value.seed.source.url = 'https://example.gov/job' },
      value => { value.seed.source.originalBlobName = value.seed.source.originalBlobName.replace(f.workspaceId, 'other-workspace') },
      value => { value.seed.document.paragraphs[0].page = 2 },
      value => { value.seed.source.extractionMethod = 'html' },
      value => { delete value.seed.source.capturedAt },
      value => { value.seed.source.displayName = value.seed.job.sourceLabel = format },
    ]) {
      const invalid = clone(detail.targetSnapshot)
      mutate(invalid)
      assert.throws(() => api.parseFrozenTargetSnapshot(invalid))
    }
    for (const mutate of [
      source => { source.origin = 'upload'; source.purpose = 'agency' },
      source => { source.origin = 'url'; source.purpose = 'agency'; source.url = 'https://agency.example.gov/source.docx' },
      source => { source.purpose = 'background' },
      source => { source.selectedPages = [1] },
      source => { source.pageCount = 2 },
      source => { source.url = 'https://example.gov/job' },
    ]) {
      const invalid = clone(gs.sourceSet)
      mutate(invalid.sources.find(source => source.origin === 'seed-job'))
      invalid.contentHash = api.gradeSourceSetHash(invalid)
      assert.throws(() => api.parseGradeEntity(invalid))
    }
    f.gradeValues.clear()
    f.grades.blobs.values.clear()
    f.jobValues.clear()
    f.jobs.blobs.values.clear()
    f.resumeValues.clear()
    f.resumes.blobs.values.clear()
    assert.deepEqual((await f.service.comparisonDetail(f.workspaceId, run.id, comparison.id)).targetSnapshot, detail.targetSnapshot)
    assert.deepEqual((await f.service.document(f.workspaceId, run.id, comparison.id, job.document.id, 1)).document, job.document)
  })
}

for (const format of ['pdf', 'html']) {
  test(`historical ${format.toUpperCase()} frozen evidence keeps its exact shape, hash and pagination`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Jordan Example', randomUUID(), format)
    const job = await seedJob(f, 'Engineering role', randomUUID(), format)
    const { detail } = await freeze(f, resume, job)
    const serializedResume = JSON.stringify(detail.resumeSnapshot)
    const serializedJob = JSON.stringify(detail.targetSnapshot)
    assert.equal(JSON.stringify(api.parseFrozenResumeSnapshot(JSON.parse(serializedResume))), serializedResume)
    assert.equal(JSON.stringify(api.parseFrozenTargetSnapshot(JSON.parse(serializedJob))), serializedJob)
    assert.equal(detail.resumeSnapshot.capture.original.sha256, resume.record.capture.original.sha256)
    assert.equal(detail.targetSnapshot.original.sha256, job.record.source.sha256)
    assert.equal(detail.resumeSnapshot.extraction.pagination, format === 'pdf' ? 'pdf-pages' : 'html-sections')
    assert.equal(detail.resumeSnapshot.extraction.pageCount, format === 'pdf' ? 1 : null)
    assert.equal(detail.targetSnapshot.original.blobName.endsWith(`.${format}`), true)
    assert.deepEqual(detail.resumeSnapshot.extraction, resume.record.extraction)
    assert.deepEqual(detail.targetSnapshot.source, job.record.source)
    assert.throws(() => api.parseFrozenTargetSnapshot({
      ...detail.targetSnapshot, source: { ...detail.targetSnapshot.source, extractionMethod: 'legacy-word' },
    }))
    const gs = await seedGrade(f, job)
    const before = JSON.stringify(gs.sourceSet)
    assert.deepEqual(api.parseGradeEntity(JSON.parse(before)), gs.sourceSet)
    assert.equal(api.gradeSourceSetHash(api.parseGradeEntity(JSON.parse(before))), gs.sourceSet.contentHash)
    assert.equal(api.gradeSourcePagination(gs.sourceSet.sources[0]), format === 'pdf' ? 'pdf-pages' : 'html-sections')
    assert.throws(() => api.parseGradeSeedSnapshot({ ...gs.seed, source: { ...gs.seed.source, extractionMethod: 'legacy-word' } }))
  })
}
