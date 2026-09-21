import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, PDFName } from 'pdf-lib'
import { loadWorker } from './shared-model-loader.mjs'
import { settingsSnapshot } from './runtime-settings-test-support.mjs'
import { fakeDi, immutableCache, pdfFixture, source } from './reference-fixtures.mjs'

const { extractReferenceDocument } = await loadWorker('../worker/references/index.ts')
const { inspectReferencePdf } = await loadWorker('../worker/references/pdf.ts')

test('captured reference page selection, chunk and byte limits preserve original-page evidence and cache identity', async () => {
  const original = await pdfFixture(5)
  const di = fakeDi()
  const cache = immutableCache()
  const snapshot = settingsSnapshot(settings => {
    settings.grades.references.pdfChunkPages = 2
    settings.grades.references.maxSelectedPages = 5
  })
  const options = { documentIntelligence: di.options, ...cache, processingSettings: snapshot }
  const result = await extractReferenceDocument(source(), original, options)
  assert.deepEqual(di.submissions, [[1, 2], [3, 4], [5]])
  assert.deepEqual(result.document.paragraphs.map(paragraph => paragraph.page), [1, 2, 3, 4, 5])
  await extractReferenceDocument(source(), original, options)
  assert.equal(di.submissions.length, 3)
  await extractReferenceDocument(source(), original, {
    ...options, processingSettings: settingsSnapshot(settings => { settings.grades.references.pdfChunkPages = 3 }),
  })
  assert.deepEqual(di.submissions.slice(3), [[1, 2, 3], [4, 5]])
  for (const [change, code] of [
    [settings => { settings.grades.references.maxSelectedPages = 2; settings.grades.references.pdfChunkPages = 2 }, 'reference-page-selection-required'],
    [settings => { settings.grades.references.maxPdfBytes = 128 }, 'reference-too-large'],
  ]) {
    await assert.rejects(extractReferenceDocument(source(), original, {
      ...options, processingSettings: settingsSnapshot(change),
    }), error => error.code === code)
  }
  assert.equal(di.submissions.length, 5)
})

test('the explicit legacy baseline reuses verified pre-settings default chunk checkpoints', async () => {
  const original = await pdfFixture(2)
  const di = fakeDi()
  di.options.pollTimeoutMilliseconds = 240_000
  const cache = immutableCache()
  await extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache })
  await extractReferenceDocument(source(), original, {
    documentIntelligence: di.options, ...cache, processingSettings: settingsSnapshot(() => {}, 'legacy-v1'),
  })
  assert.equal(di.submissions.length, 1)
})

test('captured reference link and character limits fail explicitly instead of dropping evidence', async () => {
  const di = fakeDi()
  const linked = await pdfFixture(2, [
    { page: 1, url: 'https://agency.example/one' }, { page: 2, url: 'https://agency.example/two' },
  ])
  await assert.rejects(extractReferenceDocument(source(), linked, {
    documentIntelligence: di.options,
    processingSettings: settingsSnapshot(settings => { settings.grades.references.maxLinks = 1 }),
  }), error => error.code === 'reference-link-budget')
  assert.equal(di.submissions.length, 0)
  await assert.rejects(extractReferenceDocument(source(), await pdfFixture(1), {
    documentIntelligence: di.options,
    processingSettings: settingsSnapshot(settings => { settings.grades.references.maxSourceCharacters = 12 }),
  }), error => error.code === 'reference-too-long')
})

test('177-page standards use bounded page-copy chunks, absolute original numbering and immutable recovery', async () => {
  const original = await pdfFixture(177)
  const cache = immutableCache()
  const di = fakeDi()
  const input = source({ origin: 'upload', requestedUrl: undefined, purpose: 'grading' })
  const options = { documentIntelligence: di.options, ...cache }
  const first = await extractReferenceDocument(input, original, options)
  assert.equal(first.document.pageCount, 177)
  assert.equal(first.document.completeness, 'complete')
  assert.equal(first.document.selectedPages.length, 177)
  assert.deepEqual(di.submissions.map(pages => pages.length), [50, 50, 50, 27])
  assert.deepEqual(di.submissions.flat(), Array.from({ length: 177 }, (_, index) => index + 1))
  assert.equal(first.document.paragraphs.at(-1).page, 177)
  assert.match(first.document.paragraphs.at(-1).id, /p0177/)
  assert.equal(cache.values.size, 8)
  const tokens = di.tokenCalls
  const second = await extractReferenceDocument(input, original, options)
  assert.deepEqual(second.document, first.document)
  assert.equal(di.submissions.length, 4)
  assert.equal(di.tokenCalls, tokens)
})

