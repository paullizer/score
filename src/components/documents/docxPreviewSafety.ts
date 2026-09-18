import { WORD_DOCUMENT_LIMITS } from '../../domain/document-formats'

export const DOCX_PREVIEW_LIMITS = {
  ...WORD_DOCUMENT_LIMITS,
  maxImages: 24,
  maxImageBytes: 1024 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxTotalImagePixels: 24_000_000,
  maxHtmlCharacters: 8 * 1024 * 1024,
} as const

export interface DocxPreviewResult {
  html: string
  warnings: string[]
}

export function rasterImagePixels(bytes: Uint8Array, contentType: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0, frames = 1
  if (contentType === 'image/png' && bytes.length >= 24
    && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16)
    height = view.getUint32(20)
    let offset = 8, complete = false
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset)
      if (offset + length + 12 > bytes.length) return 0
      const type = view.getUint32(offset + 4)
      if (type === 0x6163544c) {
        if (length !== 8) return 0
        frames = view.getUint32(offset + 8)
      }
      offset += length + 12
      if (type === 0x49454e44) { complete = true; break }
    }
    if (!complete) return 0
  } else if (contentType === 'image/gif' && bytes.length >= 13
    && (String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF87a' || String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a')) {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
    let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0)
    let pixels = 0
    const skipBlocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++]
        if (!length) return true
        offset += length
      }
      return false
    }
    while (offset < bytes.length) {
      const marker = bytes[offset++]
      if (marker === 0x3b) return pixels > 0 && pixels <= DOCX_PREVIEW_LIMITS.maxImagePixels ? pixels : 0
      if (marker === 0x21) { offset++; if (!skipBlocks()) return 0; continue }
      if (marker !== 0x2c || offset + 9 > bytes.length) return 0
      const framePixels = view.getUint16(offset + 4, true) * view.getUint16(offset + 6, true)
      pixels += Math.max(width * height, framePixels)
      if (!framePixels || pixels > DOCX_PREVIEW_LIMITS.maxImagePixels) return 0
      const packed = bytes[offset + 8]
      offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0) + 1
      if (!skipBlocks()) return 0
    }
    return 0
  } else if (contentType === 'image/jpeg' && bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return 0
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) return 0
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
        break
      }
      offset += length
    }
  }
  const pixels = width * height * frames
  return width > 0 && height > 0 && frames > 0 && pixels <= DOCX_PREVIEW_LIMITS.maxImagePixels ? pixels : 0
}

// Check actual expansion before handing the archive to Mammoth's ZIP/XML parsers.
export async function validatePreviewArchive(buffer: ArrayBuffer): Promise<void> {
  const limits = DOCX_PREVIEW_LIMITS
  if (buffer.byteLength > limits.maxFileBytes || buffer.byteLength < 22) throw new Error('The DOCX archive is empty, corrupt, or too large to preview.')
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let end = bytes.length - 22
  const minimum = Math.max(0, end - 0xffff)
  while (end >= minimum && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length)) end--
  if (end < minimum) throw new Error('The DOCX archive directory is missing or corrupt.')
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryStart = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count
    || !count || count > limits.maxEntries || directoryStart + directorySize !== end) {
    throw new Error('This DOCX archive exceeds preview limits or uses an unsupported ZIP layout.')
  }
  let offset = directoryStart
  let expanded = 0
  const names = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The DOCX archive directory is corrupt.')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const expandedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const entryEnd = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    if (entryEnd > end || flags & 1 || ![0, 8].includes(method) || expandedSize > limits.maxEntryBytes
      || compressedSize > limits.maxFileBytes || local + 30 > directoryStart || view.getUint32(local, true) !== 0x04034b50
      || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) & 1) {
      throw new Error('An encrypted, corrupt, or oversized DOCX entry cannot be previewed.')
    }
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (!name || name.includes('\\') || name.includes('\0') || name.split('/').includes('..') || name.startsWith('/') || names.has(name)) {
      throw new Error('The DOCX archive contains an unsafe or duplicate entry.')
    }
    names.add(name)
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (dataStart + compressedSize > directoryStart || expanded + expandedSize > limits.maxExpandedBytes) {
      throw new Error('This DOCX archive exceeds the expanded preview size limit.')
    }
    let actualSize = 0
    if (method === 0) {
      actualSize = compressedSize
    } else {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot safely expand DOCX previews. Download the original or use the extracted text.')
      const reader = new Blob([buffer.slice(dataStart, dataStart + compressedSize)]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw')).getReader()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          actualSize += part.value.byteLength
          if (actualSize > expandedSize || actualSize > limits.maxEntryBytes || expanded + actualSize > limits.maxExpandedBytes) {
            throw new Error('This DOCX archive exceeds the actual expanded preview size limit.')
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    }
    if (actualSize !== expandedSize) throw new Error('The DOCX archive entry size does not match its contents.')
    expanded += actualSize
    offset = entryEnd
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) throw new Error('This file is not a supported Word DOCX document.')
}
