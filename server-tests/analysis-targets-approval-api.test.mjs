import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { buildResumeAnalysisTestRuntime, jsonResponse, startResumeAnalysisFixture } from '../src/services/resumeAnalysis.test-support.mjs'
import { seedRealJob } from '../src/services/gradeLadders.test-support.mjs'

let runtime
before(async () => { runtime = await buildResumeAnalysisTestRuntime() })
after(async () => { await runtime?.close() })

// Each seeded job saves v1 and v2. The first job's owner approved v2; the second job has no approval yet.
async function seedJobs(fixture) {
  const approved = await seedRealJob(fixture)
  const draft = await seedRealJob(fixture)
  for (const value of fixture.jobs.records.values()) if (value.record.id === draft.job.id) delete value.record.rubricApproval
  return { approved, draft }
}

async function jobTargets(fixture) {
  const page = await jsonResponse(await fixture.request(`/api/workspaces/${fixture.workspaceId}/analyses/targets`))
  const targets = page.targets.filter(target => target.kind === 'job')
  return { page, targets, versions: targets.map(target => `${target.selection.jobId}:v${target.selection.rubricVersion}`).sort() }
}

test('the analysis target list follows the Admin rubric approval switch over HTTP', async (t) => {
  const required = await startResumeAnalysisFixture(runtime)
  t.after(() => required.close())
  const strictJobs = await seedJobs(required)
  const strict = await jobTargets(required)
  assert.deepEqual(strict.versions, [`${strictJobs.approved.job.id}:v2`], 'Only the approved version of an approved job is offered')
  assert.equal(strict.page.unapprovedJobRubrics, 1)
  const record = [...required.jobs.records.values()].find(value => value.record.id === strictJobs.approved.job.id).record
  assert.equal(strict.targets[0].selection.approvalId, record.rubricApproval.approvalId)
  assert.equal((await jsonResponse(await required.request('/api/features'))).rubricApprovalRequired, true)

  const optional = await startResumeAnalysisFixture(runtime, { rubricApprovalRequired: false })
  t.after(() => optional.close())
  const openJobs = await seedJobs(optional)
  const open = await jobTargets(optional)
  assert.deepEqual(open.versions, [openJobs.approved.job.id, openJobs.draft.job.id]
    .flatMap(jobId => [`${jobId}:v1`, `${jobId}:v2`]).sort(), 'Turning the switch off offers every saved version')
  assert.equal(open.page.unapprovedJobRubrics, undefined)
  assert.equal((await jsonResponse(await optional.request('/api/features'))).rubricApprovalRequired, false)
})
