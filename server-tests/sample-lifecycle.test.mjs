import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  stdin: {
    contents: [
      "export * from './src/domain/lifecycle'",
      "export * from './src/domain/selectors'",
      "export * from './src/domain/workspace-validation'",
      "export * from './src/services/scoring'",
      "export * from './src/services/mockWorkspace'",
      "export * from './src/services/persistence'",
      "export * from './src/data/fixtures'",
      "export * from './src/app/useWorkspaceEngine'",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
    sourcefile: 'sample-lifecycle-test-entry.ts',
  },
  bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node24', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const {
  applySampleLifecycle, assertEntityWritable, createAnalysisRun, createFixtureWorkspace, createFreshInitialWorkspace,
  createInitialWorkspace, evaluateComparison, getEntityLifecycle, getSampleLifecycleImpact,
  isEntityArchived, isEntityRemoved, isLifecycleManagementTransition, latestRubrics, LifecycleBlockedError, loadWorkspace, matchesArchiveFilter,
  normalizeLifecycleTarget, sampleLifecycleTargets, saveWorkspace, setWorkspaceArchive, useWorkspaceEngine,
  validateWorkspace, withSampleResetTombstones, WORKSPACE_STORAGE_KEY, workspaceLifecycleTransitionErrors,
} = module.exports

const timestamp = '2026-09-18T14:00:00.000Z'
const later = '2026-09-18T14:05:00.000Z'
const workspaceTarget = { kind: 'workspace', id: 'local-demo' }
const target = (kind, id) => ({ kind, id })
const apply = (workspace, entity, action) => applySampleLifecycle(workspace, entity, action, timestamp)
const validTransition = (previous, next) => {
  validateWorkspace(next)
  assert.deepEqual(workspaceLifecycleTransitionErrors(previous, next), [])
  return next
}
const removeRuns = (workspace) => workspace.runs.reduce((state, run) => apply(state, target('analysis', run.id), 'delete'), workspace)

test('legacy version-1 workspaces without lifecycle metadata load as active without changing snapshots', () => {
  const workspace = createInitialWorkspace()
  const before = structuredClone(workspace)
  assert.equal(workspace.lifecycle, undefined)
  assert.deepEqual(validateWorkspace(workspace), workspace)
  for (const entity of sampleLifecycleTargets(workspace)) assert.equal(isEntityArchived(workspace, entity), false)
  assert.equal(getEntityLifecycle(workspace, target('job', workspace.jobs[0].id)), undefined)
  assert.deepEqual(workspaceLifecycleTransitionErrors(workspace, structuredClone(workspace)), [])
  assert.deepEqual(workspace, before)
})

test('default browsing hides archives; searches include them unless explicitly filtered', () => {
  for (const archived of [false, true]) {
    assert.equal(matchesArchiveFilter(archived, '', 'default'), !archived)
    assert.equal(matchesArchiveFilter(archived, '   ', 'default'), !archived)
    assert.equal(matchesArchiveFilter(archived, 'find me', 'default'), true)
    assert.equal(matchesArchiveFilter(archived, 'find me', 'active'), !archived)
    assert.equal(matchesArchiveFilter(archived, '', 'archived'), archived)
    assert.equal(matchesArchiveFilter(archived, '', 'all'), true)
  }
})

test('job archive inherits to rubrics without changing independent archive flags or analysis snapshots', () => {
  const original = createInitialWorkspace()
  const job = original.jobs[0]
  const rubric = original.rubrics.find((item) => item.id === job.rubricId)
  const rubricTarget = target('rubric', rubric.id)
  assert.deepEqual(normalizeLifecycleTarget(original, rubricTarget), target('rubric', rubric.groupId))
  const separatelyArchived = validTransition(original, apply(original, rubricTarget, 'archive'))
  const archived = validTransition(separatelyArchived, apply(separatelyArchived, target('job', job.id), 'archive'))
  assert.equal(isEntityArchived(archived, rubricTarget), true)
  assert.deepEqual(archived.rubrics, original.rubrics)
  assert.deepEqual(archived.runs, original.runs)
  const restored = validTransition(archived, apply(archived, target('job', job.id), 'unarchive'))
  assert.equal(isEntityArchived(restored, target('job', job.id)), false)
  assert.equal(isEntityArchived(restored, rubricTarget), true)
  assert.equal(isEntityArchived(restored, target('analysis', original.runs[0].id)), false)
  assert.equal(getEntityLifecycle(restored, rubricTarget).parentKey, `job:${job.id}`)
  assert.equal(getEntityLifecycle(original, rubricTarget), undefined, 'pure operations must not mutate inputs')
})

