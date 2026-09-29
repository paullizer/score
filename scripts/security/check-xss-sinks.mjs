import { createHash } from 'node:crypto'
import { BLOCKER, REVIEW, finding, scopeToChanges } from './lib/findings.mjs'
import { calleeName, expressionName, lineOf, loadTypeScript, parseTypeScript, propertyName, stringLiteralValue, walk } from './lib/ast.mjs'
import { isMain, main } from './lib/runner.mjs'
import { isTestPath } from './lib/paths.mjs'
import * as defaultPolicy from './policy/xss.mjs'

const SCRIPT_EXECUTION = new Set(['eval', 'Function'])
const STRING_TIMER_CALLEES = new Set(['setTimeout', 'window.setTimeout', 'globalThis.setTimeout', 'setInterval', 'window.setInterval', 'globalThis.setInterval'])
const HTML_INSERTION_CALLEES = new Set([
  'insertAdjacentHTML', 'Element.insertAdjacentHTML', 'document.write', 'document.writeln', 'window.document.write', 'window.document.writeln',
  'createContextualFragment', 'Range.createContextualFragment', 'setHTMLUnsafe', 'Element.setHTMLUnsafe', 'parseHTMLUnsafe', 'Document.parseHTMLUnsafe',
])
const MARKUP_MODULES = new Set([
  'marked', 'markdown-it', 'showdown', 'remarkable', 'micromark', 'html-react-parser', 'react-html-parser', 'htmr', 'rehype-raw',
  'dompurify', 'mammoth', 'word-extractor', 'docx-preview',
])
const URL_ATTRS = new Set(['href', 'src', 'action', 'formAction'])
const NAVIGATION_CALLEES = new Set(['location.assign', 'window.location.assign', 'document.location.assign', 'location.replace', 'window.location.replace', 'document.location.replace', 'window.open'])
const STORAGE_NAMES = new Set(['localStorage', 'window.localStorage', 'globalThis.localStorage', 'sessionStorage', 'window.sessionStorage', 'globalThis.sessionStorage'])
const DOM_INSERTION_METHODS = new Set(['append', 'appendChild', 'prepend', 'replaceChildren', 'replaceWith', 'before', 'after', 'insertBefore'])
const SAFE_TEMPLATE_PREFIXES = ['/', '#', '?', './', 'https://', 'mailto:']
const JSON_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json', 'importmap', 'speculationrules'])

export const spec = {
  id: 'check-xss-sinks',
  title: 'XSS sink check',
  description: 'Finds dangerous browser HTML, script, URL and storage sinks in React and DOM code.',
  includeFile(file) {
    if (file.endsWith('.d.ts') || isTestPath(file)) return false
    return file === 'index.html' || /^src\/.*\.tsx?$/.test(file)
  },
  async check(ctx) {
    const ts = loadTypeScript(ctx.repoRoot)
    const results = []
    for (const file of ctx.files) {
      if (file.binary) continue
      const text = file.text()
      if (text === null) continue
      results.push(...scopeToChanges(file, analyzeFile(file.path, text, { ts, policy: defaultPolicy })))
      for (const sensitive of defaultPolicy.sanitizerSensitiveFiles) {
        if (sensitive.file !== file.path) continue
        for (const { line } of file.addedLines) {
          results.push(finding({
            rule: 'xss/sanitizer-sensitive-change',
            verdict: REVIEW,
            file: file.path,
            line,
            message: 'DOCX preview sanitizer changed.',
            hint: `${sensitive.reason} Suppress only with // security-reviewed: xss/sanitizer-sensitive-change -- <reason>.`,
          }))
        }
        for (const { line } of file.removedLines) {
          results.push(finding({
            rule: 'xss/sanitizer-sensitive-change',
            verdict: REVIEW,
            file: file.path,
            line,
            side: 'base',
            message: 'DOCX preview sanitizer line was removed.',
            hint: sensitive.reason,
          }))
        }
      }
    }
    return results
  },
}

export function analyzeFile(file, text, { ts = loadTypeScript(), policy = defaultPolicy } = {}) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (file === 'index.html') return analyzeHtml(file, normalized, policy)
  return analyzeTypeScript(file, normalized, ts, policy)
}

