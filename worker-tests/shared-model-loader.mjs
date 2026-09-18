import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const modules = new Map()

export async function loadWorker(entry) {
  if (!modules.has(entry)) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      write: false,
      logLevel: 'silent',
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
    modules.set(entry, module.exports)
  }
  return modules.get(entry)
}