test('illustrative ladder archive inherits only to its owned groups and restores independent child flags', () => {
  const original = createFixtureWorkspace()
  const grade = original.rubrics.find((item) => item.kind === 'grade')
  const sibling = original.rubrics.find((item) => item.kind === 'grade' && item.ladder === grade.ladder && item.groupId !== grade.groupId)
  assert.ok(sibling)
  let state = apply(original, target('rubric', grade.id), 'archive')
  state = validTransition(state, apply(state, target('ladder', grade.ladder), 'archive'))
  assert.equal(isEntityArchived(state, target('rubric', sibling.id)), true)
  assert.equal(getEntityLifecycle(state, target('rubric', sibling.id)), undefined)
  state = validTransition(state, apply(state, target('ladder', grade.ladder), 'unarchive'))
  assert.equal(isEntityArchived(state, target('rubric', grade.id)), true)
  assert.equal(isEntityArchived(state, target('rubric', sibling.id)), false)
  assert.deepEqual(state.rubrics, original.rubrics)
})

test('archive cancels only owned unfinished work and unarchive never restarts it', () => {
  const original = createInitialWorkspace()
  const job = original.jobs[0]
  const pending = createAnalysisRun(original, original.resumes.slice(0, 2).map((item) => item.id), [job.rubricId])
  pending.comparisons[0] = evaluateComparison(pending, pending.comparisons[0].id)
  original.runs.unshift(pending)
  original.jobs[0] = { ...job, status: 'generating' }
  const archivedJob = validTransition(original, apply(original, target('job', job.id), 'archive'))
  assert.equal(archivedJob.jobs[0].status, 'cancelled')
  assert.deepEqual(archivedJob.runs, original.runs, 'an independent captured analysis is not owned by its source')
  const archivedRun = validTransition(archivedJob, apply(archivedJob, target('analysis', pending.id), 'archive'))
  assert.deepEqual(archivedRun.runs[0].comparisons[0], pending.comparisons[0])
  assert.equal(archivedRun.runs[0].comparisons[1].status, 'cancelled')
  assert.deepEqual(archivedRun.runs[0].resumes, pending.resumes)
  assert.deepEqual(archivedRun.runs[0].targets, pending.targets)
  const restoredRun = validTransition(archivedRun, apply(archivedRun, target('analysis', pending.id), 'unarchive'))
  assert.equal(restoredRun.runs[0].comparisons[1].status, 'cancelled')
  const restoredJob = validTransition(restoredRun, apply(restoredRun, target('job', job.id), 'unarchive'))
  assert.equal(restoredJob.jobs[0].status, 'cancelled')
})

test('workspace archive cancels pending work; lifecycle deletion stays available while ordinary edits are locked', () => {
  const original = createInitialWorkspace()
  const pending = createAnalysisRun(original, [original.resumes[0].id], [original.jobs[0].rubricId])
  original.runs.unshift(pending)
  original.jobs[0] = { ...original.jobs[0], status: 'parsing' }
  const archived = validTransition(original, setWorkspaceArchive(original, true, timestamp))
  assert.equal(archived.jobs[0].status, 'cancelled')
  assert.equal(archived.runs[0].comparisons[0].status, 'cancelled')
  assert.deepEqual(archived.lifecycle.entities, {}, 'root archive must not stamp child archive flags')
  assert.throws(() => assertEntityWritable(archived, target('resume', archived.resumes[0].id)), /archived/)
  const edited = structuredClone(archived)
  edited.resumes[0].name = 'Changed while archived'
  assert.match(workspaceLifecycleTransitionErrors(archived, edited).join(' '), /read-only/)
  const cleared = validTransition(archived, removeRuns(archived))
  assert.deepEqual(cleared.runs, [])
  const restored = validTransition(cleared, setWorkspaceArchive(cleared, false, later))
  assert.equal(restored.jobs[0].status, 'cancelled')
  assert.throws(() => apply(archived, workspaceTarget, 'delete'), LifecycleBlockedError)
})

test('lifecycle-only transition classification permits archive management but rejects edits and resurrection', () => {
  const original = createInitialWorkspace()
  const edited = structuredClone(original)
  edited.resumes[0].name = 'A valid ordinary profile edit'
  assert.deepEqual(workspaceLifecycleTransitionErrors(original, edited), [])
  assert.equal(isLifecycleManagementTransition(original, edited), false)
  assert.match(workspaceLifecycleTransitionErrors(original, edited, { lifecycleOnly: true }).join(' '), /read-only/)
  assert.equal(isLifecycleManagementTransition(original, structuredClone(original)), true, 'idempotent saves are safe')
  let state = setWorkspaceArchive(original, true, timestamp)
  const jobTarget = target('job', original.jobs[0].id)
  for (const action of ['archive', 'unarchive']) {
    const next = apply(state, jobTarget, action)
    assert.equal(isLifecycleManagementTransition(state, next), true)
    validTransition(state, next)
    assert.equal(next.lifecycle.archivedAt, timestamp)
    assert.equal(isEntityArchived(next, jobTarget), true, 'unarchiving a child cannot override its workspace')
    state = next
  }
  const deletedAnalysis = apply(state, target('analysis', state.runs[0].id), 'delete')
  assert.equal(isLifecycleManagementTransition(state, deletedAnalysis), true)
  validTransition(state, deletedAnalysis)
  assert.equal(isLifecycleManagementTransition(deletedAnalysis, state), false)
  assert.match(workspaceLifecycleTransitionErrors(deletedAnalysis, state).join(' '), /deletion marker|deleted analysis/)
})

