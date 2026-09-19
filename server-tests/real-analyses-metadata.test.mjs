import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  api, fixture, createRun, seedResume, seedJob, publishResult, startHttp, ACTOR, NOW, LATER, clone, jsonBytes, sha,
} from './real-analyses.test-support.mjs'

const comparisonFor = (f, id) => [...f.analysis.store.values.values()]
  .find(value => value.record.recordType === 'analysis-comparison' && value.record.runId === id)

test('analysis metadata PATCH enforces exact ETags, strict normalized names, access, CSRF, and lifecycle fencing', async () => {
  const f = fixture()
  const created = await createRun(f)
  const http = await startHttp(f)
  const suffix = `/${created.run.id}/metadata`
  const patch = (body = { displayName: 'Renamed analysis' }, options = {}) =>
    http.request(suffix, 'PATCH', body, { ...options, headers: { 'if-match': created.etag, ...options.headers } })
  try {
    for (const [options, expected] of [
      [{ noAuth: true }, 401], [{ role: 'stranger' }, 404], [{ role: 'viewer' }, 403],
      [{ headers: { origin: 'https://foreign.example' } }, 403], [{ headers: { 'x-score-request': '' } }, 403],
      [{ headers: { 'if-match': '' } }, 428], [{ headers: { 'if-match': '*' } }, 400],
      [{ headers: { 'if-match': `W/${created.etag}` } }, 400], [{ headers: { 'if-match': `${created.etag}, "other"` } }, 400],
      [{ headers: { 'if-match': '"stale"' } }, 409],
    ]) assert.equal((await patch(undefined, options)).status, expected, JSON.stringify(options))
    for (const body of [
      {}, [], null, { displayName: 42 }, { displayName: '' }, { displayName: '  ' }, { displayName: 'x'.repeat(161) },
      { displayName: 'line\nbreak' }, { displayName: '\tName' }, { displayName: 'control\u0085' },
      { displayName: 'Allowed', name: 'Rebind original' }, { displayName: 'Allowed', status: 'complete' },
      { displayName: 'Allowed', manifest: created.run.manifest }, { displayName: 'Allowed', progress: created.run.progress },
    ]) assert.equal((await patch(body)).status, 400, JSON.stringify(body))
    assert.equal((await http.request('/analysis-run-invalid/metadata', 'PATCH', { displayName: 'Name' },
      { headers: { 'if-match': created.etag } })).status, 404)
    assert.equal((await http.request(`/${created.run.id}/metadata?extra=true`, 'PATCH', { displayName: 'Name' },
      { headers: { 'if-match': created.etag } })).status, 400)
    assert.equal((await f.analysis.store.get(f.workspaceId, created.run.id)).etag, created.etag)
    f.now = LATER
    const response = await patch({ displayName: `  ${'n'.repeat(160)}  ` })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const { run } = await response.json()
    assert.equal(response.headers.get('etag'), run.etag)
    assert.notEqual(run.etag, created.etag)
    assert.equal(run.run.displayName, 'n'.repeat(160))
    assert.deepEqual(run.run, { ...created.run, displayName: 'n'.repeat(160), updatedAt: LATER })
    assert.equal((await patch()).status, 409)
    assert.equal((await f.service.list(f.workspaceId)).runs[0].run.displayName, 'n'.repeat(160))
    assert.equal((await f.service.detail(f.workspaceId, run.run.id)).run.name, created.run.name)
    assert.ok(f.mutationLeases.acquired > 0)
    assert.equal(f.mutationLeases.active, 0)

    const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis, () => new Date(LATER))
    await lifecycle.change(f.workspaceId, run.run.id, 'archive', run.etag, ACTOR)
    let current = await f.analysis.store.get(f.workspaceId, run.run.id)
    assert.equal((await patch(undefined, { headers: { 'if-match': current.etag } })).status, 409)
    await lifecycle.change(f.workspaceId, run.run.id, 'unarchive', current.etag, ACTOR)
    current = await f.analysis.store.get(f.workspaceId, run.run.id)
    f.workspaceMetadata = { archivedAt: NOW }
    assert.equal((await patch(undefined, { headers: { 'if-match': current.etag } })).status, 409)
    delete f.workspaceMetadata
    f.analysis.store.save({ ...current.record, lifecycle: { deletingAt: LATER } })
    assert.equal((await patch(undefined, { headers: { 'if-match': current.etag } })).status, 404)
  } finally { await http.close() }
})

