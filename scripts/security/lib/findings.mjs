import { riskArea } from './paths.mjs'

export const BLOCKER = 'blocker'
export const REVIEW = 'review'
export const NOTE = 'note'

const VERDICT_ORDER = { [BLOCKER]: 0, [REVIEW]: 1, [NOTE]: 2 }

/**
 * A finding. `rule` is a stable id such as `xss/inner-html`; it is what a suppression names.
 * `line` is 1-based and refers to the head version of the file (or the base version for removed lines,
 * in which case `side` is 'base').
 */
export function finding({ rule, verdict, file, line, message, hint, side = 'head' }) {
  if (!rule || !Object.hasOwn(VERDICT_ORDER, verdict)) throw new Error(`Invalid finding: ${JSON.stringify({ rule, verdict })}`)
  return {
    rule,
    verdict,
    file: file ?? null,
    line: Number.isInteger(line) && line > 0 ? line : null,
    side,
    message,
    hint: hint ?? null,
    area: file ? riskArea(file) : 'other',
  }
}

export function sortFindings(findings) {
  return findings.sort((a, b) =>
    VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
    || String(a.file).localeCompare(String(b.file))
    || (a.line ?? 0) - (b.line ?? 0)
    || a.rule.localeCompare(b.rule))
}

export function dedupeFindings(findings) {
  const seen = new Set()
  return findings.filter(item => {
    const key = `${item.rule}|${item.verdict}|${item.file}|${item.line}|${item.side}|${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function summarize(findings) {
  return {
    blockers: findings.filter(item => item.verdict === BLOCKER).length,
    review: findings.filter(item => item.verdict === REVIEW).length,
    notes: findings.filter(item => item.verdict === NOTE).length,
  }
}

/**
 * Guardrail convention for one touched file: blockers are whole-file invariants and are always kept;
 * review and note findings are kept only when they sit on an added line. Findings without a head line are kept.
 */
export function scopeToChanges(file, findings) {
  return findings.filter(item => item.verdict === BLOCKER || !item.line || item.side !== 'head' || file.isAdded(item.line))
}

export const SUPPRESSION_TOKEN = 'security-reviewed:'
export const MIN_SUPPRESSION_REASON = 10
const SUPPRESSION_PATTERN = /security-reviewed:\s*([a-z0-9][\w./-]*)(?:\s*--\s*(.*))?$/i

/** Parses `security-reviewed: <rule-id> -- <reason>` from one line of any comment style. */
export function parseSuppression(lineText) {
  if (!lineText || !lineText.includes(SUPPRESSION_TOKEN)) return null
  const match = SUPPRESSION_PATTERN.exec(lineText)
  if (!match) return null
  const reason = (match[2] ?? '')
    .replace(/\s*(\*\/\s*\}?|--!?>|#\}|%\})\s*$/, '')
    .trim()
  return { rule: match[1], reason, valid: reason.length >= MIN_SUPPRESSION_REASON }
}

/**
 * Applies suppressions found on the finding's line or up to two lines above it.
 * `linesFor(file)` returns the head file split into lines (0-based array) or null.
 */
export function applySuppressions(findings, linesFor) {
  const kept = []
  const suppressed = []
  for (const item of findings) {
    if (!item.file || !item.line || item.side !== 'head') {
      kept.push(item)
      continue
    }
    const lines = linesFor(item.file)
    let match = null
    for (let offset = 0; offset <= 2 && !match; offset++) {
      const candidate = parseSuppression(lines?.[item.line - 1 - offset])
      if (candidate && candidate.rule === item.rule) match = candidate
    }
    if (match?.valid) suppressed.push({ ...item, reason: match.reason })
    else if (match) kept.push({ ...item, message: `${item.message} (suppression ignored: add a reason of at least ${MIN_SUPPRESSION_REASON} characters after "--")` })
    else kept.push(item)
  }
  return { findings: kept, suppressed }
}
