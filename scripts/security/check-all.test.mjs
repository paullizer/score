import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHECKS, buildArgs, combinedExitCode } from './check-all.mjs'

const reviewer = CHECKS.find(check => check.id === 'malicious-pr-review')
const xss = CHECKS.find(check => check.id === 'xss-sinks')

test('passes the shared range and options to every check', () => {
  const values = { base: 'origin/main', head: 'abc', 'fail-on-findings': true, quiet: true, 'report-dir': 'reports' }
  const args = buildArgs(xss, values)
  assert.deepEqual(args.slice(0, 6), ['--base', 'origin/main', '--head', 'abc', '--fail-on-findings', '--quiet'])
  assert.equal(args[6], '--report')
  assert.match(args[7], /reports[\\/]xss-sinks\.md$/)
  assert.ok(!args.includes('--verify-release-age'))
})

test('verifies release age for the reviewer unless skipped or doing a full scan', () => {
  assert.ok(buildArgs(reviewer, {}).includes('--verify-release-age'))
  assert.ok(!buildArgs(reviewer, { 'no-release-age': true }).includes('--verify-release-age'))
  assert.ok(!buildArgs(reviewer, { 'full-scan': true }).includes('--verify-release-age'))
})

test('combines exit codes with errors taking precedence', () => {
  assert.equal(combinedExitCode([0, 0]), 0)
  assert.equal(combinedExitCode([0, 1]), 1)
  assert.equal(combinedExitCode([1, 2]), 2)
  assert.equal(combinedExitCode([0, null]), 2)
})

test('every check script exists', async () => {
  const { existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  for (const check of CHECKS) {
    assert.ok(existsSync(fileURLToPath(new URL(check.script, import.meta.url))), `${check.script} is missing`)
  }
})
