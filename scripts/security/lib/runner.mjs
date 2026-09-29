import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changedFiles, defaultBaseRef, fileDiff, fileModes, gitTopLevel, listFiles, mergeBase,
  rangeDiff, readManyAt, readWorktree, resolveCommit,
} from './git.mjs'
import { applySuppressions, dedupeFindings, sortFindings, summarize } from './findings.mjs'
import { isTextPath, riskArea } from './paths.mjs'
import {
  annotation, appendStepSummary, consoleLines, escapeControl, escapeData, escapeProperty, renderMarkdown, writeReport,
} from './report.mjs'

export const COMMON_OPTIONS = {
  base: { type: 'string' },
  head: { type: 'string' },
  'full-scan': { type: 'boolean', default: false },
  'fail-on-findings': { type: 'boolean', default: false },
  report: { type: 'string' },
  repo: { type: 'string' },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
}

const COMMON_USAGE = `Options:
  --base <ref>          Compare against the merge base with this ref (default: origin/main, then main).
  --head <ref>          Check this commit. Omit to check the working tree, including untracked files.
  --full-scan           Check every file instead of only the changes.
  --fail-on-findings    Also fail when there are findings to review, not only blockers.
  --report <file>       Write the Markdown report to a file.
  --repo <dir>          Repository root (default: the git top level of the current directory).
  --quiet               Print only the summary line.
  -h, --help            Show this help.`

const MAX_ANNOTATIONS_PER_LEVEL = 50

export function usage(spec) {
  const extra = spec.usage ? `\n${spec.usage.trimEnd()}` : ''
  return `${spec.title}\n\nUsage: node ${spec.script ?? `scripts/security/${spec.id}.mjs`} [options]\n\n${COMMON_USAGE}${extra}\n`
}

function isBinary(buffer) {
  return !!buffer && buffer.subarray(0, 8000).includes(0)
}

function hasNul(buffer) {
  return !!buffer && buffer.includes(0)
}

function shortSha(sha) {
  return sha ? sha.slice(0, 12) : 'working tree'
}

