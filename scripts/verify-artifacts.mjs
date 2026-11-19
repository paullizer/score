import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchMetadata, publicationStatus } from './security/lib/release-age.mjs'

function assertOld(published, label, now) {
  const status = publicationStatus(published, now)
  if (status !== 'old') throw new Error(`${label}: publication age is ${status}; fourteen complete days and authoritative evidence are required.`)
}

export async function verifyImage(image, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const metadata = await fetchMetadata(image.metadata, { fetchImpl })
  const record = Array.isArray(metadata) ? metadata.find(item => item.name === image.tag) : metadata
  const digest = image.reference.split('@')[1]
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') || record?.digest !== digest) {
    throw new Error(`${image.name}: publication metadata does not identify the pinned image digest.`)
  }
  assertOld(record.tag_last_pushed ?? record.lastModifiedDate, image.reference, now)
}

export async function verifyGithubRelease(artifact, { fetchImpl = globalThis.fetch, now = new Date(), token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(artifact.repository) || !/^[\w.-]+$/.test(artifact.tag)) throw new Error('Invalid release identity.')
  const base = `https://api.github.com/repos/${artifact.repository}`
  const requestOptions = { fetchImpl, headers: token ? { Authorization: `Bearer ${token}` } : {} }
  const release = await fetchMetadata(`${base}/releases/tags/${artifact.tag}`, requestOptions)
  if (release.draft || release.prerelease || release.tag_name !== artifact.tag) throw new Error(`${artifact.repository}: expected a stable published release.`)
  assertOld(release.published_at, `${artifact.repository}@${artifact.tag}`, now)
  if (artifact.sha) {
    const ref = await fetchMetadata(`${base}/git/ref/tags/${artifact.tag}`, requestOptions)
    let object = ref.object
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid annotated release tag.')
      object = (await fetchMetadata(`${base}/git/tags/${object.sha}`, requestOptions)).object
    }
    if (object?.type !== 'commit' || object.sha !== artifact.sha) throw new Error(`${artifact.repository}: release tag does not identify the pinned action commit.`)
  }
}

export async function verifyArtifacts({ root = process.cwd(), fetchImpl = globalThis.fetch, now = new Date(), deploymentTools = false } = {}) {
  const policy = JSON.parse(await readFile(resolve(root, 'scripts/security/policy/installations.json'), 'utf8'))
  const options = { fetchImpl, now }
  const failures = []
  async function check(label, run) {
    try { await run() } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  for (const image of policy.images) await check(image.name, () => verifyImage(image, options))
  const imageRefs = new Set(policy.images.map(image => image.reference))
  for (const file of ['Dockerfile', 'Dockerfile.worker', 'Dockerfile.renderer']) {
    const text = await readFile(resolve(root, file), 'utf8')
    const stages = new Set()
    for (const match of text.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gmi)) {
      if (!stages.has(match[1]) && !imageRefs.has(match[1])) failures.push(`${file}: unapproved or mutable base image ${match[1]}.`)
      if (match[2]) stages.add(match[2])
    }
    if (/\b(?:apt(?:-get)?|apk|dnf|yum)\s+(?:[^\n]*\s)?(?:install|upgrade|add)\b|\bplaywright\s+install\b/.test(text)) {
      failures.push(`${file}: use an age-verified immutable image, not additional untracked OS/browser downloads.`)
    }
  }
  const approvedActions = new Set(policy.actions.map(action => `${action.repository}@${action.sha}`))
  for (const action of policy.actions) await check(action.repository, () => verifyGithubRelease(action, options))
  for (const file of await readdir(resolve(root, '.github/workflows'))) {
    if (!/\.ya?ml$/.test(file)) continue
    const text = await readFile(resolve(root, '.github/workflows', file), 'utf8')
    for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const [path, sha] = match[1].split('@')
      const repository = path.split('/').slice(0, 2).join('/')
      if (!path.startsWith('./') && !approvedActions.has(`${repository}@${sha}`)) failures.push(`${file}: unapproved action ${match[1]}.`)
    }
    for (const match of text.matchAll(/^\s*node-version:\s*['"]?([^'"\s]+)/gm)) {
      if (match[1] !== policy.nodeVersion) failures.push(`${file}: Node must be pinned to ${policy.nodeVersion}.`)
    }
  }
  await check('Node runtime release', () => verifyGithubRelease({ repository: 'nodejs/node', tag: `v${policy.nodeVersion}` }, options))
  if (deploymentTools) {
    for (const tool of policy.deploymentTools) {
      await check(tool.name, async () => {
        await verifyGithubRelease(tool, options)
        const command = tool.name === 'node' ? process.execPath : tool.name
        const args = tool.name === 'az' ? ['version', '--output', 'json'] : tool.name === 'azd' ? ['version'] : ['--version']
        const runOptions = {
          encoding: 'utf8', timeout: 60_000, windowsHide: true,
          env: { ...process.env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', AZURE_EXTENSION_DIR: resolve(root, '.azure/no-extensions') },
        }
        const output = tool.name === 'az' && process.platform === 'win32'
          ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'az version --output json'], runOptions)
          : execFileSync(command, args, runOptions)
        const version = tool.name === 'az' ? JSON.parse(output)['azure-cli'] : /(?:^|[^\d])(\d+\.\d+\.\d+)\b/.exec(output)?.[1]
        if (version !== tool.version) throw new Error(`expected ${tool.version}, found ${version ?? 'unrecognized output'}. Use an approved isolated toolchain; do not upgrade shared tools.`)
        if (tool.name === 'az') {
          const extensions = process.platform === 'win32'
            ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'az extension list --output json'], runOptions)
            : execFileSync(command, ['extension', 'list', '--output', 'json'], runOptions)
          if (JSON.parse(extensions).length) throw new Error('Deployment uses built-in Azure CLI commands only. The isolated .azure/no-extensions directory must contain no extensions.')
        }
      })
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  console.log('External images, action commits, and runtime releases satisfy the exact-pin and fourteen-day policy.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--deployment-tools')) throw new Error('Only --deployment-tools is supported; there is no age bypass.')
    await verifyArtifacts({ deploymentTools: process.argv.includes('--deployment-tools') })
  } catch (error) {
    console.error(`Artifact admission blocked: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
