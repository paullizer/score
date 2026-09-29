import { BLOCKER, REVIEW, finding, scopeToChanges } from './lib/findings.mjs'
import { calleeName, expressionName, lineOf, loadTypeScript, parseTypeScript, propertyName, stringLiteralValue, walk } from './lib/ast.mjs'
import { isTestPath, matchesAny } from './lib/paths.mjs'
import { isMain, main } from './lib/runner.mjs'
import {
  knownModelTransportFiles,
  networkModules,
  playwrightModules,
  sanctionedTransports,
  ssrfPolicyFiles,
} from './policy/outbound.mjs'

const INCLUDE_GLOBS = ['server/**/*.ts', 'worker/**/*.ts', 'renderer/**/*.ts']
const NETWORK_MODULES = new Set(networkModules)
const PLAYWRIGHT_MODULES = new Set(playwrightModules)
const SANCTIONED = new Map(sanctionedTransports.map(entry => [entry.file, entry]))
const SSRF_POLICY = new Map(ssrfPolicyFiles.map(entry => [entry.file, entry]))
const MODEL_TRANSPORT_FILES = new Set(knownModelTransportFiles.map(entry => entry.file))
const ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '**=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '^=',
  '|=',
  '&&=',
  '||=',
  '??=',
])
// Text markers, not URL validators: a file that mentions a model endpoint or token scope is a model transport.
const MODEL_TRANSPORT_MARKERS = ['openai/v1/chat/completions', 'cognitiveservices.azure.com/.default']
const MODEL_TRANSPORT_CALL = /\binvokeStructuredModel\s*\(/

function ruleAllowed(file, rule) {
  const entry = SANCTIONED.get(file)
  return !!entry && (!entry.rules || entry.rules.includes(rule))
}

function addFinding(findings, details) {
  findings.push(finding(details))
}

function messageForModule(moduleName) {
  return `Imports outbound network module "${moduleName}".`
}

function hintForModule(moduleName) {
  return PLAYWRIGHT_MODULES.has(moduleName)
    ? 'Route browser traffic through renderer/browser.ts or worker/runtime.ts so public URLs keep policy, redirect and byte-limit enforcement.'
    : 'Use worker safeFetch for public URLs, or add an exact sanctioned transport policy entry for a fixed deployment endpoint.'
}

function bindingNames(ts, node, result = []) {
  if (!node) return result
  if (ts.isIdentifier(node)) result.push(node.text)
  else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) bindingNames(ts, element.name, result)
    }
  }
  return result
}

function containsBinding(ts, node, wanted) {
  return bindingNames(ts, node).includes(wanted)
}

function nearestScope(ts, ancestors, includeCurrent = true) {
  for (let index = ancestors.length - (includeCurrent ? 1 : 2); index >= 0; index -= 1) {
    const candidate = ancestors[index]
    if (ts.isSourceFile(candidate) || ts.isBlock(candidate) || ts.isModuleBlock(candidate) || ts.isCaseClause(candidate) || ts.isDefaultClause(candidate)) {
      return candidate
    }
  }
  return ancestors[0]
}

function nearestFunctionScope(ts, ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index]
    if (ts.isFunctionLike(candidate)) return candidate.body ?? candidate
  }
  return ancestors[0]
}

function declarationRanges(ts, source) {
  const ranges = []
  const add = scope => {
    if (!scope) return
    ranges.push({ start: scope.getFullStart(), end: scope.getEnd() })
  }
  walk(ts, source, (node, ancestors) => {
    if (ts.isImportClause(node)) {
      if (node.name?.text === 'fetch') add(source)
      if (node.namedBindings && containsBinding(ts, node.namedBindings, 'fetch')) add(source)
      return
    }
    if (ts.isImportSpecifier(node) && node.name.text === 'fetch') add(source)
    if (ts.isParameter(node) && containsBinding(ts, node.name, 'fetch')) add(nearestFunctionScope(ts, ancestors))
    if (ts.isVariableDeclaration(node) && containsBinding(ts, node.name, 'fetch')) add(nearestScope(ts, ancestors))
    if (ts.isCatchClause(node) && node.variableDeclaration && containsBinding(ts, node.variableDeclaration.name, 'fetch')) add(node.block)
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'fetch') add(nearestScope(ts, ancestors, false))
    if (ts.isClassDeclaration(node) && node.name?.text === 'fetch') add(nearestScope(ts, ancestors, false))
  })
  return ranges
}