function analyzeHtml(file, text, policy) {
  const results = []
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = htmlAttrs(match[1])
    const line = lineAt(text, match.index)
    if (attrs.src) {
      if (/^(?:https?:)?\/\//i.test(attrs.src.value.trim())) {
        results.push(finding({
          rule: 'xss/index-remote-script',
          verdict: BLOCKER,
          file,
          line,
          message: 'index.html loads a script from an absolute remote URL.',
          hint: 'Bundle scripts locally through Vite.',
        }))
      }
    } else if (!JSON_SCRIPT_TYPES.has((attrs.type?.value ?? '').trim().toLowerCase()) && !allowedIndexInlineScript(file, match[2], policy)) {
      results.push(finding({
        rule: 'xss/index-inline-script',
        verdict: BLOCKER,
        file,
        line,
        message: 'index.html contains an inline script that is not pinned in the XSS policy.',
        hint: `Move executable code into bundled TypeScript. If the script must stay inline, review it and record sha256 ${inlineScriptDigest(match[2])} in indexInlineScriptAllowed in scripts/security/policy/xss.mjs.`,
      }))
    }
    checkCspString(results, file, line, attrs.content?.value ?? match[0])
  }
  for (const match of text.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = htmlAttrs(match[1])
    if ((attrs['http-equiv']?.value ?? '').toLowerCase() === 'content-security-policy') {
      checkCspString(results, file, lineAt(text, match.index), attrs.content?.value ?? '')
    }
  }
  for (const match of text.matchAll(/<[^!][^>]*>/g)) {
    const attrs = htmlAttrs(match[0])
    const line = lineAt(text, match.index)
    for (const [name, attr] of Object.entries(attrs)) {
      if (/^on/i.test(name)) {
        results.push(finding({
          rule: 'xss/index-inline-handler',
          verdict: BLOCKER,
          file,
          line,
          message: 'index.html contains an inline event handler.',
          hint: 'Bind events from bundled TypeScript instead.',
        }))
      }
      if (isJavascriptUrl(attr.value)) {
        results.push(finding({
          rule: 'xss/javascript-url',
          verdict: BLOCKER,
          file,
          line,
          message: 'index.html contains a javascript: URL.',
          hint: 'Use routed actions or safe http(s), mailto, hash or relative URLs.',
        }))
      }
    }
  }
  return results
}

