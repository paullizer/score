import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, test } from 'node:test'
import { BLOCKER, NOTE, REVIEW, applySuppressions, finding, parseSuppression } from './lib/findings.mjs'
import { parseUnifiedDiff, readManyAt } from './lib/git.mjs'
import { globToRegExp, isTestPath, isTextPath, matchesAny, riskArea } from './lib/paths.mjs'
import { annotation, escapeControl, escapeData, escapeProperty, renderMarkdown } from './lib/report.mjs'
import { runCheck } from './lib/runner.mjs'
import { createRepo, runSpec } from './lib/testing.mjs'
import { expressionName, loadTypeScript, parseTypeScript, walk } from './lib/ast.mjs'

const repos = []
after(() => repos.forEach(repo => repo.cleanup()))
function repo(options) {
  const created = createRepo(options)
  repos.push(created)
  return created
}

const MARKER = ['DEMO', 'MARKER'].join('_')
const spec = {
  id: 'demo',
  title: 'Demo check',
  includeFile: file => file.endsWith('.ts'),
  check(ctx) {
    const findings = []
    for (const file of ctx.files) {
      for (const { line, text } of file.addedLines) {
        if (text.includes(`${MARKER}_BLOCK`)) findings.push(finding({ rule: 'demo/block', verdict: BLOCKER, file: file.path, line, message: 'blocked' }))
        if (text.includes(`${MARKER}_REVIEW`)) findings.push(finding({ rule: 'demo/review', verdict: REVIEW, file: file.path, line, message: 'review' }))
      }
    }
    for (const file of ctx.deletedFiles) findings.push(finding({ rule: 'demo/deleted', verdict: NOTE, file: file.path, side: 'base', line: 1, message: 'deleted' }))
    return findings
  },
}

describe('paths', () => {
  test('glob matching', () => {
    assert.ok(globToRegExp('server/**/*.ts').test('server/jobs/routes.ts'))
    assert.ok(globToRegExp('server/**/*.ts').test('server/app.ts'))
    assert.ok(!globToRegExp('server/*.ts').test('server/jobs/routes.ts'))
    assert.ok(matchesAny('src/a.tsx', ['src/**']))
    assert.ok(!matchesAny('srcx/a.tsx', ['src/**']))
  })

  test('risk areas and test paths', () => {
    assert.equal(riskArea('.github/workflows/ci.yml'), 'github')
    assert.equal(riskArea('package-lock.json'), 'dependencies')
    assert.equal(riskArea('server-tests/csrf.test.mjs'), 'tests')
    assert.equal(riskArea('scripts/security/lib/git.mjs'), 'security-tooling')
    assert.equal(riskArea('infra/main.bicep'), 'deployment')
    assert.equal(riskArea('server/app.ts'), 'server')
    assert.equal(riskArea('src/App.tsx'), 'browser')
    assert.equal(riskArea('docs/guide.md'), 'docs')
    assert.ok(isTestPath('src/services/analysisReports/a.test.mjs'))
    assert.ok(!isTestPath('src/services/tester.ts'))
  })

  test('text paths', () => {
    for (const file of ['a.ts', 'src/App.tsx', '.gitattributes', 'server/.npmrc', 'Dockerfile', 'Dockerfile.worker', '.env.local', 'LICENSE', 'infra/main.bicep', '.eslintrc.json']) {
      assert.ok(isTextPath(file), file)
    }
    for (const file of ['logo.png', 'fixtures/sample.docx', 'bin/tool', 'archive.tgz']) assert.ok(!isTextPath(file), file)
  })
})

