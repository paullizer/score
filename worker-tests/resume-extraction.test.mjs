import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { loadWorker } from './shared-model-loader.mjs'

const { extractResumeHtml, documentIntelligenceResumeParagraphs, ResumeExtractionError, ResumeHtmlShellError } = await loadWorker('../worker/resumes/extraction.ts')
const { analyzePdf, createRemoteRenderer, extractHtml, documentIntelligenceParagraphs, invokeStructuredModel, normalizeText, safeFetch } = await loadWorker('../worker/runtime.ts')
const sourceUrl = 'https://profiles.example/ada'
const person = {
  '@type': 'Person', '@id': '#ada', name: 'Ada Li', jobTitle: 'Research engineer',
  description: '<p>Built reliable data systems for public services.</p><p>Led a team of five engineers.</p>',
  worksFor: { '@type': 'Organization', name: 'Example Research' },
  alumniOf: { name: 'Example University' },
  knowsAbout: ['Python', 'Data engineering'],
}
const ld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`
const page = (body, data, title = 'Ada Li') => `<html><head><title>${title}</title>${data ? ld(data) : ''}</head><body>${body}</body></html>`
const pdfResult = (paragraphs, rest = {}) => ({
  status: 'succeeded', analyzeResult: { pages: [{ pageNumber: 1 }], paragraphs, ...rest },
})
const pdfParagraph = (content, pageNumber = 1, rest = {}) => ({ content, boundingRegions: [{ pageNumber }], ...rest })
const hasCode = code => error => error instanceof ResumeExtractionError && error.code === code && typeof error.retryable === 'boolean'

test('generic public resume HTML preserves exact normalized paragraphs, short headers and repeatable citations', () => {
  globalThis.__resumeScriptRan = false
  const html = page(`
    <header><nav><a href="/login">Sign in</a><a href="/jobs">Browse jobs</a></nav></header>
    <main><header><h1>Ada Li</h1><p>Research engineer</p><address>ada@example.test</address></header>
      <h2>Experience</h2><p>Built&nbsp;  reliable <strong>data systems</strong>.<br>Led a team of five.</p>
      <ul><li>Delivered accessible public services.</li><li>Mentored engineers.</li></ul>
      <h2>Education</h2><p>Example University</p>
      <section aria-hidden="true"><h2>Access denied</h2><p>Hidden template.</p></section>
      <div style="display: none">Discarded hidden text.</div>
    </main><footer><nav>Navigation footer</nav></footer>
    <script>globalThis.__resumeScriptRan = true</script>`)
  const first = extractResumeHtml(html, sourceUrl)
  const second = extractResumeHtml(html, sourceUrl)
  assert.equal(first.title, 'Ada Li')
  assert.deepEqual(second, first)
  assert.deepEqual(first.paragraphs.map(value => value.text), [
    'Ada Li', 'Research engineer', 'ada@example.test', 'Experience',
    'Built reliable data systems.\nLed a team of five.', 'Delivered accessible public services.',
    'Mentored engineers.', 'Education', 'Example University',
  ])
  const evidence = first.paragraphs.find(value => value.text.startsWith('Built'))
  assert.deepEqual(evidence, {
    id: 'p-0005', page: 1, heading: 'Experience',
    text: 'Built reliable data systems.\nLed a team of five.',
  })
  const quote = normalizeText('Built\u00a0  reliable data systems.\nLed a team of five.')
  assert.equal(second.paragraphs.find(value => value.id === evidence.id).text, quote)
  assert.ok(first.paragraphs.every(value => value.page === 1 && !value.heading.includes('Job posting')))
  assert.equal(globalThis.__resumeScriptRan, false)
  delete globalThis.__resumeScriptRan
})

test('Person, ProfilePage, type arrays and graph references yield actual professional evidence', () => {
  for (const data of [
    person,
    [person],
    { ...person, '@type': ['Thing', 'https://schema.org/Person'] },
    { '@type': 'ProfilePage', mainEntity: person },
    { '@graph': [
      { '@type': 'ProfilePage', mainEntity: { '@id': '#ada' } },
      person,
      { '@type': 'Person', '@id': '#author', name: 'Editorial Author' },
      { '@type': 'WebPage', author: { '@id': '#author' } },
    ] },
    [{ '@graph': [{ '@type': 'WebPage', mainEntity: { '@id': '#ada' } }, person] }],
    { '@graph': [{ '@type': 'ProfilePage', mainEntity: '#ada' }, person] },
  ]) {
    const result = extractResumeHtml(page('<main></main>', data), sourceUrl)
    assert.equal(result.title, 'Ada Li')
    assert.ok(result.paragraphs.some(value => value.text === 'Research engineer' && value.heading === 'Role'))
    assert.ok(result.paragraphs.some(value => value.text === 'Built reliable data systems for public services.'))
    assert.ok(result.paragraphs.some(value => value.text === 'Led a team of five engineers.'))
    assert.ok(result.paragraphs.some(value => value.text === 'Example University' && value.heading === 'Education'))
    assert.ok(!result.paragraphs.some(value => value.text.includes('Editorial Author')))
    assert.ok(!result.paragraphs.some(value => value.text.includes('[object Object]')))
  }
})

test('structured entity references and repeated definitions are resolved without fetching linked URLs', () => {
  const result = extractResumeHtml(page('<main><h1>Ada Li</h1><p>Research engineer</p></main>', {
    '@graph': [
      { '@type': 'ProfilePage', mainEntity: { '@id': '#ada' } },
      { ...person, worksFor: { '@id': 'https://organization.example/' }, address: { addressLocality: 'Ottawa', addressCountry: { name: 'Canada' } } },
      { '@id': '#ada' },
      { '@type': 'Organization', '@id': 'https://organization.example/', name: 'Example Research' },
    ],
  }), sourceUrl)
  assert.equal(result.paragraphs.filter(value => value.text === 'Ada Li').length, 1)
  assert.equal(result.paragraphs.filter(value => value.text === 'Research engineer').length, 1)
  assert.ok(result.paragraphs.some(value => value.text === 'Example Research'))
  assert.ok(result.paragraphs.some(value => value.text === 'Canada' && value.heading === 'Location'))
})

test('public profiles with navigation login links, cookie notices and auth-related work are not blocked', () => {
  const result = extractResumeHtml(page(`
    <nav><a href="/signin">Sign in to view profiles</a></nav>
    <main><h1>Ada Li</h1><p>Research engineer</p><h2>Experience</h2>
      <p>I built sign-in systems and CAPTCHA integrations for public services.</p>
      <a href="/login">Sign in</a>
    </main><div role="dialog"><p>We use cookies to improve this website.</p><button>Accept all cookies</button></div>
    <script>const captcha = 'Access denied'</script>`), 'https://www.linkedin.com/in/ada-example')
  assert.equal(result.title, 'Ada Li')
  assert.ok(result.paragraphs.some(value => value.text.startsWith('I built sign-in')))
  assert.ok(!result.paragraphs.some(value => value.text === 'Sign in'))
})

test('HTTP-200 access, login, private-profile, consent and challenge walls override stale Person data', () => {
  for (const [title, body] of [
    ['Sign in to continue', '<main><h1>Sign in</h1><form><input type="password"></form></main>'],
    ['Ada Li', '<main><p>Sign in to view this profile.</p></main>'],
    ['Ada Li', '<main><p>This profile is private.</p></main>'],
    ['Access denied', '<main>Request blocked.</main>'],
    ['403 Forbidden', '<main>Access forbidden.</main>'],
    ['Just a moment...', '<main>Checking your browser.</main>'],
    ['Security verification', '<main>Complete the CAPTCHA to continue.</main>'],
    ['Ada Li', '<main><p>Please verify you are human.</p></main>'],
    ['Ada Li', '<main><p>Please verify you are a human.</p></main>'],
    ['Ada Li', '<main><p>You need to sign in to continue.</p></main>'],
    ['Ada Li', '<main><p>Join now to view this profile.</p></main>'],
    ['Profiles: Log In', '<main>Member profiles</main>'],
    ['Consent required', '<main>Accept terms to access profiles.</main>'],
    ['Before you continue', '<main>You must accept the terms to access this content.</main>'],
    ['Ada Li', '<main><form><label>Password<input type="password"></label></form></main>'],
  ]) {
    assert.throws(() => extractResumeHtml(page(body, person, title), sourceUrl), error => {
      assert.ok(hasCode('access-blocked')(error))
      assert.equal(error.stage, 'download')
      assert.equal(error.retryable, false)
      assert.equal(error.message, 'This URL is not publicly accessible and could not be processed.')
      assert.ok(!error.message.includes(sourceUrl))
      return true
    })
  }
  assert.throws(() => extractResumeHtml(page('<main>Sign in to view this profile.</main>', [person, { ...person, '@id': '#other', name: 'Bo Xu' }]), sourceUrl), hasCode('access-blocked'))
})

test('multiple main people and semantic directories are rejected instead of merged into a person', () => {
  const second = { ...person, '@id': '#bo', name: 'Bo Xu' }
  for (const data of [
    [person, second],
    { '@graph': [person, second] },
    { '@type': 'ProfilePage', mainEntity: [person, second] },
    { '@type': 'ItemList', itemListElement: [{ item: person }, { item: second }] },
  ]) {
    assert.throws(() => extractResumeHtml(page('<main></main>', data), sourceUrl), hasCode('multiple-profiles'))
  }
  for (const body of [
    '<main><h1>Our team</h1><p>Meet our engineers.</p></main>',
    '<main><h1>Search results for Ada</h1><p>Research engineer</p></main>',
    '<main><article><h2>Ada Li</h2><p>Research engineer</p></article><article><h2>Bo Xu</h2><p>Architect</p></article></main>',
    '<main><div itemtype="https://schema.org/Person">Ada Li</div><div itemtype="https://schema.org/Person">Bo Xu</div></main>',
  ]) {
    assert.throws(() => extractResumeHtml(page(body), sourceUrl), hasCode('multiple-profiles'))
  }
})

test('job postings and article-author metadata cannot become resumes', () => {
  for (const data of [
    { '@type': 'JobPosting', title: 'Research engineer', description: '<h2>Experience</h2><p>Ten years required.</p>' },
    { '@type': 'Article', headline: 'Research experience', author: person },
    { '@graph': [{ '@type': 'BlogPosting', author: { '@id': '#ada' } }, person] },
  ]) {
    assert.throws(() => extractResumeHtml(page('<main><h1>Research experience</h1><p>News about engineering.</p></main>', data), sourceUrl), hasCode('not-a-profile'))
  }
  assert.throws(() => extractResumeHtml(page('<main><h1>Privacy Policy</h1><p>Read our website terms.</p></main>'), sourceUrl), hasCode('not-a-profile'))
})

test('sparse genuine profiles, arbitrary div-based sites and missing fields retain evidence with warnings', () => {
  const sparse = extractResumeHtml(page('<main><h1>Bo Xu</h1><div>Tax consultant</div></main>', undefined, 'Bo Xu'), 'https://public.example/about')
  assert.equal(sparse.title, 'Bo Xu')
  assert.equal(sparse.thin, true)
  assert.ok(sparse.warnings.some(value => /limited resume evidence/.test(value)))
  assert.deepEqual(sparse.paragraphs.map(value => value.text), ['Bo Xu', 'Tax consultant'])
  const nameless = extractResumeHtml(page('<main></main>', { '@type': 'ProfilePage', mainEntity: { '@type': 'Person', jobTitle: 'Research engineer' } }, ''), sourceUrl)
  assert.equal(nameless.title, '')
  assert.deepEqual(nameless.paragraphs.map(value => value.text), ['Research engineer'])
  assert.ok(nameless.warnings.length)
  const malformed = extractResumeHtml(page('<script type="application/ld+json">{ broken</script><h1>Bo Xu</h1><p>Tax consultant</p>'), sourceUrl)
  assert.ok(malformed.warnings.some(value => /structured profile data was unreadable/.test(value)))
  const jobs = extractResumeHtml(page('<main><h1>Ada Li</h1><h2>Experience</h2><article><h3>Example Research</h3><p>Engineer</p></article><article><h3>Example Services</h3><p>Architect</p></article></main>'), sourceUrl)
  assert.ok(jobs.paragraphs.some(value => value.text === 'Example Services'))
  const shortName = extractResumeHtml(page('<main><h1>Li</h1><h2>Skills</h2><p>C</p></main>', undefined, 'Li'), sourceUrl)
  assert.deepEqual(shortName.paragraphs.map(value => value.text), ['Li', 'Skills', 'C'])
})

test('empty executable-script app shells expose a typed renderer signal without fabricated paragraphs', () => {
  for (const body of [
    '<div id="app"></div><script src="/assets/app.js"></script>',
    '<main><p>Loading profile…</p></main><script type="module" src="/main.js"></script>',
    '<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script>document.body.dataset.boot = "ready"</script>',
    '<main>Please wait...</main><script src="/app.js"></script>',
  ]) {
    assert.throws(() => extractResumeHtml(page(body), sourceUrl), error => {
      assert.ok(error instanceof ResumeHtmlShellError)
      assert.ok(error instanceof ResumeExtractionError)
      assert.equal(error.requiresRendering, true)
      assert.equal(error.stage, 'parsing')
      assert.equal(error.code, 'unreadable-document')
      return true
    })
  }
  const structured = extractResumeHtml(page('<div id="app"></div><script src="/app.js"></script>', person), sourceUrl)
  assert.ok(structured.paragraphs.some(value => value.text === 'Ada Li'))
})

test('populated unrelated pages, inert documents and auth controls are never app-shell fallback signals', () => {
  for (const [body, data] of [
    ['<main><h1>Privacy Policy</h1><p>Read our website terms.</p></main><script src="/app.js"></script>'],
    ['<main></main><article><h1>Privacy Policy</h1><p>Read our website terms.</p></article><script src="/app.js"></script>'],
    ['<div id="app"></div>'],
    ['<div id="app"></div><script type="application/json">{"boot":true}</script>'],
    ['<div id="app"></div><script src="/app.js"></script>', { '@type': 'Article', author: person }],
    ['<main><a href="/signin">Sign in</a></main><script src="/app.js"></script>'],
    ['<main><form><input type="email"></form></main><script src="/app.js"></script>'],
  ]) {
    assert.throws(() => extractResumeHtml(page(body, data), sourceUrl), error =>
      error instanceof ResumeExtractionError && !(error instanceof ResumeHtmlShellError) && error.code === 'not-a-profile')
  }
})

test('challenge/auth app scripts and access walls never trigger shell rendering or accept stale Person data', () => {
  for (const body of [
    '<div id="app"></div><script src="/security/challenge.js"></script>',
    '<main>Loading...</main><script src="/captcha.js"></script>',
    '<div id="app"></div><script>window.authwall = true</script>',
    '<main><p>Sign in to view this profile.</p></main><script src="/app.js"></script>',
    '<h1>Sign in</h1><form><input type="password"></form><main></main><script src="/app.js"></script>',
  ]) {
    assert.throws(() => extractResumeHtml(page(body, person), sourceUrl), error =>
      error instanceof ResumeExtractionError && !(error instanceof ResumeHtmlShellError) && error.code === 'access-blocked')
  }
  assert.throws(() => extractResumeHtml(page('<div id="app"></div><script src="/app.js"></script>'), 'https://profiles.example/authwall'),
    hasCode('access-blocked'))
  const publicProfile = extractResumeHtml(page('<main><h1>Ada Li</h1><p>Research engineer</p></main><script src="/captcha.js"></script>'), sourceUrl)
  assert.ok(publicProfile.paragraphs.some(value => value.text === 'Research engineer'))
})

test('source limits reject oversized evidence rather than truncating it, without counting removable markup', () => {
  const text = 'x'.repeat(180_000 - 42)
  const body = value => `<main><h1>Ada Li</h1><h2>Experience</h2><p>${value}</p></main>`
  const exact = extractResumeHtml(page(body(text)), sourceUrl)
  assert.equal(exact.paragraphs.reduce((sum, value) => sum + value.text.length + value.heading.length, 0), 180_000)
  assert.equal(exact.paragraphs.at(-1).text, text)
  assert.throws(() => extractResumeHtml(page(body(`${text}x`)), sourceUrl), hasCode('source-too-large'))
  assert.throws(() => extractResumeHtml(' '.repeat(10 * 1024 * 1024 + 1), sourceUrl), hasCode('source-too-large'))
  const markup = extractResumeHtml(page(`<style>${' '.repeat(200_000)}</style><main><h1>Ada Li</h1><p>Research engineer</p></main>`), sourceUrl)
  assert.equal(markup.paragraphs.length, 2)
  assert.throws(() => extractResumeHtml(page(body('Experience')), 'https://profiles.example/?' + 'x'.repeat(4096)), hasCode('invalid-source'))
  assert.throws(() => extractResumeHtml(page(body('Experience')), 'file:///resume.html'), hasCode('invalid-source'))
})

test('resume OCR preserves short name/skill paragraphs, section names, exact quotes and original pages', () => {
  const result = pdfResult([
    pdfParagraph('Li', 1, { role: 'title', spans: [{ offset: 0 }] }),
    pdfParagraph('Experience', 1, { spans: [{ offset: 10 }] }),
    pdfParagraph('Built\u00a0  reliable systems.', 1, { spans: [{ offset: 30 }] }),
    pdfParagraph('Skills', 2, { spans: [{ offset: 100 }] }),
    pdfParagraph('C', 2, { spans: [{ offset: 110 }] }),
    pdfParagraph('Education', 3, { spans: [{ offset: 200 }] }),
  ], {
    pages: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
    tables: [{
      boundingRegions: [{ pageNumber: 2 }, { pageNumber: 3 }],
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Python', boundingRegions: [{ pageNumber: 2 }], spans: [{ offset: 120 }] },
        { rowIndex: 0, columnIndex: 1, content: 'Advanced', boundingRegions: [{ pageNumber: 2 }], spans: [{ offset: 130 }] },
        { rowIndex: 1, columnIndex: 0, content: 'Example University', boundingRegions: [{ pageNumber: 3 }], spans: [{ offset: 210 }] },
        { rowIndex: 1, columnIndex: 1, content: '2019', boundingRegions: [{ pageNumber: 3 }], spans: [{ offset: 230 }] },
      ],
    }],
  })
  const paragraphs = documentIntelligenceResumeParagraphs(result)
  assert.deepEqual(documentIntelligenceResumeParagraphs(structuredClone(result)), paragraphs)
  assert.deepEqual(paragraphs.map(value => [value.id, value.page, value.heading, value.text]), [
    ['p-0001', 1, 'Li', 'Li'],
    ['p-0002', 1, 'Experience', 'Experience'],
    ['p-0003', 1, 'Experience', 'Built reliable systems.'],
    ['p-0004', 2, 'Skills', 'Skills'],
    ['p-0005', 2, 'Skills', 'C'],
    ['p-0006', 2, 'Skills - table', 'Python | Advanced'],
    ['p-0007', 3, 'Education', 'Education'],
    ['p-0008', 3, 'Education - table', 'Example University | 2019'],
  ])
  assert.deepEqual(documentIntelligenceResumeParagraphs(pdfResult([pdfParagraph('Research engineer')])),
    [{ id: 'p-0001', page: 1, heading: 'Resume', text: 'Research engineer' }])
})

test('OCR enforces page and source bounds and never invents page locators or swallows failures', () => {
  for (const result of [
    pdfResult([], { pages: Array.from({ length: 51 }, (_, index) => ({ pageNumber: index + 1 })) }),
    pdfResult([], { pages: [{ pageNumber: 51 }] }),
    pdfResult([pdfParagraph('Readable text', 51)]),
    pdfResult([], { tables: [{ boundingRegions: [{ pageNumber: 1 }], cells: [{ content: 'Skill', boundingRegions: [{ pageNumber: 51 }] }] }] }),
  ]) assert.throws(() => documentIntelligenceResumeParagraphs(result), hasCode('pdf-too-many-pages'))
  for (const paragraph of [
    { content: 'Readable text' },
    pdfParagraph('Readable text', 0),
    pdfParagraph('Readable text', 1.5),
    pdfParagraph('Readable text', 2),
    { content: 'Readable text', boundingRegions: [{ pageNumber: 1 }, { pageNumber: 2 }] },
  ]) assert.throws(() => documentIntelligenceResumeParagraphs(pdfResult([paragraph])), hasCode('unreadable-document'))
  assert.throws(() => documentIntelligenceResumeParagraphs(pdfResult([], {
    tables: [{ boundingRegions: [{ pageNumber: 1 }, { pageNumber: 2 }], cells: [{ content: 'Ambiguous page' }] }],
  })), hasCode('unreadable-document'))
  assert.throws(() => documentIntelligenceResumeParagraphs(pdfResult([pdfParagraph('x'.repeat(180_001))])), hasCode('source-too-large'))
  assert.throws(() => documentIntelligenceResumeParagraphs({ status: 'succeeded' }), hasCode('service-unavailable'))
  assert.throws(() => documentIntelligenceResumeParagraphs({ status: 'running' }), hasCode('service-unavailable'))
  assert.throws(() => documentIntelligenceResumeParagraphs({ status: 'failed' }), hasCode('unreadable-document'))
  assert.throws(() => documentIntelligenceResumeParagraphs(pdfResult([])), hasCode('unreadable-document'))
  assert.equal(documentIntelligenceResumeParagraphs(pdfResult([pdfParagraph('Last page', 50)], { pages: [{ pageNumber: 50 }] }))[0].page, 50)
})

test('resume OCR uses the shared bounded PDF transport without any alternate network path', async () => {
  let submissions = 0
  const options = {
    endpoint: 'https://di.example',
    getToken: async () => 'synthetic-test-token',
    clock: { now: () => new Date(), sleep: async () => {} },
    fetch: async (_url, init) => {
      submissions += 1
      return init.method === 'POST'
        ? new Response('', { status: 202, headers: { 'operation-location': 'https://di.example/operations/resume' } })
        : Response.json(pdfResult([pdfParagraph('Scanned resume experience', 2)], { pages: [{ pageNumber: 1 }, { pageNumber: 2 }] }))
    },
  }
  await assert.rejects(analyzePdf(new Uint8Array(10 * 1024 * 1024 + 1), options), error => error.code === 'pdf-too-large')
  assert.equal(submissions, 0)
  const paragraphs = documentIntelligenceResumeParagraphs(await analyzePdf(Buffer.from('%PDF-1.7\nfixture'), options))
  assert.equal(submissions, 2)
  assert.equal(paragraphs[0].page, 2)
  assert.equal(paragraphs[0].text, 'Scanned resume experience')
})

test('explicit resume PDF-prefix support submits original bytes unchanged, including the exact admission boundary', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  const original = Buffer.from(await pdf.save())
  for (const prefixLength of [3, 31, 1019]) {
    const bytes = Buffer.concat([Buffer.alloc(prefixLength, 32), original])
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1)
    let submissions = 0
    let tokenCalls = 0
    const options = {
      endpoint: 'https://di.example',
      getToken: async () => { tokenCalls += 1; return 'synthetic-token' },
      clock: { now: () => new Date(), sleep: async () => {} },
      fetch: async (_url, init) => {
        if (init.method === 'POST') {
          submissions += 1
          assert.deepEqual(Buffer.from(init.body), bytes)
          return new Response('', { status: 202, headers: { 'operation-location': 'https://di.example/operations/prefixed' } })
        }
        return Response.json(pdfResult([pdfParagraph('Readable original PDF page')]))
      },
    }
    await assert.rejects(analyzePdf(bytes, options), error => error.code === 'invalid-pdf')
    assert.equal(tokenCalls, 0)
    const result = await analyzePdf(bytes, { ...options, allowPdfHeaderPrefix: true })
    assert.equal(documentIntelligenceResumeParagraphs(result)[0].page, 1)
    assert.equal(submissions, 1)
    assert.equal(tokenCalls, 2)
  }
})

test('resume PDF-prefix opt-in cannot bypass the byte bound or an absent/truncated/out-of-window signature', async () => {
  const options = {
    endpoint: 'https://di.example', allowPdfHeaderPrefix: true,
    getToken: async () => assert.fail('Invalid PDFs cannot acquire a token'),
    fetch: async () => assert.fail('Invalid PDFs cannot reach OCR'),
  }
  for (const bytes of [
    Buffer.from('not a PDF'),
    Buffer.concat([Buffer.alloc(1020, 32), Buffer.from('%PDF-1.7')]),
    Buffer.concat([Buffer.alloc(1024, 32), Buffer.from('%PDF-1.7')]),
  ]) await assert.rejects(analyzePdf(bytes, options), error => error.code === 'invalid-pdf')
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1)
  oversized.write('%PDF-1.7', 20)
  await assert.rejects(analyzePdf(oversized, options), error => error.code === 'pdf-too-large')
})

test('shared public fetch reports only the actual followed redirect destinations in order', async () => {
  const requested = []
  const resolved = []
  const result = await safeFetch('https://profiles.example/start', {
    resolver: async hostname => { resolved.push(hostname); return ['93.184.216.34'] },
    transport: async request => {
      requested.push(request.url.href)
      assert.equal(request.address, '93.184.216.34')
      if (requested.length === 1) return { status: 301, headers: { Location: '/moved' }, body: new Uint8Array() }
      if (requested.length === 2) return { status: 308, headers: { location: 'https://public.example/profile' }, body: new Uint8Array() }
      return { status: 200, headers: {}, body: Buffer.from('Public profile') }
    },
  })
  assert.deepEqual(result.redirects, ['https://profiles.example/moved', 'https://public.example/profile'])
  assert.deepEqual(result.redirects, requested.slice(1))
  assert.equal(result.url, 'https://public.example/profile')
  assert.deepEqual(resolved, ['profiles.example', 'profiles.example', 'public.example'])
})

test('unfollowed redirects and direct responses have empty history, never transport-invented provenance', async () => {
  for (const status of [200, 302]) {
    let calls = 0
    const result = await safeFetch(sourceUrl, {
      followRedirects: false,
      resolver: async () => ['93.184.216.34'],
      transport: async () => {
        calls += 1
        return {
          status, headers: { location: 'https://unvisited.example/' }, body: new Uint8Array(),
          redirects: ['https://invented.example/'],
        }
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.url, sourceUrl)
    assert.deepEqual(result.redirects, [])
  }
})

test('redirect history does not weaken public-address validation or aggregate byte limits', async () => {
  let connections = 0
  await assert.rejects(safeFetch(sourceUrl, {
    resolver: async hostname => hostname === 'profiles.example' ? ['93.184.216.34'] : ['127.0.0.1'],
    transport: async () => {
      connections += 1
      return { status: 302, headers: { location: 'https://private.example/' }, body: new Uint8Array() }
    },
  }), error => error.code === 'unsafe-url')
  assert.equal(connections, 1)
  connections = 0
  await assert.rejects(safeFetch(sourceUrl, {
    maxBytes: 10,
    resolver: async () => ['93.184.216.34'],
    transport: async request => {
      connections += 1
      assert.equal(request.maxBytes, connections === 1 ? 10 : 4)
      return {
        status: connections === 1 ? 302 : 200,
        headers: { location: '/next' }, body: new Uint8Array(6),
      }
    },
  }), error => error.code === 'source-too-large')
  assert.equal(connections, 2)
})

test('shared renderer permits loopback HTTP only with an explicit opt-in and sends no credentials', async () => {
  for (const endpoint of ['http://127.0.0.1:5188', 'http://localhost:5188', 'http://[::1]:5188']) {
    assert.throws(() => createRemoteRenderer(endpoint), /HTTPS/)
    const requests = []
    const renderer = createRemoteRenderer(endpoint, async (url, init) => {
      requests.push({ url, init })
      return Response.json({ html: '<main>Public profile</main>', finalUrl: sourceUrl })
    }, { allowLocalHttp: true })
    assert.deepEqual(await renderer.render(sourceUrl, { headers: { authorization: 'private-marker', cookie: 'private-marker' } }), {
      html: '<main>Public profile</main>', finalUrl: sourceUrl,
    })
    assert.equal(requests[0].url, `${endpoint}/render`)
    assert.equal(requests[0].init.redirect, 'error')
    assert.equal(requests[0].init.headers.authorization, undefined)
    assert.equal(requests[0].init.headers.cookie, undefined)
    assert.deepEqual(JSON.parse(requests[0].init.body), { url: sourceUrl })
    assert.ok(requests[0].init.signal instanceof AbortSignal)
  }
  for (const endpoint of [
    'http://renderer.example/', 'http://10.0.0.1/', 'http://localhost.example/', 'http://0.0.0.0/', 'http://127.0.0.2/',
    'http://127.0.0.1/?mode=local', 'http://127.0.0.1/#fragment', 'http://user:password@127.0.0.1/',
  ]) assert.throws(() => createRemoteRenderer(endpoint, fetch, { allowLocalHttp: true }), /HTTPS/)
})

test('local renderer opt-in does not permit private source/final destinations or unsafe response errors', async () => {
  let calls = 0
  let response
  const renderer = createRemoteRenderer('http://127.0.0.1:5188', async () => { calls += 1; return response }, { allowLocalHttp: true })
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://metadata.internal/']) {
    await assert.rejects(renderer.render(url, {}), error => error.code === 'invalid-url')
  }
  assert.equal(calls, 0)
  for (const [value, code] of [
    [Response.json({ html: 'private-marker', finalUrl: 'http://127.0.0.1/private' }), 'renderer-invalid-response'],
    [Response.json({ unexpected: 'private-marker' }), 'renderer-invalid-response'],
    [new Response('private-marker'), 'renderer-invalid-response'],
    [new Response('private-marker', { status: 503 }), 'renderer-unavailable'],
  ]) {
    response = value
    await assert.rejects(renderer.render(sourceUrl, {}), error => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /private-marker|profiles\.example/)
      return true
    })
  }
})

test('local renderer stops streaming at its response byte bound and honors cancellation during body reads', async () => {
  let cancelled = false
  const oversized = createRemoteRenderer('http://127.0.0.1:5188', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  })), { allowLocalHttp: true })
  await assert.rejects(oversized.render(sourceUrl, {}), error => error.code === 'source-too-large')
  assert.equal(cancelled, true)

  const controller = new AbortController()
  cancelled = false
  const aborted = createRemoteRenderer('http://127.0.0.1:5188', async () => {
    setImmediate(() => controller.abort())
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  }, { allowLocalHttp: true })
  await assert.rejects(aborted.render(sourceUrl, { signal: controller.signal }), error => error.code === 'cancelled')
  assert.equal(cancelled, true)
  let fetched = false
  await assert.rejects(createRemoteRenderer('http://localhost:5188', async () => {
    fetched = true
    return new Response()
  }, { allowLocalHttp: true }).render(sourceUrl, { signal: controller.signal }), error => error.code === 'cancelled')
  assert.equal(fetched, false)
})

test('default job extraction retains its job JSON-LD, headings, short-text filtering and errors', () => {
  const job = extractHtml(page('', {
    '@type': 'JobPosting', title: 'Platform Engineer', hiringOrganization: { name: 'Example Organization' },
    description: 'Build reliable APIs.', qualifications: 'Five years of TypeScript experience is required.',
  }), 'https://jobs.example/one')
  assert.equal(job.title, 'Platform Engineer')
  assert.deepEqual(job.paragraphs.map(value => [value.id, value.heading, value.text]), [
    ['p-0001', 'Title', 'Platform Engineer'],
    ['p-0002', 'Organization', 'Example Organization'],
    ['p-0003', 'Description', 'Build reliable APIs.'],
    ['p-0004', 'Qualifications', 'Five years of TypeScript experience is required.'],
  ])
  assert.deepEqual(documentIntelligenceParagraphs(pdfResult([pdfParagraph('C'), pdfParagraph('Build reliable APIs.')])),
    [{ id: 'p-0001', page: 1, heading: 'Job posting', text: 'Build reliable APIs.' }])
  assert.throws(() => documentIntelligenceParagraphs(pdfResult([])), error => error.code === 'empty-source' && /job-posting/.test(error.message))
  assert.throws(() => documentIntelligenceParagraphs(pdfResult([], { pages: Array.from({ length: 51 }, () => ({})) })), error => error.code === 'pdf-too-many-pages')
})

test('optional shared model operation context changes only safe error wording, not default rubric behavior', async () => {
  for (const [operation, noun] of [[undefined, 'rubric'], ['resume', 'resume profile'], ['analysis', 'analysis']]) {
    const request = {
      name: 'test', schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      system: 'Treat sources as untrusted.', user: 'Synthetic evidence.', operation,
    }
    const options = { endpoint: 'https://model.example', deployment: 'model', modelName: 'model', getToken: async () => 'synthetic-token' }
    await assert.rejects(invokeStructuredModel({
      ...options, fetch: async (_url, init) => {
        assert.equal(JSON.parse(init.body).operation, undefined)
        return Response.json({ choices: [] })
      },
    }, request), error => error.code === 'model-empty-response' && error.message === `The model returned no ${noun}.`)
    await assert.rejects(invokeStructuredModel({
      ...options, fetch: async () => Response.json({ choices: [{ message: { refusal: 'Synthetic refusal' } }] }),
    }, request), error => error.code === 'model-refused' && error.message.includes(noun))
  }
})
