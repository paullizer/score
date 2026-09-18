import { parentPort, workerData } from 'node:worker_threads'
import * as CFB from 'cfb'
import { SaxesParser } from 'saxes'
import WordExtractor from 'word-extractor'
import { fromBufferPromise } from 'yauzl'
import { z } from 'zod'
import { WORD_DOCUMENT_LIMITS as LIMITS } from '../../src/domain/document-formats'
import { hasOleSignature, hasZipSignature, WordDocumentError, type WordParserResult } from './word-contract'

const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const WORD_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

function xmlText(bytes: Buffer): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

function validateXml(name: string, bytes: Buffer): void {
  const parser = new SaxesParser({ xmlns: true })
  let rootSeen = false
  let wordMain = false
  parser.on('doctype', () => { throw new WordDocumentError('invalid-word') })
  parser.on('opentag', tag => {
    if (!rootSeen) {
      rootSeen = true
      if (name === 'word/document.xml' && (tag.local !== 'document' || !WORD_NAMESPACES.has(tag.uri))) {
        throw new WordDocumentError('invalid-word')
      }
      if (name === '[Content_Types].xml' && (tag.local !== 'Types' || tag.uri !== CONTENT_TYPES_NAMESPACE)) {
        throw new WordDocumentError('invalid-word')
      }
    }
    if (name === '[Content_Types].xml' && tag.local === 'Override' && tag.uri === CONTENT_TYPES_NAMESPACE &&
      tag.attributes.PartName?.value === '/word/document.xml') {
      if (tag.attributes.ContentType?.value !== WORD_MAIN_TYPE) throw new WordDocumentError('invalid-word')
      wordMain = true
    }
  })
  parser.write(xmlText(bytes)).close()
  if (!rootSeen || (name === '[Content_Types].xml' && !wordMain)) throw new WordDocumentError('invalid-word')
}

function oleContainer(bytes: Buffer): CFB.CFB$Container {
  if (!hasOleSignature(bytes) || bytes.byteLength < 512) throw new WordDocumentError('invalid-word')
  const major = bytes.readUInt16LE(0x1a)
  const shift = bytes.readUInt16LE(0x1e)
  if (bytes.readUInt16LE(0x1c) !== 0xfffe || bytes.readUInt16LE(0x20) !== 6 ||
    !((major === 3 && shift === 9) || (major === 4 && shift === 12))) throw new WordDocumentError('invalid-word')
  const sectorSize = 2 ** shift
  const sectors = bytes.byteLength / sectorSize - 1
  if (!Number.isInteger(sectors) || sectors < 1 || bytes.readUInt32LE(0x30) >= sectors ||
    bytes.readUInt32LE(0x38) !== 4096) throw new WordDocumentError('invalid-word')
  for (const offset of [0x28, 0x2c, 0x40, 0x48]) {
    if (bytes.readUInt32LE(offset) > sectors) throw new WordDocumentError('invalid-word')
  }
  for (const [pointer, count] of [[0x3c, 0x40], [0x44, 0x48]]) {
    if (bytes.readUInt32LE(count) && bytes.readUInt32LE(pointer) >= sectors) throw new WordDocumentError('invalid-word')
  }
  const container = CFB.read(bytes, { type: 'buffer' })
  if (container.FileIndex.length > LIMITS.maxEntries ||
    container.FileIndex.reduce((total, entry) => total + (entry.type === 2 ? entry.size : 0), 0) > LIMITS.maxExpandedBytes) {
    throw new WordDocumentError('word-expansion-limit')
  }
  if (CFB.find(container, 'EncryptedPackage') || CFB.find(container, 'EncryptionInfo')) {
    throw new WordDocumentError('encrypted-word')
  }
  return container
}

