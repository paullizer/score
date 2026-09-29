import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { BLOCKER, NOTE, REVIEW, finding, scopeToChanges } from './lib/findings.mjs'
import { loadTypeScript, parseTypeScript, walk, calleeName, expressionName, lineOf, stringLiteralValue, propertyName, unwrapExpression } from './lib/ast.mjs'
import { main, isMain } from './lib/runner.mjs'
import {
  appWiringOrder,
  authenticatedOnlyRoutes,
  devHeaderGuard,
  directAppRouteAllowlist,
  guardHelperFiles,
  principalHeaderAllowedFiles,
  publicRoutes,
  recognizedGuards,
} from './policy/access-control.mjs'

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'])
const GUARD_NAMES = new Set(recognizedGuards.map(guard => guard.name))
const SERVER_TS = /^server\/.*\.ts$/

function posix(file) {
  return file.replace(/\\/g, '/')
}

function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function lineFromOffset(starts, offset) {
  let low = 0, high = starts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (starts[mid] <= offset) low = mid + 1
    else high = mid - 1
  }
  return high + 1
}

function normalizeRoutePath(value) {
  if (!value) return '/'
  let result = value.replace(/\/+/g, '/')
  if (!result.startsWith('/')) result = `/${result}`
  return result.length > 1 ? result.replace(/\/$/, '') : result
}

function joinRoutes(prefix, route) {
  if (route === '<non-literal>') return route
  return normalizeRoutePath(`${prefix === '/' ? '' : prefix}${route === '/' ? '' : route}`)
}

function pathCovers(prefix, route) {
  const a = normalizeRoutePath(prefix)
  const b = normalizeRoutePath(route)
  return a === '/' || b === a || b.startsWith(`${a}/`)
}

function sameRoute(a, b) {
  return a.method.toUpperCase() === b.method.toUpperCase() && normalizeRoutePath(a.path) === normalizeRoutePath(b.path)
}

function routePolicyReason(route, entries) {
  return entries.find(entry => sameRoute({ method: route.method, path: route.fullPath ?? route.path }, entry))?.reason ?? null
}

function textOf(source, node) {
  return node.getText(source)
}

function evaluateString(ts, node, env = new Map()) {
  const current = unwrapExpression(ts, node)
  if (!current) return null
  const literal = stringLiteralValue(ts, current)
  if (literal !== null) return literal
  if (ts.isIdentifier(current)) return env.get(current.text) ?? `:${current.text}`
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateString(ts, current.left, env)
    const right = evaluateString(ts, current.right, env)
    return left !== null && right !== null ? `${left}${right}` : null
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text
    for (const span of current.templateSpans) {
      const expression = evaluateString(ts, span.expression, env)
      value += expression ?? `:${textOf(current.getSourceFile(), span.expression).replace(/\W+/g, '') || 'value'}`
      value += span.literal.text
    }
    return value
  }
  return null
}

function collectLexicalFacts(ts, source) {
  const stringEnv = new Map()
  const functions = new Map()
  const routerNames = new Set()
  const appNames = new Set(['app'])

  walk(ts, source, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer
      if (init) {
        const value = evaluateString(ts, init, stringEnv)
        if (value !== null) stringEnv.set(node.name.text, value)
        const initName = expressionName(ts, init)
        if (initName === 'express.Router()' || initName === 'Router()') routerNames.add(node.name.text)
        if (initName === 'express()') appNames.add(node.name.text)
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(node.name.text, init)
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node)
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'app') {
      appNames.add(node.name.text)
    }
  })
  return { stringEnv, functions, routerNames, appNames }
}

function referencesGuard(ts, source, node, functions, seen = new Set()) {
  let matched = null
  walk(ts, node, candidate => {
    if (matched) return false
    if (ts.isIdentifier(candidate) && GUARD_NAMES.has(candidate.text)) {
      matched = { guard: candidate.text, reason: recognizedGuards.find(guard => guard.name === candidate.text)?.reason }
      return false
    }
    if (ts.isPropertyAccessExpression(candidate) && GUARD_NAMES.has(candidate.name.text)) {
      matched = { guard: candidate.name.text, reason: recognizedGuards.find(guard => guard.name === candidate.name.text)?.reason }
      return false
    }
    if (ts.isCallExpression(candidate)) {
      const name = calleeName(ts, candidate)?.split('.').at(-1)?.replace(/\(\)$/, '')
      if (name && functions.has(name) && !seen.has(name)) {
        seen.add(name)
        matched = referencesGuard(ts, source, functions.get(name), functions, seen)
        if (matched) return false
      }
    }
    return undefined
  })
  if (matched) return matched
  if (ts.isIdentifier(node) && functions.has(node.text) && !seen.has(node.text)) {
    seen.add(node.text)
    return referencesGuard(ts, source, functions.get(node.text), functions, seen)
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(ts, node)?.split('.').at(-1)?.replace(/\(\)$/, '')
    if (name && functions.has(name) && !seen.has(name)) {
      seen.add(name)
      return referencesGuard(ts, source, functions.get(name), functions, seen)
    }
  }
  return null
}