test('archived retained analyses block sources and every historical version of a logical rubric', () => {
  const original = createInitialWorkspace()
  const job = original.jobs[0]
  const first = original.rubrics.find((item) => item.id === job.rubricId)
  const second = { ...structuredClone(first), id: 'rubric-version-2', version: 2, createdAt: later }
  original.rubrics.push(second)
  original.jobs[0] = { ...job, rubricId: second.id }
  const historicalRun = original.runs.find((run) => run.targets.some((snapshot) => snapshot.rubric.id === first.id))
  const archived = apply(original, target('analysis', historicalRun.id), 'archive')
  for (const entity of [target('job', job.id), target('rubric', first.id), target('rubric', second.id), target('resume', historicalRun.resumes[0].resume.id)]) {
    const impact = getSampleLifecycleImpact(archived, entity)
    assert.ok(impact.blockers.some((blocker) => blocker.id === historicalRun.id && blocker.href.includes(historicalRun.id)))
    assert.throws(() => apply(archived, entity, 'delete'), LifecycleBlockedError)
  }
  const bypass = structuredClone(archived)
  bypass.rubrics = bypass.rubrics.filter((rubric) => rubric.groupId !== first.groupId)
  bypass.jobs[0] = { ...bypass.jobs[0], rubricId: null, rubricDeletedAt: timestamp }
  bypass.lifecycle.entities[`rubric:${first.groupId}`] = { deletedAt: timestamp, parentKey: `job:${job.id}` }
  validateWorkspace(bypass)
  assert.match(workspaceLifecycleTransitionErrors(archived, bypass).join(' '), /retained analysis/)
})

test('rubric deletion removes all versions, preserves the source, and validates an intentional No rubric state', () => {
  const original = removeRuns(createInitialWorkspace())
  const job = original.jobs[0]
  const first = original.rubrics.find((item) => item.id === job.rubricId)
  const second = { ...structuredClone(first), id: 'newer-rubric', version: 2, createdAt: later }
  original.rubrics.push(second)
  original.jobs[0] = { ...job, rubricId: second.id }
  const impact = getSampleLifecycleImpact(original, target('rubric', second.id))
  assert.equal(impact.counts.rubricVersions, 2)
  const deleted = validTransition(original, apply(original, target('rubric', second.id), 'delete'))
  assert.equal(deleted.rubrics.some((rubric) => rubric.groupId === first.groupId), false)
  assert.equal(latestRubrics(deleted).some((rubric) => rubric.groupId === first.groupId), false)
  assert.equal(deleted.jobs[0].rubricId, null)
  assert.equal(deleted.jobs[0].rubricDeletedAt, timestamp)
  assert.equal(deleted.jobs[0].status, 'ready')
  assert.deepEqual(deleted.documents, original.documents)
  assert.deepEqual(deleted.lifecycle.entities[`rubric:${first.groupId}`], { deletedAt: timestamp, parentKey: `job:${job.id}` })
  const accidental = structuredClone(deleted)
  delete accidental.jobs[0].rubricDeletedAt
  assert.throws(() => validateWorkspace(accidental), /intentional rubric-removal marker/)
  const fallback = structuredClone(deleted)
  fallback.rubrics.push(first)
  assert.throws(() => validateWorkspace(fallback), /No rubric|Deleted rubric/)
  assert.match(workspaceLifecycleTransitionErrors(deleted, original).join(' '), /deletion marker|deleted rubric/)
})

test('archived jobs allow lifecycle rubric deletion but not ordinary edits; individual version deletion is rejected', () => {
  const original = createFixtureWorkspace()
  const job = original.jobs[0]
  const rubric = original.rubrics.find((item) => item.id === job.rubricId)
  original.rubrics.push({ ...structuredClone(rubric), id: 'historical-v2', version: 2, createdAt: later })
  original.jobs[0].rubricId = 'historical-v2'
  const archived = apply(original, target('job', job.id), 'archive')
  validTransition(archived, apply(archived, target('rubric', rubric.groupId), 'delete'))
  const fallback = structuredClone(original)
  fallback.rubrics = fallback.rubrics.filter((item) => item.id !== 'historical-v2')
  fallback.jobs[0].rubricId = rubric.id
  validateWorkspace(fallback)
  assert.match(workspaceLifecycleTransitionErrors(original, fallback).join(' '), /complete rubric group/)
})

