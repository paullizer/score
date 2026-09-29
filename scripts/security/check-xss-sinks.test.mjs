import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { BLOCKER, REVIEW } from './lib/findings.mjs'
import { createRepo, joined, runSpec } from './lib/testing.mjs'
import { loadTypeScript } from './lib/ast.mjs'
import { analyzeFile, inlineScriptDigest, spec } from './check-xss-sinks.mjs'

const ts = loadTypeScript()
const repos = []
after(() => repos.forEach(repo => repo.cleanup()))

function rules(file, text) {
  return analyzeFile(file, text, { ts }).map(item => `${item.verdict}:${item.rule}:${item.line}`)
}

function findings(file, text) {
  return analyzeFile(file, text, { ts })
}

function repo(options) {
  const created = createRepo(options)
  repos.push(created)
  return created
}

describe('xss sink analysis', () => {
  test('detects React and object inner HTML sinks', () => {
    const result = rules('src/App.tsx', `
      export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />
      const props = { dangerouslySetInnerHTML: { __html: html } }
    `)
    assert.ok(result.includes('blocker:xss/dangerously-set-inner-html:2'))
    assert.ok(result.includes('blocker:xss/dangerously-set-inner-html:3'))
  })

  test('detects innerHTML and outerHTML assignments', () => {
    assert.deepEqual(rules('src/App.ts', `
      node.innerHTML = html
      node.outerHTML += html
    `), ['blocker:xss/inner-html-assignment:2', 'blocker:xss/inner-html-assignment:3'])
  })

  test('detects HTML insertion APIs and DOMParser insertion', () => {
    const result = findings('src/App.ts', `
      element.insertAdjacentHTML('beforeend', html)
      document.write(html)
      range.createContextualFragment(html)
      element.setHTMLUnsafe(html)
      Document.parseHTMLUnsafe(html)
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      mount.appendChild(parsed.body)
      const parser = new DOMParser()
      mount.appendChild(parser.parseFromString(html, 'text/html').body)
      mount.appendChild(new DOMParser().parseFromString(html, 'text/html').body)
    `)
    assert.deepEqual(
      result.filter(item => item.rule === 'xss/html-insertion' && item.verdict === BLOCKER).map(item => `${item.rule}:${item.line}`),
      [
        'xss/html-insertion:2',
        'xss/html-insertion:3',
        'xss/html-insertion:4',
        'xss/html-insertion:5',
        'xss/html-insertion:6',
        'xss/html-insertion:8',
        'xss/html-insertion:10',
        'xss/html-insertion:11',
      ],
    )
  })

  test('detects string code execution sinks', () => {
    const result = rules('src/App.ts', `
      eval(code)
      Function(code)
      new Function(code)
      setTimeout('alert(1)')
      window.setInterval(\`alert(1)\`)
    `)
    assert.deepEqual(result.filter(item => item.startsWith('blocker:xss/string-code-execution')), [
      'blocker:xss/string-code-execution:2',
      'blocker:xss/string-code-execution:3',
      'blocker:xss/string-code-execution:4',
      'blocker:xss/string-code-execution:5',
      'blocker:xss/string-code-execution:6',
    ])
  })

  test('enforces srcDoc allowlist narrowly', () => {
    assert.ok(rules('src/Unsafe.tsx', `export const A = () => <iframe sandbox="" srcDoc={html} />`).includes('blocker:xss/srcdoc:1'))
    assert.deepEqual(findings('src/components/documents/DocxPreview.tsx', `export const A = () => <iframe sandbox="" srcDoc={html} />`)
      .filter(item => item.rule === 'xss/srcdoc'), [])
  })

  test('checks iframe sandbox literals and expressions', () => {
    const result = findings('src/App.tsx', `
      const strict = ''
      export const A = () => <>
        <iframe />
        <iframe sandbox="allow-scripts allow-same-origin" />
        <iframe sandbox="allow-scripts" />
        <iframe sandbox={strict} />
        <iframe sandbox={tokens} />
      </>
    `)
    assert.equal(result.find(item => item.line === 4 && item.rule === 'xss/iframe-sandbox')?.verdict, BLOCKER)
    assert.equal(result.find(item => item.line === 5 && item.rule === 'xss/iframe-sandbox')?.verdict, BLOCKER)
    assert.equal(result.find(item => item.line === 6 && item.rule === 'xss/iframe-sandbox')?.verdict, REVIEW)
    assert.equal(result.some(item => item.line === 7 && item.rule === 'xss/iframe-sandbox'), false)
    assert.equal(result.find(item => item.line === 8 && item.rule === 'xss/iframe-sandbox')?.verdict, REVIEW)
  })

  test('flags unsafe script CSP only in script directives', () => {
    const result = rules('src/App.ts', `
      const ok = "default-src 'none'; style-src 'unsafe-inline'"
      const bad = "default-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'"
      const worse = "script-src 'unsafe-eval'"
    `)
    assert.deepEqual(result, ['blocker:xss/csp-unsafe-script:3', 'blocker:xss/csp-unsafe-script:4'])
  })

  test('checks browser markup renderer imports with precise policy exceptions', () => {
    assert.ok(rules('src/App.ts', `import { marked } from 'marked'`).includes('blocker:xss/markup-renderer-import:1'))
    assert.ok(rules('src/App.ts', `await import('marked')`).includes('blocker:xss/markup-renderer-import:1'))
    assert.ok(rules('src/App.tsx', `lazy(() => import('docx-preview'))`).includes('blocker:xss/markup-renderer-import:1'))
    assert.ok(rules('src/App.ts', `export { marked } from 'marked'`).includes('blocker:xss/markup-renderer-import:1'))
    assert.deepEqual(findings('src/App.ts', `export type { marked } from 'marked'`)
      .filter(item => item.rule === 'xss/markup-renderer-import'), [])
    assert.deepEqual(rules('src/App.ts', `import(name)`), ['review:xss/dynamic-module-load:1'])
    assert.deepEqual(rules('src/App.ts', `require('marked-' + name)`), ['review:xss/dynamic-module-load:1'])
    assert.deepEqual(findings('src/components/documents/docxPreviewSanitize.ts', `import createDOMPurify from 'dompurify'`)
      .filter(item => item.rule === 'xss/markup-renderer-import'), [])
    assert.deepEqual(findings('src/components/documents/docxPreviewConversion.ts', `import mammoth from 'mammoth'`)
      .filter(item => item.rule === 'xss/markup-renderer-import'), [])
  })

  test('detects wildcard postMessage', () => {
    assert.ok(rules('src/App.ts', `target.postMessage({ ok: true }, '*')`).includes('blocker:xss/post-message-wildcard:1'))
  })

  test('detects runtime script creation', () => {
    const result = rules('src/App.tsx', `
      document.createElement('script')
      export const A = () => <script src="/x.js" />
    `)
    assert.deepEqual(result, ['blocker:xss/runtime-script:2', 'blocker:xss/runtime-script:3'])
  })

  test('detects javascript URL strings and attributes', () => {
    const jsUrl = joined('java', 'script:alert(1)')
    const spaced = joined('j a v a s c r i p t', ':alert(1)')
    const result = findings('src/App.tsx', `
      const a = ${JSON.stringify(jsUrl)}
      export const A = () => <a href={${JSON.stringify(spaced)}}>bad</a>
    `)
    assert.equal(result.filter(item => item.rule === 'xss/javascript-url' && item.verdict === BLOCKER).length, 2)
  })

  test('reviews non-literal URL attributes while allowing safe literals, templates and builders', () => {
    const result = findings('src/App.tsx', `
      const unsafe = '/already-safe'
      export const A = ({ dynamic }) => <>
        <a href="/local">ok</a>
        <a href={\`/jobs/\${dynamic}\`}>ok</a>
        <a href={privateOriginalUrl(dynamic)}>ok</a>
        <a href={dynamic}>review</a>
        <form action={dynamic} />
      </>
    `)
    assert.deepEqual(result.filter(item => item.rule === 'xss/nonliteral-url').map(item => item.line), [7, 8])
  })

  test('reviews non-literal navigation', () => {
    const result = findings('src/App.ts', `
      window.location.assign('/logout')
      window.location.assign(next)
      location.href = next
      window.open(authLoginUrl('/'))
      window.open(next)
    `)
    assert.deepEqual(result.filter(item => item.rule === 'xss/navigation-nonliteral').map(item => item.line), [3, 4, 6])
  })

  test('reviews browser storage writes because README promises private data stays out', () => {
    const result = findings('src/App.ts', `
      localStorage.setItem('score-theme', theme)
      sessionStorage['private'] = value
      window.localStorage.extra = value
    `)
    assert.deepEqual(result.filter(item => item.rule === 'xss/browser-storage-write').map(item => item.line), [2, 3, 4])
  })

  test('reviews message listeners', () => {
    const result = findings('src/App.ts', `
      window.addEventListener('message', onMessage)
      self.onmessage = onMessage
    `)
    assert.deepEqual(result.filter(item => item.rule === 'xss/message-listener').map(item => item.line), [2, 3])
  })

  test('checks index.html script, handler, remote script, CSP and URL rules', () => {
    const jsUrl = joined('java', 'script:bad()')
    const html = `
      <script>console.log('inline')</script>
      <script type="application/json">{"ok":true}</script>
      <script src="https://cdn.example.invalid/app.js"></script>
      <button onclick="go()">Go</button>
      <a href="${jsUrl}">bad</a>
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'">
    `
    const result = findings('index.html', html)
    assert.deepEqual(result.map(item => item.rule).sort(), [
      'xss/csp-unsafe-script',
      'xss/index-inline-handler',
      'xss/index-inline-script',
      'xss/index-remote-script',
      'xss/javascript-url',
    ].sort())
  })

  test('allows index.html inline scripts only when their exact content is pinned by policy', () => {
    const body = `(() => { document.documentElement.setAttribute('data-theme', 'dark') })()`
    const policy = { indexInlineScriptAllowed: [{ file: 'index.html', sha256: inlineScriptDigest(body), reason: 'fixture theme bootstrap' }] }
    const inline = source => analyzeFile('index.html', source, { ts, policy }).map(item => item.rule)
    assert.deepEqual(inline(`<script>\r\n  ${body}\r\n</script>`), [])
    assert.deepEqual(inline(`<script>${body}</script\t\nfoo="bar">`), [])
    assert.deepEqual(inline(`<script>${body};fetch('/steal')</script>`), ['xss/index-inline-script'])
    const [blocked] = analyzeFile('index.html', `<script>${body};fetch('/steal')</script>`, { ts, policy })
    assert.match(blocked.hint, new RegExp(inlineScriptDigest(`${body};fetch('/steal')`)))

    const marked = `${body} // <!--`
    const markedPolicy = { indexInlineScriptAllowed: [{ file: 'index.html', sha256: inlineScriptDigest(marked), reason: 'fixture with markup' }] }
    const [unpinnable, ...rest] = analyzeFile('index.html', `<script>${marked}</script>`, { ts, policy: markedPolicy })
    assert.deepEqual(rest, [])
    assert.equal(unpinnable.rule, 'xss/index-inline-script')
    assert.match(unpinnable.hint, /can't be pinned/)
  })

  test('reads index.html tags, attributes, character references and script ends the way browsers do', () => {
    const htmlRules = source => findings('index.html', source).map(item => item.rule)
    const remote = 'https://cdn.example.invalid/app.js'
    for (const source of [
      `<script src="//cdn.example.invalid/app.js"></script>`,
      `<script src="\\\\cdn.example.invalid\\app.js"></script>`,
      `<script src="/\\cdn.example.invalid/app.js"></script>`,
      `<script src="&#47;&#x2f;cdn.example.invalid/app.js"></script>`,
      `<script src="/&Tab;/cdn.example.invalid/app.js"></script>`,
      `<script src="${joined('data', ':text/javascript,void 0')}"></script>`,
      `<script/src=//cdn.example.invalid/app.js></script>`,
      `<SCRIPT TITLE="a>b" SRC='${remote}'></SCRIPT >`,
      `<script src="${remote}" src="/src/main.tsx"></script>`,
      `<svg><script href="${remote}"></script></svg>`,
      `<svg><script xlin\u212A:href="/src/main.tsx" xlink:href="${remote}"></script></svg>`,
    ]) {
      assert.deepEqual(htmlRules(source), ['xss/index-remote-script'], source)
    }
    for (const source of [
      `<script type="module" src="/src/main.tsx"></script>`,
      `<script type=module src=/src/main.tsx>\n</script>`,
      `<script src="&sol;src/main.tsx"></script>`,
      `<script type=" Application/JSON ">{"ok":true}</script>`,
    ]) {
      assert.deepEqual(htmlRules(source), [], source)
    }
    for (const source of [
      `<script>fetch('/a')</script foo="bar">`,
      `<script>fetch('/a')`,
      `<script type="importmap">{"imports":{}}</script>`,
      `<script type="speculationrules">{}</script>`,
      `<svg><script src="/src/main.tsx">fetch('/a')</script></svg>`,
    ]) {
      assert.deepEqual(htmlRules(source), ['xss/index-inline-script'], source)
    }
    assert.deepEqual(htmlRules(`<base href="https://cdn.example.invalid/">`), ['xss/index-base-element'])
    assert.deepEqual(htmlRules(`<iframe srcdoc="&lt;script&gt;fetch('/a')&lt;/script&gt;"></iframe>`), ['xss/srcdoc'])
    assert.deepEqual(htmlRules(`<div title="a>b" onclick="go()"></div>`), ['xss/index-inline-handler'])
    assert.deepEqual(htmlRules(`<body/ONLOAD=go()>`), ['xss/index-inline-handler'])
    for (const href of ['java&#115;cript:go()', '&#x6A;ava&Tab;script&colon;go()', ' JAVA&#10;SCRIPT:go()']) {
      assert.deepEqual(htmlRules(`<a href="${href}">x</a>`), ['xss/javascript-url'], href)
    }
    assert.deepEqual(htmlRules(`<svg><a><animate attributeName="href" values="#;java&#115;cript:go()"/></a></svg>`), ['xss/javascript-url'])
    assert.deepEqual(htmlRules(`<meta http-equiv="refresh" content="0;url=java&#115;cript:go()">`), ['xss/javascript-url'])
    assert.deepEqual(htmlRules(`<meta content="script-src 'unsafe-eval'" http-equiv=" content-security-policy ">`), ['xss/csp-unsafe-script'])
  })

  test('the current index.html passes the default policy', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    assert.deepEqual(findings('index.html', html), [])
  })
})

