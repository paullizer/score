---
applyTo: "src/**,index.html"
---

# Rendering untrusted content in the browser

Job descriptions, résumés, grade references, rubric text, model output and Word documents come from users, websites or models. Treat all of it as untrusted.

- Render text with React (`{value}`), which escapes it. Don't build HTML strings.
- Don't use `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `createContextualFragment`, `setHTMLUnsafe`, `eval`, `new Function`, or `setTimeout` and `setInterval` with a string.
- Don't import Markdown renderers, HTML parsers, sanitizers or Word-to-HTML converters into the browser app. The Word preview is the one exception, and it keeps three layers: `sanitizeDocxPreview` (`src/components/documents/docxPreviewSanitize.ts`) cleans the HTML with DOMPurify and adds a restrictive Content Security Policy, and `DocxPreview` shows it in an `<iframe sandbox="">`. Don't use `srcDoc` anywhere else. Every iframe needs a `sandbox` attribute, and never combine `allow-scripts` with `allow-same-origin`.
- Before you bind a URL from data or user input to `href`, `src`, `action`, `formAction`, `location` or `window.open`, check that it uses `http:` or `https:`, or build it with a same-origin helper such as `realJobOriginalUrl`. Never write a `javascript:` URL.
- Don't create `<script>` elements at runtime. Keep inline event handlers and remote scripts out of `index.html`. Its two inline theme scripts are pinned by SHA-256 in `scripts/security/policy/xss.mjs`, so changing either one fails the XSS check until someone reviews the new script and records its hash.
- Don't send `postMessage` to `'*'`, and check where a message came from before you act on it.
- Keep tokens, secrets and personal data out of `localStorage` and `sessionStorage`.
- When you change `docxPreviewSanitize.ts`, run `src/services/wordPreview.browser.integration.test.mjs` and add a case for what you changed.

The XSS check (`scripts/security/check-xss-sinks.mjs`) enforces these rules. See [docs/security-scanning.md](../../docs/security-scanning.md).
