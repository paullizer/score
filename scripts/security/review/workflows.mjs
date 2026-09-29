import { BLOCKER, REVIEW, addFinding } from './common.mjs'

function isWorkflow(file) {
  return file.startsWith('.github/workflows/') || file.startsWith('.github/actions/')
}

function indentation(text) {
  return /^\s*/.exec(text)?.[0].length ?? 0
}

function stripYamlComment(text) {
  let quote = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#') {
      return text.slice(0, index)
    }
  }
  return text
}

function yamlTokenPattern(token) {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])["']?${token}["']?(?=$|[^A-Za-z0-9_-])`, 'i')
}

function containsYamlToken(text, token) {
  return yamlTokenPattern(token).test(stripYamlComment(text))
}

const TRIGGER_KEY = /(^[ \t]*|[{,][ \t]*)["']?on["']?[ \t]*:/gi
const SCRIPT_KEY = /(^[ \t]*(?:-[ \t]+)?|[{,[][ \t]*)["']?(?:run|script)["']?[ \t]*:(?=[ \t]|$)/g
// Expression property names are case-insensitive, and `github['event']` is the same as `github.event`.
const UNTRUSTED_CONTEXT = /\bgithub\s*(?:\.\s*(?:event|head_ref)\b|\[\s*['"](?:event|head_ref)['"]\s*\])|\btojson\s*\(\s*github\s*\)/i

// Returns the text after each `key:` plus every later line indented deeper than the key, which is
// how YAML continues block, plain and quoted scalars and nested mappings. Comment lines never end a value.
function keyedValues(lines, pattern) {
  const values = []
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(pattern)) {
      const column = match.index + match[1].length
      const parts = [{ line: index + 1, text: lines[index].slice(match.index + match[0].length) }]
      for (let next = index + 1; next < lines.length; next++) {
        const text = lines[next]
        if (text.trim() && !/^\s*#/.test(text) && indentation(text) <= column) break
        parts.push({ line: next + 1, text })
      }
      values.push(parts)
    }
  }
  return values
}

function triggerLines(lines, token) {
  const hits = new Set()
  for (const parts of keyedValues(lines, TRIGGER_KEY)) {
    for (const part of parts) if (containsYamlToken(part.text, token)) hits.add(part.line)
  }
  return [...hits]
}

// Double-quoted YAML can spell an expression with escapes such as "\x24{{" or split it with an escaped
// line break, so decode those and remember the source line of every character.
function decodeValue(parts) {
  let text = ''
  const lineOf = []
  let joinNext = false
  parts.forEach((part, index) => {
    let raw = joinNext ? part.text.replace(/^[ \t]+/, '') : part.text
    joinNext = index < parts.length - 1 && /(?:^|[^\\])(?:\\\\)*\\$/.test(raw)
    if (joinNext) raw = raw.slice(0, -1)
    const decoded = raw.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g, (escape, x, u, U) => {
      const point = parseInt(x ?? u ?? U, 16)
      return point <= 0x10ffff ? String.fromCodePoint(point) : escape
    })
    const chunk = joinNext || index === parts.length - 1 ? decoded : `${decoded}\n`
    text += chunk
    for (let count = 0; count < chunk.length; count++) lineOf.push(part.line)
  })
  return { text, lineOf }
}

// A `}}` inside a quoted expression string does not end the expression.
function expressions(text) {
  const found = []
  let start = text.indexOf('${{')
  while (start >= 0) {
    let end = text.length
    let quoted = false
    for (let index = start + 3; index < text.length; index++) {
      if (text[index] === "'") quoted = !quoted
      else if (!quoted && text.startsWith('}}', index)) {
        end = index + 2
        break
      }
    }
    found.push({ start, end })
    start = text.indexOf('${{', end)
  }
  return found
}

function usesRef(value) {
  const match = /^\s*-?\s*uses:\s*([^\s#]+)/i.exec(value)
  if (!match) return null
  const spec = match[1].replace(/^['"]|['"]$/g, '')
  if (spec.startsWith('./')) return { local: true, spec }
  if (spec.startsWith('docker://') && spec.includes('@sha256:')) return { dockerPinned: true, spec }
  const at = spec.lastIndexOf('@')
  return { spec, ref: at >= 0 ? spec.slice(at + 1) : null }
}

function checkoutPersistFalse(lines, usesLine) {
  const baseIndent = indentation(lines[usesLine - 1])
  for (let index = usesLine; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() && indentation(line) <= baseIndent && /^\s*-?\s*(?:name:|uses:|run:)/.test(line)) break
    if (/persist-credentials\s*:\s*false/i.test(line)) return true
  }
  return false
}

export function checkWorkflows(ctx) {
  const findings = []
  for (const file of ctx.files.filter(item => isWorkflow(item.path))) {
    const lines = file.lines()
    for (const line of triggerLines(lines, 'pull_request_target')) {
      if (file.isAdded(line)) addFinding(findings, { rule: 'review/workflow-pull-request-target', verdict: BLOCKER, file: file.path, line, message: 'Workflow uses pull_request_target.', hint: 'Use pull_request for untrusted PR code.' })
    }
    for (const line of triggerLines(lines, 'workflow_run')) {
      if (file.isAdded(line)) addFinding(findings, { rule: 'review/workflow-run-trigger', verdict: REVIEW, file: file.path, line, message: 'Workflow uses workflow_run trigger.', hint: 'Confirm the upstream workflow cannot be attacker-controlled.' })
    }
    for (const { line, text } of file.addedLines) {
      if (/echo|Write-Host|printf/i.test(text) && /\$\{\{\s*secrets\./i.test(text)) addFinding(findings, { rule: 'review/workflow-echo-secrets', verdict: BLOCKER, file: file.path, line, message: 'Workflow echoes a secret expression.', hint: 'Never print secrets.' })
      if (/toJSON\s*\(\s*secrets\s*\)/i.test(text)) addFinding(findings, { rule: 'review/workflow-echo-secrets', verdict: BLOCKER, file: file.path, line, message: 'Workflow serializes all secrets.', hint: 'Never serialize secrets.' })
      if (/ACTIONS_ALLOW_UNSECURE_COMMANDS/i.test(text)) addFinding(findings, { rule: 'review/workflow-unsafe-commands', verdict: BLOCKER, file: file.path, line, message: 'Workflow enables insecure commands.', hint: 'Do not set ACTIONS_ALLOW_UNSECURE_COMMANDS.' })
      const uses = usesRef(text)
      if (uses && !uses.local && !uses.dockerPinned) {
        if (!uses.ref || /^(?:main|master|latest|HEAD)$/i.test(uses.ref) || uses.ref.includes('${{')) addFinding(findings, { rule: 'review/workflow-uses-floating', verdict: BLOCKER, file: file.path, line, message: 'Workflow action reference is floating or dynamic.', hint: 'Pin third-party actions to a full commit SHA.' })
        else if (!/^[a-f0-9]{40}$/i.test(uses.ref)) addFinding(findings, { rule: 'review/workflow-uses-not-sha', verdict: REVIEW, file: file.path, line, message: 'Workflow action is not pinned to a 40-character SHA.', hint: 'Pin third-party actions to a full commit SHA.' })
        if (/^actions\/checkout@/i.test(uses.spec) && !checkoutPersistFalse(lines, line)) addFinding(findings, { rule: 'review/workflow-checkout-credentials', verdict: REVIEW, file: file.path, line, message: 'actions/checkout does not set persist-credentials: false.', hint: 'Set persist-credentials: false unless later git pushes are required.' })
      }
      if (/\bwrite-all\b|^\s*[a-z-]+\s*:\s*write\s*$/i.test(text)) addFinding(findings, { rule: 'review/workflow-write-permission', verdict: REVIEW, file: file.path, line, message: 'Workflow grants write permissions.', hint: 'Use least-privilege GitHub token permissions.' })
      if (/\bself-hosted\b/i.test(text)) addFinding(findings, { rule: 'review/workflow-self-hosted', verdict: REVIEW, file: file.path, line, message: 'Workflow uses self-hosted runners.', hint: 'Confirm runner isolation for untrusted code.' })
      if (/\bsecrets\./i.test(text)) addFinding(findings, { rule: 'review/workflow-secret-reference', verdict: REVIEW, file: file.path, line, message: 'Workflow references a secret.', hint: 'Confirm the secret is not exposed to untrusted code.' })
    }
    const flagged = new Set()
    for (const parts of keyedValues(lines, SCRIPT_KEY)) {
      const { text, lineOf } = decodeValue(parts)
      for (const { start, end } of expressions(text)) {
        if (!UNTRUSTED_CONTEXT.test(text.slice(start, end))) continue
        const line = [...new Set(lineOf.slice(start, end))].find(item => file.isAdded(item))
        if (!line || flagged.has(line)) continue
        flagged.add(line)
        addFinding(findings, { rule: 'review/workflow-untrusted-run-context', verdict: BLOCKER, file: file.path, line, message: 'Workflow run script uses untrusted pull request context directly.', hint: 'Pass values through env and quote them safely.' })
      }
    }
  }
  return findings
}
