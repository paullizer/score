import { build } from 'esbuild'

await build({
  entryPoints: ['server/telemetry.ts'],
  outfile: 'dist-server/telemetry.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
})

await build({
  entryPoints: ['server/documents/word-parser-worker.ts'],
  outfile: 'dist-server/word-parser.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
})

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/server.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
})

await build({
  entryPoints: ['server/app.ts'],
  outfile: 'dist-server/app.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
})