function guardForHandlers(ts, source, handlers, functions) {
  for (const handler of handlers) {
    const guard = referencesGuard(ts, source, handler, functions)
    if (guard) return guard
  }
  return null
}

function routeCallInfo(ts, call, env, routerNames, appNames) {
  const expression = unwrapExpression(ts, call.expression)
  if (!ts.isPropertyAccessExpression(expression)) return null
  const method = expression.name.text
  if (!ROUTE_METHODS.has(method)) return null

  const targetName = expressionName(ts, expression.expression)
  const routeChain = findRouteChain(ts, expression.expression)
  if (routeChain) {
    const { owner, routeCall } = routeChain
    const routePath = routeCall.arguments[0] ? evaluateString(ts, routeCall.arguments[0], env) : null
    return {
      owner,
      ownerKind: appNames.has(owner) ? 'app' : routerNames.has(owner) ? 'router' : 'unknown',
      method,
      path: routePath ? normalizeRoutePath(routePath) : '<non-literal>',
      handlers: [...call.arguments],
    }
  }

  function findRouteChain(ts, node) {
    const current = unwrapExpression(ts, node)
    if (!ts.isCallExpression(current)) return null
    const expression = unwrapExpression(ts, current.expression)
    if (!ts.isPropertyAccessExpression(expression)) return null
    if (expression.name.text === 'route') {
      const owner = expressionName(ts, expression.expression)
      return owner ? { owner, routeCall: current } : null
    }
    if (ROUTE_METHODS.has(expression.name.text)) return findRouteChain(ts, expression.expression)
    return null
  }

  const owner = targetName
  if (!owner || (!routerNames.has(owner) && !appNames.has(owner))) return null
  const routePath = call.arguments[0] ? evaluateString(ts, call.arguments[0], env) : null
  return {
    owner,
    ownerKind: appNames.has(owner) ? 'app' : 'router',
    method,
    path: routePath ? normalizeRoutePath(routePath) : '<non-literal>',
    handlers: [...call.arguments].slice(1),
  }
}

function useCallInfo(ts, call, env, routerNames) {
  const name = calleeName(ts, call)
  if (!name?.endsWith('.use')) return null
  const owner = name.slice(0, -4)
  if (!routerNames.has(owner)) return null
  const first = call.arguments[0]
  const prefix = first ? evaluateString(ts, first, env) : null
  const startsWithPath = prefix !== null
  return {
    owner,
    prefix: startsWithPath ? normalizeRoutePath(prefix) : '/',
    handlers: [...call.arguments].slice(startsWithPath ? 1 : 0),
  }
}

