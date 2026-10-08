import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { prepareBlindSpotChecks, prepareResumeJobEvaluation, evaluationHash, scoringSuiteSchema, importBlindHumanLabels, measureExtractionPreservation } = await loadWorker('../worker/evals/index.ts')

function fixture() {
  const cases = [], inputs = [], targets = []
  const citation = { documentId: 'job-document', documentVersion: 1, paragraphId: 'job-p1', page: 1, heading: 'Work', quote: 'Documented statistical analysis.' }
  for (const split of ['development', 'calibration', 'holdout']) {
    for (let job = 1; job <= 4; job++) {
      for (let item = 0; item < (split === 'development' ? 6 : 3); item++) {
        const id = `${split}-job-${job}-item-${item}`
        const input = prepareResumeJobEvaluation('Applied regression to survey data.', id, {
          id: 'rubric-1', groupId: 'rubric-1', jobId: `job-${job}`, kind: 'job', dataKind: 'real',
          name: 'Statistical work', description: 'Documented statistical analysis.', version: 1,
          createdAt: '2026-10-07T00:00:00Z',
          criteria: [{
            id: 'statistics', key: 'custom', label: 'Statistics', description: 'Documented statistical analysis.',
            weight: 100, requirementType: 'required',
            guidance: '0: Not documented. 1: Coursework. 2: Applied example. 3: Sustained work. 4: Coordinated work. 5: Led work.',
            sourceCitations: [citation],
          }],
        })
        cases.push({ id, familyId: id, jobId: `job-${job}`, split, inputSha256: evaluationHash(input), criterionIds: ['statistics'] })
        inputs.push({ id, input })
        targets.push({ id: `reference-${id}`, caseId: id, criterionId: 'statistics', priority: item })
      }
    }
  }
  return {
    suite: scoringSuiteSchema.parse({
      schemaVersion: 1, id: 'blind-fixture', purpose: 'screening', sourceVersion: 'fixtures-v1', repetitions: 2,
      configurations: [{ id: 'hidden-model', settingsSha256: 'a'.repeat(64), algorithmVersion: 'score-production-v1' }],
      cases,
    }),
    inputs, targets,
  }
}

test('blind batch preserves split allocations, job coverage and probability denominators without model leakage', () => {
  const { suite, inputs, targets } = fixture()
  const pack = prepareBlindSpotChecks(suite, targets, inputs, 'seed-1')
  assert.equal(pack.cards.length, 30)
  assert.equal(pack.cards.filter(card => card.stratum === 'probability-sample').length, 20)
  for (const [split, count] of [['development', 18], ['calibration', 6], ['holdout', 6]]) {
    const cards = pack.cards.filter(card => card.split === split)
    assert.equal(cards.length, count)
    for (let job = 1; job <= 4; job++) {
      const probabilityCards = cards.filter(card => card.jobId === `job-${job}` && card.stratum === 'probability-sample')
      assert.equal(probabilityCards.length, split === 'development' ? 3 : 1)
      for (const card of probabilityCards) assert.equal(card.inclusionProbability, split === 'development' ? 0.5 : 1 / 3)
    }
  }
  for (const card of pack.cards) {
    assert.deepEqual(card.response, { score: null, unableToJudge: null, reason: '', supportingPassageIds: [] })
    assert.equal(card.inputSha256, suite.cases.find(item => item.id === card.caseId).inputSha256)
    assert.ok(card.source.paragraphs.length)
    assert.equal(Object.hasOwn(card, 'priority'), false)
  }
  assert.equal(JSON.stringify(pack).includes('hidden-model'), false)
  assert.deepEqual(prepareBlindSpotChecks(suite, [...targets].reverse(), [...inputs].reverse(), 'seed-1'), pack)
})

