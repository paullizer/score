import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  ACTOR, NOW, allowUnapprovedRubrics, api, approvalIdFor, clone, createRun, fixture, seedJob, seedResume,
} from './real-analyses.test-support.mjs'

const status = code => error => error?.status === code
const comparisonsOf = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
  .sort((a, b) => a.record.index - b.record.index)

/** Pins an owner's approval to one saved version, so later drafts don't move it. */
function approve(f, job, rubric) {
  const stored = f.jobValues.get(`${f.workspaceId}/${job.record.id}`)
  stored.record.rubricApproval = {
    approvalId: approvalIdFor(job.record.id), rubricId: rubric.id, version: rubric.version,
    rubricHash: api.analysisHash(rubric), approvedBy: ACTOR, approvedAt: NOW,
  }
}

test('while approval is required, discovery offers only approved job rubric versions and explains the rest', async () => {
  const f = fixture()
  const approved = await seedJob(f, 'Approved role')
  const unapproved = await seedJob(f, 'Draft-only role', randomUUID(), { approved: false })
  approve(f, approved, approved.rubric)
  const draft = { ...clone(approved.rubric), version: 2, name: 'Newer draft' }
  f.rubricValues.get(`${f.workspaceId}/${approved.record.id}`).push(draft)

  const page = await f.service.listTargets(f.workspaceId)
  const jobs = page.targets.filter(target => target.kind === 'job')
  assert.equal(jobs.length, 1, 'Only the approved version of the approved job is offered')
  assert.deepEqual(jobs[0].selection, approved.selection)
  assert.equal(jobs[0].selection.approvalId, approvalIdFor(approved.record.id))
  assert.equal(jobs[0].approvedAt, NOW)
  assert.equal(jobs[0].newerDraftAvailable, true)
  assert.match(jobs[0].sublabel, /approved v1$/)
  assert.equal(page.unapprovedJobRubrics, 1)
  assert.equal(jobs.some(target => target.selection.jobId === unapproved.record.id), false)

  const resume = await seedResume(f)
  const draftSelection = { ...approved.selection, rubricVersion: 2, rubricHash: api.analysisHash(draft) }
  delete draftSelection.approvalId
  for (const target of [unapproved.selection, draftSelection]) {
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), { name: 'Unapproved', resumes: [resume.selection], targets: [target] }, ACTOR),
      error => error.status === 409 && /isn't approved/.test(error.message))
  }
  const withoutApproval = { ...approved.selection }
  delete withoutApproval.approvalId
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), { name: 'Stale', resumes: [resume.selection], targets: [withoutApproval] }, ACTOR),
    error => error.status === 409 && /stale/.test(error.message), 'A selection must name the approval that is in force')
  assert.equal(f.analysis.store.values.size, 0)

  const created = await f.service.create(f.workspaceId, randomUUID(), { name: 'Approved', resumes: [resume.selection], targets: [approved.selection] }, ACTOR)
  const detail = await f.service.detail(f.workspaceId, created.run.id)
  assert.equal(detail.targets[0].selection.approvalId, approvalIdFor(approved.record.id), 'The frozen target records its approval')
  assert.equal(detail.targets[0].approvedAt, NOW)
})

test('a later approval does not strand retries of work accepted with the earlier approved version', async () => {
  const f = fixture()
  const created = await createRun(f, 1, 1)
  const job = created.targets[0]
  approve(f, job, job.rubric)
  const [comparison] = comparisonsOf(f, created.run.id)
  const cancelled = await f.service.comparisonAction(f.workspaceId, created.run.id, comparison.record.id, 'cancel', comparison.etag)
  const newer = { ...clone(job.rubric), version: 2, name: 'Approved later' }
  f.rubricValues.get(`${f.workspaceId}/${job.record.id}`).push(newer)
  approve(f, job, newer)
  f.jobValues.get(`${f.workspaceId}/${job.record.id}`).record.rubricApproval.approvalId = `rubric-approval-${randomUUID()}`
  const retried = await f.service.comparisonAction(f.workspaceId, created.run.id, cancelled.comparison.id, 'retry', cancelled.etag)
  assert.equal(retried.comparison.retryCount, 1)
  assert.equal(retried.comparison.target.summary.selection.rubricVersion, 1)
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), { ...created.request, name: 'New work' }, ACTOR), status(409),
    'New work must choose the version that is approved now')
})

test('Admin settings can let new analyses use any saved job rubric version', async () => {
  const f = allowUnapprovedRubrics(fixture())
  const unapproved = await seedJob(f, 'Draft-only role', randomUUID(), { approved: false })
  const page = await f.service.listTargets(f.workspaceId)
  assert.equal(page.unapprovedJobRubrics, undefined)
  const target = page.targets.find(item => item.kind === 'job' && item.selection.jobId === unapproved.record.id)
  assert.deepEqual(target.selection, unapproved.selection)
  assert.equal(target.approvedAt, undefined)
  const resume = await seedResume(f)
  const created = await f.service.create(f.workspaceId, randomUUID(), { name: 'Any version', resumes: [resume.selection], targets: [unapproved.selection] }, ACTOR)
  const detail = await f.service.detail(f.workspaceId, created.run.id)
  assert.equal(detail.targets[0].selection.approvalId, undefined)
})
