import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCheck } from './runner.mjs'

function run(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

/**
 * Creates a throwaway git repository for checker tests.
 * `base` and `head` map repo-relative paths to file contents; a `null` head value deletes the file.
 * `worktree` files are written after the head commit without committing (untracked or modified).
 */
export function createRepo({ base = {}, head = {}, worktree = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'score-security-'))
  const git = args => run(root, args)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Security Test'])
  git(['config', 'user.email', 'security-test@example.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'commit.gpgsign', 'false'])
  const write = (file, content) => {
    const absolute = path.join(root, file)
    if (content === null) {
      rmSync(absolute, { force: true })
      return
    }
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  const commit = (files, message) => {
    for (const [file, content] of Object.entries(files)) write(file, content)
    git(['add', '-A'])
    git(['commit', '-q', '--allow-empty', '-m', message])
    return git(['rev-parse', 'HEAD']).trim()
  }
  const baseSha = commit({ 'README.md': '# Test repository\n', ...base }, 'base')
  git(['checkout', '-q', '-b', 'feature'])
  const headSha = commit(head, 'head')
  for (const [file, content] of Object.entries(worktree)) write(file, content)
  return {
    root,
    baseSha,
    headSha,
    git,
    write,
    commit,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  }
}

/**
 * Runs a checker spec against a temporary repository without touching GitHub Actions output.
 * By default it checks base...head. Pass `--worktree` to check the working tree against base,
 * or `--full-scan` (optionally with `--head`) to check every file.
 */
export async function runSpec(spec, repo, args = []) {
  let output = ''
  const worktree = args.includes('--worktree')
  const fullScan = args.includes('--full-scan')
  const argv = args.filter(arg => arg !== '--worktree')
  const rangeArgs = fullScan ? [] : worktree ? ['--base', repo.baseSha] : ['--base', repo.baseSha, '--head', repo.headSha]
  const result = await runCheck(spec, ['--repo', repo.root, ...rangeArgs, ...argv], {
    env: {},
    stdout: text => { output += text },
  })
  return { ...result, output }
}

/** Builds a string at runtime so fixtures don't contain the literal text that the scanners look for. */
export function joined(...parts) {
  return parts.join('')
}