describe('findings', () => {
  test('parses suppressions in several comment styles', () => {
    assert.deepEqual(parseSuppression('// security-reviewed: xss/inner-html -- sanitized by DOMPurify first'), { rule: 'xss/inner-html', reason: 'sanitized by DOMPurify first', valid: true })
    assert.equal(parseSuppression('{/* security-reviewed: xss/inner-html -- sanitized by DOMPurify */}').reason, 'sanitized by DOMPurify')
    assert.equal(parseSuppression('# security-reviewed: review/curl -- documented install step').valid, true)
    assert.equal(parseSuppression('// security-reviewed: xss/inner-html -- short').valid, false)
    assert.equal(parseSuppression('// security-reviewed: xss/inner-html').valid, false)
    assert.equal(parseSuppression('const a = 1'), null)
  })

  test('applies suppressions on the same line or up to two lines above', () => {
    const lines = [
      '// security-reviewed: demo/block -- reviewed and safe here',
      'line two',
      'flagged line three',
      'flagged line four',
      'x // security-reviewed: demo/block -- bad',
    ]
    const make = line => finding({ rule: 'demo/block', verdict: BLOCKER, file: 'a.ts', line, message: 'm' })
    const result = applySuppressions([make(3), make(4), make(5)], () => lines)
    assert.deepEqual(result.suppressed.map(item => item.line), [3])
    assert.deepEqual(result.findings.map(item => item.line), [4, 5])
    assert.match(result.findings[1].message, /suppression ignored/)
  })

  test('rejects unknown verdicts', () => {
    assert.throws(() => finding({ rule: 'x', verdict: 'maybe', message: 'm' }))
  })
})

describe('report', () => {
  test('escapes workflow commands', () => {
    assert.equal(escapeData('50%\nnext'), '50%25%0Anext')
    assert.equal(escapeProperty('a:b,c'), 'a%3Ab%2Cc')
    const line = annotation(finding({ rule: 'demo/block', verdict: BLOCKER, file: 'dir/a,b.ts', line: 3, message: 'bad\nthing' }))
    assert.equal(line, '::error file=dir/a%2Cb.ts,line=3,title=demo/block::bad%0Athing')
    assert.equal(annotation(finding({ rule: 'n', verdict: NOTE, message: 'note' })), null)
  })

  test('escapes backslashes and pipes in Markdown table cells and code spans', () => {
    const markdown = renderMarkdown({
      title: 't', rangeText: 'r', filesChecked: 1, exitCode: 1, summary: { blockers: 1, review: 0, notes: 0 },
      findings: [finding({ rule: 'demo/a|b', verdict: BLOCKER, file: 'dir\\a|b.ts', line: 2, message: 'ends with \\', hint: 'x\\|y | z' })],
    })
    const row = markdown.split('\n').find(line => line.includes('demo/'))
    assert.equal(row, '| `demo/a\\x7cb` | `dir\\a\\x7cb.ts:2` | ends with \\\\ x\\\\\\|y \\| z |')
  })
})

describe('git diff parsing', () => {
  test('tracks added and removed line numbers', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -2 +2,2 @@',
      '-old',
      '+new one',
      '+new two',
      '@@ -10,0 +12 @@',
      '+++plus',
      '\\ No newline at end of file',
    ].join('\r\n')
    const parsed = parseUnifiedDiff(patch)
    assert.deepEqual(parsed.added, [{ line: 2, text: 'new one' }, { line: 3, text: 'new two' }, { line: 12, text: '++plus' }])
    assert.deepEqual(parsed.removed, [{ line: 2, text: 'old' }])
  })
})

