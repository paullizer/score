import { createRequire } from 'node:module'
import path from 'node:path'

let typescript

/** Loads the repository's TypeScript compiler (a devDependency), falling back to the one next to these scripts. */
export function loadTypeScript(repoRoot = process.cwd()) {
  if (typescript) return typescript
  const candidates = [path.join(repoRoot, 'package.json'), import.meta.url]
  for (const candidate of candidates) {
    try {
      typescript = createRequire(candidate)('typescript')
      return typescript
    } catch {
      // try the next location
    }
  }
  throw new Error('The TypeScript compiler is not installed. Run npm ci first.')
}

export function scriptKindFor(ts, file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export function parseTypeScript(ts, file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file))
}

/** 1-based line where the node's own text starts (ignoring leading comments). */
export function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

export function endLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
}

/** Depth-first walk. `visit(node, ancestors)` may return false to skip the node's children. */
export function walk(ts, root, visit) {
  const ancestors = []
  const step = node => {
    if (visit(node, ancestors) === false) return
    ancestors.push(node)
    ts.forEachChild(node, step)
    ancestors.pop()
  }
  step(root)
}

export function unwrapExpression(ts, node) {
  let current = node
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression?.(current)
    || ts.isSatisfiesExpression?.(current)
    || ts.isAwaitExpression(current)
  )) current = current.expression
  return current
}

/** Dotted name for identifiers and property chains: `res.setHeader`, `window.location.href`, `this.client.get`. */
export function expressionName(ts, node) {
  const current = unwrapExpression(ts, node)
  if (!current) return null
  if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) return current.text
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (current.kind === ts.SyntaxKind.SuperKeyword) return 'super'
  if (ts.isPropertyAccessExpression(current)) {
    const left = expressionName(ts, current.expression)
    return left ? `${left}.${current.name.text}` : null
  }
  if (ts.isElementAccessExpression(current)) {
    const left = expressionName(ts, current.expression)
    const key = stringLiteralValue(ts, current.argumentExpression)
    return left && key !== null ? `${left}.${key}` : null
  }
  if (ts.isCallExpression(current)) {
    const left = expressionName(ts, current.expression)
    return left ? `${left}()` : null
  }
  return null
}

export function calleeName(ts, call) {
  return expressionName(ts, call.expression)
}

/** Value of a string literal or a template literal without substitutions; otherwise null. */
export function stringLiteralValue(ts, node) {
  const current = unwrapExpression(ts, node)
  if (!current) return null
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text
  return null
}

/** Name of a property in an object literal or JSX attribute (identifier, string or computed string key). */
export function propertyName(ts, name) {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isComputedPropertyName(name)) return stringLiteralValue(ts, name.expression)
  if (ts.isJsxNamespacedName?.(name)) return `${name.namespace.text}:${name.name.text}`
  return null
}

/** The closest enclosing function-like ancestor, or null at module level. */
export function enclosingFunction(ts, ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    if (ts.isFunctionLike(ancestors[index])) return ancestors[index]
  }
  return null
}
