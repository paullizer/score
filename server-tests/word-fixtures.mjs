import * as CFB from 'cfb'

const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
export const wordFixtureText = 'Jordan Example\nEngineering specialist\nExperience\nApplied engineering methods and led delivery of public infrastructure projects.\nEducation\nBachelor of Engineering'

export function escapeWordXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function zipWordParts(parts, { compression = true } = {}) {
  const container = CFB.utils.cfb_new()
  for (const [name, content] of Object.entries(parts)) CFB.utils.cfb_add(container, name, Buffer.from(content))
  return Buffer.from(CFB.write(container, { type: 'buffer', fileType: 'zip', compression }))
}

export function docxFile(text = wordFixtureText, options = {}) {
  const paragraphs = text.split(/\r?\n/).map((line, index) =>
    `<w:p>${index === 0 ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r><w:t xml:space="preserve">${escapeWordXml(line)}</w:t></w:r></w:p>`).join('')
  const table = options.table ? `<w:tbl>${options.table.map(row => `<w:tr>${row.map(cell =>
    `<w:tc><w:p><w:r><w:t>${escapeWordXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : ''
  return zipWordParts({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${options.mainType ?? mainType}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageNs}"><Relationship Id="document" Type="${relationshipNs}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': options.documentXml ?? `<w:document xmlns:w="${wordNs}" xmlns:r="${relationshipNs}"><w:body>${paragraphs}${table}<w:sectPr/></w:body></w:document>`,
    'word/styles.xml': `<w:styles xmlns:w="${wordNs}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${packageNs}"><Relationship Id="styles" Type="${relationshipNs}/styles" Target="styles.xml"/></Relationships>`,
    ...options.parts,
  }, { compression: options.compression ?? true })
}

export function legacyDocFile(text = wordFixtureText, options = {}) {
  const headerStories = options.headers || options.footers
    ? ['\r', '\r', '\r', '\r', '\r', '\r', `${options.headers ?? ''}\r`, '\r', `${options.footers ?? ''}\r`, '\r', '\r', '\r']
    : []
  const stories = [
    text.replace(/\r?\n/g, '\r') + '\r',
    options.footnotes ?? '',
    headerStories.join(''),
    options.annotations ?? '',
    options.endnotes ?? '',
    options.textboxes ?? '',
    '',
  ]
  const body = Buffer.from(stories.join(''), 'utf16le')
  const textOffset = 1024
  const main = Buffer.alloc(textOffset + body.byteLength)
  main.writeUInt16LE(0xa5ec, 0)
  main.writeUInt16LE(0x00c1, 2)
  main.writeUInt16LE(options.encrypted ? 0x0304 : 0x0204, 0x0a)
  main.writeUInt16LE(0x00bf, 0x0c)
  main.writeUInt32LE(textOffset, 0x18)
  main.writeUInt32LE(main.byteLength, 0x1c)
  main.writeUInt16LE(14, 0x20)
  main.writeUInt16LE(22, 0x3e)
  main.writeUInt32LE(main.byteLength, 0x40)
  for (const [index, offset] of [0x4c, 0x50, 0x54, 0x5c, 0x60, 0x64, 0x68].entries()) {
    main.writeUInt32LE(stories[index].length, offset)
  }
  main.writeUInt16LE(93, 0x98)
  main.writeUInt32LE(0, 0x1a2)
  main.writeUInt32LE(21, 0x1a6)
  body.copy(main, textOffset)

  // A single uncompressed Unicode piece in the Word 97 CLX/Pcdt table.
  const table = Buffer.alloc(21 + (headerStories.length ? (headerStories.length + 1) * 4 : 0))
  table[0] = 2
  table.writeUInt32LE(16, 1)
  table.writeUInt32LE(stories.reduce((sum, story) => sum + story.length, 0), 9)
  table.writeUInt32LE(textOffset, 15)
  if (headerStories.length) {
    main.writeUInt32LE(21, 0xf2)
    main.writeUInt32LE((headerStories.length + 1) * 4, 0xf6)
    let position = 0
    headerStories.forEach((story, index) => {
      position += story.length
      table.writeUInt32LE(position, 21 + (index + 1) * 4)
    })
  }
  const container = CFB.utils.cfb_new()
  CFB.utils.cfb_add(container, 'WordDocument', main)
  CFB.utils.cfb_add(container, '1Table', table)
  return Buffer.from(CFB.write(container, { type: 'buffer', fileType: 'cfb' }))
}