function analyzeSourceFile(ts, file, text, options = {}) {
  const source = parseTypeScript(ts, file, text)
  const facts = collectLexicalFacts(ts, source)
  const uses = []
  const routes = []
  const directAppRoutes = []
  const findings = []

  walk(ts, source, node => {
    if (!ts.isCallExpression(node)) return undefined
    const use = useCallInfo(ts, node, facts.stringEnv, facts.routerNames)
    if (use) {
      const guard = guardForHandlers(ts, source, use.handlers, facts.functions)
      if (guard) uses.push({ ...use, line: lineOf(source, node), guardReason: guard.reason ?? guard.guard })
      return undefined
    }
    const info = routeCallInfo(ts, node, facts.stringEnv, facts.routerNames, facts.appNames)
    if (!info) return undefined
    const route = {
      file,
      line: lineOf(source, node),
      method: info.method.toUpperCase(),
      path: info.path,
      fullPath: info.ownerKind === 'app'
        ? info.path
        : joinRoutes('/api', info.path),
      guarded: false,
      guardReason: null,
      guardName: null,
      ownerKind: info.ownerKind,
    }
    const handlerGuard = guardForHandlers(ts, source, info.handlers, facts.functions)
    const cover = uses.find(use => use.owner === info.owner && use.line < route.line && pathCovers(use.prefix, info.path))
    const publicReason = routePolicyReason(route, publicRoutes)
    const authenticatedReason = routePolicyReason(route, authenticatedOnlyRoutes)
    const directAllow = info.ownerKind === 'app'
      ? directAppRouteAllowlist.find(entry => entry.file === file && (entry.path === route.path || entry.path === '<non-literal>'))
      : null
    if (publicReason) {
      route.guarded = true
      route.guardReason = publicReason
      route.guardName = 'public-policy'
    } else if (directAllow) {
      route.guarded = true
      route.guardReason = directAllow.reason
      route.guardName = 'direct-app-policy'
    } else if (handlerGuard) {
      route.guarded = true
      route.guardReason = handlerGuard.reason ?? handlerGuard.guard
      route.guardName = handlerGuard.guard
    } else if (cover) {
      route.guarded = true
      route.guardReason = cover.guardReason
      route.guardName = 'router.use'
    } else if (authenticatedReason) {
      route.guarded = true
      route.guardReason = authenticatedReason
      route.guardName = 'authenticated-policy'
    }
    routes.push(route)
    if (info.ownerKind === 'app') directAppRoutes.push(route)
    return undefined
  })

  for (const route of routes) {
    if (!route.guarded) {
      findings.push(finding({
        rule: 'access/unguarded-route',
        verdict: BLOCKER,
        file,
        line: route.line,
        message: `${route.method} ${route.fullPath} has no recognized route guard.`,
        hint: 'Add a workspace/admin guard or document an authenticated-only policy entry.',
      }))
    }
    if (!options.fullScan && route.guardName === 'getPrincipal' && options.isAdded?.(route.line)) {
      findings.push(finding({
        rule: 'access/get-principal-only',
        verdict: NOTE,
        file,
        line: route.line,
        message: `${route.method} ${route.fullPath} is guarded only by getPrincipal.`,
        hint: 'Confirm a downstream service performs the workspace or role check.',
      }))
    }
  }

  for (const route of directAppRoutes) {
    const allowed = routePolicyReason(route, publicRoutes) ||
      directAppRouteAllowlist.some(entry => entry.file === file && (entry.path === route.path || entry.path === '<non-literal>'))
    if (!allowed) {
      findings.push(finding({
        rule: 'access/direct-app-route',
        verdict: BLOCKER,
        file,
        line: route.line,
        message: `${route.method} ${route.path} is registered directly on the app.`,
        hint: 'Mount API routes on the authenticated /api router; /healthz is the only public app route.',
      }))
    }
  }

  return { source, routes, findings }
}

function analyzePrincipalHeaders(file, text) {
  if (principalHeaderAllowedFiles.some(entry => entry.file === file)) return []
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    if (/\bx-ms-client-principal\b|\bx-score-dev-principal\b/i.test(lines[index])) {
      findings.push(finding({
        rule: 'access/principal-header-read',
        verdict: BLOCKER,
        file,
        line: index + 1,
        message: 'Principal headers are read outside the auth middleware boundary.',
        hint: 'Use getPrincipal(req) after createAuthMiddleware instead.',
      }))
    }
  }
  return findings
}

