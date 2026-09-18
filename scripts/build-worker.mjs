import { build } from 'esbuild'

for (const [entry, output] of [
  ['worker/index.ts', 'dist-worker/worker.mjs'],
  ['worker/runtime.ts', 'dist-worker/runtime.mjs'],
  ['worker/grades/runtime.ts', 'dist-worker/grade-runtime.mjs'],
  ['worker/grade-index.ts', 'dist-worker/grade-worker.mjs'],
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