function analyzeTypeScript(file, text, ts, policy) {
  const source = parseTypeScript(ts, file, text)
  const results = []
  const literalBindings = collectLiteralBindings(ts, source)
  const domParserBindings = collectDomParserBindings(ts, source)

  const add = options => results.push(finding({ file, ...options }))
  const literalValue = node => resolveLiteral(ts, node, literalBindings)
  const isSafeUrlExpression = node => safeUrlValue(ts, node, literalBindings, policy)

  walk(ts, source, (node, ancestors) => {
    addModuleLoadFinding(add, source, node, ts, policy, file)

    if (ts.isJsxOpeningLikeElement?.(node)) {
      const tag = jsxTagName(ts, node.tagName)
      if (tag === 'script') {
        add({
          rule: 'xss/runtime-script',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'JSX creates a script element.',
          hint: 'Bundle code statically instead of creating runtime script tags.',
        })
      }
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue
        const name = propertyName(ts, attr.name)
        if (!name) continue
        if (name === 'dangerouslySetInnerHTML') {
          addDangerousInnerHtml(add, source, attr)
        }
        if (/^srcdoc$/i.test(name) && !srcDocAllowed(file, policy)) {
          add({
            rule: 'xss/srcdoc',
            verdict: BLOCKER,
            line: lineOf(source, attr),
            message: 'iframe srcDoc is only allowed in the sanctioned DOCX preview.',
            hint: 'Use text rendering or add a reviewed policy exception for a sandboxed, sanitized preview.',
          })
        }
        if (URL_ATTRS.has(name)) checkJsxUrlAttribute(add, source, ts, attr, name, literalBindings, policy)
        if (name === 'sandbox' && tag === 'iframe') checkSandbox(add, source, ts, attr, literalBindings)
        if (name !== 'sandbox' || tag !== 'iframe') continue
      }
      if (tag === 'iframe' && !jsxAttribute(node, 'sandbox')) {
        add({
          rule: 'xss/iframe-sandbox',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'iframe is missing a sandbox attribute.',
          hint: 'Add sandbox="" or the narrowest sandbox tokens possible.',
        })
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(ts, node.name)
      if (name === 'dangerouslySetInnerHTML') addDangerousInnerHtml(add, source, node)
    }

    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      const leftName = expressionName(ts, node.left)
      if (['innerHTML', 'outerHTML'].includes(lastPart(leftName)) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(operator)) {
        add({
          rule: 'xss/inner-html-assignment',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: `${lastPart(leftName)} assignment can inject HTML.`,
          hint: 'Render with React or textContent, or sanitize before crossing the DOCX preview boundary.',
        })
      }
      if (isLocationTarget(leftName) && operator === ts.SyntaxKind.EqualsToken && !isSafeUrlExpression(node.right)) {
        add({
          rule: 'xss/navigation-nonliteral',
          verdict: REVIEW,
          line: lineOf(source, node),
          message: 'Location is assigned from a non-literal URL.',
          hint: 'Validate the destination cannot become javascript: or leave the intended origin.',
        })
      }
      if (isOnMessageTarget(leftName) && operator === ts.SyntaxKind.EqualsToken) {
        add({
          rule: 'xss/message-listener',
          verdict: REVIEW,
          line: lineOf(source, node),
          message: 'Message event handler changed.',
          hint: 'Validate event.origin, event.source and payload shape.',
        })
      }
      if (isStorageAssignment(leftName, ts, node.left) && operator === ts.SyntaxKind.EqualsToken) {
        addStorageFinding(add, source, node)
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = calleeName(ts, node)
      if (callee && HTML_INSERTION_CALLEES.has(callee)) {
        addHtmlInsertion(add, source, node)
      } else if (callee && lastPart(callee) && HTML_INSERTION_CALLEES.has(lastPart(callee))) {
        addHtmlInsertion(add, source, node)
      }
      if (callee && SCRIPT_EXECUTION.has(callee)) {
        add({
          rule: 'xss/string-code-execution',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'Dynamic code execution is not allowed.',
          hint: 'Use explicit functions or data-driven dispatch instead.',
        })
      }
      if (callee && STRING_TIMER_CALLEES.has(callee) && node.arguments[0] && isStringLike(ts, node.arguments[0], literalBindings)) {
        add({
          rule: 'xss/string-code-execution',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'Timer executes a string argument as code.',
          hint: 'Pass a function callback to timers.',
        })
      }
      if (isNewFunctionCall(ts, node)) {
        add({
          rule: 'xss/string-code-execution',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'Function constructor executes strings as code.',
          hint: 'Use explicit functions or data-driven dispatch instead.',
        })
      }
      if (callee === 'postMessage' || callee?.endsWith('.postMessage')) {
        const target = node.arguments[1] ? literalValue(node.arguments[1]) : null
        if (target === '*') {
          add({
            rule: 'xss/post-message-wildcard',
            verdict: BLOCKER,
            line: lineOf(source, node),
            message: 'postMessage uses a wildcard target origin.',
            hint: 'Send messages only to an exact expected origin.',
          })
        }
      }
      if (callee === 'document.createElement' || callee?.endsWith('.document.createElement')) {
        if ((node.arguments[0] ? literalValue(node.arguments[0]) : null)?.toLowerCase() === 'script') {
          add({
            rule: 'xss/runtime-script',
            verdict: BLOCKER,
            line: lineOf(source, node),
            message: 'Runtime code creates a script element.',
            hint: 'Bundle code statically instead of creating runtime script tags.',
          })
        }
      }
      if (callee && NAVIGATION_CALLEES.has(callee) && node.arguments[0] && !isSafeUrlExpression(node.arguments[0])) {
        add({
          rule: 'xss/navigation-nonliteral',
          verdict: REVIEW,
          line: lineOf(source, node),
          message: 'Navigation uses a non-literal URL.',
          hint: 'Validate the destination cannot become javascript: or leave the intended origin.',
        })
      }
      if ((callee === 'addEventListener' || callee?.endsWith('.addEventListener')) && node.arguments[0] && literalValue(node.arguments[0]) === 'message') {
        add({
          rule: 'xss/message-listener',
          verdict: REVIEW,
          line: lineOf(source, node),
          message: 'Message event listener changed.',
          hint: 'Validate event.origin, event.source and payload shape.',
        })
      }
      if (callee && (callee.endsWith('.setItem') || callee === 'setItem') && STORAGE_NAMES.has(parentExpressionName(ts, node.expression))) {
        addStorageFinding(add, source, node)
      }
      if (callee && DOM_INSERTION_METHODS.has(lastPart(callee)) && node.arguments.some(argument => isDomParserValue(ts, argument, domParserBindings))) {
        add({
          rule: 'xss/html-insertion',
          verdict: BLOCKER,
          line: lineOf(source, node),
          message: 'DOMParser output is inserted into the DOM.',
          hint: 'Avoid parsing untrusted HTML into DOM nodes or sanitize before insertion.',
        })
      }
    }

    if (ts.isNewExpression(node) && expressionName(ts, node.expression) === 'Function') {
      add({
        rule: 'xss/string-code-execution',
        verdict: BLOCKER,
        line: lineOf(source, node),
        message: 'Function constructor executes strings as code.',
        hint: 'Use explicit functions or data-driven dispatch instead.',
      })
    }

    if (isStringLiteralNode(ts, node) && !ancestors.some(parent => ts.isJsxAttribute(parent) || ts.isImportDeclaration(parent))) {
      const value = literalOrTemplateText(ts, node)
      if (value !== null) {
        if (isJavascriptUrl(value)) {
          add({
            rule: 'xss/javascript-url',
            verdict: BLOCKER,
            line: lineOf(source, node),
            message: 'String contains a javascript: URL.',
            hint: 'Use routed actions or safe http(s), mailto, hash or relative URLs.',
          })
        }
        checkCspString(results, file, lineOf(source, node), value)
      }
    }
  })
  return results
}

