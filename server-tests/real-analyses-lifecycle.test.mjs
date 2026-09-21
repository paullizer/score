import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, createRun, seedJob, seedResume, seedGrade, publishResult, startHttp, ACTOR, NOW, LATER, clone, sha,
} from './real-analyses.test-support.mjs'
import { settleNarratives } from './real-analysis-narratives.test-support.mjs'

const lifecycle = f => new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(f.now))
const participant = f => api.createAnalysisLifecycleParticipant(f.analysis)
const comparisons = (f, runId) => [...f.analysis.store.values.values()]
  .filter(value => value.record.recordType === 'analysis-comparison' && value.record.runId === runId)
  .sort((a, b) => a.record.index - b.record.index)
const current = (f, runId) => f.analysis.store.get(f.workspaceId, runId)
const failStatus = expected => error => error.status === expected
async function change(f, runId, action) {
  const run = await current(f, runId)
  return lifecycle(f).change(f.workspaceId, runId, action, run.etag, ACTOR)
}
async function settle(f, runId) {
  for (let pass = 0; pass < 40; pass++) {
    const control = await f.analysis.store.getControl(f.workspaceId, runId)
    if (control?.record.state === 'deleted' || control?.record.operation?.status === 'complete') return
    try { await participant(f).resume(f.workspaceId, f.now) } catch (error) {
      assert.equal(error.status, 503)
    }
  }
  assert.fail('Lifecycle operation did not finish within its bounded passes.')
}

test('permanent deletion of an uninitialized 500-pair run resumes every cancellation and cleanup chunk', async () => {
  const f = fixture()
  const run = await createRun(f, 125, 4)
  const first = await change(f, run.run.id, 'delete')
  assert.equal(first.pending, true)
  assert.equal(first.analysis.run.progress.initialized, 100)
  assert.equal(first.analysis.run.progress.cancelled, 100)
  await settle(f, run.run.id)
  assert.equal(await current(f, run.run.id), undefined)
  assert.equal(comparisons(f, run.run.id).length, 0)
  assert.equal(f.analysis.blobs.values.size, 0)
  const deleted = f.analysis.store.batches.flat().filter(item => item.kind === 'delete')
  assert.equal(deleted.filter(item => item.record.recordType === 'analysis-comparison').length, 500)
  assert.equal(deleted.filter(item => item.record.recordType === 'analysis-run').length, 1)
  assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26 &&
    Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
})

test('the last budgeted cleanup page completes small deletions without an unnecessary pending response', async () => {
  for (const boundary of ['records', 'blobs']) {
    const f = fixture()
    const created = await createRun(f, boundary === 'records' ? 8 : 1)
    let pages = 0
    if (boundary === 'records') {
      const list = f.analysis.store.list.bind(f.analysis.store)
      f.analysis.store.list = async (workspaceId, options) => {
        const page = await list(workspaceId, options.recordType === 'analysis-comparison' ? { ...options, limit: 2 } : options)
        if (options.recordType === 'analysis-comparison' && page.items.length) pages++
        return page
      }
    } else {
      await publishResult(f, created.run.id, comparisons(f, created.run.id)[0].record.id)
      assert.equal((await settleNarratives(f, created.run.id)).ready, true)
      assert.ok(f.analysis.blobs.values.size >= 4)
      const list = f.analysis.blobs.list.bind(f.analysis.blobs)
      f.analysis.blobs.list = async (...args) => {
        const page = await list(...args)
        if (!page.items.length || ++pages === 4) return page
        return { items: page.items.slice(0, 1), continuationToken: '1' }
      }
    }
    assert.deepEqual(await change(f, created.run.id, 'delete'), { deleted: true }, boundary)
    assert.equal(pages, 4, boundary)
    assert.equal(await current(f, created.run.id), undefined)
    assert.equal(f.analysis.store.values.size, 0)
    assert.equal(f.analysis.blobs.values.size, 0)
    assert.equal((await f.analysis.store.getControl(f.workspaceId, created.run.id)).record.state, 'deleted')
    assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26 &&
      Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
  }
})

