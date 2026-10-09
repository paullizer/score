import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { fakeJobCosmos, realJobRecord, realJobRubric, JOB_TEST_WORKSPACE as workspaceId, JOB_TEST_ID as jobId, JOB_TEST_TIME as timestamp } from './job-cosmos-fake.mjs'

const output = join(process.cwd(), 'dist-server', `rubric-approval-store-${process.pid}.mjs`)
let api
before(async () => {
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      export { createJobStoreFromContainer } from './server/jobs/azure-store.ts'
      export { validateRealRubric } from './server/jobs/validation.ts'
      export { analysisHash } from './server/analyses/deterministic.ts'
      export { EVIDENCE_SCALE_VERSION, renderEvidenceGuidance } from './src/domain/evidence-scale.ts'
      export { RUBRIC_QA_VERSION, rubricQaChecks } from './src/domain/rubric-qa.ts'
      export { RUBRIC_REVIEW_PROMPT_VERSION, rubricQaRecordId } from './src/domain/rubric-approval.ts'
    ` },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  })
  api = await import(pathToFileURL(output).href)
})
after(async () => { await rm(output, { force: true }) })

const levels = [
  'Lists relevant training.',
  'Describes one relevant task.',
  'Describes repeated relevant work.',
  'Describes independent complex work.',
  'Describes leading relevant work with outcomes.',
].map((examples, index) => ({ level: index + 1, examples }))

function rubricFor(record, version = 1) {
  const rubric = realJobRubric(record, version)
  return {
    ...rubric, scaleVersion: api.EVIDENCE_SCALE_VERSION,
    criteria: rubric.criteria.map(criterion => ({ ...criterion, levels, guidance: api.renderEvidenceGuidance(levels) })),
  }
}

function qaFor(rubric) {
  return {
    id: api.rubricQaRecordId(rubric.id, rubric.version), workspaceId, recordType: 'rubric-qa', jobId,
    rubricId: rubric.id, version: rubric.version, rubricHash: api.analysisHash(rubric), qaVersion: api.RUBRIC_QA_VERSION,
    checks: [], review: { promptVersion: api.RUBRIC_REVIEW_PROMPT_VERSION, model: 'fixture-model', summary: 'No concerns.', findings: [] },
    createdBy: 'user', createdAt: timestamp,
  }
}

function approvalFor(rubric, checks, supersedes) {
  return {
    id: `rubric-approval-${randomUUID()}`, workspaceId, recordType: 'rubric-approval', jobId,
    rubricId: rubric.id, version: rubric.version, rubricHash: api.analysisHash(rubric), scaleVersion: api.EVIDENCE_SCALE_VERSION,
    qa: { id: checks.id, sha256: api.analysisHash(checks) },
    document: { id: `document-${jobId.slice(4)}`, version: 1, sha256: 'a'.repeat(64) },
    approvedBy: 'owner', approvedAt: timestamp, ...(supersedes ? { supersedes } : {}),
  }
}

function withApproval(value, approval) {
  return {
    ...value.record,
    rubricApproval: {
      approvalId: approval.id, rubricId: approval.rubricId, version: approval.version,
      rubricHash: approval.rubricHash, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
    },
  }
}

async function fixture({ checked = true } = {}) {
  const cosmos = fakeJobCosmos()
  const store = api.createJobStoreFromContainer(cosmos.container)
  const created = await store.create(realJobRecord())
  const rubric = rubricFor(created.value.record)
  const checks = qaFor(rubric)
  const record = { ...created.value.record, job: { ...created.value.record.job, status: 'ready', rubricId: rubric.id } }
  const value = await store.publish(record, created.value.etag, rubric, checked ? checks : undefined)
  return { cosmos, store, rubric, checks, value }
}

test('generated rubric, completed QA and ready job publish in one guarded transaction with the correct job ETag', async () => {
  const { cosmos, store, rubric, checks, value } = await fixture()
  assert.deepEqual(cosmos.batches.at(-1).map(operation => operation.resourceBody.recordType),
    ['workspace-lifecycle', 'rubric-version', 'rubric-qa', 'job'])
  assert.deepEqual(await store.getRubricQa(workspaceId, jobId, rubric.id, rubric.version), checks)
  assert.equal(value.etag, (await store.get(workspaceId, jobId)).etag, 'The ETag belongs to the job, not the inserted QA record')
  await store.replace({ ...value.record, updatedAt: timestamp }, value.etag)
})

test('atomic generation rejects mismatched QA without publishing a job or rubric', async () => {
  const cosmos = fakeJobCosmos()
  const store = api.createJobStoreFromContainer(cosmos.container)
  const created = await store.create(realJobRecord())
  const rubric = rubricFor(created.value.record)
  const record = { ...created.value.record, job: { ...created.value.record.job, status: 'ready', rubricId: rubric.id } }
  for (const change of [{ rubricHash: 'b'.repeat(64) }, { workspaceId: 'workspace-other' }, { jobId: `job-${randomUUID()}` }]) {
    await assert.rejects(store.publish(record, created.value.etag, rubric, { ...qaFor(rubric), ...change }), /checks.*match/)
  }
  assert.equal((await store.get(workspaceId, jobId)).record.job.status, 'queued')
  assert.deepEqual(await store.listRubrics(workspaceId, jobId), [])
  assert.ok(![...cosmos.records.values()].some(record => record.recordType === 'rubric-qa'))
})

test('long valid shared quotations retain their full evidence without overflowing the persisted QA diagnostic', async () => {
  const cosmos = fakeJobCosmos()
  const store = api.createJobStoreFromContainer(cosmos.container)
  const created = await store.create(realJobRecord())
  const rubric = rubricFor(created.value.record)
  const quote = 'Experience required for documented program delivery. '.repeat(500).trim()
  assert.ok(quote.length > 20_000, 'The fixture exceeds the persisted diagnostic bound')
  rubric.criteria[0].sourceCitations[0].quote = quote
  rubric.criteria[0].weight = 50
  rubric.criteria.push({ ...structuredClone(rubric.criteria[0]), id: 'criterion-two' })
  assert.deepEqual(api.validateRealRubric(rubric, {
    id: created.value.record.job.documentId, title: 'Test role', kind: 'job', version: 1, sample: false,
    paragraphs: [{ id: 'p1', page: 1, heading: '', text: quote }],
  }), [], 'This is valid source evidence, not malformed input')
  const checks = { ...qaFor(rubric), checks: api.rubricQaChecks(rubric) }
  const record = { ...created.value.record, job: { ...created.value.record.job, status: 'ready', rubricId: rubric.id } }
  await store.publish(record, created.value.etag, rubric, checks)
  const stored = await store.getRubricQa(workspaceId, jobId, rubric.id, 1)
  const overlap = stored.checks.find(finding => finding.code === 'shared-source-text')
  assert.equal(overlap.severity, 'warning')
  assert.ok(overlap.match.length <= 20_000)
  assert.equal((await store.listRubrics(workspaceId, jobId))[0].criteria[0].sourceCitations[0].quote, quote)
})

test('on-demand QA is create-only, bound to a saved hash, and rejects corrupt stored results', async () => {
  const { cosmos, store, rubric, checks } = await fixture({ checked: false })
  assert.deepEqual(await store.createRubricQa(checks), checks)
  assert.deepEqual(await store.createRubricQa({
    ...checks, review: { ...checks.review, summary: 'A competing model response.' },
  }), checks, 'The first checked result stays immutable')
  await assert.rejects(store.createRubricQa({ ...checks, rubricHash: 'b'.repeat(64) }), /do not match/)
  const missing = { ...checks, version: 2, id: api.rubricQaRecordId(rubric.id, 2) }
  await assert.rejects(store.createRubricQa(missing), /unavailable/)
  cosmos.write({ ...checks, jobId: `job-${randomUUID()}` })
  await assert.rejects(store.getRubricQa(workspaceId, jobId, rubric.id, rubric.version), /invalid ownership/)
})

test('approvals atomically move the pointer and supersede earlier approvals without overwriting audit records', async () => {
  const { cosmos, store, rubric, checks, value } = await fixture()
  const first = approvalFor(rubric, checks)
  const approved = await store.approveRubric(withApproval(value, first), value.etag, first)
  assert.deepEqual(cosmos.batches.at(-1).map(operation => operation.resourceBody.recordType),
    ['workspace-lifecycle', 'rubric-approval', 'job'])
  assert.equal(approved.etag, (await store.get(workspaceId, jobId)).etag)
  const secondRubric = rubricFor(approved.record, 2)
  const secondChecks = qaFor(secondRubric)
  const edited = await store.publish(approved.record, approved.etag, secondRubric, secondChecks)
  assert.equal(edited.record.rubricApproval.approvalId, first.id, 'Editing never changes the approved version')
  const second = approvalFor(secondRubric, secondChecks, first.id)
  const newer = await store.approveRubric(withApproval(edited, second), edited.etag, second)
  assert.equal(newer.record.rubricApproval.approvalId, second.id)
  const records = [...cosmos.records.values()].filter(record => record.recordType === 'rubric-approval')
  assert.equal(records.length, 2)
  assert.equal(records.find(record => record.id === first.id).supersedes, undefined)
  assert.equal(records.find(record => record.id === second.id).supersedes, first.id)
  await assert.rejects(store.approveRubric(withApproval(edited, second), edited.etag, second), /changed/)
})

test('ordinary job writes cannot remove or replace approval pointers or smuggle other changes through approval', async () => {
  const { store, rubric, checks, value } = await fixture()
  const approval = approvalFor(rubric, checks)
  const approved = await store.approveRubric(withApproval(value, approval), value.etag, approval)
  const changed = { ...approved.record, rubricApproval: undefined }
  await assert.rejects(store.replace(changed, approved.etag), /Only rubric approval/)
  await assert.rejects(store.publish(changed, approved.etag, rubricFor(approved.record, 2)), /Only rubric approval/)
  const nextApproval = approvalFor(rubric, checks, approval.id)
  await assert.rejects(store.approveRubric({
    ...withApproval(approved, nextApproval), job: { ...approved.record.job, title: 'Changed title' },
  }, approved.etag, nextApproval), /can change only/)
  const badSupersedes = approvalFor(rubric, checks)
  await assert.rejects(store.approveRubric(withApproval(approved, badSupersedes), approved.etag, badSupersedes), /Another approval/)
})

test('workspace fencing prevents late generation, QA and approval from crossing an archive', async () => {
  for (const action of ['publish', 'checks', 'approve']) {
    const { cosmos, store, rubric, checks, value } = await fixture({ checked: false })
    cosmos.beforeBatch(async () => { await store.setWorkspaceLifecycle(workspaceId, 'archived', timestamp) })
    if (action === 'publish') {
      const second = rubricFor(value.record, 2)
      await assert.rejects(store.publish(value.record, value.etag, second, qaFor(second)), /workspace is archived/)
    } else if (action === 'checks') {
      await assert.rejects(store.createRubricQa(checks), /workspace is archived/)
    } else {
      const approval = approvalFor(rubric, checks)
      await assert.rejects(store.approveRubric(withApproval(value, approval), value.etag, approval), /workspace is archived/)
    }
    assert.ok(![...cosmos.records.values()].some(record => ['rubric-qa', 'rubric-approval'].includes(record.recordType)))
    assert.equal((await store.listRubrics(workspaceId, jobId)).length, 1)
  }
})

test('rubric cleanup removes paginated QA and approval history and clears the approval pointer', async () => {
  const { cosmos, store, rubric, checks, value } = await fixture()
  const approval = approvalFor(rubric, checks)
  const approved = await store.approveRubric(withApproval(value, approval), value.etag, approval)
  for (let version = 2; version <= 61; version++) {
    const draft = rubricFor(approved.record, version)
    const qa = qaFor(draft)
    cosmos.write({ id: `rubric-version:${draft.id}:${version}`, workspaceId, recordType: 'rubric-version',
      jobId, rubricId: draft.id, version, rubric: draft })
    cosmos.write(qa)
    cosmos.write(approvalFor(draft, qa, approval.id))
  }
  const deleting = await store.transitionLifecycle(workspaceId, jobId, approved.etag, 'rubric', 'delete', timestamp)
  await assert.rejects(store.completeRubricDeletion(workspaceId, jobId, deleting.etag, timestamp), /cleanup has not completed/)
  await store.purgeRubrics(workspaceId, jobId)
  const deleted = await store.completeRubricDeletion(workspaceId, jobId, deleting.etag, timestamp)
  assert.equal(deleted.record.rubricApproval, undefined)
  assert.equal(deleted.record.job.rubricId, null)
  assert.equal(deleted.record.job.rubricDeletedAt, timestamp)
  assert.ok(![...cosmos.records.values()].some(record => ['rubric-version', 'rubric-qa', 'rubric-approval'].includes(record.recordType)))
  assert.ok(cosmos.batches.filter(batch => batch.some(operation => operation.operationType === 'Delete')).length >= 4)
})