function addDangerousInnerHtml(add, source, node) {
  add({
    rule: 'xss/dangerously-set-inner-html',
    verdict: BLOCKER,
    line: lineOf(source, node),
    message: 'dangerouslySetInnerHTML bypasses React escaping.',
    hint: 'Render structured React nodes or a sanctioned sanitized preview.',
  })
}

function addHtmlInsertion(add, source, node) {
  add({
    rule: 'xss/html-insertion',
    verdict: BLOCKER,
    line: lineOf(source, node),
    message: 'HTML insertion API can execute untrusted markup.',
    hint: 'Render with React or textContent, or sanitize before using a sanctioned sink.',
  })
}

function addStorageFinding(add, source, node) {
  add({
    rule: 'xss/browser-storage-write',
    verdict: REVIEW,
    line: lineOf(source, node),
    message: 'Browser storage write changed.',
    hint: 'README promises private documents, counts, searches and saved evidence are not stored in browser storage.',
  })
}

function checkJsxUrlAttribute(add, source, ts, attr, name, literalBindings, policy) {
  const value = jsxAttributeExpression(ts, attr)
  if (!value) return
  const literal = resolveLiteral(ts, value, literalBindings)
  if (literal !== null) {
    if (isJavascriptUrl(literal)) {
      add({
        rule: 'xss/javascript-url',
        verdict: BLOCKER,
        line: lineOf(source, attr),
        message: `JSX ${name} contains a javascript: URL.`,
        hint: 'Use routed actions or safe http(s), mailto, hash or relative URLs.',
      })
    }
    return
  }
  if (safeUrlValue(ts, value, literalBindings, policy)) return
  add({
    rule: 'xss/nonliteral-url',
    verdict: REVIEW,
    line: lineOf(source, attr),
    message: `JSX ${name} uses a non-literal URL.`,
    hint: 'Use a literal safe URL, a safe URL builder, or validate that it cannot become javascript:.',
  })
}

function checkSandbox(add, source, ts, attr, literalBindings) {
  const value = jsxAttributeExpression(ts, attr)
  const literal = attr.initializer === undefined ? '' : value ? resolveLiteral(ts, value, literalBindings) : null
  if (literal === null) {
    add({
      rule: 'xss/iframe-sandbox',
      verdict: REVIEW,
      line: lineOf(source, attr),
      message: 'iframe sandbox value is not statically resolvable.',
      hint: 'Use a literal sandbox value so review can verify it.',
    })
    return
  }
  const tokens = new Set(literal.toLowerCase().split(/\s+/).filter(Boolean))
  if (tokens.has('allow-scripts') && tokens.has('allow-same-origin')) {
    add({
      rule: 'xss/iframe-sandbox',
      verdict: BLOCKER,
      line: lineOf(source, attr),
      message: 'iframe sandbox allows scripts with same-origin privileges.',
      hint: 'Remove allow-scripts, allow-same-origin, or both.',
    })
  } else if (tokens.has('allow-scripts')) {
    add({
      rule: 'xss/iframe-sandbox',
      verdict: REVIEW,
      line: lineOf(source, attr),
      message: 'iframe sandbox allows scripts.',
      hint: 'Confirm scripts are required and the framed document cannot access sensitive data.',
    })
  }
}