test('ambiguous lifecycle fence and final tombstone commits are reconciled without losing recovery or reviving work', async () => {
  for (const stage of ['fence', 'comparison', 'tombstone', 'archive-complete']) {
    const f = fixture()
    const run = await createRun(f)
    let interrupted = false
    const interrupt = async operations => {
      const control = await f.analysis.store.getControl(f.workspaceId, run.run.id)
      const matches = stage === 'fence' || stage === 'comparison' &&
        operations.some(item => item.kind === 'delete' && item.record.recordType === 'analysis-comparison') ||
        stage === 'tombstone' && control.record.state === 'deleted' ||
        stage === 'archive-complete' && control.record.operation?.status === 'complete'
      if (matches && !interrupted) {
        interrupted = true
        throw new Error('Lost lifecycle transaction response')
      }
      if (!interrupted) f.analysis.store._afterBatch(interrupt)
    }
    f.analysis.store._afterBatch(interrupt)
    const result = await change(f, run.run.id, stage === 'archive-complete' ? 'archive' : 'delete')
    assert.equal(interrupted, true)
    if (stage === 'comparison') {
      assert.equal(result.pending, true)
      await settle(f, run.run.id)
    } else assert.equal(result.pending, undefined)
    if (stage === 'archive-complete') {
      assert.equal(result.analysis.run.progress.cancelled, 1)
      assert.equal(result.analysis.operation.status, 'complete')
    } else assert.equal(await current(f, run.run.id), undefined)
  }
})

test('creation rechecks exact source eligibility after capture and cannot admit a previously prepared archived input', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const request = { name: 'Intake eligibility race', resumes: [resume.selection], targets: [job.selection] }
  const key = randomUUID()
  f.analysis.blobs._afterPut(name => {
    if (name.endsWith('/manifest.json')) f.resumeValues.get(`${f.workspaceId}/${resume.record.id}`).record.lifecycle = { archivedAt: NOW }
  })
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), failStatus(409))
  assert.equal(f.analysis.store.values.size, 0)
  const prepared = clone(f.analysis.blobs.values.get(`${f.workspaceId}/analysis-run-${key}/manifest.json`))
  assert.ok(prepared)
  await assert.rejects(f.service.create(f.workspaceId, key, request, ACTOR), failStatus(409))
  assert.equal(f.analysis.store.values.size, 0)
  assert.deepEqual(f.analysis.blobs.values.get(`${f.workspaceId}/analysis-run-${key}/manifest.json`), prepared)
})

test('source workspace and family deletion controls reject intake before new work is published', async () => {
  for (const state of ['archived', 'deleting', 'deleted']) {
    for (const source of ['resume', 'resume-workspace', 'job-workspace', 'grade-family', 'grade-workspace']) {
      const f = fixture()
      const resume = await seedResume(f)
      const job = await seedJob(f)
      const grade = source.startsWith('grade') ? await seedGrade(f, job) : undefined
      const request = { name: 'Fenced source', resumes: [resume.selection], targets: [(grade ?? job).selection] }
      if (source.startsWith('resume')) f.resumes.store.getControl = async (workspaceId, id) => {
        if ((source === 'resume' && id === resume.record.id) || (source === 'resume-workspace' && id === undefined)) {
          return { record: {
            id: id ? `resume-lifecycle-${id}` : 'resume-lifecycle-workspace', recordType: 'resume-lifecycle',
            workspaceId, ...(id ? { resumeId: id } : {}), state, updatedAt: NOW,
          }, etag: '"fenced-source"' }
        }
      }
      if (source === 'job-workspace') f.jobs.store.getWorkspaceLifecycle = async () => ({ state, updatedAt: NOW })
      if (source.startsWith('grade')) f.grades.store.getControl = async (workspaceId, id) => {
        if ((source === 'grade-family' && id === grade.ladder.id) || (source === 'grade-workspace' && id === undefined)) {
          return { record: {
            id: id ? `grade-lifecycle-${id}` : 'grade-lifecycle-workspace', recordType: 'grade-lifecycle',
            workspaceId, ...(id ? { ladderId: id } : {}), state, updatedAt: NOW,
          }, etag: '"fenced-source"' }
        }
      }
      await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR), failStatus(409))
      assert.equal(f.analysis.store.values.size, 0)
    }
  }
})

