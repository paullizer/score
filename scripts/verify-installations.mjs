import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkLockfiles } from './security/review/lockfile.mjs'
import { checkPackageJson } from './security/review/manifest.mjs'
import { BLOCKER } from './security/lib/findings.mjs'

export async function verifyNpmInstallation({ root = process.cwd(), fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const files = await Promise.all(['package.json', 'package-lock.json'].map(async path => {
    const text = await readFile(resolve(root, path), 'utf8')
    return { path, status: 'A', text: () => text, baseText: () => null }
  }))
  const manifest = JSON.parse(files[0].text())
  const lock = JSON.parse(files[1].text())
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Installation requires a version 3 npm lockfile with root metadata.')
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (JSON.stringify(manifest[section] ?? {}) !== JSON.stringify(lock.packages[''][section] ?? {})) {
      throw new Error(`package.json and package-lock.json disagree on ${section}. Regenerate the lockfile before installing.`)
    }
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Locked ${name} does not match its exact manifest version.`)
    }
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key && (!key.startsWith('node_modules/') || entry.link || entry.inBundle || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version ?? ''))) {
      throw new Error(`Unverifiable installation entry: ${key}. Only exact registry artifacts are admitted.`)
    }
  }
  const ctx = { files, fullScan: true, options: { 'verify-release-age': true }, notes: [] }
  const findings = [...checkPackageJson(ctx), ...await checkLockfiles(ctx, { fetchImpl, now })]
  const blockers = findings.filter(item => item.verdict === BLOCKER)
  if (blockers.length) throw new Error([
    ...blockers.slice(0, 20).map(item => `${item.file}: ${item.message}`),
    ...(blockers.length > 20 ? [`${blockers.length - 20} additional blocked artifacts. No installation was admitted.`] : []),
  ].join('\n'))
  console.log('Every locked npm artifact is exact-pinned, integrity-recorded, and at least fourteen days old.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('verify-installations takes no bypass flags.')
    await verifyNpmInstallation()
  } catch (error) {
    console.error(`Installation blocked: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
