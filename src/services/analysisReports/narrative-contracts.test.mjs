import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { before, test } from 'node:test'
import { build } from 'esbuild'

let api
before(async () => {
  const result = await build({
    entryPoints: [resolve('src', 'domain', 'analysis-narratives.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
})

const fingerprint = 'a'.repeat(64)
const publication = {
  generationId: 'generation-1', inputFingerprint: fingerprint,
  revision: 'b'.repeat(64), publishedAt: '2026-09-19T17:00:00.000Z',
}
const current = {
  status: 'ready', generationId: 'generation-1', inputFingerprint: fingerprint, published: publication,
}
const snapshot = { snapshotId: 'snapshot-1', sha256: 'c'.repeat(64) }

function comparison(comparisonId, status = 'complete') {
  const complete = status === 'complete'
  return {
    comparisonId, status, resumeSnapshot: snapshot,
    resultSha256: complete ? 'd'.repeat(64) : null,
    candidateInputFingerprint: complete ? fingerprint : null,
    narrative: complete ? structuredClone(current) : null,
  }
}

function targetBinding(comparisons) {
  return {
    kind: 'target', workspaceId: 'workspace-1', runId: 'run-1', manifestSha256: 'e'.repeat(64),
    targetId: 'target-1', targetSnapshot: snapshot, comparisons,
  }
}

test('narrative budgets preserve the analysis bound and complete prose layout contracts', () => {
  assert.equal(api.ANALYSIS_NARRATIVE_SCHEMA_VERSION, 1)
  assert.deepEqual(api.ANALYSIS_NARRATIVE_LIMITS, {
    maxComparisons: 500, maxAutomaticAttempts: 3, maxOutputCorrections: 2,
    candidateMinSentences: 3, candidateMaxSentences: 4, candidateMaxCharacters: 900,
    overviewSentences: 1, overviewMaxCharacters: 220,
    targetMinParagraphs: 1, targetMaxParagraphs: 3, targetParagraphMaxCharacters: 900,
    targetMaxCharacters: 2400, maxClaims: 32, maxReferencesPerClaim: 500,
  })
})

test('current means the exact ready generation and exact expected input, not any old publication', () => {
  assert.equal(api.analysisNarrativeIsCurrent(current, fingerprint), true)
  for (const status of ['missing', 'waiting', 'queued', 'running', 'stale', 'failed', 'cancelled', 'not-required']) {
    assert.equal(api.analysisNarrativeIsCurrent({ ...current, status }, fingerprint), false, status)
  }
  for (const changed of [
    { generationId: 'replacement-generation' },
    { generationId: null },
    { inputFingerprint: null },
    { inputFingerprint: 'changed-input' },
    { published: undefined },
    { published: null },
    { published: { ...publication, revision: '' } },
    { published: { ...publication, generationId: 'older-generation' } },
    { published: { ...publication, inputFingerprint: 'older-input' } },
  ]) {
    assert.equal(api.analysisNarrativeIsCurrent({ ...current, ...changed }, fingerprint), false)
  }
  assert.equal(api.analysisNarrativeIsCurrent(current, null), false)
  assert.equal(api.analysisNarrativeIsCurrent(current, ''), false)
  assert.equal(api.analysisNarrativeIsCurrent(current, 'new-source'), false)
})

test('target generation waits for every exact comparison and candidate without mutating prior versions', () => {
  const binding = targetBinding([comparison('one'), comparison('two')])
  const original = structuredClone(binding)
  assert.equal(api.analysisTargetNarrativeCanGenerate(binding, ['two', 'one']), true)
  assert.equal(api.analysisTargetNarrativeCanGenerate(binding, ['one']), false)
  assert.equal(api.analysisTargetNarrativeCanGenerate(binding, ['one', 'missing']), false)
  assert.equal(api.analysisTargetNarrativeCanGenerate(binding, ['one', 'one']), false)
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding([comparison('one'), comparison('one')]), ['one', 'two']), false)
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding([]), []), false)
  assert.deepEqual(binding, original)

  for (const status of ['queued', 'running']) {
    const waiting = targetBinding([comparison('one'), comparison('two', status)])
    assert.equal(api.analysisTargetNarrativeCanGenerate(waiting, ['one', 'two']), false)
  }
  for (const status of ['missing', 'waiting', 'queued', 'running', 'stale', 'failed', 'cancelled']) {
    const waiting = structuredClone(binding)
    waiting.comparisons[1].narrative.status = status
    assert.equal(api.analysisTargetNarrativeCanGenerate(waiting, ['one', 'two']), false, status)
    assert.deepEqual(waiting.comparisons[1].narrative.published, publication)
  }
})

test('target generation accepts terminal unassessed pairs but rejects missing or misbound completed evidence', () => {
  const binding = targetBinding([comparison('one'), comparison('two', 'failed'), comparison('three', 'cancelled')])
  assert.equal(api.analysisTargetNarrativeCanGenerate(binding, ['one', 'two', 'three']), true)
  for (const changed of [
    { resultSha256: null },
    { candidateInputFingerprint: null },
    { candidateInputFingerprint: 'changed-input' },
    { narrative: null },
    { narrative: { ...current, generationId: 'new-generation' } },
  ]) {
    const invalid = targetBinding([{ ...comparison('one'), ...changed }])
    assert.equal(api.analysisTargetNarrativeCanGenerate(invalid, ['one']), false)
  }
  for (const changed of [
    { resultSha256: 'unexpected-result' },
    { candidateInputFingerprint: fingerprint },
    { narrative: current },
  ]) {
    const invalid = targetBinding([{ ...comparison('failed', 'failed'), ...changed }])
    assert.equal(api.analysisTargetNarrativeCanGenerate(invalid, ['failed']), false)
  }
})

test('full 500-pair target coverage is required, including readiness of the last non-featured candidate', () => {
  const comparisons = Array.from({ length: 500 }, (_, index) => comparison(`comparison-${index}`))
  const ids = comparisons.map(item => item.comparisonId)
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding(comparisons), ids), true)
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding(comparisons.slice(0, 5)), ids), false)
  comparisons[499].narrative.generationId = 'pending-replacement'
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding(comparisons), ids), false)
  comparisons[499].narrative.generationId = current.generationId
  comparisons.push(comparison('comparison-500'))
  assert.equal(api.analysisTargetNarrativeCanGenerate(targetBinding(comparisons), [...ids, 'comparison-500']), false)
})
