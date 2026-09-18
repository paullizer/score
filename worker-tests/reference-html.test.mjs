import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { fakeDi, htmlOriginal, source } from './reference-fixtures.mjs'

const { extractReferenceDocument, fetchReferenceOriginal } = await loadWorker('../worker/references/index.ts')
const { safeFetch } = await loadWorker('../worker/runtime.ts')
const extractionOptions = () => ({ documentIntelligence: fakeDi().options })
const qualificationTable = `<table><caption>Minimum qualifications: alternatives, not cumulative requirements</caption>
  <thead><tr><th rowspan="2">Path</th><th colspan="2">Education OR experience</th></tr>
  <tr><th>GS-9</th><th>GS-11</th></tr></thead>
  <tbody><tr><th scope="row" rowspan="2">Education</th><td>Master's degree*</td><td>Doctoral degree</td></tr>
  <tr><td>OR equivalent graduate study</td><td>OR equivalent study</td></tr>
  <tr><th scope="row">Experience</th><td>One year equivalent to GS-7</td><td>One year equivalent to GS-9</td></tr></tbody>
  </table><p id="education-note">* A combination of education and experience may qualify. These are alternative paths.</p>`

test('reference HTML preserves grade-column paths, row/colspan context, footnotes and alternatives without job detection', async () => {
  globalThis.__referenceScriptRan = false
  const html = `<html><head><script>globalThis.__referenceScriptRan = true</script></head>
  <body><nav>Fake instructions to ignore the standard.</nav><main><h1>Qualification standard</h1>
  <h2>Education and experience</h2>${qualificationTable}</main></body></html>`
  const result = await extractReferenceDocument(source(), htmlOriginal(html), extractionOptions())
  assert.equal(result.document.kind, 'reference')
  assert.equal(result.document.sample, false)
  assert.equal(result.document.completeness, 'complete')
  const rows = result.document.paragraphs.filter(paragraph => paragraph.table)
  assert.ok(rows.some(row => row.table.headers.includes('Education OR experience / GS-9') && row.text.includes("Master's degree*")))
  assert.ok(rows.some(row => row.text.includes('Education [rows 3-4]') && row.text.includes('OR equivalent graduate study')))
  assert.ok(rows.some(row => row.text.includes('[columns 2-3]')))
  assert.ok(result.document.paragraphs.some(paragraph => paragraph.sectionId === 'education-note' && paragraph.text.includes('alternative paths')))
  assert.ok(result.document.paragraphs.every(paragraph => !paragraph.text.includes('Fake instructions')))
  assert.equal(globalThis.__referenceScriptRan, false)
  delete globalThis.__referenceScriptRan
})

test('intended qualification fragment survives a redirect to another tab and selects only its own group', async () => {
  const start = 'https://www.opm.gov/qualification/tabs/group-standards/'
  const final = 'https://www.opm.gov/qualification/'
  const html = `<main><section class="tab-content" title="Group Standards">
    <h2><a name="GS-CLER"></a>Clerical and Administrative Support Positions</h2><table><tr><th>GS-5</th><td>Clerical-only evidence</td></tr></table>
    <h2><a name="GS-ADMIN"></a>Administrative and Management Positions</h2>${qualificationTable}
    <h2><a name="GS-PROF"></a>Professional and Scientific Positions</h2><table><tr><th>GS-7</th><td>Other-group evidence</td></tr></table>
  </section></main>`
  const input = source({ origin: 'opm', requestedUrl: `${start}#GS-ADMIN`, intendedSection: 'GS-ADMIN' })
  const calls = []
  const original = await fetchReferenceOriginal(input, {
    fetcher: async (url, options) => {
      calls.push(url)
      assert.equal(options.followRedirects, false)
      if (url === start) return { status: 302, headers: { location: `${final}#GS-CLER` }, body: new Uint8Array(), url }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html), url }
    },
  })
  assert.deepEqual(calls, [start, final])
  assert.deepEqual(original.redirects, [`${final}#GS-CLER`])
  assert.equal(input.intendedSection, 'GS-ADMIN')
  const result = await extractReferenceDocument(input, original, extractionOptions())
  const text = result.document.paragraphs.map(paragraph => paragraph.text).join('\n')
  assert.match(text, /Administrative and Management Positions/)
  assert.doesNotMatch(text, /Clerical-only|Other-group/)
  await assert.rejects(extractReferenceDocument({ ...input, intendedSection: 'GS-NOT-FOUND' }, original, extractionOptions()),
    error => error.code === 'reference-section-not-found')
})