describe('xss spec integration', () => {
  test('blockers are whole-file invariants on touched files', async () => {
    const fixture = repo({
      base: { 'src/App.tsx': `export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />\nconst ok = 1\n` },
      head: { 'src/App.tsx': `export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />\nconst ok = 2\n` },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.findings.map(item => `${item.rule}:${item.line}`), ['xss/dangerously-set-inner-html:1'])
  })

  test('reviews on unchanged lines are not reported', async () => {
    const fixture = repo({
      base: { 'src/App.tsx': `export const A = ({ dynamic }) => <a href={dynamic}>x</a>\nconst ok = 1\n` },
      head: { 'src/App.tsx': `export const A = ({ dynamic }) => <a href={dynamic}>x</a>\nconst ok = 2\n` },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.findings, [])
  })

  test('suppression with a reason works and one without a reason does not', async () => {
    const valid = repo({ head: { 'src/App.tsx': `// security-reviewed: xss/dangerously-set-inner-html -- fixture sanitizer wraps this value\nexport const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />\n` } })
    const suppressed = await runSpec(spec, valid)
    assert.equal(suppressed.exitCode, 0)
    assert.equal(suppressed.suppressed.length, 1)

    const invalid = repo({ head: { 'src/App.tsx': `// security-reviewed: xss/dangerously-set-inner-html\nexport const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />\n` } })
    const result = await runSpec(spec, invalid)
    assert.equal(result.exitCode, 1)
    assert.match(result.findings[0].message, /suppression ignored/)
  })

  test('full-scan mode treats reviews as added lines', async () => {
    const fixture = repo({ base: { 'src/App.tsx': `export const A = ({ dynamic }) => <a href={dynamic}>x</a>\n` } })
    const result = await runSpec(spec, fixture, ['--full-scan', '--head', fixture.baseSha])
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.findings.map(item => `${item.rule}:${item.line}`), ['xss/nonliteral-url:1'])
  })

  test('fail-on-findings makes reviews fail', async () => {
    const fixture = repo({ head: { 'src/App.tsx': `export const A = ({ dynamic }) => <a href={dynamic}>x</a>\n` } })
    assert.equal((await runSpec(spec, fixture)).exitCode, 0)
    assert.equal((await runSpec(spec, fixture, ['--fail-on-findings'])).exitCode, 1)
  })

  test('sanitizer-sensitive file changes are reviews and removed lines are reported', async () => {
    const fixture = repo({
      base: { 'src/components/documents/docxPreviewSanitize.ts': `export const kept = 1\nexport const removed = 1\n` },
      head: { 'src/components/documents/docxPreviewSanitize.ts': `export const kept = 2\n` },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.findings.filter(item => item.rule === 'xss/sanitizer-sensitive-change' && item.verdict === REVIEW).length, 3)
    assert.ok(result.findings.some(item => item.side === 'base'))
  })
})