test('job deletion removes owned rubrics and documents; resume deletion preserves a shared live document', () => {
  const original = createFixtureWorkspace()
  const job = original.jobs[0]
  const deleted = validTransition(original, apply(original, target('job', job.id), 'delete'))
  assert.equal(deleted.documents.some((document) => document.id === job.documentId), false)
  assert.equal(deleted.rubrics.some((rubric) => rubric.jobId === job.id), false)
  assert.deepEqual(deleted.resumes, original.resumes)
  const shared = structuredClone(deleted)
  const resume = shared.resumes[0]
  shared.resumes.push({ ...structuredClone(resume), id: 'shared-resume', name: 'Another fictional owner' })
  validateWorkspace(shared)
  const removedFirst = validTransition(shared, apply(shared, target('resume', resume.id), 'delete'))
  assert.ok(removedFirst.documents.some((document) => document.id === resume.documentId))
  const removedLast = validTransition(removedFirst, apply(removedFirst, target('resume', 'shared-resume'), 'delete'))
  assert.equal(removedLast.documents.some((document) => document.id === resume.documentId), false)
  const retainedArtifact = structuredClone(deleted)
  retainedArtifact.documents.push(original.documents.find((document) => document.id === job.documentId))
  assert.match(workspaceLifecycleTransitionErrors(original, retainedArtifact).join(' '), /unused document/)
})

test('grade rubric and ladder deletion preserve siblings, and workspace deletion removes the entire cleared sample', () => {
  const original = createFixtureWorkspace()
  const grade = original.rubrics.find((rubric) => rubric.kind === 'grade')
  const siblings = original.rubrics.filter((rubric) => rubric.kind === 'grade' && rubric.ladder === grade.ladder && rubric.groupId !== grade.groupId)
  const deleted = validTransition(original, apply(original, target('rubric', grade.id), 'delete'))
  for (const sibling of siblings) assert.deepEqual(deleted.rubrics.find((rubric) => rubric.id === sibling.id), sibling)
  const deletedLadder = validTransition(deleted, apply(deleted, target('ladder', grade.ladder), 'delete'))
  assert.equal(deletedLadder.rubrics.some((rubric) => rubric.ladder === grade.ladder), false)
  assert.deepEqual(deletedLadder.jobs, original.jobs)
  const archived = apply(deletedLadder, workspaceTarget, 'archive')
  const empty = validTransition(archived, apply(archived, workspaceTarget, 'delete'))
  for (const key of ['jobs', 'resumes', 'rubrics', 'documents', 'runs']) assert.deepEqual(empty[key], [])
  assert.equal(empty.lifecycle.entities[`workspace:${workspaceTarget.id}`].deletedAt, timestamp)
  assert.match(workspaceLifecycleTransitionErrors(empty, original).join(' '), /deletion marker|deleted/)
})

test('debounced new analysis captures survive a subsequent ordinary rubric edit without permitting fabricated snapshots', () => {
  const original = createFixtureWorkspace()
  const job = original.jobs[0]
  const rubric = original.rubrics.find((item) => item.id === job.rubricId)
  const run = createAnalysisRun(original, [original.resumes[0].id], [rubric.id])
  const newer = { ...structuredClone(rubric), id: 'edited-after-capture', version: 2, createdAt: later }
  const coalesced = {
    ...original, runs: [run], rubrics: [...original.rubrics, newer],
    jobs: original.jobs.map((item) => item.id === job.id ? { ...item, rubricId: newer.id } : item),
  }
  validTransition(original, coalesced)
  const forged = structuredClone(coalesced)
  forged.runs[0].targets[0].job.title = 'A job that was never captured'
  assert.match(workspaceLifecycleTransitionErrors(original, forged).join(' '), /live source/)
})

test('new rubric groups cannot bypass an archived ladder by clearing its flag in the same state replacement', () => {
  const original = createFixtureWorkspace()
  const grade = original.rubrics.find((item) => item.kind === 'grade')
  const archived = apply(original, target('ladder', grade.ladder), 'archive')
  const restored = apply(archived, target('ladder', grade.ladder), 'unarchive')
  const duplicated = { ...structuredClone(grade), id: 'bypass-grade', groupId: 'bypass-group' }
  const candidate = { ...restored, rubrics: [...restored.rubrics, duplicated] }
  validateWorkspace(candidate)
  assert.match(workspaceLifecycleTransitionErrors(archived, candidate).join(' '), /Archived rubric/)
})

