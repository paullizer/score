import { BLOCKER, NOTE, REVIEW, addFinding } from './common.mjs'

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
        if (!image.includes(':') || /:latest(?:@|$)/i.test(image)) addFinding(findings, { rule: 'review/docker-floating-from', verdict: REVIEW, file: file.path, line, message: 'Dockerfile base image uses latest or no tag.', hint: 'Pin to a specific tag.' })
        else if (!image.includes('@sha256:')) addFinding(findings, { rule: 'review/docker-from-no-digest', verdict: NOTE, file: file.path, line, message: 'Dockerfile base image tag is not digest-pinned.', hint: 'Digest pinning is a follow-up hardening item.' })
      }
      if (/^\s*USER\s+(?:root|0)\s*$/i.test(text)) addFinding(findings, { rule: 'review/docker-root-user', verdict: REVIEW, file: file.path, line, message: 'Dockerfile sets the runtime user to root.', hint: 'Run containers as a non-root user.' })
    }
    for (const { line, text } of file.removedLines) {
      if (/^\s*USER\s+/i.test(text)) addFinding(findings, { rule: 'review/docker-user-removed', verdict: REVIEW, file: file.path, side: 'base', line, message: 'Dockerfile USER directive was removed.', hint: 'Confirm the container still runs as non-root.' })
    }
  }
  return findings
}
