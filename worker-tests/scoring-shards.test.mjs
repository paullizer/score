import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { prepareScoringShards, validateScoringShardIndex, mergeScoringShardObservations,
  prepareResumeJobEvaluation, scoringSuiteSchema, evaluationHash, QC_LIMITS } =
  await loadWorker('../worker/evals/index.ts')

function fixture() {
  const rubric = {
    id: 'rubric', groupId: 'rubric', jobId: 'job-1', kind: 'job', dataKind: 'real',
    name: 'Statistics', description: 'Applied statistical methods.', version: 1, createdAt: '2026-10-07T00:00:00Z',
    criteria: [{
      id: 'statistics', key: 'custom', label: 'Statistics', description: 'Applied statistical methods.',
      weight: 100, requirementType: 'required', guidance: '0: No evidence. 1: Training. 2: Applied example.',
      sourceCitations: [{ documentId: 'job-source', documentVersion: 1, paragraphId: 'job-p1', page: 1,
        heading: 'Work', quote: 'Applied statistical methods.' }],
    }],
  }
  const cases = [], inputs = []
  for (let family = 1; family <= 7; family++) for (let job = 1; job <= 4; job++) {
    const id = `family-${family}.job-${job}`, familyId = `family-${family}`
    const input = prepareResumeJobEvaluation('Applied regression to survey data.', familyId, rubric)
    inputs.push({ id, input })
    cases.push({ id, familyId, jobId: `job-${job}`, split: family <= 4 ? 'development' : 'calibration',
      inputSha256: evaluationHash(input), criterionIds: ['statistics'] })
  }
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'parent', purpose: 'screening', sourceVersion: 'fixtures', repetitions: 2,
    configurations: [{ id: 'baseline', algorithmVersion: 'score-production-v1', settingsSha256: 'a'.repeat(64) }],
    cases,
  })
  return { suite, inputs }
}

function results(partition) {
  return partition.shards.map(shard => ({
    shardId: shard.suite.id, suiteSha256: evaluationHash(shard.suite),
    observations: shard.suite.cases.flatMap(item => [1, 2].map(repetition => ({
      schemaVersion: 1, suiteSha256: evaluationHash(shard.suite), caseId: item.id,
      configurationId: 'baseline', repetition, durationMilliseconds: 1,
      result: { status: 'complete', overall: 0, criteria: [{ criterionId: 'statistics', score: 0 }] },
    }))),
  }))
}

test('source-bound execution shards preserve every family, split and configuration within existing QC case limits', () => {
  const data = fixture()
  const partition = prepareScoringShards(data.suite, data.inputs)
  assert.equal(partition.shards.length, 2)
  assert.deepEqual(partition.shards.map(row => row.suite.cases.length), [24, 4])
  assert(partition.shards.every(row => row.suite.cases.length <= QC_LIMITS.planCases))
  assert.deepEqual(prepareScoringShards(data.suite, data.inputs), partition)
  assert.equal(partition.index.parentSuiteSha256, evaluationHash(data.suite))
  const familyShards = new Map()
  for (const [index, shard] of partition.shards.entries()) {
    assert.deepEqual(shard.suite.configurations, data.suite.configurations)
    for (const item of shard.suite.cases) {
      assert.deepEqual(item, data.suite.cases.find(row => row.id === item.id))
      if (familyShards.has(item.familyId)) assert.equal(familyShards.get(item.familyId), index)
      familyShards.set(item.familyId, index)
      assert.deepEqual(shard.inputs.find(row => row.id === item.id).input, data.inputs.find(row => row.id === item.id).input)
    }
  }
  assert.equal(familyShards.size, 7)
  const leaked = structuredClone(data.inputs)
  leaked[0].input.resume.paragraphs[0].text = 'Altered source.'
  assert.throws(() => prepareScoringShards(data.suite, leaked), /exact saved case/)
  assert.throws(() => prepareScoringShards(data.suite, data.inputs.slice(1)), /every exact parent/)
  assert.throws(() => prepareScoringShards(data.suite, [...data.inputs, data.inputs[0]]), /every exact parent/)
  const oversizedFamily = structuredClone(data.suite)
  oversizedFamily.cases.forEach(row => { row.familyId = 'one-family'; row.split = 'development' })
  assert.throws(() => prepareScoringShards(oversizedFamily, data.inputs), /family exceeds/)
})

