import { dataBlobAssetAllowlist } from '../policy/review.mjs'
import { isDocPath, isTestPath, matchesAny } from '../lib/paths.mjs'
import { BLOCKER, REVIEW, addFinding, downgradeForTestOrDoc, isMetadataAllowed, isProse, isReviewerContentExempt } from './common.mjs'

const EXFIL_HOST = /(?:webhook\.site|\brequestbin\b|m\.pipedream\.net|pipedream\.net|ngrok(?:-free)?\.app|ngrok\.io|\binteractsh\b|(?:^|[./])oast\.(?:live|site|fun|online|pro|me)|burpcollaborator|oastify|\brequestcatcher\b|\bhookbin\b|\bbeeceptor\b|pastebin\.com|paste\.ee|transfer\.sh|serveo\.net|localtunnel\.me|trycloudflare\.com|\bdnslog\b|ceye\.io|\bcanarytokens\b|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot)/i
const METADATA = /(?:169\.254\.169\.254|metadata\.google\.internal|169\.254\.170\.2|fd00:ec2::254|100\.100\.100\.200)/i
const ENV_DUMP = /JSON\.stringify\s*\(\s*process\.env|(?:^|[;&|]\s*)printenv(?:\s|$)|(?:^|[;&|]\s*)env\s*\||Get-ChildItem\s+env:|(?:^|[;&|]\s*)gci\s+env:|(?:^|[;&|]\s*)dir\s+env:|toJSON\s*\(\s*secrets\s*\)/i
const DECODE_EXEC = /(?:eval|Function|new\s+Function).*(?:atob|Buffer\.from)|(?:curl|wget)\b.*\|\s*(?:sh|bash)\b|(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|\s*(?:iex|Invoke-Expression)\b|(?:-|\/)(?:EncodedCommand|enc)\s+[A-Za-z0-9+/=]{20,}|base64\s+-d\s*\|\s*sh\b/i
const RISK_IMPORT = /\b(?:import|require)\s*(?:\(|\s).*['"](?:node:)?(?:child_process|vm|worker_threads)['"]/i
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:['"]data:|[A-Za-z_$][\w$]*|`[^`]*\$\{)/i
const BLOB = /\b(?:[A-Za-z0-9+/]{200,}={0,2}|[a-f0-9]{200,})\b/i
const LINT_DISABLE = /eslint-disable|@ts-ignore|@ts-nocheck/
const TEST_SKIP_ONLY = /(?:\.(?:skip|only)\s*\(|\b(?:test|describe)\.(?:skip|only)\s*\(|\{\s*(?:skip|only)\s*:\s*true\s*\})/
const SUPPRESSION = /security-reviewed:/
const TEST_CALL = /\b(?:test|it)\s*\(/

const SECRET_PATTERNS = [
  ['review/secret-github-token', /(?:gh[pousr]_)[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['review/secret-aws-key', /AKIA[0-9A-Z]{16}/],
  ['review/secret-slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['review/secret-google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['review/secret-stripe-key', /sk_live_[0-9A-Za-z]{10,}/],
  ['review/secret-npm-token', /npm_[A-Za-z0-9]{36}/],
  ['review/secret-azure-storage-key', /AccountKey=[A-Za-z0-9+/=]{80,}/],
  ['review/private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

function urlHosts(line) {
  const result = []
  for (const match of line.matchAll(/\bhttps?:\/\/[^\s'"<>)]+/gi)) {
    try {
      result.push(new URL(match[0]).hostname.replace(/^\[|\]$/g, ''))
    } catch {
      // ignore malformed URLs
    }
  }
  return result
}

function ipv4Public(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 203 && b === 0) return false
  return !(a === 192 && b === 0 && parts[2] === 2) && !(a === 198 && b === 51 && parts[2] === 100)
}

function ipv6Public(host) {
  const value = host.toLowerCase()
  if (!value.includes(':')) return false
  return !(value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb'))
}

function downgrade(file, verdict, preserve = false) {
  return downgradeForTestOrDoc(file, verdict, { preserve })
}

function skipBlob(file, line) {
  return /(?:^|\/)package-lock\.json$/.test(file)
    || /\.(?:svg|map)$/i.test(file)
    || (/data:(?:font|image)\//i.test(line) && matchesAny(file, dataBlobAssetAllowlist.map(item => item.glob)))
}

export function checkContent(ctx) {
  const findings = []
  for (const file of ctx.files) {
    if (file.binary || file.text() === null) continue
    if (/(^|\/)package-lock\.json$/.test(file.path)) continue
    const securityTool = file.path.startsWith('scripts/security/')
    const prose = isProse(file.path)
    const skipFullScanTestReview = ctx.fullScan && (isTestPath(file.path) || isDocPath(file.path))
    const exempt = isReviewerContentExempt(file.path)
    if (!exempt) {
      for (const { line, text } of file.addedLines) {
        const skipReviewRules = securityTool || prose || skipFullScanTestReview
        for (const [rule, pattern] of SECRET_PATTERNS) {
          if (pattern.test(text)) addFinding(findings, { rule, verdict: downgrade(file.path, BLOCKER, true), file: file.path, line, message: 'A high-confidence secret or private key was added.', hint: 'Remove the secret and rotate it if it was real.' })
        }
        if (EXFIL_HOST.test(text)) addFinding(findings, { rule: 'review/exfiltration-host', verdict: downgrade(file.path, BLOCKER), file: file.path, line, message: 'Known exfiltration or request-capture host was added.', hint: 'Remove callback, tunnel, paste or webhook endpoints.' })
        if (METADATA.test(text) && !isMetadataAllowed(file.path)) addFinding(findings, { rule: 'review/metadata-endpoint', verdict: downgrade(file.path, BLOCKER), file: file.path, line, message: 'Cloud metadata endpoint was added.', hint: 'Do not allow untrusted code or URLs to reach metadata services.' })
        for (const host of urlHosts(text)) {
          if (ipv4Public(host) || ipv6Public(host)) addFinding(findings, { rule: 'review/public-ip-url', verdict: downgrade(file.path, BLOCKER), file: file.path, line, message: 'URL uses a public IP literal.', hint: 'Use a named service endpoint or document why a direct IP is required.' })
        }
        if (ENV_DUMP.test(text)) addFinding(findings, { rule: 'review/environment-dump', verdict: downgrade(file.path, BLOCKER), file: file.path, line, message: 'Environment or secrets dump was added.', hint: 'Log only specific non-secret values.' })
        if (DECODE_EXEC.test(text)) addFinding(findings, { rule: 'review/decode-and-execute', verdict: downgrade(file.path, BLOCKER), file: file.path, line, message: 'Decode-and-execute or pipe-to-shell pattern was added.', hint: 'Download, verify and execute scripts explicitly.' })
        if (!securityTool && !prose && SUPPRESSION.test(text)) addFinding(findings, { rule: 'review/new-suppression', verdict: REVIEW, file: file.path, line, message: 'A new security-reviewed suppression was added.', hint: 'Confirm the suppression is necessary and specific.' })
        if (skipReviewRules) continue
        if (RISK_IMPORT.test(text)) addFinding(findings, { rule: 'review/risky-node-import', verdict: REVIEW, file: file.path, line, message: 'Sensitive Node module import was added.', hint: 'Review child process, vm or worker-thread usage.' })
        if (DYNAMIC_IMPORT.test(text)) addFinding(findings, { rule: 'review/dynamic-import', verdict: REVIEW, file: file.path, line, message: 'Dynamic import of data URL or non-literal specifier was added.', hint: 'Keep imports static where possible.' })
        if (!skipBlob(file.path, text) && BLOB.test(text)) addFinding(findings, { rule: 'review/large-encoded-blob', verdict: REVIEW, file: file.path, line, message: 'Large base64 or hex blob was added.', hint: 'Review generated or encoded content.' })
        if (LINT_DISABLE.test(text)) addFinding(findings, { rule: 'review/lint-disable', verdict: REVIEW, file: file.path, line, message: 'Lint or TypeScript checking was disabled.', hint: 'Prefer fixing the typed or linted issue.' })
        if (TEST_SKIP_ONLY.test(text)) addFinding(findings, { rule: 'review/test-skip-only', verdict: REVIEW, file: file.path, line, message: 'Test skip or only marker was added.', hint: 'Remove focused or skipped tests before merging.' })
      }
    }
  }
  for (const file of ctx.deletedFiles) {
    if (file.path.match(/(?:^|\/)(?:[^/]+\.)?test\.[cm]?[jt]sx?$/) || file.path.includes('-tests/')) {
      addFinding(findings, { rule: 'review/deleted-test', verdict: REVIEW, file: file.path, side: 'base', line: 1, message: 'A test file was deleted.', hint: 'Confirm coverage remains adequate.' })
    }
  }
  for (const file of ctx.files) {
    if (file.binary || !(/(?:^|\/)(?:[^/]+\.)?test\.[cm]?[jt]sx?$/.test(file.path) || file.path.includes('-tests/'))) continue
    const added = file.addedLines.filter(item => TEST_CALL.test(item.text)).length
    const removed = file.removedLines.filter(item => TEST_CALL.test(item.text)).length
    if (removed > added) addFinding(findings, { rule: 'review/test-count-reduced', verdict: REVIEW, file: file.path, line: file.addedLines[0]?.line ?? 1, message: 'This test file removes more test cases than it adds.', hint: 'Confirm coverage remains adequate.' })
  }
  return findings
}
