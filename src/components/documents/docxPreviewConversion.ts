// This module is imported only by the lazily created browser worker.
import mammoth from 'mammoth'
import { DOCX_PREVIEW_LIMITS, rasterImagePixels, validatePreviewArchive, type DocxPreviewResult } from './docxPreviewSafety'

export async function convertDocxPreview(buffer: ArrayBuffer): Promise<DocxPreviewResult> {
  await validatePreviewArchive(buffer)
  const warnings = new Set<string>()
  let imageCount = 0, imageBytes = 0, imagePixels = 0
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    includeDefaultStyleMap: true,
    convertImage: mammoth.images.imgElement(async (image) => {
      if (++imageCount > DOCX_PREVIEW_LIMITS.maxImages || imageBytes >= DOCX_PREVIEW_LIMITS.maxTotalImageBytes) {
        warnings.add('Some embedded images were omitted to keep the preview within its image limits.')
        return { src: '' }
      }
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(image.contentType)) {
        warnings.add('Only embedded PNG, JPEG and GIF images can be previewed. Linked images, SVG and other objects are omitted.')
        return { src: '' }
      }
      try {
        const bytes = new Uint8Array(await image.readAsArrayBuffer())
        const pixels = rasterImagePixels(bytes, image.contentType)
        if (bytes.byteLength > DOCX_PREVIEW_LIMITS.maxImageBytes || imageBytes + bytes.byteLength > DOCX_PREVIEW_LIMITS.maxTotalImageBytes
          || !pixels || imagePixels + pixels > DOCX_PREVIEW_LIMITS.maxTotalImagePixels) {
          warnings.add('An oversized or unsupported embedded image was omitted from this preview.')
          return { src: '' }
        }
        imageBytes += bytes.byteLength
        imagePixels += pixels
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        return { src: `data:${image.contentType};base64,${btoa(binary)}` }
      } catch {
        warnings.add('A linked or unreadable image was omitted. External resources are never fetched for the preview.')
        return { src: '' }
      }
    }),
  })
  if (result.value.length > DOCX_PREVIEW_LIMITS.maxHtmlCharacters) throw new Error('The formatted preview exceeds its safe display size. Use the extracted text or download the original.')
  if (!result.value.trim()) throw new Error('The converter did not produce readable formatted content. The extracted evidence remains available.')
  for (const message of result.messages.slice(0, 20)) warnings.add(message.message.slice(0, 400))
  return { html: result.value, warnings: [...warnings] }
}