test('stale recovery discovery cannot cancel explicitly retried work after a completed unarchive operation', async () => {
  const f = fixture()
  const run = await createRun(f)
  await change(f, run.run.id, 'archive')
  const restored = await change(f, run.run.id, 'unarchive')
  await f.service.retry(f.workspaceId, run.run.id, {}, restored.etag)
  const before = await current(f, run.run.id)
  const list = f.analysis.store.listControls.bind(f.analysis.store)
  f.analysis.store.listControls = async (...args) => {
    const page = await list(...args)
    for (const value of page.items) if (value.record.runId === run.run.id) value.record.operation.status = 'pending'
    return page
  }
  await participant(f).resume(f.workspaceId, NOW)
  assert.deepEqual(await current(f, run.run.id), before)
  assert.equal(before.record.progress.queued, 1)
})

test('automatic lifecycle recovery preserves paused cancellation budgets; only an explicit action resets them', async () => {
  const f = fixture()
  const run = await createRun(f, 125, 4)
  await change(f, run.run.id, 'archive')
  const value = await current(f, run.run.id)
  const paused = await f.analysis.store.replace({
    ...value.record, attempts: 3, error: {
      code: 'snapshot-invalid', stage: 'initialization', retryable: false, message: 'Frozen cancellation input requires explicit recovery.',
    },
  }, value.etag)
  await assert.rejects(participant(f).resume(f.workspaceId, NOW), failStatus(503))
  assert.deepEqual(await current(f, run.run.id), paused)
  assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
  const resumed = await change(f, run.run.id, 'archive')
  assert.equal(resumed.analysis.run.attempts, 0)
  assert.equal(resumed.analysis.run.error, undefined)
  await settle(f, run.run.id)
  assert.equal((await current(f, run.run.id)).record.progress.cancelled, 500)
})

test('archive fences a partially initialized 500-pair run, cancels only its work, and never restarts on unarchive', async () => {
  const f = fixture()
  const run = await createRun(f, 125, 4)
  const other = await createRun(f)
  const neighbor = clone(comparisons(f, other.run.id))
  const immutable = clone([...f.analysis.blobs.values])
  assert.equal(run.run.progress.initialized, 25)
  const result = await change(f, run.run.id, 'archive')
  assert.equal(result.pending, true)
  assert.equal(result.operation.action, 'archive')
  assert.ok(result.analysis.run.lifecycle.archivedAt)
  assert.equal(api.analysisRunCanScore(result.analysis.run), false)
  assert.deepEqual(await participant(f).pendingWorkspaces(10), [f.workspaceId])
  await assert.rejects(f.service.retry(f.workspaceId, run.run.id, {}, result.etag), failStatus(409))
  await settle(f, run.run.id)
  const archived = await current(f, run.run.id)
  assert.equal(archived.record.progress.initialized, 500)
  assert.equal(archived.record.initialization.nextComparisonIndex, 500)
  assert.equal(archived.record.progress.cancelled, 500)
  assert.equal(archived.record.cancellation.nextComparisonIndex, 500)
  assert.ok(archived.record.cancellation.completedAt)
  assert.equal(comparisons(f, run.run.id).length, 500)
  assert.ok(comparisons(f, run.run.id).every(value => value.record.status === 'cancelled'))
  assert.deepEqual(comparisons(f, other.run.id), neighbor)
  assert.deepEqual([...f.analysis.blobs.values], immutable, 'Archive changes no immutable evidence or source metadata.')
  const restored = await change(f, run.run.id, 'unarchive')
  assert.equal(restored.analysis.run.lifecycle, undefined)
  assert.deepEqual(restored.analysis.run.cancellation, archived.record.cancellation)
  assert.deepEqual(restored.analysis.run.progress, archived.record.progress)
  assert.deepEqual((await f.analysis.store.listPending(NOW, 100)).map(value => value.record.runId), [other.run.id])
  assert.ok(f.analysis.store.batches.every(batch => batch.length <= 26 &&
    Buffer.byteLength(JSON.stringify(batch)) <= api.MAX_ANALYSIS_TRANSACTION_BYTES))
})