test('archived inputs, archived ancestors, and stale builder selections cannot create new analyses', () => {
  const original = createFixtureWorkspace()
  const resume = original.resumes[0]
  const job = original.jobs[0]
  const grade = original.rubrics.find((item) => item.kind === 'grade')
  for (const entity of [
    workspaceTarget, target('resume', resume.id), target('job', job.id), target('rubric', job.rubricId),
  ]) {
    const archived = apply(original, entity, 'archive')
    assert.throws(() => createAnalysisRun(archived, [resume.id], [job.rubricId]), /archived/)
    const bypass = { ...archived, runs: [createAnalysisRun(original, [resume.id], [job.rubricId])] }
    assert.match(workspaceLifecycleTransitionErrors(archived, bypass).join(' '), /archived/)
  }
  const archivedLadder = apply(original, target('ladder', grade.ladder), 'archive')
  assert.throws(() => createAnalysisRun(archivedLadder, [resume.id], [grade.id]), /archived/)
  const oldSnapshot = createAnalysisRun(original, [resume.id], [job.rubricId])
  const deleted = apply(original, target('job', job.id), 'delete')
  const bypass = { ...deleted, runs: [oldSnapshot] }
  validateWorkspace(bypass)
  assert.match(workspaceLifecycleTransitionErrors(deleted, bypass).join(' '), /deleted|missing/)
})

test('retained snapshot content and completed results cannot be rewritten even in an active workspace', () => {
  const original = createInitialWorkspace()
  const changedSnapshot = structuredClone(original)
  changedSnapshot.runs[0].targets[0].rubric.description = 'Rewritten historical description'
  validateWorkspace(changedSnapshot)
  assert.match(workspaceLifecycleTransitionErrors(original, changedSnapshot).join(' '), /preserve its captured source snapshots/)
  const changedResult = structuredClone(original)
  changedResult.runs[0].comparisons[0].summary = 'Rewritten finished result'
  validateWorkspace(changedResult)
  assert.match(workspaceLifecycleTransitionErrors(original, changedResult).join(' '), /preserve its completed results/)
})

test('fresh explicit sample resets preserve tombstones without reusing identities', () => {
  const original = createInitialWorkspace()
  const deleted = apply(removeRuns(original), target('job', original.jobs[0].id), 'delete')
  const reset = validTransition(deleted, withSampleResetTombstones(deleted, createFreshInitialWorkspace(), later))
  const oldKeys = new Set(sampleLifecycleTargets(original).map((entity) => `${entity.kind}:${entity.id}`))
  assert.ok(sampleLifecycleTargets(reset).every((entity) => !oldKeys.has(`${entity.kind}:${entity.id}`)))
  assert.equal(reset.jobs.length, original.jobs.length)
  assert.equal(reset.runs.length, original.runs.length)
  assert.deepEqual(reset.lifecycle.entities[`job:${original.jobs[0].id}`], deleted.lifecycle.entities[`job:${original.jobs[0].id}`])
  assert.match(workspaceLifecycleTransitionErrors(reset, deleted).join(' '), /deletion marker|deleted/)
  const again = validTransition(reset, withSampleResetTombstones(reset, createFreshInitialWorkspace(), later))
  assert.equal(again.jobs.length, original.jobs.length)
})

test('explicit creation after local workspace deletion keeps old root tombstones and rejects stale epochs', () => {
  const original = createFixtureWorkspace()
  const deleted = apply(setWorkspaceArchive(original, true, timestamp), workspaceTarget, 'delete')
  const recreated = validTransition(deleted, withSampleResetTombstones(deleted, createFreshInitialWorkspace(), later, 'new-local-root'))
  assert.equal(isEntityRemoved(recreated, workspaceTarget), false)
  assert.equal(isEntityArchived(recreated, workspaceTarget), false)
  assert.equal(recreated.lifecycle.epoch, 'new-local-root')
  assert.deepEqual(normalizeLifecycleTarget(recreated, workspaceTarget), target('workspace', 'new-local-root'))
  for (const [key, metadata] of Object.entries(deleted.lifecycle.entities)) assert.deepEqual(recreated.lifecycle.entities[key], metadata)
  assert.equal(isLifecycleManagementTransition(deleted, recreated), false, 'creating a new root is not an archived-item management edit')
  assert.match(workspaceLifecycleTransitionErrors(recreated, original).join(' '), /epoch|deleted/)
  const forged = structuredClone(recreated)
  forged.lifecycle.epoch = 'forged-active-root'
  assert.match(workspaceLifecycleTransitionErrors(recreated, forged).join(' '), /epoch/)
  const reset = validTransition(recreated, withSampleResetTombstones(recreated, createFreshInitialWorkspace(), later))
  assert.equal(reset.lifecycle.epoch, recreated.lifecycle.epoch, 'ordinary reset must not change the active root identity')
  const deletedAgain = apply(removeRuns(reset), workspaceTarget, 'delete')
  assert.equal(deletedAgain.lifecycle.entities['workspace:new-local-root'].deletedAt, timestamp)
  assert.throws(() => withSampleResetTombstones(deletedAgain, createFreshInitialWorkspace(), later, 'new-local-root'), /fresh workspace epoch/)
  const createdAgain = validTransition(deletedAgain, withSampleResetTombstones(deletedAgain, createFreshInitialWorkspace(), later, 'another-local-root'))
  assert.deepEqual(createdAgain.lifecycle.entities['workspace:new-local-root'], deletedAgain.lifecycle.entities['workspace:new-local-root'])
  assert.match(workspaceLifecycleTransitionErrors(createdAgain, recreated).join(' '), /epoch|deleted/)
})

