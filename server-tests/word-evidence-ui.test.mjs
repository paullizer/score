import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server.js'
import { build } from 'esbuild'
import {
  api, fixture, seedJob, seedResume, seedGrade, publishResult, ACTOR, NOW,
} from './real-analyses.test-support.mjs'

const bundle = path.resolve('dist-server', `word-evidence-ui-${process.pid}.mjs`)
await mkdir(path.dirname(bundle), { recursive: true })
await build({
  stdin: {
    resolveDir: process.cwd(), contents: [
      "export { GradeSourceProvenance } from './src/features/grade-ladders/GradeSourceInspector.tsx';",
      "export { RealComparisonReview } from './src/features/analyses/RealComparisonReview.tsx';",
      "export { DocumentViewer } from './src/components/documents/DocumentViewer.tsx';",
      "export { RubricPanel } from './src/features/rubrics/RubricPanel.tsx';",
      "export { WorkspaceContext } from './src/app/workspace-context.ts';",
    ].join('\n'),
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'silent',
})
const ui = await import(pathToFileURL(bundle).href)
after(async () => { await unlink(bundle) })

const cloud = {
  currentWorkspaceId: 'workspace-one',
  user: { tenantId: 'tenant-one', id: 'user-one' },
  workspaces: [{ id: 'workspace-one', role: 'owner' }],
  realJobs: { source: () => undefined, detail: () => ({ state: 'idle' }) },
}

for (const format of ['docx', 'doc']) {
  test(`${format.toUpperCase()} rubric source buttons and links identify captured sections while PDF labels stay unchanged`, async () => {
    const f = fixture()
    const job = await seedJob(f, 'Word engineering source', randomUUID(), format)
    const paragraph = job.document.paragraphs[0]
    for (const exact of [true, false]) {
      const rubric = {
        ...job.rubric, criteria: job.rubric.criteria.map(criterion => ({
          ...criterion, sourceParagraphId: paragraph.id, ...(exact ? {} : { sourceCitations: [] }),
        })),
      }
      for (const interactive of [true, false]) {
        const render = source => renderToStaticMarkup(createElement(StaticRouter, { location: '/' },
          createElement(ui.WorkspaceContext.Provider, {
            value: { workspace: { lifecycle: { entities: { [`rubric:${rubric.groupId}`]: {} } },
              jobs: [{ ...job.record.job, source }], documents: [job.document], rubrics: [rubric] }, cloud,
              saveRubric: async () => rubric.id },
          }, createElement(ui.RubricPanel, {
            rubric, readOnly: true, ...(interactive ? { onSelectCriterion: () => {} } : {}),
          })),
        ))
        const word = render(format)
        assert.match(word, /(?:View exact source|View source|Job source) · Captured section 1/)
        assert.doesNotMatch(word, /(?:View exact source|View source|Job source) · p\./)
        assert.match(render('pdf'), /(?:View exact source|View source|Job source) · p\. 1/)
      }
    }
  })

  test(`${format.toUpperCase()} frozen comparisons render captured sections, not original pages or HTML`, async () => {
    const f = fixture()
    const resume = await seedResume(f, 'Renée Example', randomUUID(), format)
    const job = await seedJob(f, 'Word engineering source', randomUUID(), format)
    const created = await f.service.create(f.workspaceId, randomUUID(), {
      name: 'Word source label review', resumes: [resume.selection], targets: [job.selection],
    }, ACTOR)
    const comparison = [...f.analysis.store.values.values()].find(value => value.record.recordType === 'analysis-comparison').record
    await publishResult(f, created.run.id, comparison.id)
    const detail = await f.service.comparisonDetail(f.workspaceId, created.run.id, comparison.id)
    const comparisonMarkup = renderToStaticMarkup(createElement(StaticRouter, { location: '/' },
      createElement(ui.WorkspaceContext.Provider, {
        value: { workspace: { lifecycle: { entities: { [`analysis:${created.run.id}`]: {} } }, jobs: [], documents: [], rubrics: [] },
          cloud, notify: () => {} },
      }, createElement(ui.RealComparisonReview, { detail })),
    ))
    assert.match(comparisonMarkup, /Captured source section 1 of 1/)
    assert.doesNotMatch(comparisonMarkup, /Original page|Captured HTML/)
    const jobMarkup = renderToStaticMarkup(createElement(ui.DocumentViewer, {
      document: detail.targetSnapshot.document, pagination: api.documentPagination(detail.targetSnapshot.original.contentType),
    }))
    assert.match(jobMarkup, /Captured source section 1 of 1/)
    assert.doesNotMatch(jobMarkup, /Original page|Captured HTML/)
  })

  test(`${format.toUpperCase()} current and historical GS source inspectors describe one captured section without PDF/HTML labels`, async () => {
    const f = fixture()
    const job = await seedJob(f, 'Word engineering source', randomUUID(), format)
    const gs = await seedGrade(f, job)
    const frozen = gs.sourceSet.sources.find(source => source.origin === 'seed-job')
    const { sourceId, ...metadata } = frozen
    const live = api.parseGradeEntity({
      ...metadata, id: sourceId, workspaceId: f.workspaceId, ladderId: gs.selection.ladderId,
      recordType: 'grade-source', createdAt: NOW, updatedAt: NOW, status: 'ready',
      redirects: [], discoveryPath: [], relatedLinks: [], originalContentType: api.UPLOAD_CONTENT_TYPES[format],
      bytes: job.record.source.bytes, capturedAt: NOW, extractionMethod: 'seed-snapshot', extractionVersion: 'grade-seed-v1',
      inputFingerprint: job.record.inputFingerprint,
    })
    for (const source of [live, frozen]) {
      const markup = renderToStaticMarkup(createElement(ui.GradeSourceProvenance, { source }))
      assert.match(markup, /1 captured section/)
      assert.match(markup, /printed page numbers unavailable/)
      assert.doesNotMatch(markup, /original pages|Original page|HTML/)
      const document = JSON.parse(Buffer.from((await f.grades.blobs.read(source.documentBlobName)).bytes).toString())
      const viewer = renderToStaticMarkup(createElement(ui.DocumentViewer, {
        document, pagination: api.gradeSourcePagination(source), highlightedId: job.document.paragraphs[0].id,
        quote: job.document.paragraphs[0].text,
      }))
      assert.match(viewer, /Captured source section 1 of 1/)
      assert.match(viewer, /<mark>/)
      assert.doesNotMatch(viewer, /Original page|Captured HTML/)
    }
  })
}