test('archive preserves completed comparisons, model reviews, original bytes and citations exactly', async () => {
  const f = fixture()
  const run = await createRun(f, 1, 3)
  const first = comparisons(f, run.run.id)[0]
  await publishResult(f, run.run.id, first.record.id)
  const completed = clone(comparisons(f, run.run.id)[0])
  const evidence = clone([...f.analysis.blobs.values])
  const detail = await f.service.comparisonDetail(f.workspaceId, run.run.id, first.record.id)
  const subject = { kind: 'candidate', subjectId: first.record.id }
  assert.equal((await f.service.summarySubject(f.workspaceId, run.run.id, subject)).narrative.status, 'queued')
  const result = await change(f, run.run.id, 'archive')
  assert.equal(result.pending, undefined)
  assert.equal(result.analysis.run.progress.complete, 1)
  assert.equal(result.analysis.run.progress.cancelled, 2)
  assert.deepEqual(comparisons(f, run.run.id)[0], completed)
  assert.deepEqual([...f.analysis.blobs.values], evidence)
  const archivedDetail = await f.service.comparisonDetail(f.workspaceId, run.run.id, first.record.id)
  const archivedSummary = await f.service.summarySubject(f.workspaceId, run.run.id, subject)
  assert.equal(archivedSummary.narrative.status, 'cancelled', 'Archive fences pending sidecar work, not the immutable result.')
  assert.equal(archivedDetail.narrative, undefined, 'Narratives load independently of immutable comparison evidence.')
  assert.deepEqual(archivedDetail, detail)
  assert.deepEqual((await f.service.document(f.workspaceId, run.run.id, first.record.id,
    detail.resumeSnapshot.document.id, detail.resumeSnapshot.document.version)).document, detail.resumeSnapshot.document)
  await change(f, run.run.id, 'unarchive')
  assert.deepEqual(comparisons(f, run.run.id)[0], completed)
  assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
})

test('permanent deletion removes every owned record and artifact with exact ETags and leaves only a non-reusable tombstone', async () => {
  const f = fixture()
  const run = await createRun(f, 1, 2)
  const neighbor = await createRun(f)
  const pair = comparisons(f, run.run.id)[0]
  await publishResult(f, run.run.id, pair.record.id)
  const old = await current(f, run.run.id)
  const orphan = Buffer.from('{"abandonedAttempt":true}')
  await f.analysis.blobs.putImmutable(`${f.workspaceId}/${run.run.id}/evidence/${sha(orphan)}.json`, orphan, 'application/json')
  const neighborRecords = clone(comparisons(f, neighbor.run.id))
  const neighborBlobs = clone([...f.analysis.blobs.values].filter(([name]) => name.startsWith(`${f.workspaceId}/${neighbor.run.id}/`)))
  const originals = clone([...f.resumes.blobs.values])
  assert.deepEqual(await change(f, run.run.id, 'delete'), { deleted: true })
  assert.equal(await current(f, run.run.id), undefined)
  assert.equal(comparisons(f, run.run.id).length, 0)
  assert.equal([...f.analysis.blobs.values.keys()].some(name => name.startsWith(`${f.workspaceId}/${run.run.id}/`)), false)
  const control = await f.analysis.store.getControl(f.workspaceId, run.run.id)
  assert.deepEqual(Object.keys(control.record).sort(), ['id', 'recordType', 'runId', 'state', 'updatedAt', 'workspaceId'])
  assert.equal(control.record.state, 'deleted')
  assert.deepEqual(comparisons(f, neighbor.run.id), neighborRecords)
  assert.deepEqual([...f.analysis.blobs.values].filter(([name]) => name.startsWith(`${f.workspaceId}/${neighbor.run.id}/`)), neighborBlobs)
  assert.deepEqual([...f.resumes.blobs.values], originals)
  assert.ok(f.analysis.blobs.events.filter(event => event[0] === 'delete').every(event => event[2] && event[2] !== '*'))
  await assert.rejects(f.service.create(f.workspaceId, run.key, run.request, ACTOR), failStatus(409))
  await assert.rejects(f.analysis.store.create(run.run), api.StoreConflictError)
  await assert.rejects(f.analysis.store.replace(old.record, old.etag), api.StoreConflictError)
  await assert.rejects(f.service.detail(f.workspaceId, run.run.id), failStatus(404))
  await assert.rejects(api.updateAnalysisControl(f.analysis.store, f.workspaceId, run.run.id,
    value => ({ ...value, state: 'active' })), api.StoreConflictError)
  assert.equal((await participant(f).counts(f.workspaceId)).analyses, 1)
})

