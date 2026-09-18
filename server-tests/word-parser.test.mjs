import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { docxFile, legacyDocFile, zipWordParts } from './word-fixtures.mjs'

let output, parser
before(async () => {
  await mkdir('dist-server', { recursive: true })
  output = await mkdtemp(join(process.cwd(), 'dist-server', 'word-parser-test-'))
  await build({
    entryPoints: { word: 'server/documents/word.ts', 'word-parser': 'server/documents/word-parser-worker.ts' },
    outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  parser = await import(pathToFileURL(join(output, 'word.mjs')).href)
})
after(async () => { if (output) await rm(output, { recursive: true, force: true }) })

test('validates genuine DOCX packages and reads genuine binary DOC Unicode and separate stories', async () => {
  assert.deepEqual(await parser.parseWordFile(docxFile('Zo\u00eb Example\nEngineering experience'), 'docx'), {
    sections: [], containsImages: false,
  })
  const result = await parser.parseWordFile(legacyDocFile('Zo\u00eb Example\nEngineering experience \ud83c\udf0d', {
    footnotes: 'Professional certification\r',
    textboxes: 'Project delivery\r',
    endnotes: 'Additional credentials\r',
    headers: 'Professional contact header',
    footers: 'Professional contact footer',
    annotations: 'Reviewer-only annotation\r',
  }), 'doc')
  assert.match(result.sections[0].text, /Zo\u00eb Example\nEngineering experience/)
  assert.match(result.sections[0].text, /\ud83c\udf0d/)
  assert.match(result.sections.find(section => section.heading === 'Footnotes').text, /Professional certification/)
  assert.match(result.sections.find(section => section.heading === 'Text boxes').text, /Project delivery/)
  assert.match(result.sections.find(section => section.heading === 'Endnotes').text, /Additional credentials/)
  assert.match(result.sections.find(section => section.heading === 'Header').text, /Professional contact header/)
  assert.doesNotMatch(result.sections.find(section => section.heading === 'Header').text, /Professional contact footer/)
  assert.match(result.sections.find(section => section.heading === 'Footer').text, /Professional contact footer/)
  assert.doesNotMatch(result.sections.map(section => section.text).join('\n'), /Reviewer-only annotation/)
})

test('rejects renamed non-Word files, mismatches, encryption and macro-enabled packages', async () => {
  for (const [bytes, format] of [
    [Buffer.from('not a document'), 'docx'],
    [docxFile(), 'doc'],
    [legacyDocFile(), 'docx'],
    [zipWordParts({ 'sheet.xml': '<sheet/>' }), 'docx'],
    [docxFile('text', { mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml' }), 'docx'],
  ]) await assert.rejects(parser.parseWordFile(bytes, format), { code: 'invalid-word' })
  await assert.rejects(parser.parseWordFile(legacyDocFile('secret', { encrypted: true }), 'doc'), { code: 'encrypted-word' })
})

test('rejects XML entities and oversized expanded entries without trusting compressed size', async () => {
  await assert.rejects(parser.parseWordFile(docxFile('text', {
    documentXml: '<!DOCTYPE x [<!ENTITY leaked SYSTEM "file:///private">]><x>&leaked;</x>',
  }), 'docx'), { code: 'invalid-word' })
  const bomb = docxFile('text', { parts: { 'word/media/large.bin': Buffer.alloc(16 * 1024 * 1024 + 1) } })
  assert.ok(bomb.byteLength < 10 * 1024 * 1024)
  await assert.rejects(parser.parseWordFile(bomb, 'docx'), { code: 'word-expansion-limit' })
})

test('bounds legacy compound headers before parsing their declared sector tables', async () => {
  const corrupt = legacyDocFile()
  corrupt.writeUInt32LE(0x7fffffff, 0x2c)
  await assert.rejects(parser.parseWordFile(corrupt, 'doc'), { code: 'invalid-word' })
  await assert.rejects(parser.parseWordFile(legacyDocFile('Malformed Unicode \ud800'), 'doc'), { code: 'invalid-word' })
})

test('supports a full concurrent batch and removes cancelled queued parsing work', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => parser.parseWordFile(legacyDocFile(), 'doc')))
  assert.equal(results.length, 10)
  assert.ok(results.every(result => result.sections[0].text.includes('Jordan Example')))
  const controller = new AbortController()
  const running = [parser.parseWordFile(docxFile(), 'docx'), parser.parseWordFile(docxFile(), 'docx')]
  const cancelled = parser.parseWordFile(docxFile(), 'docx', controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { code: 'word-cancelled' })
  await Promise.all(running)
  assert.ok((await parser.parseWordFile(legacyDocFile(), 'doc')).sections.length)
})

test('enforces the exact upload-byte cap and cancellation', async () => {
  const base = docxFile('Readable text', { parts: { 'word/media/padding.bin': Buffer.alloc(1) }, compression: false })
  const exact = docxFile('Readable text', {
    parts: { 'word/media/padding.bin': Buffer.alloc(10 * 1024 * 1024 - base.byteLength + 1) }, compression: false,
  })
  assert.equal(exact.byteLength, 10 * 1024 * 1024)
  assert.equal((await parser.parseWordFile(exact, 'docx')).containsImages, true)
  await assert.rejects(parser.parseWordFile(Buffer.alloc(10 * 1024 * 1024 + 1), 'doc'), { code: 'word-too-large' })
  await assert.rejects(parser.parseWordFile(Buffer.alloc(0), 'docx'), { code: 'invalid-word' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(parser.parseWordFile(docxFile(), 'docx', controller.signal), { code: 'word-cancelled' })
})
