export const srcDocAllowed = [
  {
    file: 'src/components/documents/DocxPreview.tsx',
    reason: 'DOCX previews are sanitized by src/components/documents/docxPreviewSanitize.ts and rendered in an empty sandbox iframe.',
  },
]

export const moduleAllowlist = [
  {
    file: 'src/components/documents/docxPreviewSanitize.ts',
    module: 'dompurify',
    rules: ['xss/markup-renderer-import'],
    reason: 'The DOCX preview sanitizer is the only browser-side DOMPurify boundary and removes active content before srcDoc rendering.',
  },
  {
    file: 'src/components/documents/docxPreviewConversion.ts',
    module: 'mammoth',
    rules: ['xss/markup-renderer-import'],
    reason: 'The private DOCX preview worker converts Word content to HTML only for the sanitizer in docxPreviewSanitize.ts.',
  },
]

export const safeUrlBuilders = [
  { name: 'authLoginUrl', reason: 'Builds a same-origin Easy Auth login path from a separately validated redirect path.' },
  { name: 'authLogoutUrl', reason: 'Builds a same-origin Easy Auth logout path from a separately validated redirect path.' },
  { name: 'privateOriginalUrl', reason: 'Accepts only same-origin private original endpoints for the current workspace.' },
  { name: 'realJobOriginalUrl', reason: 'Builds same-origin API routes for authorized job originals.' },
  { name: 'realResumeOriginalUrl', reason: 'Builds same-origin API routes for authorized resume originals.' },
  { name: 'gradeSourceOriginalUrl', reason: 'Builds same-origin API routes for authorized grade-reference originals.' },
  { name: 'URL.createObjectURL', reason: 'Creates browser blob URLs for locally generated downloads, not scriptable navigation input.' },
]

export const sanitizerSensitiveFiles = [
  {
    file: 'src/components/documents/docxPreviewSanitize.ts',
    reason: 'DOCX preview sanitization changes alter the XSS boundary; run src/services/wordPreview.browser.integration.test.mjs and src/services/wordPreview.test-support.mjs consumers.',
  },
]

// Inline scripts in index.html are pinned by the SHA-256 of their trimmed body (CRLF normalized to LF).
// Any change to a pinned script fails the check until the new script is reviewed and its hash recorded here.
export const indexInlineScriptAllowed = [
  {
    file: 'index.html',
    sha256: '09114839894635992a0b8a8fc561f633f610b0175eeb81bcc7178b60d2c43c59',
    reason: 'Early theme bootstrap reads only the scoutTheme query parameter and sets data-theme with setAttribute before React loads; it does not process private workspace data.',
  },
  {
    file: 'index.html',
    sha256: 'd4d9446f5fcbf2f6f0954d2903f2a70404b6247f99b0ec1f555a019e9f37b9a3',
    reason: 'Early theme bootstrap reads only the documented non-private score-theme preference, accepts only light or dark, and handles storage failures explicitly.',
  },
]