test('blind pack rejects stale evidence, duplicate targets, unknown criteria and invalid sampling', () => {
  const { suite, inputs, targets } = fixture()
  assert.throws(() => prepareBlindSpotChecks(suite, [...targets, targets[0]], inputs, 'seed-1'), /unique/)
  assert.throws(() => prepareBlindSpotChecks(suite, targets.map(row => ({ ...row, criterionId: 'invented' })), inputs, 'seed-1'), /outside/)
  const stale = inputs.map(row => ({
    ...row, input: { ...row.input, resume: { ...row.input.resume, title: 'Changed source' } },
  }))
  assert.throws(() => prepareBlindSpotChecks(suite, targets, stale, 'seed-1'), /source hash/)
  assert.throws(() => prepareBlindSpotChecks(suite, targets, inputs, ''), /small/)
  assert.throws(() => prepareBlindSpotChecks(suite, targets.map(row => ({ ...row, priority: NaN })), inputs, 'seed-1'), /number/)
  assert.throws(() => prepareBlindSpotChecks(
    { ...suite, cases: suite.cases.filter(row => row.jobId !== 'job-4') }, targets, inputs, 'seed-1',
  ), /four jobs/)
})

test('human label revisions bind the unchanged blind source, expose seen-model labels and retain unresolved outcomes', () => {
  const { suite, targets, inputs } = fixture()
  const pack = prepareBlindSpotChecks(suite, targets, inputs, 'human-seed')
  const responses = pack.cards.slice(0, 3).map((card, index) => ({
    cardId: card.id, inputSha256: card.inputSha256,
    score: index === 2 ? null : index,
    unableToJudge: index === 2, reason: 'Read the exact document against the saved anchor.',
    supportingPassageIds: index === 1 ? [1] : [],
    exposure: index === 1 ? 'model-output-seen' : 'blind',
  }))
  const submission = {
    suite, targets, inputs, seed: 'human-seed', packSha256: evaluationHash(pack),
    author: 'human-reviewer', revision: 'human-v1', submittedAt: '2026-10-07T18:00:00Z', responses,
  }
  const labels = importBlindHumanLabels(submission)
  assert.deepEqual(labels.references.map(row => row.score), [0, 1, null])
  assert.deepEqual(labels.references.map(row => row.independent), [true, false, true])
  assert.equal(labels.evidence[1].citations[0].quote, 'Applied regression to survey data.')
  assert.equal(labels.references[2].reason, responses[2].reason)
  assert.throws(() => importBlindHumanLabels({ ...submission, packSha256: 'a'.repeat(64) }), /unchanged blind pack/)
  assert.throws(() => importBlindHumanLabels({ ...submission, responses: [...responses, responses[0]] }), /unique/)
  assert.throws(() => importBlindHumanLabels({ ...submission, responses: [{
    ...responses[1], supportingPassageIds: [999],
  }] }), /outside/)
  assert.throws(() => importBlindHumanLabels({ ...submission, responses: [{
    ...responses[1], supportingPassageIds: [],
  }] }), /positive scores/)
  assert.throws(() => importBlindHumanLabels({ ...submission, responses: [{
    ...responses[2], unableToJudge: false,
  }] }), /unresolved status/)
})

test('extraction measurements distinguish exact, whitespace-equivalent and missing facts without modifying sources', () => {
  const { inputs } = fixture()
  const trial = {
    id: 'trial-1', familyId: 'family-1', input: inputs[0].input, inputSha256: evaluationHash(inputs[0].input),
    facts: [
      { id: 'exact', text: 'Applied regression to survey data.', critical: true },
      { id: 'whitespace', text: 'Applied regression  to survey data.', critical: false },
      { id: 'missing', text: 'Directed a national survey redesign.', critical: true },
    ],
  }
  const before = JSON.stringify(trial)
  const result = measureExtractionPreservation([trial])
  assert.equal(result.catalogLossless, true)
  assert.equal(result.exactPreservedFacts, 1)
  assert.equal(result.whitespaceEquivalentFacts, 2)
  assert.equal(result.criticalMissing, 1)
  assert.equal(result.exactRecall, 1 / 3)
  assert.equal(JSON.stringify(trial), before)
  assert.throws(() => measureExtractionPreservation([{ ...trial, inputSha256: 'b'.repeat(64) }]), /exact frozen/)
  assert.throws(() => measureExtractionPreservation([{ ...trial, facts: [trial.facts[0], trial.facts[0]] }]), /fact IDs/)
})
