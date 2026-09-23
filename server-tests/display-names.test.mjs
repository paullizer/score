import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/domain/displayNames'",
      "export * from './src/domain/lifecycle'",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const {
  DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName, getDisplayName, defaultAnalysisName,
} = module.exports

test('display names normalize whitespace, preserve Unicode, and enforce explicit 160-character/control boundaries', () => {
  assert.equal(DISPLAY_NAME_MAX_LENGTH, 160)
  assert.equal(normalizeDisplayName('  Résumé · 李 — 2026  '), 'Résumé · 李 — 2026')
  assert.equal(normalizeDisplayName(`  ${'x'.repeat(160)}  `), 'x'.repeat(160))
  for (const invalid of ['', '   ', 'x'.repeat(161), null, 42, {}, ['name']]) {
    assert.throws(() => normalizeDisplayName(invalid), /Display name/)
  }
  for (const control of [0, 9, 10, 13, 31, 127, 128, 159, 0x2028, 0x2029]) {
    assert.throws(() => normalizeDisplayName(`a${String.fromCharCode(control)}b`), /control|line break/)
    assert.throws(() => normalizeDisplayName(`${String.fromCharCode(control)}name`), /control|line break/)
  }
  assert.equal(getDisplayName({}, 'Source-stated title'), 'Source-stated title')
  assert.equal(getDisplayName({ displayName: 'Library label' }, 'Source-stated title'), 'Library label')
})

test('default analysis names are descriptive, bounded, and safe before all selections exist', () => {
  assert.equal(defaultAnalysisName(4, ['Program Analyst']), 'Program Analyst - 4 resumes')
  assert.equal(defaultAnalysisName(1, ['Program Analyst']), 'Program Analyst - 1 resume')
  assert.equal(defaultAnalysisName(4, ['A', 'B', 'C']), '4 resumes - 3 targets')
  for (const [count, labels] of [[0, []], [1, ['']], [4, ['x'.repeat(600)]], [500, ['\nLong\tlabel\u0085']], [NaN, []]]) {
    const name = defaultAnalysisName(count, labels)
    assert.ok(name.length <= 160)
    assert.equal(normalizeDisplayName(name), name)
  }
  const suffix = ' - 1 resume'
  const boundary = DISPLAY_NAME_MAX_LENGTH - suffix.length
  assert.equal(defaultAnalysisName(1, [`${'x'.repeat(boundary - 1)}\u{1F600} extra`]), `${'x'.repeat(boundary - 1)}${suffix}`)
  assert.equal(defaultAnalysisName(1, [`${'x'.repeat(boundary - 2)}\u{1F600} extra`]), `${'x'.repeat(boundary - 2)}\u{1F600}${suffix}`)
})