function isDeclaredAt(ranges, position) {
  return ranges.some(range => range.start <= position && position <= range.end)
}

function isTypeOnlyImport(ts, declaration) {
  const clause = declaration.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
}

function moduleLoad(ts, node) {
  if (ts.isImportDeclaration(node)) {
    if (isTypeOnlyImport(ts, node)) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleSpecifier), dynamic: false }
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    if (node.isTypeOnly) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleSpecifier), dynamic: false }
  }
  if (ts.isImportEqualsDeclaration(node)) {
    if (node.isTypeOnly || !ts.isExternalModuleReference(node.moduleReference)) return null
    return { node, moduleName: stringLiteralValue(ts, node.moduleReference.expression), dynamic: false }
  }
  if (ts.isCallExpression(node)) {
    if (calleeName(ts, node) === 'require' && node.arguments.length === 1) {
      return { node, moduleName: stringLiteralValue(ts, node.arguments[0]), dynamic: true }
    }
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      return { node, moduleName: stringLiteralValue(ts, node.arguments[0]), dynamic: true }
    }
  }
  return null
}

function addModuleLoadFinding(findings, file, source, load) {
  if (!load) return
  const { moduleName, node } = load
  if (!moduleName || moduleName === 'module' || moduleName === 'node:module') {
    addFinding(findings, {
      rule: 'outbound/dynamic-module-load',
      verdict: REVIEW,
      file,
      line: lineOf(source, node),
      message: moduleName
        ? `Imports "${moduleName}", whose createRequire can load modules the checker cannot see.`
        : 'Module load uses a non-literal specifier, so the checker cannot see which module loads.',
      hint: 'Use a literal import/require specifier or manually review that no outbound transport module can load.',
    })
    return
  }
  if (!(NETWORK_MODULES.has(moduleName) || PLAYWRIGHT_MODULES.has(moduleName))) return
  const rule = PLAYWRIGHT_MODULES.has(moduleName) ? 'outbound/playwright-import' : 'outbound/network-module'
  if (ruleAllowed(file, rule)) return
  addFinding(findings, {
    rule,
    verdict: BLOCKER,
    file,
    line: lineOf(source, node),
    message: messageForModule(moduleName),
    hint: hintForModule(moduleName),
  })
}

function isGlobalFetchCall(ts, call, fetchDeclarations) {
  const name = calleeName(ts, call)
  if (name === 'globalThis.fetch' || name === 'window.fetch') return true
  const expression = call.expression
  return name === 'fetch' && ts.isIdentifier(expression) && !isDeclaredAt(fetchDeclarations, expression.getStart())
}

function isPlaywrightNavigation(ts, call) {
  const name = calleeName(ts, call)
  if (!name) return false
  if (name.endsWith('.goto') || name === 'route.fetch' || name === 'request.newContext') return true
  if (name === 'route.continue') {
    const first = call.arguments[0]
    if (!first || !ts.isObjectLiteralExpression(first)) return false
    return first.properties.some(prop => ts.isPropertyAssignment(prop) && propertyName(ts, prop.name) === 'url')
  }
  return false
}

function isPlaywrightRequestProperty(ts, node) {
  const name = expressionName(ts, node)
  return name === 'page.request' || name === 'context.request'
}

function booleanProperty(ts, node, names, wanted) {
  if (!ts.isPropertyAssignment(node)) return false
  const name = propertyName(ts, node.name)
  return names.includes(name) && node.initializer.kind === (wanted ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword)
}

function isNodeTlsAssignment(ts, node) {
  if (!ts.isBinaryExpression(node) || !ASSIGNMENT_OPERATORS.has(node.operatorToken.getText())) return false
  return expressionName(ts, node.left)?.endsWith('NODE_TLS_REJECT_UNAUTHORIZED') === true
}

