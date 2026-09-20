import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/domain/displayNames'",
      "export * from './src/domain/workspace-validation'",
      "export * from './src/domain/lifecycle'",
      "export { createInitialWorkspace } from './src/data/fixtures'",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const {
  DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName, getDisplayName, defaultAnalysisName,
  validateWorkspace, createInitialWorkspace, workspaceLifecycleTransitionErrors, getSampleLifecycleImpact,
  applySampleLifecycle, setWorkspaceArchive,
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

test('sample display metadata persists without changing original names or captured history and honors read-only lifecycle', () => {
  const original = createInitialWorkspace()
  assert.deepEqual(validateWorkspace(original), original)
  const renamed = structuredClone(original)
  renamed.jobs[0].displayName = 'Hiring target'
  renamed.resumes[0].displayName = 'Candidate A'
  renamed.runs[0].displayName = 'Interview shortlist'
  assert.deepEqual(validateWorkspace(renamed), renamed)
  assert.deepEqual(workspaceLifecycleTransitionErrors(original, renamed), [])
  assert.equal(renamed.jobs[0].title, original.jobs[0].title)
  assert.equal(renamed.resumes[0].name, original.resumes[0].name)
  assert.equal(renamed.runs[0].name, original.runs[0].name)
  assert.deepEqual(renamed.runs[0].targets, original.runs[0].targets)
  assert.deepEqual(renamed.runs[0].resumes, original.runs[0].resumes)
  assert.deepEqual(renamed.runs[0].comparisons, original.runs[0].comparisons)
  for (const [kind, record, label] of [
    ['job', renamed.jobs[0], 'Hiring target'], ['resume', renamed.resumes[0], 'Candidate A'],
    ['analysis', renamed.runs[0], 'Interview shortlist'],
  ]) {
    assert.equal(getSampleLifecycleImpact(renamed, { kind, id: record.id }).name, label)
    const archived = applySampleLifecycle(renamed, { kind, id: record.id }, 'archive', '2026-09-19T12:00:00.000Z')
    const changed = structuredClone(archived)
    changed[kind === 'analysis' ? 'runs' : `${kind}s`].find(item => item.id === record.id).displayName = 'Not permitted'
    assert.ok(workspaceLifecycleTransitionErrors(archived, changed).some(error => /read-only/.test(error) && error.includes(label)))
  }
  const archived = setWorkspaceArchive(original, true, '2026-09-19T12:00:00.000Z')
  const changed = structuredClone(archived)
  changed.runs[0].displayName = 'Cannot change archived workspace'
  assert.ok(workspaceLifecycleTransitionErrors(archived, changed).some(error => /read-only/.test(error)))
  assert.ok(workspaceLifecycleTransitionErrors(original, renamed, { lifecycleOnly: true }).length)
  const changedHistory = structuredClone(renamed)
  changedHistory.runs[0].targets[0].displayName = 'Live labels must not rewrite snapshots'
  changedHistory.runs[0].resumes[0].resume.displayName = 'Replaced captured name'
  assert.ok(workspaceLifecycleTransitionErrors(renamed, changedHistory).some(error => /captured source snapshots/.test(error)))
})

test('sample schemas accept captured display metadata but reject malformed aliases without altering source fields', () => {
  const workspace = createInitialWorkspace()
  const captured = structuredClone(workspace)
  captured.runs[0].targets[0].displayName = 'Captured target'
  captured.runs[0].resumes[0].resume.displayName = 'Captured candidate'
  assert.deepEqual(validateWorkspace(captured), captured)
  for (const invalid of ['', ' spaced ', 'x'.repeat(161), 'line\nbreak', 'control\u0085', 1, null]) {
    for (const record of ['job', 'resume', 'run', 'target', 'captured-resume']) {
      const value = structuredClone(workspace)
      const entity = {
        job: value.jobs[0], resume: value.resumes[0], run: value.runs[0],
        target: value.runs[0].targets[0], 'captured-resume': value.runs[0].resumes[0].resume,
      }[record]
      entity.displayName = invalid
      assert.throws(() => validateWorkspace(value), /displayName/, `${record}: ${JSON.stringify(invalid)}`)
    }
  }
})
