import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMarkdown } from '../dist-worker/runtime.mjs'

test('Markdown preserves ordered evidence, headings, short skills, tables, links, and code without HTML rendering', () => {
  const bytes = Buffer.from([
    '# Zo\u00eb &amp; Kai',
    '',
    'Senior **engineer** using `C++` and R.',
    '',
    '## Experience',
    '',
    '- Built accessible tools.',
    '  - Led **delivery** reviews.',
    '- [x] Published results.',
    '',
    '| Skill | Evidence |',
    '| --- | --- |',
    '| C# | Five years |',
    '| R | Two years |',
    '',
    '> Communicated findings.',
    '',
    '[Portfolio](https://example.test/work) and <jordan@example.test>.',
    '',
    '![Project illustration](https://example.test/image.png)',
    '',
    '```text',
    'a < b && c > d &amp;',
    '```',
    '',
    '<script>globalThis.__markdownExecuted = true</script>',
  ].join('\n'))
  globalThis.__markdownExecuted = false
  const result = extractMarkdown(bytes)
  assert.equal(result.title, 'Zo\u00eb & Kai')
  assert.deepEqual(result.paragraphs.map(paragraph => paragraph.text), [
    'Zo\u00eb & Kai',
    'Senior engineer using C++ and R.',
    'Experience',
    '- Built accessible tools.',
    '- Led delivery reviews.',
    '- [x] Published results.',
    'Skill | Evidence\nC# | Five years\nR | Two years',
    'Communicated findings.',
    'Portfolio (https://example.test/work) and jordan@example.test.',
    'Project illustration',
    'a < b && c > d &amp;',
    '<script>globalThis.__markdownExecuted = true</script>',
  ])
  assert.equal(result.paragraphs[0].heading, 'Zo\u00eb & Kai')
  assert.equal(result.paragraphs[3].heading, 'Experience')
  assert.deepEqual(result.paragraphs.map(paragraph => paragraph.id), result.paragraphs.map((_, index) => `p-${String(index + 1).padStart(4, '0')}`))
  assert.deepEqual(extractMarkdown(bytes), result)
  assert.equal(globalThis.__markdownExecuted, false)
  delete globalThis.__markdownExecuted
})

test('Markdown handles UTF-8 BOM, Unicode, CRLF, setext headings, front matter as text, and more than fifty sections', () => {
  const text = '\ufeff---\r\nname: Zo\u00eb\r\n---\r\n\r\nR\r\n=\r\n\r\nC\r\n\r\n' +
    Array.from({ length: 60 }, (_, index) => `## Skill ${index}\r\n\r\nEvidence ${index}`).join('\r\n\r\n')
  const extracted = extractMarkdown(Buffer.from(text))
  assert.equal(extracted.title, 'R')
  assert.ok(extracted.paragraphs.some(paragraph => paragraph.text === 'name: Zo\u00eb'))
  assert.ok(extracted.paragraphs.some(paragraph => paragraph.text === 'C'))
  assert.ok(extracted.paragraphs.some(paragraph => paragraph.text === 'Evidence 59'))
  assert.ok(extracted.paragraphs.every(paragraph => paragraph.page === 1))
})

test('Markdown enforces exact byte and normalized-text limits without truncation', () => {
  const maximum = 10 * 1024 * 1024
  const exact = Buffer.alloc(maximum, 32)
  exact.write('# A')
  assert.equal(extractMarkdown(exact).title, 'A')
  assert.throws(() => extractMarkdown(Buffer.concat([exact, Buffer.from(' ')])), { code: 'markdown-too-large', retryable: false })
  const options = { defaultHeading: 'Source' }
  const source = Buffer.from('a'.repeat(180_000 - 'Source'.length))
  const result = extractMarkdown(source, options)
  assert.equal(result.paragraphs.reduce((count, paragraph) => count + paragraph.text.length + paragraph.heading.length, 0), 180_000)
  assert.throws(() => extractMarkdown(Buffer.concat([source, Buffer.from('a')]), options), { code: 'source-too-long', retryable: false })
})

test('Markdown rejects empty, invalid UTF-8, binary, and unreadable sources with explicit non-retryable errors', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from(' \t\r\n'), Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    Buffer.from([0xc3, 0x28]), Buffer.from('Text\0binary'), Buffer.from('Text\u001bcontrol'), Buffer.from('%PDF-1.7')]) {
    assert.throws(() => extractMarkdown(bytes), { code: 'invalid-markdown', retryable: false })
  }
  assert.throws(() => extractMarkdown(Buffer.from('---\n\n***')), { code: 'empty-source', retryable: false })
})
