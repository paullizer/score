import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function sourceReleaseId() {
  const hash = createHash('sha256')
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Deployment source must not contain symbolic links.')
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) hash.update(child.replaceAll('\\', '/')).update('\0').update(await readFile(child)).update('\0')
    }
  }
  for (const path of ['src', 'server', 'worker', 'renderer', 'scripts', 'infra', 'server-tests', 'worker-tests', 'renderer-tests']) await visit(path)
  for (const path of ['package.json', 'package-lock.json', 'azure.yaml', 'Dockerfile', 'Dockerfile.worker', 'Dockerfile.renderer',
    'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.server.json', 'tsconfig.worker.json', 'tsconfig.renderer.json', '.dockerignore']) {
    hash.update(path).update('\0').update(await readFile(path)).update('\0')
  }
  return hash.digest('hex')
}

export async function deploymentManifest() {
  const result = await build({
    stdin: { contents: "export { compiledPromptContractHash } from './server/settings/prompts'; export { PROMPT_TEMPLATE_GENERATION, PROMPT_RUNTIME_VERSION } from './src/domain/prompt-versions'",
      resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', write: false,
  })
  const temporary = resolve(`.deployment-contract-${randomUUID()}.mjs`)
  await writeFile(temporary, result.outputFiles[0].contents)
  try {
    const code = await import(pathToFileURL(temporary).href)
    return { releaseId: await sourceReleaseId(), contractSha256: code.compiledPromptContractHash(),
      generation: code.PROMPT_TEMPLATE_GENERATION, promptRuntimeVersion: code.PROMPT_RUNTIME_VERSION }
  } finally { await unlink(temporary) }
}

export async function writeDeploymentManifest(directory) {
  await writeFile(join(directory, 'deployment.json'), JSON.stringify(await deploymentManifest()))
}

export async function checkedDeploymentManifest() {
  const manifest = await deploymentManifest()
  const receipt = JSON.parse(await readFile('.score-deployment-checks.json', 'utf8'))
  if (receipt.releaseId !== manifest.releaseId || receipt.contractSha256 !== manifest.contractSha256 || receipt.passed !== true) {
    throw new Error('Deployment sources changed or checks have not passed. Run scripts\\deploy.ps1 again before deploying.')
  }
  return manifest
}