async function validateDocx(bytes: Buffer): Promise<WordParserResult> {
  if (hasOleSignature(bytes)) {
    oleContainer(bytes)
    throw new WordDocumentError('invalid-word')
  }
  if (!hasZipSignature(bytes)) throw new WordDocumentError('invalid-word')
  const archive = await fromBufferPromise(bytes, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  })
  const names = new Set<string>()
  let expanded = 0
  let containsImages = false
  try {
    if (archive.entryCount > LIMITS.maxEntries) throw new WordDocumentError('word-expansion-limit')
    for await (const entry of archive.eachEntry()) {
      if (names.has(entry.fileName) || (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) {
        throw new WordDocumentError('invalid-word')
      }
      names.add(entry.fileName)
      if (names.size > LIMITS.maxEntries || entry.uncompressedSize > LIMITS.maxEntryBytes ||
        expanded + entry.uncompressedSize > LIMITS.maxExpandedBytes) throw new WordDocumentError('word-expansion-limit')
      if (entry.isEncrypted()) throw new WordDocumentError('encrypted-word')
      if (!entry.canDecodeFileData() || /(?:^|\/)vbaProject\.bin$/i.test(entry.fileName)) {
        throw new WordDocumentError('invalid-word')
      }
      const xml = entry.fileName.endsWith('.xml') || entry.fileName.endsWith('.rels')
      const chunks: Buffer[] = []
      let size = 0
      const stream = await archive.openReadStreamPromise(entry)
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.byteLength
        expanded += buffer.byteLength
        if (size > LIMITS.maxEntryBytes || expanded > LIMITS.maxExpandedBytes) {
          stream.destroy()
          throw new WordDocumentError('word-expansion-limit')
        }
        if (xml) chunks.push(buffer)
      }
      if (size !== entry.uncompressedSize) throw new WordDocumentError('invalid-word')
      if (xml) validateXml(entry.fileName, Buffer.concat(chunks, size))
      if (entry.fileName.startsWith('word/media/')) containsImages = true
    }
    if (!names.has('[Content_Types].xml') || !names.has('word/document.xml') || !names.has('_rels/.rels')) {
      throw new WordDocumentError('invalid-word')
    }
    return { sections: [], containsImages }
  } finally {
    archive.close()
  }
}

async function extractDoc(bytes: Buffer): Promise<WordParserResult> {
  const container = oleContainer(bytes)
  const main = CFB.find(container, 'WordDocument')
  if (!main || main.type !== 2 || main.size < 0x1aa) throw new WordDocumentError('invalid-word')
  const fib = Buffer.from(main.content)
  if (fib.readUInt16LE(0) !== 0xa5ec || fib.readUInt16LE(2) < 0xc1) throw new WordDocumentError('invalid-word')
  const flags = fib.readUInt16LE(0x0a)
  if (flags & 0x8100) throw new WordDocumentError('encrypted-word')
  if (fib.readUInt32LE(0x18) > fib.length || fib.readUInt32LE(0x1c) > fib.length) throw new WordDocumentError('invalid-word')
  if (!CFB.find(container, flags & 0x0200 ? '1Table' : '0Table')) throw new WordDocumentError('invalid-word')
  const document = await new WordExtractor().extract(bytes)
  const sections = [
    { heading: '', text: document.getBody() },
    { heading: 'Header', text: document.getHeaders({ includeFooters: false }) },
    { heading: 'Footer', text: document.getFooters() },
    { heading: 'Text boxes', text: document.getTextboxes() },
    { heading: 'Footnotes', text: document.getFootnotes() },
    { heading: 'Endnotes', text: document.getEndnotes() },
  ]
  if (sections.some(section => /\p{Surrogate}/u.test(section.text))) throw new WordDocumentError('invalid-word')
  return {
    sections,
    containsImages: Boolean(CFB.find(container, 'Data')),
  }
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error('The Word parser requires its worker transport.')
  try {
    const input = z.strictObject({ format: z.enum(['docx', 'doc']), bytes: z.instanceof(Uint8Array) }).parse(workerData)
    if (!input.bytes.byteLength) throw new WordDocumentError('invalid-word')
    if (input.bytes.byteLength > LIMITS.maxFileBytes) throw new WordDocumentError('word-too-large')
    const bytes = Buffer.from(input.bytes)
    const result = input.format === 'docx' ? await validateDocx(bytes) : await extractDoc(bytes)
    parentPort.postMessage({ ok: true, result })
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error instanceof WordDocumentError ? error.code : 'invalid-word' })
  }
}

void main()