test('renaming complete analyses leaves manifests, results, citations, source metadata, and original names unchanged without source services', async () => {
  const f = fixture()
  const created = await createRun(f)
  const comparison = comparisonFor(f, created.run.id)
  await publishResult(f, created.run.id, comparison.record.id)
  const current = await f.analysis.store.get(f.workspaceId, created.run.id)
  const savedDetail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  const blobs = clone(f.analysis.blobs.values)
  const before = clone(f.analysis.store.values)
  const historyOnly = new api.RealAnalysisService(f.analysis, {}, () => new Date(LATER))
  const renamed = await historyOnly.updateMetadata(f.workspaceId, current.record.id, { displayName: 'Final shortlist' }, current.etag)
  assert.deepEqual(renamed.run, { ...current.record, displayName: 'Final shortlist', updatedAt: LATER })
  assert.deepEqual(f.analysis.blobs.values, blobs)
  assert.deepEqual(await historyOnly.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id), savedDetail)
  assert.deepEqual((await historyOnly.detail(f.workspaceId, created.run.id)).run.manifest, created.run.manifest)
  assert.equal((await api.readAnalysisManifest(f.analysis.blobs, renamed.run)).request.name, created.run.name)
  assert.deepEqual(await historyOnly.reportComparisons(f.workspaceId, created.run.id, [comparison.record.id]),
    await f.service.reportComparisons(f.workspaceId, created.run.id, [comparison.record.id]))
  for (const [key, value] of before) if (value.record.recordType === 'analysis-comparison') {
    assert.deepEqual(f.analysis.store.values.get(key), value)
  }
  const lifecycle = new api.AnalysisLibraryLifecycleService(f.analysis)
  assert.equal((await lifecycle.impact(f.workspaceId, created.run.id)).name, 'Final shortlist')
  assert.equal((await api.realAnalysisDependencyBlockers(f.analysis, f.workspaceId, {
    kind: 'resume', id: created.resumes[0].record.id,
  }))[0].name, 'Final shortlist')
  await assert.rejects(api.readAnalysisManifest(f.analysis.blobs, { ...renamed.run, name: 'Changed original' }),
    /Manifest does not belong/)
})

