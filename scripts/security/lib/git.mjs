import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'

const MAX_BUFFER = 512 * 1024 * 1024

export function git(repoRoot, args, { input, encoding = 'utf8' } = {}) {
  // --literal-pathspecs: file names from a pull request are data, never pathspec magic such as ":(exclude)".
  return execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
    cwd: repoRoot,
    input: typeof input === 'string' ? Buffer.from(input, 'utf8') : input,
    encoding: encoding === 'buffer' ? 'buffer' : 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export function tryGit(repoRoot, args, options) {
  try {
    return git(repoRoot, args, options)
  } catch {
    return undefined
  }
}

export function gitTopLevel(cwd) {
  const output = tryGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!output) throw new Error(`${cwd} is not inside a git repository.`)
  return path.resolve(output.trim())
}

export function resolveCommit(repoRoot, ref) {
  const output = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!output) throw new Error(`Cannot resolve git ref "${ref}" to a commit. Fetch it first (for example: git fetch origin main).`)
  return output.trim()
}

export function defaultBaseRef(repoRoot) {
  for (const candidate of ['origin/main', 'main']) {
    if (tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])) return candidate
  }
  throw new Error('No base ref found. Pass --base <ref> (for example --base origin/main).')
}

export function mergeBase(repoRoot, baseSha, headSha) {
  const output = tryGit(repoRoot, ['merge-base', baseSha, headSha])
  if (!output) throw new Error(`No merge base between ${baseSha} and ${headSha}. Fetch full history (fetch-depth: 0).`)
  return output.trim()
}

/** Changed files between a commit and head (a commit) or the working tree (head undefined), with file modes. */
export function changedFiles(repoRoot, fromSha, headSha) {
  const args = ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-relative', fromSha]
  if (headSha) args.push(headSha)
  const parts = git(repoRoot, args).split('\0')
  const entries = []
  for (let index = 0; index < parts.length;) {
    const meta = parts[index++]
    if (!meta) continue
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+\.* [0-9a-f]+\.* ([A-Z])(\d*)$/.exec(meta)
    if (!match) throw new Error(`Unexpected git diff --raw output: ${meta}`)
    const [, oldMode, newMode, code, score] = match
    if (code === 'R' || code === 'C') {
      const oldPath = parts[index++]
      const newPath = parts[index++]
      entries.push({ status: code, oldPath, path: newPath, oldMode, newMode, similarity: Number(score) })
    } else {
      entries.push({ status: code, path: parts[index++], oldMode, newMode })
    }
  }
  if (!headSha) {
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const file of untracked) entries.push({ status: 'A', path: file, oldMode: '000000', newMode: '100644', untracked: true })
  }
  return entries
}

/** Parses a --unified=0 patch for one file into added lines (new numbering) and removed lines (old numbering). */
export function parseUnifiedDiff(patch) {
  const added = []
  const removed = []
  let binary = false
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
        inHunk = true
      }
      continue
    }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) binary = true
      continue
    }
    if (line.startsWith('+')) added.push({ line: newLine++, text: line.slice(1) })
    else if (line.startsWith('-')) removed.push({ line: oldLine++, text: line.slice(1) })
    else if (line.startsWith(' ')) {
      oldLine++
      newLine++
    }
  }
  return { added, removed, binary }
}

// --text: the checked-out tree's .gitattributes (`-diff`, `binary`) or a NUL byte must not turn a change into
// "Binary files differ". The runner decides what is binary from the path and content instead.
const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-relative', '--unified=0', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/']

export function fileDiff(repoRoot, fromSha, headSha, entry) {
  const args = [...DIFF_ARGS, fromSha]
  if (headSha) args.push(headSha)
  args.push('--')
  if (entry.oldPath) args.push(entry.oldPath)
  args.push(entry.path)
  return parseUnifiedDiff(git(repoRoot, args))
}

function plainDiffPath(value, prefix) {
  const trimmed = value.replace(/\t$/, '')
  if (trimmed.startsWith('"')) return null
  if (prefix && !trimmed.startsWith(prefix)) return null
  return trimmed.slice(prefix?.length ?? 0)
}

function sectionPath(section) {
  let removedPath = null
  for (const rawLine of section.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('@@')) break
    if (line.startsWith('rename to ')) return plainDiffPath(line.slice('rename to '.length))
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') return plainDiffPath(line.slice(4), 'b/')
    if (line.startsWith('--- ') && line !== '--- /dev/null') removedPath = plainDiffPath(line.slice(4), 'a/')
  }
  return removedPath
}

