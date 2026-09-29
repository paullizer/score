import { allowedRegistries } from '../policy/review.mjs'
import { BLOCKER, NOTE, REVIEW, addFinding, lineMatcher } from './common.mjs'

const MAX_PACKUMENT_BYTES = 25 * 1024 * 1024

function lockfileKind(file) {
  return file.endsWith('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : 'package-lock.json'
}

function parseLock(text, file, findings) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    addFinding(findings, {
      rule: 'review/lockfile-json',
      verdict: BLOCKER,
      file,
      line: 1,
      message: `${lockfileKind(file)} is not valid JSON.`,
      hint: 'Regenerate the lockfile with npm.',
    })
    return null
  }
}

function packageName(key, entry) {
  if (entry?.name) return entry.name
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  return index >= 0 ? key.slice(index + marker.length) : key
}

function isAllowedResolved(resolved) {
  return allowedRegistries.some(item => resolved.startsWith(item.prefix))
}

function lockPackages(lock) {
  return lock?.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages) ? lock.packages : {}
}

function checkLockShape(lock, file, findings) {
  if (!lock || (lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages))) return
  addFinding(findings, {
    rule: 'review/lockfile-json',
    verdict: BLOCKER,
    file,
    line: 1,
    message: `${lockfileKind(file)} has no "packages" map, so its registries and integrity hashes cannot be checked.`,
    hint: 'Regenerate the lockfile with npm 7 or later (lockfileVersion 2 or 3).',
  })
}

function changedEntry(baseEntry, headEntry) {
  if (!baseEntry) return true
  return baseEntry.version !== headEntry.version
    || baseEntry.resolved !== headEntry.resolved
    || baseEntry.integrity !== headEntry.integrity
}

function isBundledOrLinked(key, entry) {
  return !key || entry?.link === true || entry?.inBundle === true
}