test('parent-bound merge validates shard identity before rebinding and keeps failed, null and missing outcomes distinct', () => {
  const data = fixture(), partition = prepareScoringShards(data.suite, data.inputs)
  const rows = results(partition)
  rows[0].observations[0].result = { status: 'failed', code: 'timeout' }
  rows[0].observations[1].result = {
    status: 'complete', overall: null, criteria: [{ criterionId: 'statistics', score: null }],
  }
  const merged = mergeScoringShardObservations(partition.index, rows)
  assert.equal(merged.observed, 56)
  assert.equal(merged.expected, 56)
  assert.equal(merged.complete, true)
  assert.equal(merged.coverage[0].failed, 1)
  assert.equal(merged.observations[0].result.status, 'failed')
  assert.equal(merged.observations[1].result.criteria[0].score, null)
  assert(merged.observations.every(row => row.suiteSha256 === evaluationHash(data.suite)))
  assert.equal(merged.eligibleForRelease, false)
  const incomplete = mergeScoringShardObservations(partition.index, [rows[1]])
  assert.equal(incomplete.complete, false)
  assert.equal(incomplete.observed, 8)
  assert.equal(incomplete.coverage[0].missingShard, true)
  assert.equal(incomplete.coverage[0].failed, 0)
  const partial = mergeScoringShardObservations(partition.index, [{ ...rows[0], observations: rows[0].observations.slice(0, 1) }])
  assert.equal(partial.coverage[0].missingShard, false)
  assert.equal(partial.observed, 1)
  assert.equal(partial.complete, false)
  assert.throws(() => mergeScoringShardObservations(partition.index, [rows[0], rows[0]]), /Duplicate shard result/)
  assert.throws(() => mergeScoringShardObservations(partition.index, [{ ...rows[0], shardId: 'unknown' }]), /outside/)
  assert.throws(() => mergeScoringShardObservations(partition.index, [{ ...rows[0], suiteSha256: 'b'.repeat(64) }]), /binding/)
  const altered = structuredClone(rows[0])
  altered.observations[0].suiteSha256 = evaluationHash(data.suite)
  assert.throws(() => mergeScoringShardObservations(partition.index, [altered]), /frozen suite/)
  assert.throws(() => mergeScoringShardObservations(partition.index, [{
    ...rows[0], observations: [rows[0].observations[0], rows[0].observations[0]],
  }]), /Duplicate observation/)
})

test('shard indices reject stale parent hashes, altered configurations, missing cases and split families', () => {
  const data = fixture(), partition = prepareScoringShards(data.suite, data.inputs)
  const stale = structuredClone(partition.index)
  stale.parentSuiteSha256 = 'f'.repeat(64)
  assert.throws(() => validateScoringShardIndex(stale), /parent suite/)
  const changed = structuredClone(partition.index)
  changed.parentSuite.configurations[0].settingsSha256 = 'c'.repeat(64)
  changed.parentSuiteSha256 = evaluationHash(changed.parentSuite)
  assert.throws(() => validateScoringShardIndex(changed), /suite hash/)
  const omitted = structuredClone(partition.index)
  omitted.shards.pop()
  assert.throws(() => validateScoringShardIndex(omitted), /cover every/)
  const split = structuredClone(partition.index)
  const transferred = split.shards[0].caseIds.pop()
  split.shards[1].caseIds.push(transferred)
  for (const shard of split.shards) {
    shard.suiteSha256 = evaluationHash({ ...data.suite, id: shard.id,
      cases: shard.caseIds.map(id => data.suite.cases.find(row => row.id === id)) })
  }
  assert.throws(() => validateScoringShardIndex(split), /family cannot cross/)
})