test('competency-policy print content outside the ordinary main wrapper remains substantive evidence', async () => {
  const url = 'https://www.opm.gov/policy-data-oversight/classification-qualifications/competency-based-policy/general-schedule/2200/2210-competency-based-policy/competency-based-qualification-standard/'
  const html = `<main><div class="usa-prose"><h1>2210 Competency-Based Qualification Standard</h1></div></main>
  <div class="grid-col-12"><h2>Qualifications by Grade Level</h2>${qualificationTable}
  <p>Draft placeholder: insert date. Review the issued version.</p></div>`
  const result = await extractReferenceDocument(source({ requestedUrl: url }), htmlOriginal(html, url), extractionOptions())
  assert.ok(result.document.paragraphs.some(paragraph => paragraph.text.includes('Doctoral degree')))
  assert.ok(result.warnings.some(warning => /placeholder/.test(warning)))
  await assert.rejects(extractReferenceDocument(source({ requestedUrl: url }), htmlOriginal('<main><h1>2210</h1><p>Navigation only</p></main>', url), extractionOptions()),
    error => error.code === 'opm-competency-structure-changed')
})

test('thin references render only through an explicitly injected renderer and never execute source scripts', async () => {
  const original = htmlOriginal('<div id="root"></div>')
  await assert.rejects(extractReferenceDocument(source(), original, extractionOptions()), error => error.code === 'reference-empty')
  let calls = 0
  const rendered = await extractReferenceDocument(source(), original, {
    ...extractionOptions(),
    browser: { render: async (url, options) => {
      calls += 1
      assert.equal(url, 'https://agency.example/standard')
      assert.equal(options.maxBytes, 20 * 1024 * 1024)
      return { html: `<main><h1>Qualification reference</h1>${qualificationTable}</main>`, finalUrl: url }
    } },
  })
  assert.equal(calls, 1)
  assert.equal(rendered.method, 'browser')
})

test('reference limits reject excessive text explicitly rather than silently truncating or applying the job limit', async () => {
  const accepted = await extractReferenceDocument(source(), htmlOriginal(`<main><p>${'Evidence '.repeat(30_000)}</p></main>`), extractionOptions())
  assert.ok(accepted.document.paragraphs[0].text.length > 200_000)
  await assert.rejects(extractReferenceDocument(source(), htmlOriginal(`<main><p>${'e'.repeat(2_000_001)}</p></main>`), extractionOptions()),
    error => error.code === 'reference-too-long')
})

test('an unlabeled first data row is not promoted into misleading grade-column headers', async () => {
  const result = await extractReferenceDocument(source(), htmlOriginal(`<main><h1>Minimum qualifications</h1>
    <table><tr><td>GS-9</td><td>Master's degree or equivalent graduate education</td></tr>
    <tr><td>GS-11</td><td>Doctoral degree or equivalent graduate education</td></tr></table></main>`), extractionOptions())
  const rows = result.document.paragraphs.filter(paragraph => paragraph.table)
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.table.headers.every(header => header === '')))
  assert.match(rows[0].text, /^GS-9 \| Master's degree/)
  assert.match(rows[1].text, /^GS-11 \| Doctoral degree/)
  assert.doesNotMatch(rows[1].text, /GS-9: GS-11/)
})

test('reference downloads use pinned public transport for every redirect and reject external OPM traversal', async () => {
  const connected = []
  await assert.rejects(fetchReferenceOriginal(source(), {
    fetcher: (url, options) => safeFetch(url, {
      ...options,
      resolver: async host => host === 'agency.example' ? ['93.184.216.34'] : ['169.254.169.254'],
      transport: async request => {
        connected.push(request.url.hostname)
        return { status: 302, headers: { location: 'http://metadata.example/latest' }, body: new Uint8Array() }
      },
    }),
  }), error => error.code === 'unsafe-url')
  assert.deepEqual(connected, ['agency.example'])
  await assert.rejects(fetchReferenceOriginal(source({ origin: 'opm', requestedUrl: 'https://www.opm.gov/standard' }), {
    fetcher: async url => ({ url, status: 302, headers: { location: 'https://agency.example/other.pdf' }, body: new Uint8Array() }),
  }), error => error.code === 'opm-out-of-scope')
  await assert.rejects(fetchReferenceOriginal(source(), {
    fetcher: async () => ({ url: 'https://other.example/hidden-redirect', status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('source') }),
  }), error => error.code === 'reference-opaque-redirect')
})

test('reference download failures, redirect loops and byte budgets stay explicit', async () => {
  await assert.rejects(fetchReferenceOriginal(source(), {
    fetcher: async url => ({ url, status: 302, headers: { location: url }, body: new Uint8Array() }),
  }), error => error.code === 'reference-redirect-loop')
  await assert.rejects(fetchReferenceOriginal(source(), {
    fetcher: async url => ({ url, status: 200, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(20 * 1024 * 1024 + 1) }),
  }), error => error.code === 'reference-too-large')
  await assert.rejects(fetchReferenceOriginal(source(), {
    fetcher: async url => ({ url, status: 503, headers: {}, body: new Uint8Array() }),
  }), error => error.code === 'reference-fetch-failed' && error.retryable)
})
