import { matchesAny } from '../lib/paths.mjs'
import { agentSurfaceGlobs } from '../policy/review.mjs'
import { REVIEW, addFinding, isReviewerContentExempt } from './common.mjs'

const INJECTION = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|disregard\b.{0,80}\binstructions|you are now|do not (?:tell|inform) the user|system prompt)\b/i

export function checkAgents(ctx) {
  const findings = []
  for (const file of ctx.files) {
    if (matchesAny(file.path, agentSurfaceGlobs.map(item => item.glob))) {
      addFinding(findings, { rule: 'review/agent-surface-changed', verdict: REVIEW, file: file.path, line: file.addedLines[0]?.line ?? 1, message: 'Agent or prompt surface changed.', hint: 'Review instruction and MCP changes carefully.' })
    }
    if (file.binary || file.text() === null || isReviewerContentExempt(file.path)) continue
    for (const { line, text } of file.addedLines) {
      if (INJECTION.test(text)) addFinding(findings, { rule: 'review/prompt-injection-phrase', verdict: REVIEW, file: file.path, line, message: 'Prompt-injection-like instruction phrase was added.', hint: 'Confirm this text cannot steer automation unexpectedly.' })
    }
  }
  return findings
}
