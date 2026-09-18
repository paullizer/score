import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

export function reportBrowserPlugin() {
  return {
    name: 'analysis-report-test-assets',
    setup(builder) {
      builder.onLoad({ filter: /analysisReports[\\/]client\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8'))
          .replace("new URL('./report.worker.ts', import.meta.url)", "new URL('/analysis-report-worker.mjs', window.location.href)")
          .replace("new URL('../../assets/report-fonts/NotoSans-Regular.ttf', import.meta.url)", "new URL('/report-fonts/NotoSans-Regular.ttf', window.location.href)")
          .replace("new URL('../../assets/report-fonts/NotoSans-Bold.ttf', import.meta.url)", "new URL('/report-fonts/NotoSans-Bold.ttf', window.location.href)"),
        loader: 'ts',
      }))
    },
  }
}

export async function buildReportTestWorker(directory) {
  await mkdir(join(directory, 'report-fonts'), { recursive: true })
  await Promise.all([
    build({
      entryPoints: [join('src', 'services', 'analysisReports', 'report.worker.ts')],
      outfile: join(directory, 'analysis-report-worker.mjs'), bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent',
    }),
    ...['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'].map((name) =>
      copyFile(join('src', 'assets', 'report-fonts', name), join(directory, 'report-fonts', name))),
  ])
}
