import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BLOCKER, NOTE, REVIEW } from './findings.mjs'
import { riskAreaLabel } from './paths.mjs'

export const STEP_SUMMARY_LIMIT = 900 * 1024

export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

const UNSAFE_DISPLAY = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * Makes untrusted text (paths, script names, snippets) print on one line: line breaks, control, bidi and
 * zero-width characters become visible escapes, so a finding can't start a new log line or Markdown block.
 */
export function escapeControl(value) {
  return String(value ?? '').replace(UNSAFE_DISPLAY, char => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    const code = char.charCodeAt(0)
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/** GitHub workflow command for one finding; notes produce no annotation. */
export function annotation(item) {
  if (item.verdict === NOTE) return null
  const command = item.verdict === BLOCKER ? 'error' : 'warning'
  const properties = [`title=${escapeProperty(item.rule)}`]
  if (item.file && item.side === 'head') {
    properties.unshift(`file=${escapeProperty(item.file)}`)
    if (item.line) properties.splice(1, 0, `line=${item.line}`)
  }
  const location = item.side === 'base' && item.file ? ` (removed from ${item.file}${item.line ? `:${item.line}` : ''})` : ''
  const hint = item.hint ? ` ${item.hint}` : ''
  return `::${command} ${properties.join(',')}::${escapeData(`${item.message}${location}${hint}`)}`
}

/** Plain text for a Markdown table cell: backslashes and pipes are escaped so text can't end the cell early. */
function cell(value) {
  return escapeControl(value).replace(/[\\|]/g, '\\$&')
}

/** A Markdown code span that untrusted text can't break out of. */
function code(value) {
  const text = escapeControl(value)
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = longest ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * A code span inside a table cell. A table splits on "|" before code spans are read, and backslash escapes
 * don't work inside code spans, so a pipe is shown as a visible \x7c escape like other structural characters.
 */
function cellCode(value) {
  return code(String(value ?? '').replace(/\|/g, '\\x7c'))
}

function location(item) {
  if (!item.file) return '(repository)'
  const suffix = item.line ? `:${item.line}` : ''
  return item.side === 'base' ? `${cellCode(`${item.file}${suffix}`)} (removed)` : cellCode(`${item.file}${suffix}`)
}

function table(items) {
  const rows = items.map(item =>
    `| ${cellCode(item.rule)} | ${location(item)} | ${cell(item.message)}${item.hint ? ` ${cell(item.hint)}` : ''} |`)
  return ['| Rule | Location | Details |', '| --- | --- | --- |', ...rows].join('\n')
}

export function renderMarkdown({ title, description, rangeText, filesChecked, findings, suppressed = [], notes = [], summary, exitCode, changedByArea }) {
  const result = exitCode !== 0
    ? (summary.blockers > 0 ? '**Failed**: blockers must be fixed or explained before merging.' : '**Failed**: findings need review (`--fail-on-findings`).')
    : (summary.review > 0 ? '**Passed** with findings to review.' : '**Passed**.')
  const lines = [
    `## ${title}`,
    '',
    description ? `${description}\n` : null,
    `- Scope: ${rangeText}`,
    `- Files checked: ${filesChecked}`,
    `- Blockers: ${summary.blockers} · Needs review: ${summary.review} · Notes: ${summary.notes}${suppressed.length ? ` · Suppressed: ${suppressed.length}` : ''}`,
    `- Result: ${result}`,
    '',
  ].filter(line => line !== null)
  for (const note of notes) lines.push(`> ${escapeControl(note)}`, '')
  const sections = [
    [BLOCKER, 'Blockers'],
    [REVIEW, 'Needs review'],
    [NOTE, 'Notes'],
  ]
  for (const [verdict, heading] of sections) {
    const items = findings.filter(item => item.verdict === verdict)
    if (!items.length) continue
    lines.push(`### ${heading} (${items.length})`, '')
    const areas = [...new Set(items.map(item => item.area))]
    for (const area of areas) {
      if (areas.length > 1) lines.push(`#### ${riskAreaLabel(area)}`, '')
      lines.push(table(items.filter(item => item.area === area)), '')
    }
  }
  if (suppressed.length) {
    lines.push(`### Suppressed (${suppressed.length})`, '', '| Rule | Location | Reason |', '| --- | --- | --- |')
    for (const item of suppressed) lines.push(`| ${cellCode(item.rule)} | ${location(item)} | ${cell(item.reason)} |`)
    lines.push('')
  }
  if (changedByArea && changedByArea.size) {
    lines.push('<details><summary>Changed files by risk area</summary>', '')
    for (const [area, files] of changedByArea) {
      lines.push(`**${riskAreaLabel(area)}** (${files.length})`, '')
      for (const file of files.slice(0, 200)) lines.push(`- ${code(file)}`)
      if (files.length > 200) lines.push(`- … ${files.length - 200} more`)
      lines.push('')
    }
    lines.push('</details>', '')
  }
  if (!findings.length && !suppressed.length) lines.push('No findings.', '')
  return lines.join('\n')
}

export function writeReport(file, markdown) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  writeFileSync(file, markdown)
}

export function appendStepSummary(file, markdown) {
  let content = markdown
  if (Buffer.byteLength(content) > STEP_SUMMARY_LIMIT) {
    content = Buffer.from(content).subarray(0, STEP_SUMMARY_LIMIT).toString('utf8')
      + '\n\n> Report truncated. Download the workflow artifact for the full report.\n'
  }
  appendFileSync(file, `${content}\n`)
}

export function consoleLines({ title, rangeText, findings, suppressed, summary, exitCode }) {
  const lines = [`${title}: ${escapeControl(rangeText)}`]
  for (const item of findings) {
    const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}${item.side === 'base' ? ' (removed)' : ''}` : '(repository)'
    const details = `${item.message}${item.hint ? ` ${item.hint}` : ''}`
    lines.push(`  ${item.verdict.toUpperCase().padEnd(7)} ${escapeControl(item.rule)} ${escapeControl(where)}\n          ${escapeControl(details)}`)
  }
  if (suppressed.length) lines.push(`  ${suppressed.length} finding(s) suppressed with security-reviewed comments.`)
  lines.push(`  ${summary.blockers} blocker(s), ${summary.review} to review, ${summary.notes} note(s): ${exitCode === 0 ? 'passed' : 'failed'}`)
  return lines
}
