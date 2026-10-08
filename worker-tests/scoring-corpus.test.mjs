import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { prepareScoringCorpus, selectReferenceTargets } = await loadWorker('../worker/evals/index.ts')
function sources() {
  return {
    schemaVersion: 1, seed: 'score-v1',
    existing: Array.from({ length: 40 }, (_, index) => ({ id: `resume-${index}`, text: `Documented work for simulated resume ${index}.` })),
    jobs: [7, 11, 12, 13].map(grade => ({ id: `gs-${grade}`, title: `Survey Statistician GS ${grade}`, documentSha256: 'a'.repeat(64) })),
  }
}

test('corpus contains 50 reproducible families with inherited variant splits and planted facts', () => {
  const first = prepareScoringCorpus(sources())
  assert.deepEqual(prepareScoringCorpus(sources()), first)
  assert.equal(first.families.length, 50)
  for (const [split, expected] of [['development', 30], ['calibration', 10], ['holdout', 10]]) {
    assert.equal(first.families.filter(row => row.split === split).length, expected)
  }
  assert.equal(first.families.filter(row => row.origin === 'existing-simulated').length, 30)
  assert.equal(first.families.filter(row => row.origin === 'controlled-simulated').length, 20)
  assert.equal(first.variants.length, 60)
  for (const variant of first.variants) assert.equal(variant.split, first.families.find(row => row.id === variant.familyId).split)
  assert.ok(first.families.filter(row => row.origin === 'controlled-simulated').every(row => row.text.includes(row.plantedFacts[0].text)))
  assert.throws(() => prepareScoringCorpus({ ...sources(), jobs: sources().jobs.slice(1) }))
  assert.throws(() => prepareScoringCorpus({ ...sources(), existing: [...sources().existing, sources().existing[0]] }), /unique/)
})

test('reference selection preserves 75 items per job and separate split allocations', () => {
  const corpus = prepareScoringCorpus(sources())
  const targets = corpus.jobs.flatMap(job => corpus.families.flatMap(family =>
    Array.from({ length: 4 }, (_, index) => ({
      caseId: `${job.id}.${family.id}`, familyId: family.id, jobId: job.id,
      criterionId: `criterion-${index}`, split: family.split, inputSha256: 'a'.repeat(64),
    }))))
  const selected = selectReferenceTargets(targets, 'fixed-seed')
  assert.equal(selected.length, 300)
  assert.equal(new Set(selected.map(row => row.id)).size, 300)
  assert.ok(selected.every(row => /^reference-[a-f0-9]{64}$/.test(row.id)))
  assert.deepEqual(selectReferenceTargets([...targets].reverse(), 'fixed-seed'), selected)
  for (const job of corpus.jobs) {
    const rows = selected.filter(row => row.jobId === job.id)
    assert.equal(rows.length, 75)
    assert.equal(rows.filter(row => row.split === 'development').length, 45)
    assert.equal(rows.filter(row => row.split === 'calibration').length, 15)
    assert.equal(rows.filter(row => row.split === 'holdout').length, 15)
    assert.ok(rows.every(row => row.inclusionProbability > 0 && row.inclusionProbability <= 1 && row.labelStatus === 'pending'))
  }
  assert.throws(() => selectReferenceTargets([...targets, targets[0]], 'fixed-seed'), /distinct/)
})