test('cleanup and blocker recovery traverse EMPTY continuation pages and retain dependency protection after manifest removal', async () => {
  const f = fixture()
  const run = await createRun(f)
  await publishResult(f, run.run.id, comparisons(f, run.run.id)[0].record.id)
  const list = f.analysis.store.list.bind(f.analysis.store)
  const listControls = f.analysis.store.listControls.bind(f.analysis.store)
  const listBlobs = f.analysis.blobs.list.bind(f.analysis.blobs)
  const pages = []
  f.analysis.store.list = (ws, options) => {
    pages.push(options.recordType)
    return options.continuationToken === undefined ? Promise.resolve({ items: [], continuationToken: 'empty' })
      : list(ws, { ...options, continuationToken: options.continuationToken === 'empty' ? undefined : options.continuationToken })
  }
  f.analysis.store.listControls = (ws, token) => token === undefined
    ? Promise.resolve({ items: [], continuationToken: 'empty' }) : listControls(ws, token === 'empty' ? undefined : token)
  f.analysis.blobs.list = (ws, id, token) => token === undefined
    ? Promise.resolve({ items: [], continuationToken: 'empty' }) : listBlobs(ws, id, token === 'empty' ? undefined : token)
  f.analysis.blobs._beforeDelete(name => { if (name.includes('/results/')) throw new Error('PRIVATE-STORAGE-ERROR') })
  const result = await change(f, run.run.id, 'delete')
  assert.equal(result.pending, true)
  assert.equal(result.operation.status, 'failed')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-STORAGE-ERROR/)
  assert.equal(f.analysis.blobs.values.has(run.run.manifest.blobName), false)
  assert.equal(comparisons(f, run.run.id).length, 0)
  const empty = await f.service.list(f.workspaceId)
  assert.ok(empty.continuationToken)
  assert.ok((await f.service.list(f.workspaceId, empty.continuationToken)).runs
    .some(value => value.run.id === run.run.id && value.operation.status === 'failed'))
  const recovery = await f.service.detail(f.workspaceId, run.run.id)
  assert.deepEqual([recovery.resumes, recovery.targets], [[], []])
  await assert.rejects(f.service.comparisons(f.workspaceId, run.run.id), failStatus(404))
  for (const target of [
    { kind: 'workspace', id: f.workspaceId }, { kind: 'resume', id: run.resumes[0].record.id },
    { kind: 'job', id: run.targets[0].record.id }, { kind: 'rubric', id: run.targets[0].rubric.groupId },
  ]) {
    const blockers = await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, target)
    assert.deepEqual(blockers.map(value => value.id), [run.run.id])
    assert.equal(blockers[0].href, `/analyses/${run.run.id}?data=real`)
  }
  assert.equal((await participant(f).counts(f.workspaceId)).analyses, 1, 'Partially deleted runs still block workspace deletion.')
  f.analysis.blobs._beforeDelete(undefined)
  await settle(f, run.run.id)
  assert.equal(await current(f, run.run.id), undefined)
  assert.deepEqual(await participant(f).pendingWorkspaces(10), [])
  assert.ok(pages.includes('analysis-run') && pages.includes('analysis-comparison'))
})

test('dependency blockers include archived old rubric versions beyond the first page and cleanup-pending newer references', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const request = { name: 'Old rubric history', resumes: [resume.selection], targets: [job.selection] }
  const old = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  await change(f, old.run.id, 'archive')
  f.now = LATER
  const newer = { ...clone(job.rubric), id: `rubric-${randomUUID()}`, version: 2, createdAt: LATER, name: 'Saved newer rubric' }
  f.rubricValues.set(`${f.workspaceId}/${job.record.id}`, [job.rubric, newer])
  f.jobValues.set(`${f.workspaceId}/${job.record.id}`, {
    record: { ...job.record, job: { ...job.record.job, rubricId: newer.id }, updatedAt: LATER }, etag: '"new-rubric"',
  })
  const selection = { ...job.selection, rubricId: newer.id, rubricVersion: 2, rubricHash: api.analysisHash(newer) }
  let latest
  for (let index = 0; index < 100; index++) {
    latest = await f.service.create(f.workspaceId, randomUUID(), {
      ...request, name: `Newer rubric history ${index}`, targets: [selection],
    }, ACTOR)
  }
  f.analysis.blobs._beforeDelete(() => { throw new Error('Private cleanup is temporarily unavailable') })
  assert.equal((await change(f, latest.run.id, 'delete')).pending, true)
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  const blockers = await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'rubric', id: job.rubric.groupId })
  assert.equal(blockers.length, 101)
  assert.ok(blockers.some(value => value.id === old.run.id) && blockers.some(value => value.id === latest.run.id))
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'rubric', id: job.rubric.id })).length, 1)
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'rubric', id: newer.id })).length, 100)
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'workspace', id: f.workspaceId })).length, 101)
})