function createContext(spec, options, repoRoot) {
  const fullScan = options['full-scan']
  const headSha = options.head ? resolveCommit(repoRoot, options.head) : undefined
  let baseRef = null
  let baseSha = null
  let mergeBaseSha = null
  let entries
  if (fullScan) {
    const modes = fileModes(repoRoot, headSha)
    entries = listFiles(repoRoot, headSha).map(file => ({
      status: 'A', path: file, oldMode: '000000', newMode: modes.get(file) ?? '100644', untracked: !modes.has(file),
    }))
  } else {
    baseRef = options.base ?? defaultBaseRef(repoRoot)
    baseSha = resolveCommit(repoRoot, baseRef)
    mergeBaseSha = mergeBase(repoRoot, baseSha, headSha ?? resolveCommit(repoRoot, 'HEAD'))
    entries = changedFiles(repoRoot, mergeBaseSha, headSha)
  }

  const headCache = new Map()
  const readHeadMany = files => {
    const missing = [...new Set(files)].filter(file => !headCache.has(file))
    if (!missing.length) return
    if (headSha) {
      for (const [file, content] of readManyAt(repoRoot, headSha, missing)) headCache.set(file, content)
    } else {
      for (const file of missing) headCache.set(file, readWorktree(repoRoot, file))
    }
  }
  const readHead = file => {
    readHeadMany([file])
    return headCache.get(file)
  }

  const baseCache = new Map()
  const readBase = (file, batch) => {
    if (!mergeBaseSha) return null
    if (!baseCache.has(file)) {
      const wanted = [...new Set([file, ...batch])].filter(item => !baseCache.has(item))
      for (const [item, content] of readManyAt(repoRoot, mergeBaseSha, wanted)) baseCache.set(item, content)
    }
    return baseCache.get(file)
  }

  let rangeCache
  const diffFor = entry => {
    if (fullScan || entry.untracked) return null
    rangeCache ??= rangeDiff(repoRoot, mergeBaseSha, headSha)
    return rangeCache.get(entry.path) ?? fileDiff(repoRoot, mergeBaseSha, headSha, entry)
  }

  const textCache = new Map()
  const decode = (key, buffer) => {
    if (!textCache.has(key)) textCache.set(key, buffer ? buffer.toString('utf8') : null)
    return textCache.get(key)
  }

  const included = entries.filter(entry => spec.includeFile ? spec.includeFile(entry.path, entry) : true)
  const basePaths = included.filter(entry => entry.status !== 'A').map(entry => entry.oldPath ?? entry.path)

  const makeFile = entry => {
    let diff
    let addedSet
    const getDiff = () => {
      if (diff === undefined) diff = diffFor(entry)
      return diff
    }
    const file = {
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      status: entry.status,
      oldMode: entry.oldMode,
      newMode: entry.newMode,
      untracked: !!entry.untracked,
      area: riskArea(entry.path),
      content: () => (entry.status === 'D' ? null : readHead(entry.path)),
      text: () => (entry.status === 'D' ? null : decode(`head:${entry.path}`, readHead(entry.path))),
      lines: () => file.text()?.split(/\r?\n/) ?? [],
      baseContent: () => (entry.status === 'A' ? null : readBase(entry.oldPath ?? entry.path, basePaths)),
      baseText: () => (entry.status === 'A' ? null : decode(`base:${entry.oldPath ?? entry.path}`, file.baseContent())),
      baseLines: () => file.baseText()?.split(/\r?\n/) ?? [],
      // Source, config and docs are always read as text: a NUL byte must not hide them from the rules.
      get binary() {
        if (isTextPath(entry.path)) return false
        return isBinary(entry.status === 'D' ? file.baseContent() : file.content())
      },
      get hasNulByte() {
        return hasNul(entry.status === 'D' ? file.baseContent() : file.content())
      },
      get addedLines() {
        if (file.binary) return []
        const parsed = getDiff()
        if (parsed) return parsed.added
        return entry.status === 'D' ? [] : file.lines().map((text, index) => ({ line: index + 1, text }))
      },
      get removedLines() {
        if (file.binary) return []
        return getDiff()?.removed ?? []
      },
      isAdded(line) {
        if (fullScan || entry.untracked) return true
        addedSet ??= new Set(file.addedLines.map(item => item.line))
        return addedSet.has(line)
      },
    }
    return file
  }

  const files = included.filter(entry => entry.status !== 'D').map(makeFile)
  const deletedFiles = included.filter(entry => entry.status === 'D').map(makeFile)
  readHeadMany(files.map(file => file.path))

  let allFiles
  return {
    spec,
    repoRoot,
    mode: fullScan ? 'full' : 'diff',
    fullScan,
    options,
    baseRef,
    base: baseSha,
    head: headSha ?? null,
    mergeBase: mergeBaseSha,
    files,
    deletedFiles,
    allChangedFiles: entries,
    notes: [],
    readFile: file => decode(`head:${file}`, readHead(file)),
    readBaseFile: file => decode(`base:${file}`, readBase(file, [])),
    listFiles: () => (allFiles ??= listFiles(repoRoot, headSha)),
    rangeText: fullScan
      ? `full scan of ${shortSha(headSha)}`
      : `changes in ${shortSha(headSha)} since merge base ${shortSha(mergeBaseSha)} with ${baseRef}`,
  }
}

/**
 * Runs one checker. `spec` = { id, title, description?, usage?, options?, includeFile?(path, entry),
 * suppressions? (default true), showChangedFiles?, check(ctx) -> findings[] | Promise<findings[]> }.
 * Returns { exitCode, findings, suppressed, summary, markdown }.
 */