describe('runner', () => {
  test('reports only added lines and fails on blockers', async () => {
    const fixture = repo({
      base: { 'a.ts': `const old = '${MARKER}_BLOCK'\n`, 'gone.ts': 'x\n', 'b.md': 'x\n' },
      head: { 'a.ts': `const old = '${MARKER}_BLOCK'\nconst next = '${MARKER}_BLOCK'\n`, 'gone.ts': null, 'b.md': `${MARKER}_BLOCK\n` },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.findings.filter(item => item.verdict === BLOCKER).map(item => `${item.file}:${item.line}`), ['a.ts:2'])
    assert.ok(result.findings.some(item => item.rule === 'demo/deleted' && item.file === 'gone.ts'))
    assert.match(result.markdown, /## Demo check/)
  })

  test('review findings fail only with --fail-on-findings', async () => {
    const fixture = repo({ head: { 'a.ts': `const x = '${MARKER}_REVIEW'\n` } })
    assert.equal((await runSpec(spec, fixture)).exitCode, 0)
    assert.equal((await runSpec(spec, fixture, ['--fail-on-findings'])).exitCode, 1)
  })

  test('honours suppressions with reasons', async () => {
    const fixture = repo({ head: { 'a.ts': `// security-reviewed: demo/block -- fixture proves suppression works\nconst x = '${MARKER}_BLOCK'\n` } })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 0)
    assert.equal(result.suppressed.length, 1)
  })

  test('handles renames, spaces and untracked files in worktree mode', async () => {
    const fixture = repo({
      base: { 'old name.ts': 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n' },
      head: { 'old name.ts': null, 'new name.ts': `const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = '${MARKER}_BLOCK'\n` },
      worktree: { 'fresh.ts': `const f = '${MARKER}_BLOCK'\n` },
    })
    const committed = await runSpec(spec, fixture)
    const renamed = committed.ctx.files.find(file => file.path === 'new name.ts')
    assert.equal(renamed.status, 'R')
    assert.equal(renamed.oldPath, 'old name.ts')
    assert.deepEqual(committed.findings.map(item => `${item.file}:${item.line}`), ['new name.ts:5'])
    assert.match(renamed.baseText(), /const d = 4/)

    const worktree = await runSpec(spec, fixture, ['--worktree'])
    assert.deepEqual(worktree.findings.map(item => `${item.file}:${item.line}`).sort(), ['fresh.ts:1', 'new name.ts:5'])
  })

  test('full scan treats every line as added', async () => {
    const fixture = repo({ base: { 'a.ts': `const x = '${MARKER}_BLOCK'\n` } })
    const result = await runSpec(spec, fixture, ['--full-scan', '--head', fixture.headSha])
    assert.equal(result.ctx.mode, 'full')
    assert.deepEqual(result.findings.map(item => `${item.file}:${item.line}`), ['a.ts:1'])
  })

  test('rejects unknown options', async () => {
    const fixture = repo()
    await assert.rejects(runSpec(spec, fixture, ['--nope']))
  })
})

describe('ast helpers', () => {
  test('names property chains', () => {
    const ts = loadTypeScript()
    const source = parseTypeScript(ts, 'x.tsx', "window.location['href'] = (res as any).locals.user!.name\n")
    const names = []
    walk(ts, source, node => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) names.push(expressionName(ts, node))
    })
    assert.ok(names.includes('window.location.href'))
    assert.ok(names.includes('res.locals.user.name'))
  })
})

