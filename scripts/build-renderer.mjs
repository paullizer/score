import { build } from 'esbuild'

for (const [entry, output] of [
  ['renderer/index.ts', 'dist-renderer/renderer.mjs'],
  ['renderer/app.ts', 'dist-renderer/app.mjs'],
  ['renderer/runtime-environment.ts', 'dist-renderer/runtime-environment.mjs'],
]) {
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
  })
}
