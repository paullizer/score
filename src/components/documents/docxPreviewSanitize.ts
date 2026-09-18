import createDOMPurify from 'dompurify'
import { DOCX_PREVIEW_LIMITS, rasterImagePixels } from './docxPreviewSafety'

const previewCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'"
const previewStyles = `
  :root { color-scheme: light dark; --cp-surface: #ffffff; --cp-text: #252a32; --cp-border: #dfe3e8; --cp-text-muted: #566171; }
  @media (prefers-color-scheme: dark) { :root { --cp-surface: #1c2028; --cp-text: #f0f2f6; --cp-border: #3a414e; --cp-text-muted: #bac2ce; } }
  * { box-sizing: border-box; } body { margin: 0; padding: 28px; background: var(--cp-surface); color: var(--cp-text); font: 14px/1.7 system-ui, sans-serif; overflow-wrap: anywhere; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1.2em 0 .5em; } h1 { font-size: 26px; } h2 { font-size: 22px; } h3 { font-size: 18px; }
  p { margin: .7em 0; } ul,ol { padding-inline-start: 1.8em; } table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  td,th { border: 1px solid var(--cp-border); padding: 6px 10px; vertical-align: top; } th { text-align: start; } img { max-width: 100%; height: auto; }
  blockquote { border-inline-start: 3px solid var(--cp-border); margin-inline: 0; padding-inline-start: 1em; color: var(--cp-text-muted); }
  pre { white-space: pre-wrap; } hr { border: 0; border-top: 1px solid var(--cp-border); }
`

export function sanitizeDocxPreview(html: string): { srcDoc: string; warnings: string[] } {
  if (html.length > DOCX_PREVIEW_LIMITS.maxHtmlCharacters) throw new Error('The converted preview is too large to display safely.')
  const purifier = createDOMPurify(window)
  const fragment = purifier.sanitize(html, {
    // The parsing wrapper is not returned in the fragment and must not create a false removal warning.
    ALLOWED_TAGS: ['body', 'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup',
      'br', 'hr', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'pre', 'code', 'img'],
    ALLOWED_ATTR: ['src', 'alt', 'colspan', 'rowspan', 'start', 'value'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|gif);base64,[a-z\d+/]+=*$/i,
    FORBID_TAGS: ['script', 'style', 'svg', 'math', 'form', 'input', 'button', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset', 'href', 'xlink:href', 'target', 'id', 'name'],
    RETURN_DOM_FRAGMENT: true,
  })
  const warnings = new Set<string>()
  if (purifier.removed.length) warnings.add('Links, active content and unsupported formatting or resources have been removed from the preview.')
  let count = 0, total = 0, totalPixels = 0
  for (const image of fragment.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    const match = /^data:(image\/(?:png|jpeg|gif));base64,([a-z\d+/]+=*)$/i.exec(src)
    let safe = false
    if (match && ++count <= DOCX_PREVIEW_LIMITS.maxImages && match[2].length <= Math.ceil(DOCX_PREVIEW_LIMITS.maxImageBytes / 3) * 4) {
      try {
        const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
        const pixels = rasterImagePixels(bytes, match[1].toLowerCase())
        total += bytes.byteLength
        totalPixels += pixels
        safe = bytes.byteLength <= DOCX_PREVIEW_LIMITS.maxImageBytes && total <= DOCX_PREVIEW_LIMITS.maxTotalImageBytes
          && pixels > 0 && totalPixels <= DOCX_PREVIEW_LIMITS.maxTotalImagePixels
      } catch { /* Malformed data URLs are removed, never repaired into remote URLs. */ }
    }
    if (!safe) { image.remove(); warnings.add('An unsafe, linked, unsupported or oversized image was omitted.') }
  }
  for (const element of fragment.querySelectorAll('[colspan],[rowspan],[start],[value]')) {
    for (const attribute of ['colspan', 'rowspan', 'start', 'value']) {
      const value = element.getAttribute(attribute)
      if (value !== null && (!/^\d{1,4}$/.test(value) || Number(value) > 1000)) element.removeAttribute(attribute)
    }
  }
  if (!fragment.textContent?.trim() && !fragment.querySelector('img')) throw new Error('The formatted conversion contained no safely displayable content. The extracted evidence is still available.')
  const container = document.createElement('div')
  container.append(fragment)
  return {
    srcDoc: `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approximate Word preview</title><style>${previewStyles}</style></head><body>${container.innerHTML}</body></html>`,
    warnings: [...warnings],
  }
}