test('local persistence rejects stale resurrection and reload preserves tombstones and archived metadata', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  })
  try {
    const original = createInitialWorkspace()
    stored.set(WORKSPACE_STORAGE_KEY, JSON.stringify(original))
    assert.deepEqual(loadWorkspace().workspace, original)
    const archived = apply(original, target('resume', original.resumes[0].id), 'archive')
    saveWorkspace(archived)
    assert.equal(isEntityArchived(loadWorkspace().workspace, target('resume', original.resumes[0].id)), true)
    const deleted = apply(removeRuns(archived), target('job', original.jobs[0].id), 'delete')
    saveWorkspace(deleted)
    assert.throws(() => saveWorkspace(original), /deletion marker|deleted/)
    assert.deepEqual(loadWorkspace().workspace, deleted)
    const deletedRoot = apply(deleted, workspaceTarget, 'delete')
    saveWorkspace(deletedRoot)
    assert.deepEqual(loadWorkspace().workspace, deletedRoot, 'loading a deleted local root must not silently bootstrap a demo')
    const recreated = withSampleResetTombstones(deletedRoot, createFreshInitialWorkspace(), later, 'created-local-root')
    saveWorkspace(recreated)
    assert.equal(loadWorkspace().workspace.lifecycle.epoch, 'created-local-root')
    assert.throws(() => saveWorkspace(original), /epoch|deletion marker|deleted/)
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  }
})

async function engineHarness(initial) {
  const [{ JSDOM }, React, { createRoot }] = await Promise.all([
    import('jsdom'), import('react'), import('react-dom/client'),
  ])
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  const globals = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of globals.keys()) Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key === 'window' ? 'self' : key],
  })
  let now = 0
  let timerId = 0
  const timers = new Map()
  dom.window.setTimeout = (callback, ms = 0) => {
    timers.set(++timerId, { callback, at: now + ms })
    return timerId
  }
  dom.window.clearTimeout = (id) => { timers.delete(id) }
  let engine
  let saved = initial
  const root = createRoot(dom.window.document.getElementById('root'))
  function Capture() {
    engine = useWorkspaceEngine(initial, (next) => {
      validTransition(saved, next)
      saved = next
      return 'saved'
    })
    return null
  }
  React.act(() => root.render(React.createElement(Capture)))
  return {
    get engine() { return engine },
    get saved() { return saved },
    act(callback) { let result; React.act(() => { result = callback(engine) }); return result },
    async advance(ms, beforeMicrotasks) {
      now += ms
      await React.act(async () => {
        for (let step = 0; step < 10; step++) {
          const due = [...timers.entries()].filter(([, timer]) => timer.at <= now)
          for (const [id, timer] of due) {
            timers.delete(id)
            timer.callback()
          }
          if (step === 0) beforeMicrotasks?.(engine)
          await Promise.resolve()
          if (!due.length && ![...timers.values()].some((timer) => timer.at <= now)) break
        }
      })
    },
    close() {
      React.act(() => root.unmount())
      dom.window.close()
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}

test('engine fences delayed imports and removed analysis callbacks, and restoration never restarts work', async () => {
  const original = createFixtureWorkspace()
  const harness = await engineHarness(original)
  const candidate = (label) => ({ key: label, label, title: label, fixtureIndex: 0 })
  try {
    const resumed = harness.act((engine) => engine.addResumes([candidate('Delayed fictional resume.pdf')]))
    harness.act((engine) => engine.changeLifecycle(workspaceTarget, 'archive'))
    assert.deepEqual(await resumed, [])
    await harness.advance(1000)
    assert.equal(harness.engine.workspace.resumes.length, original.resumes.length)
    assert.throws(() => harness.engine.addJobs([candidate('No archived import.pdf')], 'pdf'), /archived/)
    assert.throws(() => harness.engine.saveRubric(original.rubrics[0]), /archived/)
    assert.throws(() => harness.engine.resetDemo(), /archived/)
    await assert.rejects(harness.engine.addResumes([candidate('No archived resume.pdf')]), /archived/)
    harness.act((engine) => engine.changeLifecycle(workspaceTarget, 'unarchive'))

    const [deletedJobId] = harness.act((engine) => engine.addJobs([candidate('Deleted pending sample.pdf')], 'pdf'))
    harness.act((engine) => engine.changeLifecycle(target('job', deletedJobId), 'delete'))
    await harness.advance(2000)
    assert.equal(harness.engine.workspace.jobs.some((job) => job.id === deletedJobId), false)

    const [pausedJobId] = harness.act((engine) => engine.addJobs([candidate('Paused pending sample.pdf')], 'pdf'))
    const pausedRubric = harness.engine.workspace.rubrics.find((rubric) => rubric.jobId === pausedJobId)
    harness.act((engine) => engine.changeLifecycle(target('rubric', pausedRubric.id), 'archive'))
    harness.act((engine) => engine.changeLifecycle(target('rubric', pausedRubric.id), 'unarchive'))
    await harness.advance(2000)
    assert.equal(harness.engine.workspace.jobs.find((job) => job.id === pausedJobId).status, 'cancelled')
    harness.act((engine) => engine.retryJob(pausedJobId))
    await harness.advance(650)
    await harness.advance(1000)
    assert.equal(harness.engine.workspace.jobs.find((job) => job.id === pausedJobId).status, 'ready')

    const [noRubricJobId] = harness.act((engine) => engine.addJobs([candidate('Removed pending rubric.pdf')], 'pdf'))
    const removedRubric = harness.engine.workspace.rubrics.find((rubric) => rubric.jobId === noRubricJobId)
    harness.act((engine) => engine.changeLifecycle(target('rubric', removedRubric.id), 'delete'))
    await harness.advance(2000)
    assert.equal(harness.engine.workspace.jobs.find((job) => job.id === noRubricJobId).rubricId, null)
    assert.throws(() => harness.engine.retryJob(noRubricJobId), /No rubric/)

    const analysisId = harness.act((engine) => engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]))
    harness.act((engine) => engine.changeLifecycle(target('analysis', analysisId), 'delete'))
    await harness.advance(1000)
    assert.equal(harness.engine.workspace.runs.some((run) => run.id === analysisId), false)

    const independentId = harness.act((engine) => engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]))
    harness.act((engine) => engine.changeLifecycle(target('job', original.jobs[0].id), 'archive'))
    await harness.advance(500)
    assert.equal(harness.engine.workspace.runs.find((run) => run.id === independentId).comparisons[0].status, 'complete')
    assert.throws(() => harness.engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]), /archived/)
    assert.throws(() => harness.engine.retryJob(original.jobs[0].id), /archived/)
  } finally {
    harness.close()
  }
})