function isNodeTlsObjectProperty(ts, node) {
  return ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'NODE_TLS_REJECT_UNAUTHORIZED'
}

function isRedirectFollow(ts, node) {
  return ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'redirect' && stringLiteralValue(ts, node.initializer) === 'follow'
}

function isMaxRedirectsOption(ts, node) {
  return ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'maxRedirects'
}

function changedLineText(lines) {
  return (lines ?? []).map(item => typeof item === 'string' ? item : item.text).join('\n')
}

function ssrfPolicyHint(entry) {
  return `Update or confirm ${entry.tests.join(' and ')} with the policy change.`
}

function hasModelTransportPattern(text) {
  const lower = text.toLowerCase()
  return MODEL_TRANSPORT_MARKERS.some(marker => lower.includes(marker)) || MODEL_TRANSPORT_CALL.test(text)
}

export function includeFile(file) {
  return matchesAny(file, INCLUDE_GLOBS) && !file.endsWith('.d.ts') && !isTestPath(file)
}

export function analyzeFile(file, text, options = {}) {
  const ts = options.ts ?? loadTypeScript(options.repoRoot)
  const source = parseTypeScript(ts, file, text)
  const findings = []
  const fetchDeclarations = declarationRanges(ts, source)

  walk(ts, source, (node) => {
    addModuleLoadFinding(findings, file, source, moduleLoad(ts, node))

    if (ts.isCallExpression(node)) {
      if (isGlobalFetchCall(ts, node, fetchDeclarations) && !ruleAllowed(file, 'outbound/global-fetch')) {
        addFinding(findings, {
          rule: 'outbound/global-fetch',
          verdict: BLOCKER,
          file,
          line: lineOf(source, node),
          message: 'Calls the global fetch transport outside a sanctioned module.',
          hint: 'Inject a bounded transport, use worker safeFetch for public URLs, or add an exact sanctioned transport policy entry for a fixed endpoint.',
        })
      }
      if (isPlaywrightNavigation(ts, node) && !ruleAllowed(file, 'outbound/playwright-navigation')) {
        addFinding(findings, {
          rule: 'outbound/playwright-navigation',
          verdict: BLOCKER,
          file,
          line: lineOf(source, node),
          message: 'Uses Playwright navigation or request APIs outside a sanctioned renderer.',
          hint: 'Route navigation through renderer/browser.ts or worker/runtime.ts so URL policy, DNS pinning and byte limits are enforced.',
        })
      }
    }

    if (ts.isPropertyAccessExpression(node) && isPlaywrightRequestProperty(ts, node) && !ruleAllowed(file, 'outbound/playwright-navigation')) {
      addFinding(findings, {
        rule: 'outbound/playwright-navigation',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Uses Playwright request APIs outside a sanctioned renderer.',
        hint: 'Route browser requests through renderer/browser.ts or worker/runtime.ts so public fetch policy is enforced.',
      })
    }

    if (booleanProperty(ts, node, ['rejectUnauthorized'], false)) {
      addFinding(findings, {
        rule: 'outbound/tls-verification-disabled',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Disables TLS certificate verification.',
        hint: 'Keep certificate validation enabled; fix the trusted endpoint or certificate chain instead.',
      })
    }
    if (ts.isPropertyAssignment(node) && propertyName(ts, node.name) === 'checkServerIdentity') {
      addFinding(findings, {
        rule: 'outbound/tls-verification-disabled',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Overrides TLS server identity verification.',
        hint: 'Do not override checkServerIdentity unless this checker is extended with a precise reviewed policy exception.',
      })
    }
    if (booleanProperty(ts, node, ['ignoreHTTPSErrors', 'ignoreHttpsErrors'], true)) {
      addFinding(findings, {
        rule: 'outbound/tls-verification-disabled',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Configures Playwright to ignore HTTPS errors.',
        hint: 'Keep browser certificate validation enabled.',
      })
    }
    if (isNodeTlsAssignment(ts, node) || isNodeTlsObjectProperty(ts, node)) {
      addFinding(findings, {
        rule: 'outbound/node-tls-disabled',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Sets NODE_TLS_REJECT_UNAUTHORIZED in code.',
        hint: 'Do not disable Node TLS verification; reading the variable for a guard is okay, setting it is not.',
      })
    }
    if (stringLiteralValue(ts, node) === '--ignore-certificate-errors') {
      addFinding(findings, {
        rule: 'outbound/tls-verification-disabled',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Launches a browser with certificate errors ignored.',
        hint: 'Remove --ignore-certificate-errors and keep TLS validation enabled.',
      })
    }

    if (isRedirectFollow(ts, node)) {
      addFinding(findings, {
        rule: 'outbound/redirect-follow',
        verdict: REVIEW,
        file,
        line: lineOf(source, node),
        message: 'Allows automatic fetch redirects.',
        hint: 'Prefer redirect:error or redirect:manual so redirect targets are validated before connecting.',
      })
    }
    if (isMaxRedirectsOption(ts, node)) {
      addFinding(findings, {
        rule: 'outbound/redirect-follow',
        verdict: REVIEW,
        file,
        line: lineOf(source, node),
        message: 'Changes an explicit redirect-follow limit.',
        hint: 'Confirm every redirect destination is independently URL-policy and public-address checked.',
      })
    }
  })

  const addedText = changedLineText(options.addedLines)
  if (!MODEL_TRANSPORT_FILES.has(file) && hasModelTransportPattern(addedText)) {
    const added = options.addedLines?.[0]
    addFinding(findings, {
      rule: 'outbound/model-transport-change',
      verdict: REVIEW,
      file,
      line: typeof added === 'number' ? added : added?.line ?? 1,
      message: 'Adds a model endpoint transport outside the known transport files.',
      hint: 'Keep model requests in worker/model-transport.ts or document the fixed endpoint and redirect:error guard in policy/outbound.mjs.',
    })
  }

  return findings
}

