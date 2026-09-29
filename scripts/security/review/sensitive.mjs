import { matchesAny } from '../lib/paths.mjs'
import { guardrailGlobs, sensitiveFiles } from '../policy/review.mjs'
import { REVIEW, addFinding, isProse } from './common.mjs'

const SENSITIVE_PATTERN = /Content-Security-Policy|\bsandbox\b|DOMPurify|x-ms-client-principal|x-score-dev-principal|X-Score-Request|\bcsrf\b|safeFetch|validatePublicUrl|rejectUnauthorized/i

export function checkSensitive(ctx) {
  const findings = []
  const guardrailPatterns = guardrailGlobs.map(item => item.glob)
  for (const file of [...ctx.files, ...ctx.deletedFiles]) {
    if (sensitiveFiles.some(item => item.file === file.path)) addFinding(findings, { rule: 'review/security-control-file', verdict: REVIEW, file: file.path, line: file.addedLines?.[0]?.line ?? 1, message: 'Security-control file changed.', hint: 'Review auth, SSRF, CSRF or sanitization behavior.' })
    const guardrailFile = matchesAny(file.path, guardrailPatterns)
    if (guardrailFile) addFinding(findings, { rule: 'review/guardrail-tooling-changed', verdict: REVIEW, file: file.path, line: file.addedLines?.[0]?.line ?? 1, message: 'Security guardrail or tooling file changed.', hint: 'Review changes to security automation or build guardrails.' })
    // Guardrail files are already reviewed as a whole, and prose only describes the controls.
    if (ctx.fullScan || guardrailFile || isProse(file.path) || file.binary || file.text?.() === null) continue
    for (const { line, text } of file.addedLines ?? []) {
      if (SENSITIVE_PATTERN.test(text)) addFinding(findings, { rule: 'review/security-control-pattern', verdict: REVIEW, file: file.path, line, message: 'Security-control-related pattern changed.', hint: 'Review the control boundary and tests.' })
    }
    for (const { line, text } of file.removedLines ?? []) {
      if (SENSITIVE_PATTERN.test(text)) addFinding(findings, { rule: 'review/security-control-pattern', verdict: REVIEW, file: file.path, side: 'base', line, message: 'Security-control-related pattern was removed.', hint: 'Review the control boundary and tests.' })
    }
  }
  return findings
}