test('duplicating a grade after reset retains its fresh ladder identity rather than reviving an old ladder', async () => {
  const harness = await engineHarness(createInitialWorkspace())
  try {
    harness.act((engine) => engine.resetDemo())
    const grade = harness.engine.workspace.rubrics.find((rubric) => rubric.kind === 'grade')
    const parentKey = getEntityLifecycle(harness.engine.workspace, target('rubric', grade.id)).parentKey
    const copiedId = harness.act((engine) => engine.saveRubric({ ...grade, name: `${grade.name} copy` }, true))
    assert.equal(getEntityLifecycle(harness.engine.workspace, target('rubric', copiedId)).parentKey, parentKey)
    harness.act((engine) => engine.changeLifecycle(target('ladder', parentKey.slice('ladder:'.length)), 'archive'))
    assert.equal(isEntityArchived(harness.engine.workspace, target('rubric', copiedId)), true)
    assert.throws(() => harness.engine.saveRubric(grade, true), /archived/)
  } finally {
    harness.close()
  }
})

test('a resolved resume timer cannot publish after reset aborts its continuation', async () => {
  const harness = await engineHarness(createInitialWorkspace())
  try {
    const pending = harness.act((engine) => engine.addResumes([
      { key: 'racing-resume', label: 'Import racing explicit reset.pdf', title: 'Race', fixtureIndex: 0 },
    ]))
    await harness.advance(650, (engine) => engine.resetDemo())
    assert.deepEqual(await pending, [])
    assert.equal(harness.engine.workspace.resumes.length, createFixtureWorkspace().resumes.length)
    assert.equal(harness.engine.workspace.resumes.some((resume) => resume.sourceLabel === 'Import racing explicit reset.pdf'), false)
  } finally {
    harness.close()
  }
})

test('external workspace archive fences every pending task without autosaving authoritative lifecycle metadata', async () => {
  const original = createInitialWorkspace()
  const harness = await engineHarness(original)
  const candidate = (label) => ({ key: label, label, title: label, fixtureIndex: 0 })
  try {
    const [jobId] = harness.act((engine) => engine.addJobs([candidate('Externally archived import.pdf')], 'pdf'))
    const resumePromise = harness.act((engine) => engine.addResumes([candidate('Externally archived resume.pdf')]))
    const runId = harness.act((engine) => engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]))
    const before = harness.saved
    harness.act((engine) => engine.setExternalArchive(true))
    assert.equal(harness.saved, before, 'an external archive fence must not enqueue any sample save')
    assert.equal(harness.engine.workspace.lifecycle, before.lifecycle, 'external metadata belongs to the cloud coordinator')
    assert.deepEqual(await resumePromise, [])
    assert.equal(harness.engine.workspace.jobs.find((job) => job.id === jobId).status, 'cancelled')
    assert.equal(harness.engine.workspace.runs.find((run) => run.id === runId).comparisons[0].status, 'cancelled')
    for (const run of original.runs) {
      assert.deepEqual(harness.engine.workspace.runs.find((item) => item.id === run.id), run)
    }
    assert.throws(() => harness.engine.addJobs([candidate('Must remain blocked.pdf')], 'pdf'), /archived/)
    await assert.rejects(harness.engine.addResumes([candidate('Must remain blocked resume.pdf')]), /archived/)
    assert.throws(() => harness.engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]), /archived/)
    assert.throws(() => harness.engine.saveRubric(original.rubrics[0]), /archived/)
    assert.throws(() => harness.engine.retryJob(jobId), /archived/)
    assert.throws(() => harness.engine.retryRun(runId), /archived/)
    assert.throws(() => harness.engine.resetDemo(), /archived/)
    harness.act((engine) => engine.changeLifecycle(target('analysis', runId), 'delete'))
    assert.equal(harness.engine.workspace.runs.some((run) => run.id === runId), false, 'lifecycle management remains available')
    harness.act((engine) => engine.setExternalArchive(false))
    await harness.advance(3000)
    assert.equal(harness.engine.workspace.jobs.find((job) => job.id === jobId).status, 'cancelled')
    assert.equal(harness.engine.workspace.resumes.length, original.resumes.length)
    assert.equal(harness.engine.workspace.runs.some((run) => run.id === runId), false)
  } finally {
    harness.close()
  }
})

