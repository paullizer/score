import assert from 'node:assert/strict'
import test from 'node:test'
import { extractWordDocument } from '../dist-worker/runtime.mjs'
import { docxFile, legacyDocFile } from '../server-tests/word-fixtures.mjs'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
function intelligence(bytes, result, onRequest) {
  return {
    endpoint: 'https://word-ocr.example.test',
    getToken: async () => 'synthetic-test-token',
    clock: { now: () => new Date(), sleep: async () => {} },
    fetch: async (url, init = {}) => {
      onRequest?.(url, init)
      if (init.method === 'POST') {
        assert.equal(init.headers['content-type'], DOCX)
        assert.deepEqual(Buffer.from(init.body), bytes)
        return new Response(null, { status: 202, headers: {
          'operation-location': 'https://word-ocr.example.test/documentintelligence/operations/word',
        } })
      }
      return Response.json(result)
    },
  }
}

test('DOCX uses the existing layout service without treating synthetic units as physical PDF pages', async () => {
  const bytes = docxFile('Engineering specialist\nRequirements\nApply engineering methods.', { table: [['Skill', 'Level'], ['Engineering', 'Required']] })
  const result = await extractWordDocument(bytes, 'docx', intelligence(bytes, {
    status: 'succeeded',
    analyzeResult: {
      pages: Array.from({ length: 80 }, (_, index) => ({ pageNumber: index + 1 })),
      paragraphs: [
        { role: 'title', content: 'Engineering specialist', spans: [{ offset: 0 }] },
        { role: 'sectionHeading', content: 'Requirements', spans: [{ offset: 25 }] },
        { content: 'Apply engineering methods.', spans: [{ offset: 40 }], boundingRegions: [{ pageNumber: 80 }] },
      ],
      tables: [{
        spans: [{ offset: 70 }],
        cells: [
          { rowIndex: 0, columnIndex: 0, content: 'Skill' }, { rowIndex: 0, columnIndex: 1, content: 'Level' },
          { rowIndex: 1, columnIndex: 0, content: 'Engineering' }, { rowIndex: 1, columnIndex: 1, content: 'Required' },
        ],
      }],
    },
  }))
  assert.deepEqual(result.paragraphs.map(paragraph => paragraph.text), [
    'Engineering specialist', 'Requirements', 'Apply engineering methods.', 'Skill | Level\nEngineering | Required',
  ])
  assert.ok(result.paragraphs.every(paragraph => paragraph.page === 1))
  assert.equal(new Set(result.paragraphs.map(paragraph => paragraph.id)).size, 4)
  assert.ok(result.warnings.some(warning => /not original page numbers/.test(warning)))
})

test('legacy DOC extraction reads actual Unicode and textbox/footnote text without an Azure call', async () => {
  const result = await extractWordDocument(legacyDocFile('Zo\u00eb Example\nExperience\nApplied engineering methods.', {
    textboxes: 'Managed project delivery\r',
    footnotes: 'Professional certification\r',
  }), 'doc', {
    endpoint: 'https://must-not-be-called.example.test',
    getToken: async () => assert.fail('DOC text extraction must remain local.'),
  }, { defaultHeading: 'Resume', sectionHeadingPattern: /^Experience$/ })
  const text = result.paragraphs.map(paragraph => paragraph.text).join('\n')
  assert.match(text, /Zo\u00eb Example/)
  assert.match(text, /Managed project delivery/)
  assert.match(text, /Professional certification/)
  assert.equal(result.paragraphs.find(paragraph => paragraph.text === 'Applied engineering methods.').heading, 'Experience')
  assert.ok(result.paragraphs.every(paragraph => paragraph.page === 1))
})

test('Word extraction enforces the exact normalized character limit without truncation', async () => {
  const options = { endpoint: 'https://unused.example.test', getToken: async () => assert.fail('No network for DOC.') }
  const allowed = await extractWordDocument(legacyDocFile('x'.repeat(180_000)), 'doc', options, { defaultHeading: '' })
  assert.equal(allowed.paragraphs.reduce((sum, paragraph) => sum + paragraph.heading.length + paragraph.text.length, 0), 180_000)
  await assert.rejects(extractWordDocument(legacyDocFile('x'.repeat(180_001)), 'doc', options, { defaultHeading: '' }), {
    code: 'source-too-long',
  })
})

test('image-only and encrypted Word documents cannot become usable evidence', async () => {
  const bytes = docxFile('')
  await assert.rejects(extractWordDocument(bytes, 'docx', intelligence(bytes, {
    status: 'succeeded', analyzeResult: { pages: [{ pageNumber: 1 }], paragraphs: [] },
  })), { code: 'empty-source', message: /images.*PDF/ })
  await assert.rejects(extractWordDocument(legacyDocFile('protected', { encrypted: true }), 'doc', {
    endpoint: 'https://unused.example.test', getToken: async () => assert.fail('Do not submit protected files.'),
  }), { code: 'encrypted-word', retryable: false })
})
