import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, seedResume, seedJob, seedGrade, finishInitialization, ACTOR,
} from './real-analyses.test-support.mjs'

test('mixed PDF, HTML, Markdown, DOCX and DOC inputs freeze together with seed-only grade evidence and no live historical reads', async () => {
  const f = fixture()
  const formats = ['pdf', 'url', 'markdown', 'docx', 'doc']
  const resumes = []
  const jobs = []
  const grades = []
  for (const kind of formats) {
    resumes.push(await seedResume(f, `Example ${kind}`, randomUUID(), { kind }))
    jobs.push(await seedJob(f, `Engineering ${kind}`, randomUUID(), { kind }))
  }
  for (const kind of ['markdown', 'docx', 'doc']) {
    grades.push(await seedGrade(f, jobs.find(job => job.record.source.kind === kind), { includeContentType: true }))
  }
  assert.equal(f.analysis.store.values.size, 0)
  const created = await f.service.create(f.workspaceId, randomUUID(), {
    name: 'Mixed immutable source formats',
    resumes: resumes.map(resume => resume.selection),
    targets: [...jobs, ...grades].map(target => target.selection),
  }, ACTOR)
  const run = await finishInitialization(f, created.run.id)
  assert.equal(run.record.progress.total, 40)
  assert.equal(run.record.progress.queued, 40)
  for (const values of [f.resumeValues, f.jobValues, f.rubricValues, f.gradeValues,
    f.resumes.blobs.values, f.jobs.blobs.values, f.grades.blobs.values]) values.clear()
  const comparisons = [...f.analysis.store.values.values()].filter(value =>
    value.record.recordType === 'analysis-comparison' && value.record.runId === created.run.id)
  assert.equal(comparisons.length, 40)
  for (const { record } of comparisons) {
    const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, record.id)
    const resume = resumes.find(value => value.record.id === detail.resumeSnapshot.resume.id)
    assert.deepEqual(detail.resumeSnapshot.document, resume.document)
    assert.deepEqual(detail.resumeSnapshot.capture, resume.record.capture)
    assert.equal(detail.resumeSnapshot.extraction.pagination, api.documentPagination(resume.original.contentType))
    assert.equal(detail.resumeSnapshot.extraction.pageCount, resume.record.source.kind === 'pdf' ? 1 : null)
    assert.equal(detail.comparison.status, 'queued')
    assert.equal(detail.result, null)
    const target = detail.targetSnapshot
    if (target.kind === 'job') {
      const job = jobs.find(value => value.record.id === target.job.id)
      assert.deepEqual(target.document, job.document)
      assert.equal(target.original.contentType, job.original.contentType)
      assert.equal(target.original.sha256, job.original.sha256)
      assert.equal(target.original.blobName,
        `${f.workspaceId}/${created.run.id}/evidence/${job.original.sha256}.${api.originalExtension(job.original.contentType)}`)
      const original = await api.readAnalysisBlob(f.analysis.blobs, target.original, f.workspaceId, created.run.id)
      assert.deepEqual(original.bytes, job.original.bytes)
      assert.deepEqual(target.requirementEvidence[0].citations, job.rubric.criteria[0].sourceCitations)
    } else {
      const grade = grades.find(value => value.selection.versionId === target.version.id)
      assert.deepEqual(target.sourceSet, grade.sourceSet)
      assert.deepEqual(target.seed, grade.seed)
      const seed = target.sourceSet.sources.find(source => source.origin === 'seed-job')
      assert.equal(seed.originalContentType, grade.seed.source.originalContentType)
      assert.equal(seed.purpose, 'job-context')
      assert.equal(api.gradeSourcePagination(seed), api.documentPagination(seed.originalContentType))
      assert.ok(target.sourceSet.sources.filter(source => source.origin !== 'seed-job')
        .every(source => ['application/pdf', 'text/html'].includes(source.originalContentType)))
    }
  }
})