test('resetDemo explicitly creates a new local workspace after root deletion without resurrecting identities', async () => {
  const original = createFixtureWorkspace()
  const harness = await engineHarness(original)
  try {
    harness.act((engine) => engine.changeLifecycle(workspaceTarget, 'delete'))
    assert.equal(isEntityRemoved(harness.engine.workspace, workspaceTarget), true)
    const deleted = harness.engine.workspace
    harness.act((engine) => engine.resetDemo())
    assert.equal(isEntityRemoved(harness.engine.workspace, workspaceTarget), false)
    assert.ok(harness.engine.workspace.lifecycle.epoch)
    assert.ok(harness.engine.workspace.jobs.length)
    assert.equal(harness.engine.workspace.jobs.some((job) => original.jobs.some((old) => old.id === job.id)), false)
    assert.equal(harness.engine.workspace.lifecycle.entities[`workspace:${workspaceTarget.id}`].deletedAt,
      deleted.lifecycle.entities[`workspace:${workspaceTarget.id}`].deletedAt)
    assert.match(harness.engine.notice, /New demo workspace created/)
  } finally {
    harness.close()
  }
})

test('authoritative engine replacement aborts resolved old callbacks without persisting or retaining stale root archive', async () => {
  const original = createFixtureWorkspace()
  const harness = await engineHarness(original)
  try {
    const [jobId] = harness.act((engine) => engine.addJobs([
      { key: 'replace-job', label: 'Job before authoritative refresh.pdf', title: 'Replace', fixtureIndex: 0 },
    ], 'pdf'))
    const resumePromise = harness.act((engine) => engine.addResumes([
      { key: 'replace-resume', label: 'Resume before authoritative refresh.pdf', title: 'Replace', fixtureIndex: 0 },
    ]))
    const runId = harness.act((engine) => engine.startAnalysis([original.resumes[0].id], [original.jobs[0].rubricId]))
    const before = harness.saved
    const invalid = structuredClone(before)
    invalid.rubrics[0].dataKind = 'real'
    assert.throws(() => harness.engine.replaceWorkspace(invalid), /dataKind|Unrecognized/)
    assert.equal(harness.engine.workspace, before)
    const replacement = setWorkspaceArchive(withSampleResetTombstones(before, createFreshInitialWorkspace(), later), true, later)
    await harness.advance(650, (engine) => engine.replaceWorkspace(replacement))
    assert.deepEqual(await resumePromise, [])
    assert.equal(harness.saved, before, 'replacement must not autosave the fetched state or local cancellations')
    assert.deepEqual(harness.engine.workspace, replacement)
    assert.equal(harness.engine.workspace.jobs.some((job) => job.id === jobId), false)
    assert.equal(harness.engine.workspace.runs.some((run) => run.id === runId), false)
    await harness.advance(3000)
    assert.equal(harness.saved, before)
    assert.deepEqual(harness.engine.workspace, replacement, 'aborted continuations must not resurrect replaced identities')

    harness.act((engine) => engine.setExternalArchive(true))
    const restored = setWorkspaceArchive(replacement, false, later)
    harness.act((engine) => engine.replaceWorkspace(restored))
    assert.equal(harness.engine.workspace.lifecycle.archivedAt, undefined)
    assert.throws(() => harness.engine.startAnalysis([restored.resumes[0].id], [restored.jobs[0].rubricId]), /archived/,
      'replacement must not override the separately controlled external guard')
    harness.act((engine) => engine.setExternalArchive(false))
    assert.doesNotThrow(() => harness.act((engine) => engine.startAnalysis([restored.resumes[0].id], [restored.jobs[0].rubricId])))
  } finally {
    harness.close()
  }
})