function isFileGitOrTarballOnly(resolved) {
  if (!resolved) return false
  return /^(?:file:|git(?:\+|:)|ssh:)/i.test(resolved)
    || (!isAllowedResolved(resolved) && /^https?:\/\/.+\.tgz(?:[?#].*)?$/i.test(resolved))
}

function keyLineFinder(text) {
  const lineOf = lineMatcher(text)
  return key => lineOf(`"${key}": {`)
}

async function readCappedText(response, cap = MAX_PACKUMENT_BYTES) {
  if (!response?.ok) throw new Error(`registry returned ${response?.status ?? 'no response'}`)
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) throw new Error('registry response exceeded size limit')
      chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > cap) throw new Error('registry response exceeded size limit')
  return text
}

async function fetchPackument(fetchImpl, name) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`
    const response = await fetchImpl(url, { signal: controller.signal })
    return JSON.parse(await readCappedText(response))
  } finally {
    clearTimeout(timer)
  }
}

async function mapLimit(items, limit, fn) {
  const result = new Map()
  let index = 0
  async function worker() {
    for (;;) {
      const item = items[index++]
      if (!item) return
      result.set(item, await fn(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return result
}

async function verifyReleaseAges({ candidates, fetchImpl, now, days }) {
  const byName = [...new Set(candidates.map(item => item.name))]
  const packuments = await mapLimit(byName, 4, async name => {
    try {
      return { ok: true, packument: await fetchPackument(fetchImpl, name) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000
  return candidates.map(item => {
    const entry = packuments.get(item.name)
    if (!entry?.ok) return { ...item, status: 'unverified', reason: entry?.error ?? 'registry lookup failed' }
    const published = entry.packument?.time?.[item.version]
    if (!published) return { ...item, status: 'unverified', reason: 'publish time was missing from the registry packument' }
    const timestamp = Date.parse(published)
    if (!Number.isFinite(timestamp)) return { ...item, status: 'unverified', reason: 'publish time was invalid' }
    return { ...item, status: timestamp < cutoff ? 'old' : 'fresh', published }
  })
}

export async function checkLockfiles(ctx, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const findings = []
  const candidates = []
  const verifyAge = !!ctx.options['verify-release-age']
  const failUnverified = !!ctx.options['fail-on-unverified-release-age']
  const releaseAgeDays = Number(ctx.options['release-age-days'] ?? 7)
  if (ctx.fullScan && verifyAge) ctx.notes.push('Release age verification was skipped in full-scan mode because there is no base lockfile diff.')
  for (const file of ctx.files.filter(item => /(^|\/)(?:package-lock|npm-shrinkwrap)\.json$/.test(item.path))) {
    if (/(^|\/)npm-shrinkwrap\.json$/.test(file.path) && ['A', 'M'].includes(file.status)) {
      addFinding(findings, {
        rule: 'review/npm-shrinkwrap',
        verdict: BLOCKER,
        file: file.path,
        line: 1,
        message: 'npm-shrinkwrap.json changes can override package-lock.json during npm installs.',
        hint: 'Score uses package-lock.json; remove the shrinkwrap or explain why npm must prefer it and get maintainer approval.',
      })
    }
    const headText = file.text()
    const baseText = file.baseText()
    const headLock = parseLock(headText, file.path, findings)
    const baseLock = parseLock(baseText, file.path, [])
    checkLockShape(headLock, file.path, findings)
    const headPackages = lockPackages(headLock)
    const basePackages = lockPackages(baseLock)
    const lineOfKey = keyLineFinder(headText ?? '')
    for (const [key, entry] of Object.entries(headPackages)) {
      if (isBundledOrLinked(key, entry)) continue
      const line = lineOfKey(key)
      const name = packageName(key, entry)
      const resolved = String(entry?.resolved ?? '')
      // Keys outside node_modules/ are the project's own folders (npm workspaces), which npm never downloads.
      const installed = key.includes('node_modules/')
      if (resolved && !isAllowedResolved(resolved)) {
        addFinding(findings, {
          rule: 'review/lockfile-registry',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: `${name} resolves outside the allowlisted npm registries.`,
          hint: 'Use registry.npmjs.org or the 1ES public npm mirror.',
        })
      }
      if ((!resolved || !entry.integrity) && installed) {
        addFinding(findings, {
          rule: 'review/lockfile-integrity-missing',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: `${name} is missing ${!resolved ? 'a resolved URL' : 'an integrity hash'} in the lockfile.`,
          hint: 'Regenerate the lockfile so npm records resolved URLs and integrity hashes.',
        })
      }
      const baseEntry = basePackages[key]
      if (baseEntry && baseEntry.version === entry.version && baseEntry.integrity && entry.integrity && baseEntry.integrity !== entry.integrity) {
        addFinding(findings, {
          rule: 'review/lockfile-integrity-changed',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: `${name} changed integrity without changing version.`,
          hint: 'Investigate a possible package replacement or lockfile tampering.',
        })
      }
      if (!baseEntry && entry?.hasInstallScript) {
        addFinding(findings, {
          rule: 'review/lockfile-install-script',
          verdict: REVIEW,
          file: file.path,
          line,
          message: `${name} is newly added and declares an install script.`,
          hint: 'Review the package before merging.',
        })
      }
      if (verifyAge && !ctx.fullScan && installed && entry?.version && (!resolved || isAllowedResolved(resolved)) && !isFileGitOrTarballOnly(resolved) && changedEntry(baseEntry, entry)) {
        candidates.push({ file: file.path, line, name, version: entry.version })
      }
    }
  }
  if (verifyAge && candidates.length) {
    if (!fetchImpl) {
      for (const item of candidates) {
        addFinding(findings, {
          rule: 'review/release-age-unverified',
          verdict: failUnverified ? BLOCKER : REVIEW,
          file: item.file,
          line: item.line,
          message: `${item.name}@${item.version} publish age could not be verified.`,
          hint: 'Retry with npm registry access or review the package manually.',
        })
      }
    } else {
      for (const result of await verifyReleaseAges({ candidates, fetchImpl, now, days: releaseAgeDays })) {
        if (result.status === 'fresh') {
          addFinding(findings, {
            rule: 'review/release-age-fresh',
            verdict: BLOCKER,
            file: result.file,
            line: result.line,
            message: `${result.name}@${result.version} was published less than ${releaseAgeDays} days ago.`,
            hint: 'Wait for the package to age or perform a manual supply-chain review.',
          })
        } else if (result.status === 'unverified') {
          addFinding(findings, {
            rule: 'review/release-age-unverified',
            verdict: failUnverified ? BLOCKER : REVIEW,
            file: result.file,
            line: result.line,
            message: `${result.name}@${result.version} publish age could not be verified: ${result.reason}.`,
            hint: 'Retry with npm registry access or review the package manually.',
          })
        }
      }
    }
  }
  return findings
}