export async function runCheck(spec, argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? (text => process.stdout.write(text))
  const env = io.env ?? process.env
  const { values: options } = parseArgs({
    args: argv,
    options: { ...COMMON_OPTIONS, ...(spec.options ?? {}) },
    allowPositionals: false,
    strict: true,
  })
  if (options.help) {
    stdout(usage(spec))
    return { exitCode: 0, findings: [], suppressed: [], summary: summarize([]), markdown: '' }
  }
  const repoRoot = path.resolve(options.repo ?? gitTopLevel(io.cwd ?? process.cwd()))
  const ctx = createContext(spec, options, repoRoot)

  const raw = dedupeFindings((await spec.check(ctx)) ?? [])
  const linesFor = file => ctx.readFile(file)?.split(/\r?\n/) ?? null
  const { findings, suppressed } = spec.suppressions === false
    ? { findings: raw, suppressed: [] }
    : applySuppressions(raw, linesFor)
  sortFindings(findings)
  const summary = summarize(findings)
  const exitCode = summary.blockers > 0 || (options['fail-on-findings'] && summary.review > 0) ? 1 : 0

  let changedByArea
  if (spec.showChangedFiles) {
    changedByArea = new Map()
    for (const entry of ctx.allChangedFiles) {
      const area = riskArea(entry.path)
      if (!changedByArea.has(area)) changedByArea.set(area, [])
      changedByArea.get(area).push(entry.status === 'D' ? `${entry.path} (deleted)` : entry.path)
    }
  }
  const markdown = renderMarkdown({
    title: spec.title,
    description: spec.description,
    rangeText: ctx.rangeText,
    filesChecked: ctx.files.length + ctx.deletedFiles.length,
    findings,
    suppressed,
    notes: ctx.notes,
    summary,
    exitCode,
    changedByArea,
  })

  const printed = consoleLines({ title: spec.title, rangeText: ctx.rangeText, findings, suppressed, summary, exitCode })
  const text = `${(options.quiet ? [printed.at(-1).trim()] : printed).join('\n')}\n`
  if (env.GITHUB_ACTIONS === 'true') {
    // Findings quote pull-request content. Disable workflow commands while printing them, with a token the
    // pull request can't know, then emit the (escaped) annotations.
    const token = randomBytes(16).toString('hex')
    stdout(`::stop-commands::${token}\n${text}::${token}::\n`)
    const counts = { error: 0, warning: 0 }
    for (const item of findings) {
      const line = annotation(item)
      if (!line) continue
      const level = line.startsWith('::error') ? 'error' : 'warning'
      if (++counts[level] > MAX_ANNOTATIONS_PER_LEVEL) continue
      stdout(`${line}\n`)
    }
  } else {
    stdout(text)
  }
  if (options.report) writeReport(options.report, markdown)
  if (env.GITHUB_STEP_SUMMARY) appendStepSummary(env.GITHUB_STEP_SUMMARY, markdown)
  return { exitCode, findings, suppressed, summary, markdown, ctx }
}

/** True when the module with this `import.meta.url` is the script Node was asked to run. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false
  const normalize = file => {
    try {
      return realpathSync(path.resolve(file)).toLowerCase()
    } catch {
      return path.resolve(file).toLowerCase()
    }
  }
  return normalize(fileURLToPath(importMetaUrl)) === normalize(process.argv[1])
}

/** CLI entry point: exit code 0 passes, 1 means findings failed the check, 2 means the check itself failed. */
export async function main(spec) {
  try {
    const result = await runCheck(spec)
    process.exitCode = result.exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const actions = process.env.GITHUB_ACTIONS === 'true'
    if (actions) process.stdout.write(`::error title=${escapeProperty(spec.id)}::${escapeData(message)}\n`)
    process.stderr.write(`${spec.title} could not run: ${actions ? escapeControl(message) : message}\n`)
    if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') process.stderr.write(`\n${usage(spec)}`)
    process.exitCode = 2
  }
}