function checkCspString(results, file, line, value) {
  if (!/\b(?:default-src|script-src)\b/i.test(value) || !/'unsafe-(?:inline|eval)'/i.test(value)) return
  for (const directive of value.split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean)
    const name = parts.shift()?.toLowerCase()
    if ((name === 'script-src' || name === 'default-src') && parts.some(part => /^'unsafe-(?:inline|eval)'$/i.test(part))) {
      results.push(finding({
        rule: 'xss/csp-unsafe-script',
        verdict: BLOCKER,
        file,
        line,
        message: `CSP ${name} allows unsafe script execution.`,
        hint: 'Remove unsafe-inline and unsafe-eval from script-src/default-src.',
      }))
    }
  }
}

function htmlAttrs(text) {
  const attrs = {}
  for (const match of text.matchAll(/\s([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[match[1].toLowerCase()] = { name: match[1], value: match[2] ?? match[3] ?? match[4] ?? '' }
  }
  return attrs
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function allowedIndexInlineScript(file, body, policy) {
  const digest = inlineScriptDigest(body)
  return (policy.indexInlineScriptAllowed ?? []).some(entry => entry.file === file && entry.sha256 === digest)
}

export function inlineScriptDigest(body) {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex')
}

function collectLiteralBindings(ts, source) {
  const values = new Map()
  walk(ts, source, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return
    if (!ts.isIdentifier(node.name)) return
    const value = resolveLiteral(ts, node.initializer, values)
    if (value !== null) values.set(node.name.text, value)
  })
  return values
}

function collectDomParserBindings(ts, source) {
  const values = new Set()
  const parsers = new Set()
  walk(ts, source, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return
    if (isNewDomParser(ts, node.initializer)) {
      parsers.add(node.name.text)
    }
  })
  walk(ts, source, node => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return
    if (isDomParserParse(ts, node.initializer, parsers)) values.add(node.name.text)
  })
  return { parsers, values }
}

function moduleLoad(ts, node) {
  if (ts.isImportDeclaration(node)) {
    if (isTypeOnlyImport(ts, node)) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleSpecifier) }
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    if (node.isTypeOnly) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleSpecifier) }
  }
  if (ts.isImportEqualsDeclaration(node)) {
    if (node.isTypeOnly || !ts.isExternalModuleReference(node.moduleReference)) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleReference.expression) }
  }
  if (ts.isCallExpression(node)) {
    if (calleeName(ts, node) === 'require' && node.arguments.length === 1) {
      return { node, moduleName: stringLiteralValue(ts, node.arguments[0]) }
    }
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      return { node, moduleName: stringLiteralValue(ts, node.arguments[0]) }
    }
  }
  return null
}

function isTypeOnlyImport(ts, declaration) {
  const clause = declaration.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
}

function addModuleLoadFinding(add, source, node, ts, policy, file) {
  const load = moduleLoad(ts, node)
  if (!load) return
  if (!load.moduleName) {
    add({
      rule: 'xss/dynamic-module-load',
      verdict: REVIEW,
      line: lineOf(source, load.node),
      message: 'Module load uses a non-literal specifier, so the checker cannot see which module loads.',
      hint: 'Use a literal import/require specifier or manually review that no browser markup renderer can load.',
    })
    return
  }
  if (!isMarkupModule(load.moduleName) || moduleAllowed(file, load.moduleName, 'xss/markup-renderer-import', policy)) return
  add({
    rule: 'xss/markup-renderer-import',
    verdict: BLOCKER,
    line: lineOf(source, load.node),
    message: `Browser code imports markup-producing module "${load.moduleName}".`,
    hint: 'Keep HTML renderers out of the browser, or add a narrow policy entry with a reason.',
  })
}

function resolveLiteral(ts, node, bindings) {
  const direct = stringLiteralValue(ts, node)
  if (direct !== null) return direct
  const current = unwrap(ts, node)
  if (!current) return null
  if (ts.isIdentifier(current) && bindings.has(current.text)) return bindings.get(current.text)
  if (ts.isTemplateExpression(current) && current.templateSpans.every(span => resolveLiteral(ts, span.expression, bindings) !== null)) {
    return current.head.text + current.templateSpans.map(span => `${resolveLiteral(ts, span.expression, bindings)}${span.literal.text}`).join('')
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveLiteral(ts, current.left, bindings)
    const right = resolveLiteral(ts, current.right, bindings)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

function unwrap(ts, node) {
  let current = node
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression?.(current)
    || ts.isSatisfiesExpression?.(current)
  )) current = current.expression
  return current
}