function analyzeCors(file, text, ts) {
  const source = parseTypeScript(ts, file, text)
  const findings = []
  walk(ts, source, node => {
    if (ts.isImportDeclaration(node) && stringLiteralValue(ts, node.moduleSpecifier) === 'cors') {
      findings.push(finding({
        rule: 'access/permissive-cors',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'The cors package is imported on the server.',
        hint: 'Do not add CORS to Score; same-origin API calls are enforced by CSRF middleware.',
      }))
    }
    if (!ts.isCallExpression(node)) return undefined
    const name = calleeName(ts, node)
    if (name === 'require' && stringLiteralValue(ts, node.arguments[0]) === 'cors') {
      findings.push(finding({
        rule: 'access/permissive-cors',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'The cors package is required on the server.',
        hint: 'Do not add CORS to Score; same-origin API calls are enforced by CSRF middleware.',
      }))
    }
    const first = stringLiteralValue(ts, node.arguments[0])
    if (!first) return undefined
    const lower = first.toLowerCase()
    if (lower === 'access-control-allow-origin') {
      const second = node.arguments[1]
      const value = stringLiteralValue(ts, second)
      const secondText = second ? textOf(source, second) : ''
      if (value === '*' || /req\.headers\.origin|req\.header\(['"]origin['"]\)/i.test(secondText)) {
        findings.push(finding({
          rule: 'access/permissive-cors',
          verdict: BLOCKER,
          file,
          line: lineOf(source, node),
          message: 'Access-Control-Allow-Origin is permissive or reflects the request origin.',
          hint: 'Keep APIs same-origin and rely on the CSRF middleware.',
        }))
      }
    }
    if (lower === 'access-control-allow-credentials') {
      findings.push(finding({
        rule: 'access/permissive-cors',
        verdict: BLOCKER,
        file,
        line: lineOf(source, node),
        message: 'Access-Control-Allow-Credentials is set by server code.',
        hint: 'Do not enable credentialed cross-origin API access.',
      }))
    }
    return undefined
  })
  return findings
}

function analyzeQueryConstruction(file, text, ts, isAdded = () => true) {
  const source = parseTypeScript(ts, file, text)
  const findings = []
  const queryWords = /\b(SELECT|WHERE)\b|FROM\s+c\b/i
  const unsafeQueryExpression = node => {
    const current = unwrapExpression(ts, node)
    if (!current) return false
    if (ts.isTemplateExpression(current) && queryWords.test(textOf(source, current))) return true
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken && queryWords.test(textOf(source, current))) return true
    return false
  }
  walk(ts, source, node => {
    if (!ts.isPropertyAssignment(node) || propertyName(ts, node.name) !== 'query') return undefined
    const line = lineOf(source, node.initializer)
    if (!isAdded(line) || !unsafeQueryExpression(node.initializer)) return undefined
    findings.push(finding({
      rule: 'access/query-interpolation',
      verdict: REVIEW,
      file,
      line,
      message: 'Database query text is built with interpolation or concatenation.',
      hint: 'Use parameterized @name values instead of building query text from expressions.',
    }))
    return undefined
  })
  return findings
}

function analyzeHealthzChanges(file, text, ts, isAdded = () => true) {
  if (file !== 'server/app.ts') return []
  const source = parseTypeScript(ts, file, text)
  const starts = lineStarts(text)
  const findings = []
  walk(ts, source, node => {
    if (!ts.isCallExpression(node)) return undefined
    const name = calleeName(ts, node)
    if (name !== 'app.get' || stringLiteralValue(ts, node.arguments[0]) !== '/healthz') return undefined
    const start = lineOf(source, node)
    const end = lineFromOffset(starts, node.getEnd())
    for (let line = start; line <= end; line++) {
      if (isAdded(line)) {
        findings.push(finding({
          rule: 'access/healthz-change',
          verdict: REVIEW,
          file,
          line,
          message: '/healthz handler changed.',
          hint: 'Confirm it remains anonymous and exposes only health status.',
        }))
        break
      }
    }
    return undefined
  })
  return findings
}

function analyzeGuardHelperChanges(file, fileObject) {
  const policy = guardHelperFiles.find(entry => entry.file === file)
  if (!policy) return []
  const findings = []
  for (const { line } of fileObject.addedLines ?? []) {
    findings.push(finding({
      rule: 'access/guard-helper-change',
      verdict: REVIEW,
      file,
      line,
      message: `Guard helper file changed: ${policy.exports.join(', ')}.`,
      hint: policy.reason,
    }))
  }
  for (const { line } of fileObject.removedLines ?? []) {
    findings.push(finding({
      rule: 'access/guard-helper-change',
      verdict: REVIEW,
      file,
      line,
      side: 'base',
      message: `Guard helper file changed: ${policy.exports.join(', ')}.`,
      hint: policy.reason,
    }))
  }
  return findings
}

function analyzeAppWiring(file, text) {
  if (file !== 'server/app.ts') return []
  const findings = []
  let previous = -1
  for (const matcher of appWiringOrder) {
    const index = text.indexOf(matcher.contains)
    if (index < 0) {
      findings.push(finding({
        rule: 'access/app-wiring-order',
        verdict: BLOCKER,
        file,
        line: 1,
        message: `server/app.ts is missing ${matcher.id} wiring.`,
        hint: matcher.reason,
      }))
      continue
    }
    if (index < previous) {
      findings.push(finding({
        rule: 'access/app-wiring-order',
        verdict: BLOCKER,
        file,
        line: text.slice(0, index).split(/\r?\n/).length,
        message: `server/app.ts wires ${matcher.id} out of order.`,
        hint: 'Keep the documented order: noStore, auth, CSRF, settings context, feature routers, /api 404, SPA auth, SPA mount.',
      }))
    }
    previous = Math.max(previous, index)
  }
  return findings
}

function analyzeDevHeaderGuard(file, text) {
  if (file !== devHeaderGuard.file) return []
  if (text.includes(devHeaderGuard.contains)) return []
  return [finding({
    rule: 'access/dev-header-production-guard',
    verdict: BLOCKER,
    file,
    line: 1,
    message: 'The dev principal header production/App Service guard is missing or weakened.',
    hint: devHeaderGuard.reason,
  })]
}

/** Server TypeScript files in the working tree. Symbolic links are skipped, so the walk can't loop or leave the repository. */
function readServerFiles(repoRoot) {
  const files = []
  const visit = relativeDir => {
    let entries
    try {
      entries = readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) visit(relative)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push({ path: relative, text: readFileSync(path.join(repoRoot, relative), 'utf8') })
      }
    }
  }
  visit('server')
  return files
}