test('selected pages from a 204-page manual preserve real page IDs and selected-page completeness', async () => {
  const original = await pdfFixture(204, [
    { page: 177, url: 'https://www.opm.gov/functional-guides/gsresch.pdf', label: 'Research Grade Evaluation Guide' },
    { page: 150, url: 'https://www.opm.gov/unselected.pdf' },
  ])
  const di = fakeDi()
  const result = await extractReferenceDocument(source({ selectedPages: [204, 1, 177, 51] }), original, {
    documentIntelligence: di.options, ...immutableCache(),
  })
  assert.equal(result.document.pageCount, 204)
  assert.equal(result.document.completeness, 'selected-pages')
  assert.deepEqual(result.document.selectedPages, [1, 51, 177, 204])
  assert.deepEqual(result.document.paragraphs.map(paragraph => paragraph.page), [1, 51, 177, 204])
  assert.deepEqual(di.submissions, [[1, 51, 177, 204]])
  assert.equal(result.links.length, 1)
  assert.equal(result.links[0].page, 177)
  assert.equal(result.links[0].relation, 'grading')
})

test('PDF metadata and reference page selection are validated before any OCR request', async () => {
  const original = await pdfFixture(251)
  const di = fakeDi()
  await assert.rejects(extractReferenceDocument(source(), original, { documentIntelligence: di.options }),
    error => error.code === 'reference-page-selection-required')
  for (const pages of [[252], [2, 2], [0], [1.5], Array.from({ length: 251 }, (_, index) => index + 1)]) {
    await assert.rejects(extractReferenceDocument(source({ selectedPages: pages }), original, { documentIntelligence: di.options }),
      error => ['reference-invalid-pages', 'reference-too-many-selected-pages'].includes(error.code))
  }
  assert.equal(di.tokenCalls, 0)
  const selected = await extractReferenceDocument(source({ selectedPages: [251] }), original, { documentIntelligence: di.options })
  assert.equal(selected.document.paragraphs[0].page, 251)
  assert.equal(selected.document.pageCount, 251)
  await assert.rejects(inspectReferencePdf(new Uint8Array(20 * 1024 * 1024 + 1)), error => error.code === 'reference-pdf-too-large')
  await assert.rejects(inspectReferencePdf(Buffer.from('not a PDF')), error => error.code === 'invalid-pdf')
})

test('cancellation preserves completed chunks and submitted operation checkpoints for a later recovery', async () => {
  const original = await pdfFixture(101)
  const cache = immutableCache()
  const controller = new AbortController()
  const di = fakeDi({ onSubmit: count => { if (count === 2) controller.abort() } })
  await assert.rejects(extractReferenceDocument(source(), original, {
    documentIntelligence: di.options, ...cache, signal: controller.signal,
  }), error => error.code === 'cancelled')
  assert.equal(di.submissions.length, 2)
  assert.equal([...cache.values.keys()].filter(key => key.endsWith('-result')).length, 1)
  assert.equal([...cache.values.keys()].filter(key => key.includes('-operation-')).length, 2)
  const recovered = await extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache })
  assert.equal(recovered.document.paragraphs.at(-1).page, 101)
  assert.equal(di.submissions.length, 3)
  assert.equal(recovered.document.completeness, 'complete')
})

test('expired operations get bounded new immutable checkpoints instead of overwriting prior work', async () => {
  const original = await pdfFixture(2)
  let expired = false
  const di = fakeDi({ onPoll: url => {
    if (!expired && url.endsWith('/1')) { expired = true; return new Response('', { status: 410 }) }
  } })
  const cache = immutableCache()
  const result = await extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache })
  assert.equal(result.document.completeness, 'complete')
  assert.equal(di.submissions.length, 2)
  assert.ok([...cache.values.keys()].some(key => key.endsWith('-operation-1-expired')))
  assert.ok([...cache.values.keys()].some(key => key.endsWith('-operation-2')))
})

