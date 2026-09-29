import { allowedRegistries } from '../policy/review.mjs'
import { BLOCKER, REVIEW, addFinding } from './common.mjs'

function registryValue(line) {
  const trimmed = line.trim()
  let match = /^(?:@[\w.-]+:)?registry\s*=\s*(\S+)/i.exec(trimmed)
  if (match) return match[1].replace(/^['"]|['"]$/g, '')
  match = /^(?:npmRegistryServer|npmPublishRegistry)\s*:\s*["']?([^"'\s]+)/i.exec(trimmed)
  if (match) return match[1]
  return null
}

function allowed(value) {
  return allowedRegistries.some(item => value.startsWith(item.prefix))
}

export function checkRegistryConfig(ctx) {
  const findings = []
  for (const file of ctx.files.filter(item => /(^|\/)(\.npmrc|\.yarnrc|\.yarnrc\.yml)$/.test(item.path))) {
    let hadSpecific = false
    for (const { line, text } of file.addedLines) {
      const registry = registryValue(text)
      if (registry && !allowed(registry)) {
        hadSpecific = true
        addFinding(findings, {
          rule: 'review/registry-config-host',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: 'Package manager registry points outside the allowlisted registries.',
          hint: 'Use registry.npmjs.org or the 1ES public npm mirror.',
        })
      }
      if (/^\s*strict-ssl\s*=\s*false\s*$/i.test(text)) {
        hadSpecific = true
        addFinding(findings, {
          rule: 'review/registry-strict-ssl',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: 'Package manager TLS verification is disabled.',
          hint: 'Keep strict-ssl enabled.',
        })
      }
    }
    if (!hadSpecific && file.addedLines.length) addFinding(findings, { rule: 'review/registry-config-changed', verdict: REVIEW, file: file.path, line: file.addedLines[0].line, message: 'Package manager registry configuration changed.', hint: 'Review registry and authentication settings.' })
  }
  return findings
}
