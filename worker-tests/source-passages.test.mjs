import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  SOURCE_PASSAGE_LIMITS, createSourcePassageCatalog, describeSourcePassageError, resolveSourceCitations,
  sourcePassageText,
} = await loadWorker('../worker/source-passages.ts')

function documentFixture(paragraphs) {
  return {
    id: 'source-doc-1',
    title: 'Source document',
    version: 3,
    kind: 'job',
    sample: false,
    paragraphs: paragraphs.map((paragraph, index) => ({
      id: `p${index + 1}`,
      page: index + 1,
      heading: `Heading ${index + 1}`,
      text: paragraph,
    })),
  }
}

function reconstructed(view, paragraphIndex) {
  return view.paragraphs[paragraphIndex].passages.map(passage => passage.text).join('')
}

function citableTexts(view) {
  return view.paragraphs.flatMap(paragraph =>
    paragraph.passages.filter(passage => passage.passageId !== null).map(passage => passage.text))
}

function thrownBy(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('Expected function to throw')
}

test('catalog view reconstructs varied source text losslessly and avoids abbreviation splits', () => {
  const paragraphs = [
    'The U.S. Census Bureau requires analysis. Use tools, e.g. SAS and R; explain assumptions. ' +
      'A Ph.D. researcher named J. Smith wrote "Done." Next sentence (complete.) Another.',
    '• First bullet\n• Second bullet\r\n• Third bullet; with clause. End.',
  ]
  const { catalog, view } = createSourcePassageCatalog(documentFixture(paragraphs))

  assert.equal(reconstructed(view, 0), paragraphs[0])
  assert.equal(reconstructed(view, 1), paragraphs[1])
  assert.ok(catalog.passages.length > 5)
  assert.ok(citableTexts(view).every(text => !text.endsWith('U.S. ')))
  assert.ok(citableTexts(view).every(text => !text.endsWith('e.g. ')))
  assert.ok(citableTexts(view).every(text => !text.endsWith('Ph.D. ')))
  assert.ok(citableTexts(view).every(text => !text.endsWith('J. ')))
  assert.ok(citableTexts(view).some(text => text.endsWith('Done." ')))
  assert.ok(citableTexts(view).some(text => text.endsWith('complete.) ')))
})

test('words that merely end like an abbreviation still end sentences', () => {
  const text = 'Works as a statistical analyst. Maintains survey systems. Plays piano. Leads the first test. Writes reports.'
  const { view } = createSourcePassageCatalog(documentFixture([text]))
  assert.deepEqual(citableTexts(view), [
    'Works as a statistical analyst. ', 'Maintains survey systems. ', 'Plays piano. ', 'Leads the first test. ', 'Writes reports.',
  ])
})

test('long paragraphs split below the limit and prefer clause or whitespace boundaries', () => {
  const clause = 'technical delivery capability, operational judgment, '
  const text = `${clause.repeat(70)}final requirement`
  assert.ok(text.length > 3600)
  const { catalog, view } = createSourcePassageCatalog(documentFixture([text]))

  assert.equal(reconstructed(view, 0), text)
  assert.ok(catalog.passages.length > 6)
  for (const passage of catalog.passages) {
    const slice = sourcePassageText(catalog, documentFixture([text]), passage.passageId)
    assert.ok(slice.length <= SOURCE_PASSAGE_LIMITS.maxPassageCharacters)
    if (passage.passageId < catalog.passages.length) assert.match(slice, /[,:\s]$/)
  }
})

test('surrogate pairs are never split across passage boundaries', () => {
  const text = `${'x'.repeat(SOURCE_PASSAGE_LIMITS.maxPassageCharacters - 1)}😀 ${'y'.repeat(40)}`
  const document = documentFixture([text])
  const { catalog, view } = createSourcePassageCatalog(document)

  assert.equal(reconstructed(view, 0), text)
  assert.ok(catalog.passages.length >= 2)
  for (const passage of catalog.passages) {
    const slice = sourcePassageText(catalog, document, passage.passageId)
    assert.ok(slice.length <= SOURCE_PASSAGE_LIMITS.maxPassageCharacters)
    assert.doesNotMatch(slice.at(0) ?? '', /[\uDC00-\uDFFF]/)
    assert.doesNotMatch(slice.at(-1) ?? '', /[\uD800-\uDBFF]/)
  }
})

test('whitespace-only slices are kept as null and IDs are deterministic and sequential across paragraphs', () => {
  const document = documentFixture(['\nFirst sentence. Second sentence.', 'Third sentence.'])
  const first = createSourcePassageCatalog(document)
  const second = createSourcePassageCatalog(document)

  assert.deepEqual(first.catalog, second.catalog)
  assert.equal(first.view.paragraphs[0].passages[0].passageId, null)
  assert.equal(first.view.paragraphs[0].passages[0].text, '\n')
  assert.deepEqual(first.catalog.passages.map(passage => passage.passageId), [1, 2, 3])
  assert.deepEqual(first.catalog.passages.map(passage => passage.paragraphId), ['p1', 'p1', 'p2'])
})

test('citation resolution orders, merges adjacent passages, trims quotes, and copies document metadata', () => {
  const document = documentFixture(['  First requirement. Second requirement. Third requirement.  ', 'Other paragraph. Last sentence.'])
  const { catalog } = createSourcePassageCatalog(document)

  const merged = resolveSourceCitations(catalog, document, [2, 1])
  assert.deepEqual(merged, [{
    documentId: document.id,
    documentVersion: document.version,
    paragraphId: 'p1',
    page: 1,
    heading: 'Heading 1',
    quote: 'First requirement. Second requirement.',
  }])

  const separated = resolveSourceCitations(catalog, document, [4, 1, 3])
  assert.deepEqual(separated.map(citation => citation.quote), ['First requirement.', 'Third requirement.', 'Other paragraph.'])
  assert.deepEqual(separated.map(citation => citation.paragraphId), ['p1', 'p1', 'p2'])
})

test('citation resolution keeps only exact non-empty paragraph substrings', () => {
  const document = documentFixture([
    'Alpha sentence. Beta sentence; clause continues. Gamma sentence.',
    'Delta sentence with metadata.',
  ])
  const { catalog } = createSourcePassageCatalog(document)

  const citations = resolveSourceCitations(catalog, document, catalog.passages.map(passage => passage.passageId))
  for (const citation of citations) {
    const paragraph = document.paragraphs.find(item => item.id === citation.paragraphId)
    assert.ok(citation.quote)
    assert.ok(paragraph.text.includes(citation.quote))
  }
})

test('binding and passage selection errors are reported with correction-friendly codes', () => {
  const document = documentFixture(['First requirement. Second requirement.'])
  const { catalog } = createSourcePassageCatalog(document)

  assert.equal(describeSourcePassageError(thrownBy(
    () => resolveSourceCitations(catalog, document, []),
  )).code, 'empty')
  assert.equal(describeSourcePassageError(thrownBy(
    () => resolveSourceCitations(catalog, document, [1, 1]),
  )).code, 'duplicate-passage')
  const unknown = describeSourcePassageError(thrownBy(
    () => resolveSourceCitations(catalog, document, [99]),
  ))
  assert.equal(unknown.code, 'unknown-passage')
  assert.match(unknown.message, /Passage 99 does not exist/)

  const changed = { ...document, paragraphs: [{ ...document.paragraphs[0], text: 'Changed text.' }] }
  assert.equal(describeSourcePassageError(thrownBy(
    () => resolveSourceCitations(catalog, changed, [1]),
  )).code, 'binding')
})
