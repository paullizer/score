import assert from 'node:assert/strict'
import test from 'node:test'
import {
  modelApi, candidateFixture, targetFixture, mockModel, deterministic, validators, expandReviewedOutput,
} from './narrative-model-test-support.mjs'
import {
  narrativeModelTestResponse, narrativeModelTestResponseFor,
} from './narrative-model-response-test-support.mjs'

function fakeModel() {
  return mockModel(({ request }) => narrativeModelTestResponse(request))
}

test('the reusable fake leaves existing scoring and other model requests to their own handlers', () => {
  for (const name of ['resume_rubric_assessment', 'resume_rubric_grounding_review', 'resume_profile']) {
    assert.equal(narrativeModelTestResponse({ response_format: { json_schema: { name } } }), undefined)
    assert.equal(narrativeModelTestResponseFor(name, {}), undefined)
  }
})

test('the reusable candidate fake uses actual reference IDs and supports normal, fully supported and limited grade fixtures', async () => {
  for (const options of [{}, { strong: true }, { grade: true, limited: true }]) {
    const input = candidateFixture(17, options)
    const mock = fakeModel()
    const result = await modelApi.generateCandidateNarrative(input, mock.options)
    assert.equal(mock.calls.length, 2)
    assert.deepEqual(validators.validateCandidateNarrativeOutput(result.output, input), result.output)
    assert.equal(result.provenance.correctionCount, 0)
    assert.equal(result.provenance.groundingReviews.at(-1).outcome, 'supported')
    assert.equal(result.provenance.groundingReviews.at(-1).outputSha256, deterministic.analysisHash(result.output))
  }
})

test('the reusable target fake supports exact cohorts and terminal unassessed pairs without scoring them', async () => {
  for (const input of [targetFixture(3, { terminal: ['failed', 'cancelled'] }), targetFixture(0, { terminal: ['cancelled'] })]) {
    const mock = fakeModel()
    const result = await modelApi.generateTargetNarrative(input, mock.options)
    assert.deepEqual(validators.validateTargetNarrativeOutput(result.output, input), result.output)
    assert.equal(result.provenance.correctionCount, 0)
    assert.deepEqual(expandReviewedOutput(mock.calls.at(-1).body), result.output)
  }
})

test('the reusable fake supports exhaustive hierarchical GS synthesis and independently reviewed request shapes', async () => {
  const input = targetFixture(500, { grade: true, lateGap: true })
  const mock = fakeModel()
  const result = await modelApi.generateTargetNarrative(input, mock.options)
  assert.ok(result.provenance.synthesis.length > 1)
  assert.equal(result.provenance.groundingReviews.length, result.provenance.synthesis.length + 1)
  const seen = new Set(result.output.claims.flatMap(claim => claim.references.map(reference => reference.comparisonId)))
  assert.equal(seen.size, 500)
  assert.equal(result.output.claims.flatMap(claim => claim.references).filter(reference => reference.kind === 'qualification').length, 500)
  assert.equal(result.output.claims.flatMap(claim => claim.references).filter(reference => reference.kind === 'limitation').length, 1)
  assert.equal(result.provenance.groundingReviews.at(-1).inputFingerprint, input.inputFingerprint)
  assert.deepEqual(expandReviewedOutput(mock.calls.at(-1).body), result.output)
})