function safeUrlValue(ts, node, literalBindings, policy) {
  const value = resolveLiteral(ts, node, literalBindings)
  if (value !== null) return !isJavascriptUrl(value)
  const current = unwrap(ts, node)
  if (current && ts.isTemplateExpression(current)) {
    const head = current.head.text.trimStart().toLowerCase()
    if (SAFE_TEMPLATE_PREFIXES.some(prefix => head.startsWith(prefix))) return true
  }
  if (current && ts.isCallExpression(current)) {
    const callee = calleeName(ts, current)
    if (safeBuilder(callee, policy)) return true
  }
  return false
}

function safeBuilder(name, policy) {
  if (!name) return false
  return (policy.safeUrlBuilders ?? []).some(entry => name === entry.name || name.endsWith(`.${entry.name}`))
}

function jsxAttributeExpression(ts, attr) {
  const value = attr.initializer
  if (!value) return null
  if (ts.isStringLiteral(value)) return value
  if (ts.isJsxExpression(value)) return value.expression ?? null
  return null
}

function jsxAttribute(node, expected) {
  return node.attributes.properties.find(attr => attr.name?.text === expected)
}

function jsxTagName(ts, name) {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isPropertyAccessExpression(name)) return expressionName(ts, name)
  return null
}

function isStringLiteralNode(ts, node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
}

function literalOrTemplateText(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => span.literal.text).join('')
  return null
}

function isJavascriptUrl(value) {
  return /^[\s\0-\x20]*j[\s\0-\x20]*a[\s\0-\x20]*v[\s\0-\x20]*a[\s\0-\x20]*s[\s\0-\x20]*c[\s\0-\x20]*r[\s\0-\x20]*i[\s\0-\x20]*p[\s\0-\x20]*t[\s\0-\x20]*:/i.test(value)
}

function isStringLike(ts, node, bindings) {
  return resolveLiteral(ts, node, bindings) !== null || ts.isTemplateExpression(unwrap(ts, node))
}

function isNewFunctionCall(ts, node) {
  return ts.isNewExpression(node) && expressionName(ts, node.expression) === 'Function'
}

function parentExpressionName(ts, node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return expressionName(ts, node.expression)
  return null
}

function lastPart(name) {
  return name?.split('.').at(-1) ?? null
}

function isLocationTarget(name) {
  return ['location', 'window.location', 'document.location', 'location.href', 'window.location.href', 'document.location.href'].includes(name)
}

function isOnMessageTarget(name) {
  return ['onmessage', 'window.onmessage', 'globalThis.onmessage', 'self.onmessage'].includes(name)
}

function isStorageAssignment(name, ts, left) {
  if (!name) return false
  if (ts.isElementAccessExpression(left) && STORAGE_NAMES.has(expressionName(ts, left.expression))) return true
  const parts = name.split('.')
  return parts.length > 1 && STORAGE_NAMES.has(parts.slice(0, -1).join('.'))
}

function isMarkupModule(moduleName) {
  const normalized = moduleName.toLowerCase()
  return [...MARKUP_MODULES].some(name => normalized === name || normalized.startsWith(`${name}/`))
}

function moduleAllowed(file, moduleName, rule, policy) {
  return (policy.moduleAllowlist ?? []).some(entry =>
    entry.file === file
    && (entry.module === moduleName || moduleName.startsWith(`${entry.module}/`))
    && (!entry.rules || entry.rules.includes(rule)))
}

function srcDocAllowed(file, policy) {
  return (policy.srcDocAllowed ?? []).some(entry => entry.file === file)
}

function isNewDomParser(ts, node) {
  const current = unwrap(ts, node)
  return ts.isNewExpression(current) && expressionName(ts, current.expression) === 'DOMParser'
}

function isDomParserParse(ts, node, parsers = new Set()) {
  const current = unwrap(ts, node)
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression) || current.expression.name.text !== 'parseFromString') return false
  const receiver = current.expression.expression
  if (isNewDomParser(ts, receiver)) return true
  const name = expressionName(ts, receiver)
  return !!name && parsers.has(name)
}

function isDomParserValue(ts, node, bindings) {
  const current = unwrap(ts, node)
  if (isDomParserParse(ts, current, bindings.parsers)) return true
  if (current && ts.isPropertyAccessExpression(current) && isDomParserParse(ts, current.expression, bindings.parsers)) return true
  const name = expressionName(ts, current)
  return !!name && [...bindings.values].some(binding => name === binding || name.startsWith(`${binding}.`))
}

if (isMain(import.meta.url)) await main(spec)