function filesFromInput(input) {
  if (typeof input === 'string') return readServerFiles(input)
  if (Array.isArray(input)) return input.map(file => ({ path: posix(file.path), text: file.text }))
  if (input && typeof input === 'object' && input.files) return filesFromInput(input.files)
  throw new Error('extractRoutes expects a repository root or an array of { path, text } files.')
}

export function extractRoutes(input) {
  const files = filesFromInput(input)
  const ts = loadTypeScript(typeof input === 'string' ? input : process.cwd())
  const routes = []
  for (const file of files) {
    if (!SERVER_TS.test(file.path)) continue
    routes.push(...analyzeSourceFile(ts, file.path, file.text, { fullScan: true }).routes)
  }
  return routes
    .filter(route => route.path !== '<non-literal>' || route.file === 'server/static.ts')
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file))
}

export function analyzeAccessControl(files, options = {}) {
  const ts = loadTypeScript(options.repoRoot ?? process.cwd())
  const findings = []
  const routes = []
  for (const file of files) {
    const filePath = posix(file.path)
    const text = file.text ?? ''
    if (!SERVER_TS.test(filePath)) continue
    const added = file.addedLines instanceof Set ? line => file.addedLines.has(line)
      : Array.isArray(file.addedLines) ? line => file.addedLines.some(item => (typeof item === 'number' ? item : item.line) === line)
        : () => true
    const analysis = analyzeSourceFile(ts, filePath, text, { fullScan: options.fullScan, isAdded: added })
    routes.push(...analysis.routes)
    findings.push(
      ...analysis.findings,
      ...analyzePrincipalHeaders(filePath, text),
      ...analyzeCors(filePath, text, ts),
      ...analyzeQueryConstruction(filePath, text, ts, added),
      ...analyzeHealthzChanges(filePath, text, ts, added),
      ...analyzeAppWiring(filePath, text),
      ...analyzeDevHeaderGuard(filePath, text),
    )
    if (!options.fullScan && file.fileObject) findings.push(...analyzeGuardHelperChanges(filePath, file.fileObject))
  }
  return { findings, routes }
}

export const spec = {
  id: 'access-control',
  title: 'Access control',
  description: 'Checks Express API routes, auth middleware ordering, principal-header usage, CORS, and access-sensitive route changes.',
  includeFile: file => SERVER_TS.test(posix(file)),
  async check(ctx) {
    const findings = []
    const allRoutes = []
    for (const file of ctx.files) {
      if (file.binary) continue
      const text = file.text()
      if (text === null) continue
      const result = analyzeAccessControl([{
        path: file.path,
        text,
        addedLines: file.addedLines,
        fileObject: file,
      }], { repoRoot: ctx.repoRoot, fullScan: ctx.fullScan })
      allRoutes.push(...result.routes)
      findings.push(...scopeToChanges(file, result.findings))
    }
    for (const deleted of ctx.deletedFiles) {
      findings.push(...analyzeGuardHelperChanges(deleted.path, deleted))
    }
    const inventory = ctx.fullScan ? allRoutes : extractRoutes(ctx.repoRoot)
    const reasons = new Map()
    for (const route of inventory) {
      const key = route.guardReason ?? 'unguarded'
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    ctx.notes.push(`Route inventory: ${inventory.length} routes. Guard reasons: ${
      [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} ${reason}`).join('; ')
    }.`)
    return findings
  },
}

if (isMain(import.meta.url)) await main(spec)