/**
 * Diffs the whole range once and maps each file (new path, or old path for deletions) to its parsed diff.
 * Files whose section can't be mapped unambiguously (binary, mode-only, quoted paths) are left out;
 * callers fall back to fileDiff for those.
 */
export function rangeDiff(repoRoot, fromSha, headSha) {
  const args = [...DIFF_ARGS, fromSha]
  if (headSha) args.push(headSha)
  const patch = git(repoRoot, args)
  const result = new Map()
  const ambiguous = new Set()
  // Split only at "\n" + header. Content lines always carry a +, - or space prefix, and a /^/m split would also
  // break at CR, U+2028 or U+2029 inside a changed line.
  for (const section of patch.split(/\n(?=diff --git )/)) {
    if (!section.startsWith('diff --git ')) continue
    const target = sectionPath(section)
    if (!target) continue
    if (result.has(target)) ambiguous.add(target)
    else result.set(target, parseUnifiedDiff(section))
  }
  for (const target of ambiguous) result.delete(target)
  return result
}

const treeCache = new Map()

/** Blob paths at a commit or tree mapped to { mode, sha }. Paths come from `-z` output, so any byte is safe. */
export function treeBlobs(repoRoot, ref) {
  const treeSha = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`])?.trim()
  if (!treeSha) return new Map()
  let blobs = treeCache.get(treeSha)
  if (!blobs) {
    blobs = new Map()
    for (const record of git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', treeSha]).split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, type, sha] = record.slice(0, tab).split(' ')
      if (type === 'blob') blobs.set(record.slice(tab + 1), { mode, sha })
    }
    treeCache.set(treeSha, blobs)
  }
  return blobs
}

/**
 * Reads blobs by object id with one `git cat-file --batch` process per chunk. Requests are object ids, never
 * paths, so a file name containing LF or CR can't shift the responses. Missing objects map to null.
 */
export function readBlobs(repoRoot, shas) {
  const result = new Map()
  const unique = [...new Set(shas)]
  for (let start = 0; start < unique.length; start += 400) {
    const chunk = unique.slice(start, start + 400)
    const output = git(repoRoot, ['cat-file', '--batch'], { input: `${chunk.join('\n')}\n`, encoding: 'buffer' })
    let offset = 0
    for (const sha of chunk) {
      const headerEnd = output.indexOf(0x0a, offset)
      if (headerEnd < 0) throw new Error(`git cat-file output ended before ${sha}.`)
      const [id, type, size] = output.subarray(offset, headerEnd).toString('utf8').split(' ')
      offset = headerEnd + 1
      if (id !== sha) throw new Error(`git cat-file answered ${id} when asked for ${sha}.`)
      if (size === undefined) {
        result.set(sha, null)
        continue
      }
      const length = Number(size)
      result.set(sha, type === 'blob' ? Buffer.from(output.subarray(offset, offset + length)) : null)
      offset += length + 1
    }
  }
  return result
}

/** Reads many files at one commit. Missing paths, directories and submodules map to null. */
export function readManyAt(repoRoot, ref, paths) {
  const blobs = treeBlobs(repoRoot, ref)
  const wanted = [...new Set(paths)]
  const contents = readBlobs(repoRoot, wanted.map(file => blobs.get(file)?.sha).filter(Boolean))
  return new Map(wanted.map(file => [file, contents.get(blobs.get(file)?.sha) ?? null]))
}

export function readAt(repoRoot, ref, file) {
  return readManyAt(repoRoot, ref, [file]).get(file) ?? null
}

const MISSING_WORKTREE_FILE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENXIO'])

/** Reads a regular file from the working tree; anything else (missing, directory, FIFO, socket) maps to null. */
export function readWorktree(repoRoot, file) {
  let fd
  try {
    // Checking the open descriptor avoids a check-then-read race, and O_NONBLOCK keeps a FIFO from stalling the scan.
    fd = openSync(path.join(repoRoot, file), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (MISSING_WORKTREE_FILE.has(error.code)) return null
    throw error
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : null
  } finally {
    closeSync(fd)
  }
}

/** Tracked files at a commit, or tracked plus untracked (not ignored) files in the working tree. */
export function listFiles(repoRoot, headSha) {
  if (headSha) return git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', headSha]).split('\0').filter(Boolean)
  return git(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter(Boolean)
    .filter(file => existsSync(path.join(repoRoot, file)))
}

/** Git file modes (100644, 100755, 120000 symlink, 160000 submodule) at a commit or in the index. */
export function fileModes(repoRoot, headSha) {
  const modes = new Map()
  const output = headSha
    ? git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', headSha])
    : git(repoRoot, ['ls-files', '-s', '-z'])
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    modes.set(record.slice(tab + 1), record.slice(0, 6))
  }
  return modes
}
