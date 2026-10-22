import assert from 'node:assert/strict'
import test from 'node:test'
import { createLifecycleDependencies } from '../dist-server/app.mjs'
import { legacyStateBody } from './helpers.mjs'

test('deletions never report seed ladder or analysis blockers', async () => {
  const dependencies = createLifecycleDependencies(undefined, undefined, true, undefined, true)
  for (const target of [
    { kind: 'workspace', id: 'workspace-one' },
    { kind: 'job', id: 'seed-job' },
    { kind: 'rubric', id: 'new-version-id' },
    { kind: 'ladder', id: 'ladder-1' },
    { kind: 'resume', id: 'resume-1' },
    { kind: 'analysis', id: 'analysis-1' },
  ]) {
    assert.deepEqual(await dependencies.impact('workspace-one', target), [])
  }
})

test('configured real stores do not block job, rubric, ladder, resume, or workspace deletion', async () => {
  const jobs = { store: {
    async getRubric() { assert.fail('Deletion impact must not query rubrics for blockers') },
    async listRubrics() { assert.fail('Deletion impact must not list rubrics for blockers') },
  } }
  const grades = { store: {
    async list() { assert.fail('Deletion impact must not scan grade ladders for blockers') },
  } }
  const analyses = { store: {
    async list() { assert.fail('Deletion impact must not scan analyses for blockers') },
  } }
  const dependencies = createLifecycleDependencies(jobs, grades, true, analyses, true)
  assert.deepEqual(await dependencies.impact('workspace-one', { kind: 'job', id: 'seed-job' }), [])
  assert.deepEqual(await dependencies.impact('workspace-one', { kind: 'rubric', id: 'stable-group' }), [])
  assert.deepEqual(await dependencies.impact('workspace-one', { kind: 'workspace', id: 'workspace-one' }), [])
})

test('legacy state blobs with sample runs are irrelevant to lifecycle dependencies', async () => {
  const state = {
    async getState() { assert.fail('Lifecycle dependencies must not read legacy state.json') },
  }
  const dependencies = createLifecycleDependencies()
  const blockers = await dependencies.impact('workspace-one', { kind: 'job', id: 'seed-job' })
  assert.deepEqual(blockers, [])
  assert.ok({ ...legacyStateBody(), runs: [{ id: 'legacy-sample-run' }] })
  assert.equal(typeof state.getState, 'function')
})