test('OCR coverage gaps are incomplete evidence, not silently complete references', async () => {
  const original = await pdfFixture(3)
  const di = fakeDi({ result: () => ({
    status: 'succeeded',
    analyzeResult: {
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
      paragraphs: [{ content: 'Only the first original page was readable.', boundingRegions: [{ pageNumber: 1 }] }],
    },
  }) })
  const result = await extractReferenceDocument(source(), original, { documentIntelligence: di.options })
  assert.equal(result.document.pageCount, 3)
  assert.equal(result.document.completeness, 'incomplete')
  assert.ok(result.warnings.some(warning => warning.includes('original pages 2, 3')))
})

test('reference OCR tables retain grade headers, row spans, alternatives and table footnotes', async () => {
  const original = await pdfFixture(80)
  const di = fakeDi({ result: () => ({
    status: 'succeeded',
    analyzeResult: {
      pages: [{ pageNumber: 1 }],
      paragraphs: [{ content: 'Minimum qualifications', role: 'sectionHeading', spans: [{ offset: 0 }], boundingRegions: [{ pageNumber: 1 }] }],
      tables: [{
        rowCount: 3, columnCount: 3, spans: [{ offset: 30 }], boundingRegions: [{ pageNumber: 1 }],
        caption: { content: 'Education OR experience' },
        cells: [
          { rowIndex: 0, columnIndex: 0, content: 'Path', kind: 'columnHeader' },
          { rowIndex: 0, columnIndex: 1, content: 'GS-9', kind: 'columnHeader' },
          { rowIndex: 0, columnIndex: 2, content: 'GS-11', kind: 'columnHeader' },
          { rowIndex: 1, columnIndex: 0, rowSpan: 2, content: 'Education' },
          { rowIndex: 1, columnIndex: 1, content: "Master's degree*" },
          { rowIndex: 1, columnIndex: 2, content: 'Doctoral degree' },
          { rowIndex: 2, columnIndex: 1, columnSpan: 2, content: 'OR equivalent graduate study' },
        ],
        footnotes: [{ content: '* Acceptable combinations are alternative paths, not added mandatory requirements.' }],
      }],
    },
  }) })
  const result = await extractReferenceDocument(source({ selectedPages: [80] }), original, { documentIntelligence: di.options })
  assert.ok(result.document.paragraphs.every(paragraph => paragraph.page === 80))
  const rows = result.document.paragraphs.filter(paragraph => paragraph.table)
  assert.ok(rows.some(row => row.text.includes("GS-9: Master's degree*") && row.table.headers.includes('GS-11')))
  assert.ok(rows.some(row => row.text.includes('Education [rows 2-3]') && row.text.includes('[columns 2-3]')))
  assert.ok(result.document.paragraphs.some(paragraph => paragraph.text.includes('not added mandatory requirements')))
})

test('cache identity, checksum and source-version isolation are enforced', async () => {
  const original = await pdfFixture(1)
  const cache = immutableCache()
  const di = fakeDi()
  await extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache })
  await extractReferenceDocument(source({ documentVersion: 2 }), original, { documentIntelligence: di.options, ...cache })
  assert.equal(di.submissions.length, 2)
  await extractReferenceDocument(source({ workspaceId: 'workspace-two', ladderId: 'ladder-two' }), original, { documentIntelligence: di.options, ...cache })
  assert.equal(di.submissions.length, 3)
  const resultKey = [...cache.values.keys()].find(key => key.endsWith('-result'))
  cache.values.get(resultKey).sha256 = 'wrong'
  await assert.rejects(extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache }),
    error => error.code === 'reference-cache-invalid')
})

test('saved operation locations cannot send Document Intelligence tokens to another host', async () => {
  const original = await pdfFixture(1)
  let requests = 0
  await assert.rejects(extractReferenceDocument(source(), original, {
    documentIntelligence: {
      endpoint: 'https://di.example', getToken: async () => 'test-token',
      fetch: async () => { requests += 1; return new Response('', { status: 202, headers: { 'operation-location': 'https://untrusted.example/steal-token' } }) },
    },
  }), error => error.code === 'ocr-invalid-operation')
  assert.equal(requests, 1)
})

test('reference page-copy OCR accepts a valid PDF above the unchanged 10 MiB job byte limit', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([401, 800])
  const image = pdf.context.stream(new Uint8Array(1920 * 1920 * 3), {
    Type: 'XObject', Subtype: 'Image', Width: 1920, Height: 1920, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  })
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Image: pdf.context.register(image) } }))
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream('q 300 0 0 300 0 0 cm /Image Do Q')))
  const bytes = await pdf.save()
  assert.ok(bytes.byteLength > 10 * 1024 * 1024)
  const di = fakeDi()
  const result = await extractReferenceDocument(source(), { bytes, contentType: 'application/pdf', redirects: [] }, { documentIntelligence: di.options })
  assert.equal(result.document.completeness, 'complete')
  assert.deepEqual(di.submissions, [[1]])
})