test('unreadable dependency storage fails closed and archived historical versions bind stable groups without live source lookups', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const grade = await seedGrade(f, job)
  const request = { name: 'Historic targets', resumes: [resume.selection], targets: [job.selection, grade.selection] }
  const run = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  await change(f, run.run.id, 'archive')
  f.resumeValues.clear()
  f.jobValues.clear()
  f.rubricValues.clear()
  f.gradeValues.clear()
  f.resumes.blobs.values.clear()
  f.jobs.blobs.values.clear()
  f.grades.blobs.values.clear()
  for (const target of [
    { kind: 'resume', id: resume.record.id }, { kind: 'job', id: job.record.id },
    { kind: 'rubric', id: job.rubric.groupId }, { kind: 'rubric', id: job.rubric.id },
    { kind: 'rubric', id: grade.head.id }, { kind: 'rubric', id: grade.version.id },
    { kind: 'ladder', id: grade.ladder.id }, { kind: 'workspace', id: f.workspaceId },
  ]) {
    assert.deepEqual((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, target)).map(value => value.id), [run.run.id])
  }
  assert.deepEqual(await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'analysis', id: run.run.id }), [])
  assert.deepEqual(await api.realAnalysisDependencyBlockers(f.analysis, 'another-workspace', { kind: 'workspace', id: 'another-workspace' }), [])
  const manifest = f.analysis.blobs.values.get(run.run.manifest.blobName)
  f.analysis.blobs.values.delete(run.run.manifest.blobName)
  await assert.rejects(api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'resume', id: resume.record.id }), failStatus(503))
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'workspace', id: f.workspaceId })).length, 1)
  f.analysis.blobs.values.set(run.run.manifest.blobName, manifest)
  const first = comparisons(f, run.run.id)[0]
  f.analysis.blobs.values.delete(first.record.target.blob.blobName)
  await assert.rejects(api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'rubric', id: job.rubric.groupId }), failStatus(503))
})

test('an in-flight source writer keeps deletion pending and cannot recreate content after the permanent fence', async () => {
  const f = fixture()
  const run = await createRun(f)
  const bytes = Buffer.from('{"lateSource":true}')
  const name = `${f.workspaceId}/${run.run.id}/evidence/${sha(bytes)}.json`
  let release
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  f.analysis.blobs._beforeFencedPut(async candidate => {
    if (candidate === name) { entered(); await blocked }
  })
  const write = api.fencedAnalysisBlobs(f.analysis, f.workspaceId, run.run.id).putImmutable(name, bytes, 'application/json')
  const rejected = assert.rejects(write, api.StoreConflictError)
  await waiting
  const result = await change(f, run.run.id, 'delete')
  assert.equal(result.pending, true)
  assert.equal(result.operation.status, 'pending')
  release()
  await rejected
  assert.equal(f.analysis.blobs.values.has(name), false)
  await api.updateAnalysisControl(f.analysis.store, f.workspaceId, run.run.id, record => ({
    ...record, writers: Object.fromEntries(Object.entries(record.writers).map(([id, writer]) => [
      id, { ...writer, expiresAt: new Date(Date.now() - 1).toISOString() },
    ])),
  }))
  await settle(f, run.run.id)
  await assert.rejects(api.fencedAnalysisBlobs(f.analysis, f.workspaceId, run.run.id)
    .putImmutable(name, bytes, 'application/json'), api.StoreConflictError)
  assert.equal(f.analysis.blobs.values.size, 0)
})

test('archive cancellation failures remain discoverable after reload and recover without restarting scoring', async () => {
  const f = fixture()
  const run = await createRun(f, 3, 10)
  f.analysis.store._beforeBatch(() => {
    f.analysis.store._beforeBatch(() => { throw new Error('PRIVATE-CANCELLATION-OUTAGE') })
  })
  const result = await change(f, run.run.id, 'archive')
  assert.equal(result.pending, true)
  assert.equal(result.operation.status, 'failed')
  const saved = await current(f, run.run.id)
  assert.ok(saved.record.lifecycle.archivedAt)
  assert.equal(saved.record.cancellation.nextComparisonIndex, 0)
  assert.equal(api.analysisRunCanScore(saved.record), false)
  assert.deepEqual(await participant(f).pendingWorkspaces(100), [f.workspaceId])
  await settle(f, run.run.id)
  assert.equal((await current(f, run.run.id)).record.progress.cancelled, 30)
  assert.equal((await f.analysis.store.listPending(NOW, 100)).length, 0)
})