test('new analyses capture separate source labels while old comparisons and report summaries never resolve live aliases', async () => {
  const f = fixture()
  const resume = await seedResume(f)
  const job = await seedJob(f)
  const request = { name: 'Original accepted name', resumes: [resume.selection], targets: [job.selection] }
  const old = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  const resumeKey = `${f.workspaceId}/${resume.record.id}`
  const jobKey = `${f.workspaceId}/${job.record.id}`
  f.resumeValues.set(resumeKey, { record: { ...resume.record, displayName: 'Candidate 7' }, etag: '"resume-alias"' })
  f.jobValues.set(jobKey, { record: { ...job.record, displayName: 'Hiring target A' }, etag: '"job-alias"' })
  const offered = await f.service.listTargets(f.workspaceId)
  assert.equal(offered.targets[0].label, job.record.job.title)
  assert.equal(offered.targets[0].displayName, 'Hiring target A')
  const created = await f.service.create(f.workspaceId, randomUUID(), request, ACTOR)
  const comparison = comparisonFor(f, created.run.id)
  const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id)
  assert.equal(detail.resumeSnapshot.displayName, 'Candidate 7')
  assert.equal(comparison.record.resume.summary.displayName, 'Candidate 7')
  assert.equal(detail.targetSnapshot.summary.displayName, 'Hiring target A')
  assert.deepEqual(detail.resumeSnapshot.resume, resume.record.resume)
  assert.deepEqual(detail.resumeSnapshot.source, resume.record.source)
  assert.deepEqual(detail.resumeSnapshot.profile, resume.profile)
  assert.deepEqual(detail.targetSnapshot.job, job.record.job)
  assert.equal(detail.targetSnapshot.summary.label, job.record.job.title)
  assert.deepEqual(detail.targetSnapshot.source, job.record.source)
  f.resumeValues.set(resumeKey, { record: { ...resume.record, displayName: 'Later candidate label' }, etag: '"newer-resume"' })
  f.jobValues.set(jobKey, { record: { ...job.record, displayName: 'Later target label' }, etag: '"newer-job"' })
  assert.deepEqual(await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.record.id), detail)
  const legacy = await f.service.detail(f.workspaceId, old.run.id)
  assert.equal(legacy.resumes[0].displayName, undefined)
  assert.equal(legacy.targets[0].displayName, undefined)
  const report = await f.service.reportComparisons(f.workspaceId, created.run.id, [comparison.record.id])
  assert.equal(report.comparisons[0].candidate.displayName, 'Candidate 7')
  assert.equal(report.comparisons[0].candidate.name, resume.record.resume.name)
  assert.equal(report.comparisons[0].candidate.sourceLabel, resume.record.resume.sourceLabel)
  assert.equal(report.targets[0].displayName, 'Hiring target A')
  assert.equal(report.targets[0].label, job.record.job.title)
})

test('frozen resume display metadata is bound to its manifest summary without weakening evidence or target-label checks', async () => {
  const f = fixture()
  const created = await createRun(f)
  const comparison = clone(comparisonFor(f, created.run.id).record)
  const snapshots = await api.readAnalysisSnapshots(f.analysis.blobs, created.run, comparison)
  const snapshot = { ...snapshots.resumeSnapshot, displayName: 'Not the accepted summary' }
  const bytes = jsonBytes(snapshot)
  const ref = comparison.resume.blob
  ref.sha256 = sha(bytes)
  ref.bytes = bytes.length
  ref.blobName = `${f.workspaceId}/${created.run.id}/snapshots/${comparison.resume.snapshotId}/${ref.sha256}.json`
  await f.analysis.blobs.putImmutable(ref.blobName, bytes, 'application/json')
  const manifest = await api.readAnalysisManifest(f.analysis.blobs, created.run)
  manifest.resumes[0] = clone(comparison.resume)
  const manifestBytes = jsonBytes(manifest)
  const run = { ...created.run, manifest: { ...created.run.manifest, sha256: sha(manifestBytes), bytes: manifestBytes.length } }
  f.analysis.blobs.values.set(run.manifest.blobName, {
    bytes: manifestBytes, contentType: 'application/json', sha256: run.manifest.sha256, etag: '"tampered-manifest"',
  })
  await assert.rejects(api.readAnalysisSnapshots(f.analysis.blobs, run, comparison), /Snapshot does not match its manifest summary/)
  assert.throws(() => api.parseFrozenTargetSnapshot({
    ...snapshots.targetSnapshot, summary: { ...snapshots.targetSnapshot.summary, label: 'A display alias is not the original title' },
  }), /Job summary does not match/)
  for (const displayName of ['', ' untrimmed ', 'x'.repeat(161), 'control\u0085']) {
    assert.throws(() => api.parseAnalysisEntity({ ...created.run, displayName }))
    assert.throws(() => api.parseFrozenResumeSnapshot({ ...snapshots.resumeSnapshot, displayName }))
    assert.throws(() => api.parseFrozenTargetSnapshot({
      ...snapshots.targetSnapshot, summary: { ...snapshots.targetSnapshot.summary, displayName },
    }))
  }
})
