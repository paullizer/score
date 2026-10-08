import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { diagnoseLayoutFactPreservation, evaluationHash } = await loadWorker('../worker/evals/index.ts')
const facts = [{ id: 'fact', text: 'Designed checks, validated outputs against approved policy.', critical: true }]
function response(content = 'Designed checks, validated outputs against :unselected:\napproved policy.') {
  return {
    analyzeResult: { stringIndexType: 'utf16CodeUnit', content, pages: [{ pageNumber: 1, selectionMarks: [{
      state: 'unselected', confidence: 0.53, span: { offset: content.indexOf(':unselected:'), length: 12 },
    }] }] },
  }
}

test('layout diagnostics distinguish literal misses from preserved words and span-bound service annotations without rewriting evidence', () => {
  const raw = response(), original = structuredClone(raw)
  const result = diagnoseLayoutFactPreservation(raw, facts)
  assert.equal(result.boundSelectionAnnotations, 1)
  assert.equal(result.unboundSelectionAnnotations, 0)
  assert.equal(result.facts[0].literalPresent, false)
  assert.equal(result.facts[0].whitespaceEquivalentPresent, false)
  assert.equal(result.facts[0].wordSequencePresentIgnoringBoundSelectionMarks, true)
  assert.equal(result.responseSha256, evaluationHash(raw))
  assert.equal(result.selectionAnnotations[0].confidence, 0.53)
  assert.equal(result.eligibleForRelease, false)
  assert.deepEqual(raw, original)
  assert.match(result.limitations.join(' '), /Punctuation can change meaning/)
})

test('unbound, conflicting, invalid and unknown-index annotations remain unknown rather than removable text', () => {
  for (const change of [
    raw => { raw.analyzeResult.pages[0].selectionMarks[0].span.offset++ },
    raw => { raw.analyzeResult.pages[0].selectionMarks[0].span.length = -1 },
    raw => { raw.analyzeResult.pages[0].selectionMarks[0].span.offset = 1.1 },
    raw => { raw.analyzeResult.pages[0].selectionMarks[0].state = 'selected' },
    raw => { raw.analyzeResult.stringIndexType = 'unverified-index' },
    raw => { raw.analyzeResult.pages[0].pageNumber = 0 },
    raw => { raw.analyzeResult.pages[0].selectionMarks[0] = null },
  ]) {
    const raw = response()
    change(raw)
    const result = diagnoseLayoutFactPreservation(raw, facts)
    assert.equal(result.boundSelectionAnnotations, 0)
    assert.equal(result.unboundSelectionAnnotations, 1)
    assert.equal(result.facts[0].wordSequencePresentIgnoringBoundSelectionMarks, false)
  }
  const duplicated = response()
  duplicated.analyzeResult.pages[0].selectionMarks.push(structuredClone(duplicated.analyzeResult.pages[0].selectionMarks[0]))
  const result = diagnoseLayoutFactPreservation(duplicated, facts)
  assert.equal(result.boundSelectionAnnotations, 0)
  assert.ok(result.selectionAnnotations.every(row => row.binding === 'overlapping-span'))
})

test('explicit code-point and UTF-16 indexing bind Unicode safely while uncertain text-element offsets are not guessed', () => {
  const content = '\u{1f4c4} Designed checks, validated outputs against :unselected:\napproved policy.'
  const raw = response(content)
  assert.equal(diagnoseLayoutFactPreservation(raw, facts).boundSelectionAnnotations, 1)
  raw.analyzeResult.stringIndexType = 'unicodeCodePoint'
  raw.analyzeResult.pages[0].selectionMarks[0].span.offset--
  assert.equal(diagnoseLayoutFactPreservation(raw, facts).boundSelectionAnnotations, 1)
  raw.analyzeResult.stringIndexType = 'textElements'
  assert.equal(diagnoseLayoutFactPreservation(raw, facts).boundSelectionAnnotations, 0)
  assert.equal(diagnoseLayoutFactPreservation(raw, facts).selectionAnnotations[0].binding, 'unverified-index')
  const ascii = response()
  ascii.analyzeResult.stringIndexType = 'textElements'
  assert.equal(diagnoseLayoutFactPreservation(ascii, facts).boundSelectionAnnotations, 1)
  const crlf = response('\r\nDesigned checks, validated outputs against :unselected:\napproved policy.')
  crlf.analyzeResult.stringIndexType = 'textElements'
  assert.equal(diagnoseLayoutFactPreservation(crlf, facts).selectionAnnotations[0].binding, 'unverified-index')
})

test('raw state-consistent checkbox spans can be inspected but literal token-looking source text is never removed without service binding', () => {
  const content = 'Designed checks, validated outputs against \u2610 approved policy.'
  const raw = response(content)
  raw.analyzeResult.pages[0].selectionMarks[0].span = { offset: content.indexOf('\u2610'), length: 1 }
  assert.equal(diagnoseLayoutFactPreservation(raw, facts).boundSelectionAnnotations, 1)
  const original = response()
  delete original.analyzeResult.pages[0].selectionMarks
  assert.equal(diagnoseLayoutFactPreservation(original, facts).boundSelectionAnnotations, 0)
  assert.equal(diagnoseLayoutFactPreservation(original, facts).facts[0].wordSequencePresentIgnoringBoundSelectionMarks, false)
})

test('malformed full responses and duplicate facts fail explicitly, and punctuation-only fact diagnostics remain indeterminate', () => {
  for (const raw of [null, {}, { content: 1, pages: [] }, { content: 'text', pages: [null] },
    { content: 'text', pages: [{ selectionMarks: 'invalid' }] }]) {
    assert.throws(() => diagnoseLayoutFactPreservation(raw, facts), /Layout/)
  }
  assert.throws(() => diagnoseLayoutFactPreservation(response(), [facts[0], facts[0]]), /unique/)
  assert.throws(() => diagnoseLayoutFactPreservation({ ...response(), status: 'failed' }, facts), /failed service/)
  const result = diagnoseLayoutFactPreservation(response(), [{ id: 'punctuation', text: '!!!', critical: false }])
  assert.equal(result.facts[0].wordSequencePresentIgnoringBoundSelectionMarks, null)
})