for (const source of ['resume', 'job', 'rubric', 'ladder', 'head']) {
  test(`archived ${source} is rejected for new and explicit retry intake, without modifying frozen history`, async () => {
    const f = fixture()
    const resume = await seedResume(f)
    const job = await seedJob(f)
    const grade = ['ladder', 'head'].includes(source) ? await seedGrade(f, job) : undefined
    const target = grade ?? job
    const request = { name: 'Saved input', resumes: [resume.selection], targets: [target.selection] }
    const accepted = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
    const stopped = await f.service.cancel(f.workspaceId, accepted.run.id, ACTOR, accepted.etag)
    const frozen = clone([...f.analysis.blobs.values])
    if (source === 'resume') f.resumeValues.get(`${f.workspaceId}/${resume.record.id}`).record.lifecycle = { archivedAt: NOW }
    if (source === 'job') f.jobValues.get(`${f.workspaceId}/${job.record.id}`).record.lifecycle = { archivedAt: NOW }
    if (source === 'rubric') f.jobValues.get(`${f.workspaceId}/${job.record.id}`).record.rubricLifecycle = { archivedAt: NOW }
    if (source === 'ladder' || source === 'head') {
      f.gradeValues.get(`${f.workspaceId}/${grade[source].id}`).record.lifecycle = { archivedAt: NOW }
    }
    await assert.rejects(f.service.retry(f.workspaceId, accepted.run.id, {}, stopped.etag), failStatus(409))
    const pair = comparisons(f, accepted.run.id)[0]
    await assert.rejects(f.service.comparisonAction(f.workspaceId, accepted.run.id, pair.record.id, 'retry', pair.etag), failStatus(409))
    const snapshot = await f.service.comparisonDetail(f.workspaceId, accepted.run.id, pair.record.id)
    assert.equal(snapshot.resumeSnapshot.selection.resumeId, resume.record.id)
    assert.deepEqual([...f.analysis.blobs.values], frozen)
    await assert.rejects(f.service.create(f.workspaceId, randomUUID(), request, ACTOR), failStatus(409))
    if (source !== 'resume') assert.equal((await f.service.listTargets(f.workspaceId)).targets.some(value =>
      value.selection.kind === target.selection.kind && api.analysisHash(value.selection) === api.analysisHash(target.selection)), false)
    assert.equal((await current(f, accepted.run.id)).record.progress.queued, 0)
  })
}

test('workspace controls gate intake; workspace deletion stays blocked by all retained runs and terminal fences never downgrade', async () => {
  const f = fixture()
  const run = await createRun(f)
  await change(f, run.run.id, 'archive')
  assert.equal((await participant(f).counts(f.workspaceId)).analyses, 1)
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, { kind: 'workspace', id: f.workspaceId })).length, 1)
  await participant(f).setState(f.workspaceId, 'archived', NOW)
  await assert.rejects(f.service.create(f.workspaceId, randomUUID(), run.request, ACTOR), failStatus(409))
  await assert.rejects(f.service.listTargets(f.workspaceId), failStatus(409))
  await participant(f).setState(f.workspaceId, 'deleting', NOW)
  await assert.rejects(participant(f).purge(f.workspaceId, NOW), /retained real analyses/)
  assert.ok(await current(f, run.run.id))
  await change(f, run.run.id, 'delete')
  await participant(f).purge(f.workspaceId, NOW)
  assert.equal((await f.analysis.store.getControl(f.workspaceId)).record.state, 'deleted')
  await participant(f).setState(f.workspaceId, 'deleting', LATER)
  await participant(f).resume(f.workspaceId, LATER)
  assert.equal((await f.analysis.store.getControl(f.workspaceId)).record.state, 'deleted')
  await assert.rejects(participant(f).setState(f.workspaceId, 'active', LATER), api.StoreConflictError)
})