test('poll-budget deferral resumes the same durable OCR operation without resubmitting a paid chunk', async () => {
  const original = await pdfFixture(1)
  const cache = immutableCache()
  let processing = true
  const di = fakeDi({ onPoll: () => processing ? Response.json({ status: 'running' }) : undefined })
  di.options.pollTimeoutMilliseconds = 2_000
  await assert.rejects(extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache }),
    error => error.code === 'ocr-timeout' && error.retryable)
  processing = false
  const result = await extractReferenceDocument(source(), original, { documentIntelligence: di.options, ...cache })
  assert.equal(result.document.completeness, 'complete')
  assert.equal(di.submissions.length, 1)
})

test('exhausted OCR throttling is reported as a retryable processing error, not an unsupported-evidence result', async () => {
  let requests = 0
  await assert.rejects(extractReferenceDocument(source(), await pdfFixture(1), {
    documentIntelligence: {
      endpoint: 'https://di.example', getToken: async () => 'test-token',
      clock: { now: () => new Date(), sleep: async () => {} },
      fetch: async () => { requests += 1; return new Response('', { status: 429 }) },
    },
  }), error => error.code === 'reference-ocr-unavailable' && error.retryable)
  assert.equal(requests, 3)
})

test('raw OPM PDF link labels do not misclassify grading guides as qualifications because of the shared URL prefix', async () => {
  const url = 'https://www.opm.gov/policy-data-oversight/classification-qualifications/classifying-general-schedule-positions/functional-guides/gssg.pdf'
  const original = await pdfFixture(1, [{ page: 1, url }])
  const result = await inspectReferencePdf(original.bytes)
  assert.equal(result.links[0].relation, 'grading')
})

test('source-original integrity is checked before OCR or immutable chunk reuse', async () => {
  const original = await pdfFixture(1)
  const di = fakeDi()
  for (const mismatch of [{ sha256: 'wrong' }, { bytes: original.bytes.byteLength + 1 }, { originalContentType: 'text/html' }]) {
    await assert.rejects(extractReferenceDocument(source(mismatch), original, { documentIntelligence: di.options }),
      error => error.code === 'reference-original-mismatch')
  }
  assert.equal(di.tokenCalls, 0)
})

test('ambiguous multi-page table cell locations yield explicit incomplete extraction', async () => {
  const di = fakeDi({ result: () => ({
    status: 'succeeded',
    analyzeResult: {
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
      tables: [{
        boundingRegions: [{ pageNumber: 1 }, { pageNumber: 2 }],
        rowCount: 1, columnCount: 2,
        cells: [{ rowIndex: 0, columnIndex: 0, content: 'Grade GS-9' }, { rowIndex: 0, columnIndex: 1, content: 'Qualification on an ambiguous original page' }],
      }],
    },
  }) })
  const result = await extractReferenceDocument(source(), await pdfFixture(2), { documentIntelligence: di.options })
  assert.equal(result.document.completeness, 'incomplete')
  assert.ok(result.warnings.some(warning => warning.includes('incomplete cell-level page locators')))
})

test('a table split at an OCR chunk boundary cannot silently lose its grade-column context', async () => {
  const di = fakeDi({ result: pages => ({
    status: 'succeeded',
    analyzeResult: {
      pages: pages.map((_, index) => ({ pageNumber: index + 1 })),
      paragraphs: pages.map((page, index) => ({ content: `Readable original page ${page}.`, boundingRegions: [{ pageNumber: index + 1 }] })),
      tables: pages[0] === 51 ? [{
        boundingRegions: [{ pageNumber: 1 }], rowCount: 1, columnCount: 2,
        cells: [{ rowIndex: 0, columnIndex: 0, content: 'Continuing education alternative' }, { rowIndex: 0, columnIndex: 1, content: 'Continuing experience alternative' }],
      }] : [],
    },
  }) })
  const result = await extractReferenceDocument(source(), await pdfFixture(51), { documentIntelligence: di.options })
  assert.equal(result.document.completeness, 'incomplete')
  assert.ok(result.warnings.some(warning => /original page 51.*chunk boundary without column headers/.test(warning)))
})
