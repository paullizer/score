import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isMain } from './lib/runner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export const CHECKS = [
  { id: 'malicious-pr-review', script: 'malicious-pr-review.mjs', title: 'Malicious PR security review' },
  { id: 'xss-sinks', script: 'check-xss-sinks.mjs', title: 'XSS sinks' },
  { id: 'access-control', script: 'check-access-control.mjs', title: 'Access control' },
  { id: 'outbound-requests', script: 'check-outbound-requests.mjs', title: 'Outbound requests' },
]

const USAGE = `Runs every Score security check against the same changes.

Usage: npm run security:check -- [options]

Options:
  --base <ref>          Compare against the merge base with this ref (default: origin/main, then main).
  --head <ref>          Check this commit. Omit to check the working tree, including untracked files.
  --full-scan           Check every file instead of only the changes.
  --fail-on-findings    Also fail when there are findings to review, not only blockers.
  --report-dir <dir>    Write one Markdown report per check into this directory.
  --repo <dir>          Repository root (default: the current directory's repository).
  --only <ids>          Comma-separated checks to run: ${CHECKS.map(check => check.id).join(', ')}.
  --no-release-age      Skip the npm registry release-age lookup in the malicious PR review (no network).
  --quiet               Print only each check's summary line.
  -h, --help            Show this help.
`

export function buildArgs(check, values) {
  const args = []
  if (values.base) args.push('--base', values.base)
  if (values.head) args.push('--head', values.head)
  if (values['full-scan']) args.push('--full-scan')
  if (values['fail-on-findings']) args.push('--fail-on-findings')
  if (values.repo) args.push('--repo', values.repo)
  if (values.quiet) args.push('--quiet')
  if (values['report-dir']) args.push('--report', path.join(values['report-dir'], `${check.id}.md`))
  if (check.id === 'malicious-pr-review' && !values['no-release-age'] && !values['full-scan']) args.push('--verify-release-age')
  return args
}

export function combinedExitCode(codes) {
  if (codes.some(code => code !== 0 && code !== 1)) return 2
  return codes.includes(1) ? 1 : 0
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'full-scan': { type: 'boolean', default: false },
      'fail-on-findings': { type: 'boolean', default: false },
      'report-dir': { type: 'string' },
      repo: { type: 'string' },
      only: { type: 'string' },
      'no-release-age': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const wanted = values.only ? new Set(values.only.split(',').map(item => item.trim()).filter(Boolean)) : null
  const unknown = wanted ? [...wanted].filter(id => !CHECKS.some(check => check.id === id)) : []
  if (unknown.length) throw new Error(`Unknown check: ${unknown.join(', ')}`)
  const selected = CHECKS.filter(check => !wanted || wanted.has(check.id))

  const results = []
  for (const check of selected) {
    process.stdout.write(`\n=== ${check.title} ===\n`)
    const run = spawnSync(process.execPath, [path.join(here, check.script), ...buildArgs(check, values)], { stdio: 'inherit' })
    results.push({ check, code: run.status ?? 2, error: run.error })
  }

  process.stdout.write('\nSummary\n')
  for (const { check, code, error } of results) {
    const label = code === 0 ? 'passed' : code === 1 ? 'failed (findings)' : `error${error ? `: ${error.message}` : ''}`
    process.stdout.write(`  ${check.title.padEnd(30)} ${label}\n`)
  }
  return combinedExitCode(results.map(result => result.code))
}

const invokedDirectly = isMain(import.meta.url)
if (invokedDirectly) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`security:check could not run: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exitCode = 2
  }
}