test('HTTP lifecycle uses RUN ETags, scopes/auth/CSRF, analysis alias, and management leases on archived workspaces', async () => {
  const f = fixture()
  const run = await createRun(f)
  const pair = comparisons(f, run.run.id)[0]
  const http = await startHttp(f)
  try {
    const suffix = `/${run.run.id}/lifecycle`
    const get = await http.request(suffix, 'GET', undefined, { role: 'viewer' })
    assert.equal(get.status, 200)
    assert.equal((await get.json()).impact.target.id, run.run.id)
    assert.equal(get.headers.get('cache-control'), 'no-store')
    for (const [options, expected] of [
      [{ noAuth: true }, 401], [{ role: 'stranger' }, 404], [{ role: 'viewer' }, 403],
      [{ headers: { origin: 'https://attacker.example' } }, 403],
    ]) {
      assert.equal((await http.request(suffix, 'POST', { action: 'archive' },
        { ...options, headers: { 'If-Match': run.etag, ...options.headers } })).status, expected)
    }
    assert.equal((await http.request(suffix, 'POST', { action: 'archive' })).status, 428)
    for (const [value, expected] of [['*', 400], ['"one","two"', 400], [pair.etag, 409], ['"stale"', 409]]) {
      assert.equal((await http.request(suffix, 'POST', { action: 'archive' }, { headers: { 'If-Match': value } })).status, expected)
    }
    assert.equal((await http.request(suffix, 'POST', { action: 'archive', extra: true }, { headers: { 'If-Match': run.etag } })).status, 400)
    assert.equal((await http.request(`/analysis-run-${randomUUID()}/lifecycle`)).status, 404)
    f.workspaceMetadata = { archivedAt: NOW }
    await participant(f).setState(f.workspaceId, 'archived', NOW)
    const transact = f.analysis.store.transact.bind(f.analysis.store)
    f.analysis.store.transact = async (...args) => {
      assert.equal(f.mutationLeases.active, 1, 'The complete mutation promise must run inside the repository lease.')
      return transact(...args)
    }
    const archived = await http.request(suffix, 'POST', { action: 'archive' }, { headers: { 'If-Match': run.etag } })
    assert.equal(archived.status, 200)
    const body = await archived.json()
    assert.ok(body.analysis.run.lifecycle.archivedAt)
    assert.equal(body.run, undefined)
    assert.equal(archived.headers.get('etag'), body.analysis.etag)
    assert.equal((await http.request(`/${run.run.id}/retry`, 'POST', {}, { headers: { 'If-Match': body.analysis.etag } })).status, 409)
    assert.equal((await http.request('', 'POST', run.request, { headers: { 'Idempotency-Key': randomUUID() } })).status, 409)
    const deleted = await http.request(suffix, 'POST', { action: 'delete' }, { headers: { 'If-Match': body.analysis.etag } })
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { deleted: true })
    assert.equal((await http.request(`/${run.run.id}`)).status, 404)
    assert.equal(f.mutationLeases.active, 0)
  } finally { await http.close() }
})

test('HTTP incomplete deletion exposes only durable recovery metadata and its latest ETag after reload', async () => {
  const f = fixture()
  const run = await createRun(f)
  f.analysis.blobs._beforeDelete(() => { throw new Error('Storage is temporarily unavailable') })
  const http = await startHttp(f)
  try {
    const suffix = `/${run.run.id}/lifecycle`
    const result = await http.request(suffix, 'POST', { action: 'delete' }, { headers: { 'If-Match': run.etag } })
    assert.equal(result.status, 202)
    const body = await result.json()
    assert.equal(body.operation.status, 'failed')
    assert.ok(body.etag && body.analysis.run.lifecycle.deletingAt)
    assert.deepEqual([body.analysis.resumes, body.analysis.targets], [[], []])
    const reload = await http.request(`/${run.run.id}`)
    assert.equal(reload.status, 200)
    const recovery = await reload.json()
    assert.equal(recovery.etag, body.etag)
    assert.equal(recovery.operation.id, body.operation.id)
    assert.equal((await http.request(`/${run.run.id}/comparisons`)).status, 404)
    f.analysis.blobs._beforeDelete(undefined)
    const retry = await http.request(suffix, 'POST', { action: 'delete' }, { headers: { 'If-Match': body.etag } })
    assert.equal(retry.status, 200)
    assert.deepEqual(await retry.json(), { deleted: true })
  } finally { await http.close() }
})