/** Commits blobs at paths no Windows or macOS checkout can hold (LF, CR, ", *, :) straight into the index. */
function commitRaw(fixture, files, message) {
  const git = (args, input) => execFileSync('git', ['-c', 'core.protectNTFS=false', ...args], {
    cwd: fixture.root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const records = Object.entries(files).map(([file, content]) => `100644 ${git(['hash-object', '-w', '--stdin'], content).trim()}\t${file}\0`)
  git(['update-index', '-z', '--index-info'], records.join(''))
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD']).trim()
}

const everyFile = {
  id: 'every-file',
  title: 'Every file',
  check(ctx) {
    const findings = []
    for (const file of ctx.files) {
      for (const { line, text } of file.addedLines) {
        if (text.includes(`${MARKER}_BLOCK`)) findings.push(finding({ rule: 'demo/block', verdict: BLOCKER, file: file.path, line, message: 'blocked' }))
      }
    }
    return findings
  },
}

describe('hostile pull requests', () => {
  test('.gitattributes and NUL bytes cannot hide changed lines', async () => {
    const fixture = repo({
      base: { 'a.ts': 'const a = 1\n', 'b.ts': 'const b = 1\n' },
      head: {
        '.gitattributes': '* -diff\n*.ts binary\n',
        'a.ts': `const a = 1\nconst x = '${MARKER}_BLOCK'\n`,
        'b.ts': `const b = 1\n// \0\nconst y = '${MARKER}_BLOCK'\n`,
        'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x2b, 0x0a]),
      },
    })
    for (const args of [[], ['--worktree'], ['--full-scan', '--head', fixture.headSha]]) {
      const result = await runSpec(everyFile, fixture, args)
      assert.deepEqual(result.findings.map(item => `${item.file}:${item.line}`), ['a.ts:2', 'b.ts:3'], args.join(' '))
      const byPath = new Map(result.ctx.files.map(file => [file.path, file]))
      assert.equal(byPath.get('b.ts').binary, false)
      assert.equal(byPath.get('b.ts').hasNulByte, true)
      assert.equal(byPath.get('a.ts').hasNulByte, false)
      assert.equal(byPath.get('logo.png').binary, true)
      assert.deepEqual(byPath.get('logo.png').addedLines, [])
    }
  })

  test('file names with LF, CR or pathspec magic are read and diffed as themselves', async () => {
    const fixture = repo({ base: { 'src/leak.ts': 'const leak = 0\n' } })
    const contents = {
      'src/leak.t\nx': 'harmless\n',
      'src/leak.ts': `const leak = '${MARKER}_BLOCK'\n`,
      'src/payload.mjs\r': `export const p = '${MARKER}_BLOCK'\n`,
      ':(exclude)*"x.mjs': `export const q = '${MARKER}_BLOCK'\n`,
      'z-last.ts': 'const last = 1\n',
    }
    const headSha = commitRaw(fixture, contents, 'raw paths')
    const result = await runSpec(everyFile, { ...fixture, headSha })
    for (const file of result.ctx.files) {
      assert.equal(file.text(), contents[file.path], JSON.stringify(file.path))
      assert.deepEqual(file.addedLines.map(item => item.text), contents[file.path].split('\n').slice(0, -1), JSON.stringify(file.path))
    }
    assert.equal(result.ctx.files.length, Object.keys(contents).length)
    assert.deepEqual(result.findings.map(item => JSON.stringify(`${item.file}:${item.line}`)).sort(), [
      JSON.stringify(':(exclude)*"x.mjs:1'),
      JSON.stringify('src/leak.ts:1'),
      JSON.stringify('src/payload.mjs\r:1'),
    ].sort())
    const direct = readManyAt(fixture.root, headSha, ['src/leak.t\nx', 'src/leak.ts', 'missing.ts'])
    assert.equal(direct.get('src/leak.t\nx').toString(), 'harmless\n')
    assert.equal(direct.get('src/leak.ts').toString(), contents['src/leak.ts'])
    assert.equal(direct.get('missing.ts'), null)
  })

  test('line separators inside a changed line cannot split the range diff', async () => {
    const fixture = repo({
      base: { 'c.ts': 'const c = 0\n', 'd.ts': 'const d = 0\n' },
      head: {
        'c.ts': `const c = 1\n// \u2028diff --git a/zzz b/zzz\n// \rdiff --git a/c.ts b/c.ts\nconst hidden = '${MARKER}_BLOCK'\n`,
        'd.ts': 'const d = 1\n',
      },
    })
    const result = await runSpec(everyFile, fixture)
    assert.deepEqual(result.findings.map(item => `${item.file}:${item.line}`), ['c.ts:4'])
  })

  test('findings cannot inject workflow commands or Markdown lines', async () => {
    const fixture = repo({ head: { 'a.ts': 'const a = 1\n' } })
    const hostile = {
      id: 'hostile',
      title: 'Hostile',
      check: () => [
        finding({ rule: 'demo/block', verdict: BLOCKER, file: 'a\n::error::forged`.ts', line: 1, message: 'script ::stop-commands::abc\n::notice::forged' }),
        finding({ rule: 'demo/review', verdict: REVIEW, file: 'a.ts', line: 1, message: 'plain\r::warning::forged' }),
      ],
    }
    let output = ''
    const result = await runCheck(hostile, ['--repo', fixture.root, '--base', fixture.baseSha, '--head', fixture.headSha], {
      env: { GITHUB_ACTIONS: 'true' },
      stdout: text => { output += text },
    })
    assert.equal(result.exitCode, 1)
    const lines = output.split('\n')
    const token = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0])?.[1]
    assert.ok(token, lines[0])
    const end = lines.indexOf(`::${token}::`)
    assert.ok(end > 1)
    assert.ok(lines.slice(1, end).every(line => !line.trim().startsWith('::')), output)
    assert.ok(output.includes('script ::stop-commands::abc\\n::notice::forged'))
    const annotations = lines.slice(end + 1).filter(Boolean)
    assert.equal(annotations.length, 2)
    assert.ok(annotations.every(line => /^::(error|warning) /.test(line)), output)

    const markdownLines = result.markdown.split('\n')
    const row = markdownLines.find(line => line.includes('demo/block'))
    assert.ok(row.includes('``a\\n::error::forged`.ts:1``') || row.includes('`` a\\n::error::forged`.ts:1 ``'), row)
    assert.ok(!markdownLines.some(line => line.startsWith('::')))
    assert.equal(escapeControl('a\nb\r\u202e\u0000\tc'), 'a\\nb\\r\\u202e\\x00\tc')
    assert.ok(renderMarkdown({
      title: 't', rangeText: 'r', filesChecked: 1, findings: [], summary: { blockers: 0, review: 0, notes: 0 }, exitCode: 0,
      notes: ['one\n## Forged heading'],
    }).includes('> one\\n## Forged heading'))
  })
})