function policyChangeFinding(file, addedLines, removedLines) {
  const entry = SSRF_POLICY.get(file.path)
  if (!entry) return null
  const added = addedLines[0]
  if (added) {
    return finding({
      rule: 'outbound/ssrf-policy-change',
      verdict: REVIEW,
      file: file.path,
      line: added.line,
      message: 'Changes outbound URL or SSRF policy code.',
      hint: ssrfPolicyHint(entry),
    })
  }
  const removed = removedLines[0]
  if (removed) {
    return finding({
      rule: 'outbound/ssrf-policy-change',
      verdict: REVIEW,
      file: file.path,
      side: 'base',
      line: removed.line,
      message: 'Removes outbound URL or SSRF policy code.',
      hint: ssrfPolicyHint(entry),
    })
  }
  return null
}

export const spec = {
  id: 'outbound-requests',
  title: 'Outbound request guardrails',
  description: 'Detects new unsanctioned outbound transports, Playwright navigation, TLS-verification bypasses and SSRF policy changes.',
  script: 'scripts/security/check-outbound-requests.mjs',
  includeFile,
  showChangedFiles: true,
  check(ctx) {
    const ts = loadTypeScript(ctx.repoRoot)
    const findings = []
    for (const file of ctx.files) {
      if (file.binary) continue
      const text = file.text()
      if (text === null) continue
      const analyzed = analyzeFile(file.path, text, { ts, repoRoot: ctx.repoRoot, addedLines: file.addedLines })
      findings.push(...scopeToChanges(file, analyzed))
      const policy = policyChangeFinding(file, file.addedLines, file.removedLines)
      if (policy) findings.push(policy)
    }
    for (const file of ctx.deletedFiles) {
      const policy = policyChangeFinding(file, [], file.removedLines)
      if (policy) findings.push(policy)
    }
    ctx.notes.push('Azure SDK clients such as CosmosClient and BlobServiceClient are treated as fixed deployment-endpoint clients, not arbitrary outbound transports; policy/outbound.mjs records each exact file and reason.')
    return findings
  },
}

if (isMain(import.meta.url)) await main(spec)
