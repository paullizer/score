import assert from 'node:assert/strict'
import test from 'node:test'
import { documentIntelligenceParagraphs } from '../dist-worker/runtime.mjs'

const fact = 'Completed a course exercise comparing two statistical estimators using an instructor-provided dataset.'
function fixture() {
  const span = { offset: 40, length: fact.length }
  return {
    status: 'succeeded',
    analyzeResult: {
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
      paragraphs: [
        { role: 'title', content: 'Simulated profile', spans: [{ offset: 0, length: 17 }], boundingRegions: [{ pageNumber: 1 }] },
        { content: fact, spans: [span], boundingRegions: [{ pageNumber: 1 }] },
        { content: fact, spans: [{ ...span, offset: 200 }], boundingRegions: [{ pageNumber: 1 }] },
      ],
      tables: [{
        spans: [span], boundingRegions: [{ pageNumber: 1 }],
        cells: [{ rowIndex: 0, columnIndex: 0, content: fact, spans: [span], boundingRegions: [{ pageNumber: 1 }] }],
      }],
    },
  }
}
const options = { defaultHeading: 'Resume', minimumTextLength: 1, tableParagraphPolicy: 'span-bound' }

test('span-bound candidate removes only the exact cell representation and preserves repeated source text at a different offset', () => {
  const raw = fixture(), original = structuredClone(raw)
  const preserved = documentIntelligenceParagraphs(raw, { ...options, tableParagraphPolicy: 'preserve' })
  const legacy = documentIntelligenceParagraphs(raw, { defaultHeading: 'Resume', minimumTextLength: 1 })
  assert.deepEqual(legacy, preserved)
  assert.equal(preserved.filter(paragraph => paragraph.text === fact).length, 3)
  const corrected = documentIntelligenceParagraphs(raw, options)
  assert.equal(corrected.filter(paragraph => paragraph.text === fact).length, 2)
  assert.equal(corrected.length, 3)
  assert.ok(corrected[1].heading.endsWith(' - table'))
  assert.equal(corrected[2].text, fact)
  assert.deepEqual(raw, original)
})

test('matching text without complete identical valid spans never removes a paragraph', () => {
  for (const spans of [undefined, [], [{ offset: 40 }], [{ offset: -1, length: fact.length }],
    [{ offset: 40, length: 0 }], [{ offset: 41, length: fact.length }],
    [{ offset: 40.5, length: fact.length }], [{ offset: 40, length: fact.length - 1 }]]) {
    const raw = fixture()
    raw.analyzeResult.tables[0].cells[0].spans = spans
    assert.equal(documentIntelligenceParagraphs(raw, options).filter(paragraph => paragraph.text === fact).length, 3)
  }
  const raw = fixture()
  raw.analyzeResult.tables[0].cells[0].content = `Different ${fact}`
  assert.equal(documentIntelligenceParagraphs(raw, options).length, 4)
})

test('physical PDF page binding prevents same-text/same-offset cells on another page from suppressing evidence', () => {
  const raw = fixture()
  raw.analyzeResult.paragraphs[1].boundingRegions = [{ pageNumber: 2 }]
  const result = documentIntelligenceParagraphs(raw, { ...options, requirePageNumbers: true })
  assert.equal(result.filter(paragraph => paragraph.text === fact).length, 3)
  assert.equal(result.filter(paragraph => paragraph.page === 2).length, 1)
  raw.analyzeResult.paragraphs[1].boundingRegions = [{ pageNumber: 3 }]
  assert.throws(() => documentIntelligenceParagraphs(raw, { ...options, requirePageNumbers: true }),
    { code: 'ocr-invalid-page' })
})

test('normalization and captured DOCX sections retain one literal table fact without inferring physical pages', () => {
  const raw = fixture()
  raw.analyzeResult.tables[0].cells[0].content = `  ${fact}  `
  raw.analyzeResult.tables[0].boundingRegions = [{ pageNumber: 80 }]
  raw.analyzeResult.tables[0].cells[0].boundingRegions = [{ pageNumber: 80 }]
  const result = documentIntelligenceParagraphs(raw, { ...options, capturedSections: true })
  assert.equal(result.length, 3)
  assert.ok(result.every(paragraph => paragraph.page === 1))
  assert.equal(result.filter(paragraph => paragraph.text === fact).length, 2)
})

test('multiple source spans must agree exactly, and overwritten table cells cannot hide the prior paragraph', () => {
  const raw = fixture()
  const spans = [{ offset: 40, length: 50 }, { offset: 100, length: fact.length - 50 }]
  raw.analyzeResult.paragraphs[1].spans = spans
  raw.analyzeResult.tables[0].cells[0].spans = structuredClone(spans)
  assert.equal(documentIntelligenceParagraphs(raw, options).length, 3)
  raw.analyzeResult.tables[0].cells[0].spans.reverse()
  assert.equal(documentIntelligenceParagraphs(raw, options).length, 4)
  const replaced = fixture()
  replaced.analyzeResult.tables[0].cells.push({
    rowIndex: 0, columnIndex: 0, content: 'Another cell replaced the former content.',
    spans: [{ offset: 300, length: 40 }], boundingRegions: [{ pageNumber: 1 }],
  })
  const result = documentIntelligenceParagraphs(replaced, options)
  assert.equal(result.filter(paragraph => paragraph.text === fact).length, 2)
  assert.ok(result.some(paragraph => paragraph.text === 'Another cell replaced the former content.'))
})
