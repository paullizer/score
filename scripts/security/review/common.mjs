import { BLOCKER, NOTE, REVIEW, finding } from '../lib/findings.mjs'
import { isDocPath, isTestPath, matchesAny } from '../lib/paths.mjs'
import { metadataEndpointAllowlist, reviewerContentExemptions } from '../policy/review.mjs'

export { BLOCKER, NOTE, REVIEW }

export function addFinding(findings, { rule, verdict, file, line, message, hint, side }) {
  findings.push(finding({ rule, verdict, file, line, message, hint, side }))
}

export function isTextFile(file) {
  return !file.binary && file.text() !== null
}

export function downgradeForTestOrDoc(file, verdict, { preserve = false } = {}) {
  if (verdict !== BLOCKER || preserve) return verdict
  return isTestPath(file) || isDocPath(file) ? REVIEW : verdict
}

export function isReviewerContentExempt(file) {
  return matchesAny(file, reviewerContentExemptions.map(entry => entry.glob))
}

// Suppression comments, lint directives and code patterns have no effect in prose files.
export function isProse(file) {
  return /\.(?:md|mdx|markdown|txt)$/i.test(file)
}

export function isMetadataAllowed(file) {
  return metadataEndpointAllowlist.some(entry => entry.file === file)
}

export function extension(file) {
  const slash = file.lastIndexOf('/')
  const dot = file.lastIndexOf('.')
  return dot > slash ? file.slice(dot).toLowerCase() : ''
}

export function isProbablyBinaryBuffer(buffer) {
  return !!buffer && buffer.subarray(0, 8000).includes(0)
}

export function lineMatcher(text) {
  const lines = text.split(/\r?\n/)
  return needle => {
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(needle)) return index + 1
    }
    return 1
  }
}

export function changedFiles(ctx, predicate) {
  return [...ctx.files, ...ctx.deletedFiles].filter(file => predicate(file.path, file))
}
