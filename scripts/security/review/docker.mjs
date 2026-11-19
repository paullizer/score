import { BLOCKER, REVIEW, addFinding } from './common.mjs'

function isDockerfile(file) {
  return /(^|\/)Dockerfile[^/]*$/.test(file)
}

export function checkDocker(ctx) {
  const findings = []
  for (const file of ctx.files.filter(item => isDockerfile(item.path))) {
    for (const { line, text } of file.addedLines) {
      if (/(?:curl|wget)\b.*\|\s*(?:sh|bash)\b/i.test(text)) addFinding(findings, { rule: 'review/docker-pipe-shell', verdict: BLOCKER, file: file.path, line, message: 'Dockerfile pipes a downloaded script to a shell.', hint: 'Download, verify, then execute scripts explicitly.' })
      if (/^\s*ADD\s+https?:\/\//i.test(text)) addFinding(findings, { rule: 'review/docker-add-url', verdict: REVIEW, file: file.path, line, message: 'Dockerfile ADD downloads from a URL.', hint: 'Use curl with verification or COPY a checked-in artifact.' })
      const from = /^\s*FROM\s+([^\s]+)/i.exec(text)
      if (from) {
        const image = from[1]
        const earlierStages = file.lines().slice(0, line - 1).map(value => /^\s*FROM\s+\S+\s+AS\s+(\S+)/i.exec(value)?.[1]).filter(Boolean)
        if (!earlierStages.includes(image)) {
          if (!image.includes(':') || /:latest(?:@|$)/i.test(image)) addFinding(findings, { rule: 'review/docker-floating-from', verdict: BLOCKER, file: file.path, line, message: 'Dockerfile base image uses latest or no tag.', hint: 'Use an approved version and immutable digest.' })
          if (!/@sha256:[a-f0-9]{64}$/.test(image)) addFinding(findings, { rule: 'review/docker-from-no-digest', verdict: BLOCKER, file: file.path, line, message: 'Dockerfile base image is not pinned to a complete SHA-256 digest.', hint: 'Verify the exact image publication age with scripts/verify-artifacts.mjs.' })
        }
      }
      if (/^\s*USER\s+(?:root|0)\s*$/i.test(text)) addFinding(findings, { rule: 'review/docker-root-user', verdict: REVIEW, file: file.path, line, message: 'Dockerfile sets the runtime user to root.', hint: 'Run containers as a non-root user.' })
    }
    for (const { line, text } of file.removedLines) {
      if (/^\s*USER\s+/i.test(text)) addFinding(findings, { rule: 'review/docker-user-removed', verdict: REVIEW, file: file.path, side: 'base', line, message: 'Dockerfile USER directive was removed.', hint: 'Confirm the container still runs as non-root.' })
    }
  }
  return findings
}
