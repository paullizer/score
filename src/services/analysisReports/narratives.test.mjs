import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  loadReportFoundation, realReportFixture, reportSummariesFixture, withReadyReportNarratives, withReportNarratives, REPORT_TEST_TIMESTAMP,
} from './test-support.mjs'

let api, cleanup
before(async () => { ({ api, cleanup } = await loadReportFoundation()) })
after(async () => { await cleanup?.() })

test('legacy report payloads remain valid but cannot bypass the PDF/Word/PowerPoint narrative gate', () => {
  const legacy = api.buildAnalysisReport(realReportFixture())
  assert.throws(() => api.requireReportNarratives(legacy), /ready narrative capture/)
  assert.throws(() => api.candidateNarrativeText(legacy.groups[0].comparisons[0]), /saved candidate narrative/)
  assert.throws(() => api.candidateNarrativeOverview(legacy.groups[0].comparisons[0]), /saved candidate narrative/)
  assert.throws(() => api.targetNarrativeParagraphs(legacy.groups[0].target), /saved analysis overview/)
  assert.throws(() => api.reportTargetPresentation(legacy.groups[0].target), /Frozen job title/)
})

test('narrative helpers return complete saved fields verbatim and preserve legacy summaries, labels, scores and ordering', () => {
  const legacy = realReportFixture({ scores: [98, 95, 95, 90, 80, 80, null], targetCount: 2 })
  const input = withReportNarratives(legacy)
  input.comparisons[0].narrative.text = input.comparisons[0].narrative.text.replace('saved resume', 'captured resume')
  const original = JSON.stringify(input)
  const report = api.buildAnalysisReport(input)
  api.requireReportNarratives(report)
  const baseline = api.buildAnalysisReport(legacy)
  assert.deepEqual(report.counts, baseline.counts)
  for (const [index, group] of report.groups.entries()) {
    assert.equal(group.target.label, baseline.groups[index].target.label)
    assert.equal(group.target.sublabel, baseline.groups[index].target.sublabel)
    assert.deepEqual(group.highlightedComparisonIds, baseline.groups[index].highlightedComparisonIds)
    assert.deepEqual(api.targetNarrativeParagraphs(group.target), input.targets[index].narrative.paragraphs)
    for (const comparison of group.comparisons) {
      const saved = input.comparisons.find(item => item.id === comparison.id)
      const prior = baseline.groups[index].comparisons.find(item => item.id === comparison.id)
      assert.equal(api.candidateNarrativeText(comparison), saved.narrative.text)
      assert.equal(api.candidateNarrativeOverview(comparison), saved.narrative.overview)
      for (const field of ['summary', 'rank', 'highlighted']) assert.equal(comparison[field], prior[field])
      assert.deepEqual(comparison.overall, prior.overall)
    }
  }
  assert.equal(JSON.stringify(input), original)
})

test('canonical titles and organizations are separate, preserve dashes in full, and never merge identical-title targets', () => {
  const input = withReportNarratives(realReportFixture({ scores: [90], targetCount: 2 }))
  const title = 'Survey Statistician - Research Methods - Specialized Projects'
  for (const [index, target] of input.targets.entries()) {
    target.label = `Legacy combined label ${index} - not the presentation`
    target.sublabel = `Legacy version context ${index}`
    target.presentation = {
      title, organization: `Frozen Processing Center - Organization ${index}`,
      description: 'A full frozen description. This text must never be clipped.',
      series: '1530', grade: 'GS-12', versionLabel: target.versionLabel,
    }
  }
  const report = api.buildAnalysisReport(input)
  assert.equal(report.groups.length, 2)
  assert.notEqual(report.groups[0].target.id, report.groups[1].target.id)
  for (const [index, group] of report.groups.entries()) {
    const presentation = api.reportTargetPresentation(group.target)
    assert.equal(presentation.title, title)
    assert.equal(presentation.organization, `Frozen Processing Center - Organization ${index}`)
    assert.deepEqual(presentation, input.targets[index].presentation)
    presentation.title = 'A writer-owned copy'
    assert.equal(group.target.presentation.title, title)
    assert.equal(group.target.label, input.targets[index].label)
  }
})

test('strict additive report fields reject malformed prose, wrong provenance and unexpected metadata without weakening legacy schemas', () => {
  const mutations = [
    input => { input.targets[0].presentation.title = ' ' },
    input => { input.targets[0].presentation.organization = null },
    input => { input.targets[0].presentation.liveSource = 'mutable job' },
    input => { input.targets[0].narrative.dataKind = 'sample' },
    input => { input.comparisons[0].narrative.fixtureId = 'synthetic' },
    input => { input.comparisons[0].narrative.dataKind = 'sample' },
    input => { input.comparisons[0].narrative.text = 'One short statement.' },
    input => { input.comparisons[0].narrative.overview = 'A sentence with no ending' },
    input => { input.comparisons[0].narrative.overview = 'First complete sentence. Second complete sentence.' },
    input => { input.comparisons[0].narrative.overview = 'A fabricated shortened assessment...' },
    input => { input.comparisons[0].narrative.text = ` ${input.comparisons[0].narrative.text}` },
    input => { input.comparisons[0].narrative.text = input.comparisons[0].narrative.text.replace('saved resume', 'saved  resume') },
    input => { input.comparisons[0].narrative.overview += '\n' },
    input => { input.comparisons[0].narrative.overview = input.comparisons[0].narrative.overview.replace('record shows', 'record\tshows') },
    input => { input.targets[0].narrative.paragraphs[0] = input.targets[0].narrative.paragraphs[0].replace('reviewed records', 'reviewed\nrecords') },
    input => { input.comparisons[0].narrative.text = 'The evidence shows 4/5. The criterion totals show 5/5. The score is 90 out of 100.' },
    input => { input.comparisons[0].narrative.text += 'x'.repeat(901) },
    input => { input.targets[0].narrative.paragraphs = [''] },
    input => { input.targets[0].narrative.paragraphs = Array(4).fill('The record contains documented analytical examples.') },
    input => { input.targets[0].narrative.paragraphs = ['The source text was truncated...'] },
    input => { input.capture.summaries.source = 'fixture' },
  ]
  for (const mutate of mutations) {
    const input = withReportNarratives(realReportFixture({ scores: [90] }))
    mutate(input)
    assert.throws(() => api.buildAnalysisReport(input), undefined, mutate.toString())
  }
  assert.doesNotThrow(() => api.buildAnalysisReport(realReportFixture()))
})

test('read-only narrative validation shares generation sentence boundaries and returns normalized publications unchanged', () => {
  const input = withReportNarratives(realReportFixture({ scores: [90] }))
  const text = 'The U.S. laboratory measured 12.5 percent variation. Dr. Smith documented the method and its limitations. The method remained under review.'
  const overview = 'The U.S. laboratory documented variation, but the method remained under review.'
  input.comparisons[0].narrative.text = text
  input.comparisons[0].narrative.overview = overview
  const report = api.buildAnalysisReport(input)
  const comparison = report.groups[0].comparisons[0]
  assert.equal(api.candidateNarrativeText(comparison), text)
  assert.equal(api.candidateNarrativeOverview(comparison), overview)
  for (const whitespace of ['  ', '\t', '\n', '\r\n', '\u00a0']) {
    const changed = structuredClone(comparison)
    changed.narrative.text = text.replace('laboratory measured', `laboratory${whitespace}measured`)
    const original = changed.narrative.text
    assert.throws(() => api.candidateNarrativeText(changed), /valid saved candidate narrative/)
    assert.equal(changed.narrative.text, original, 'Export must reject changed prose instead of normalizing or repairing it.')
  }
})

test('writer gate validates exact scope membership, complete result/status pins, and exhaustive candidate and target revisions', () => {
  const input = withReportNarratives(realReportFixture({ scores: [90, 80], targetCount: 2 }))
  const good = api.buildAnalysisReport(input)
  const mutations = [
    report => { report.capture.summaries.ready = false },
    report => { report.scope.targetId = report.groups[0].target.id },
    report => { report.capture.summaries.scope.targetId = report.groups[0].target.id },
    report => { report.groups.pop() },
    report => { report.groups[0].comparisons.pop() },
    report => { report.groups[0].comparisons.push(structuredClone(report.groups[0].comparisons[0])) },
    report => { report.groups[0].comparisons[0].targetId = report.groups[1].target.id },
    report => { report.groups[0].comparisons[0].resultSha256 = 'b'.repeat(64) },
    report => { report.groups[0].comparisons[0].status = 'cancelled' },
    report => { report.groups[0].comparisons[0].narrative.revision = 'b'.repeat(64) },
    report => { report.groups[0].comparisons[0].narrative.inputFingerprint = 'b'.repeat(64) },
    report => { report.groups[0].target.narrative.revision = 'b'.repeat(64) },
    report => { report.groups[0].target.narrative.inputFingerprint = 'b'.repeat(64) },
    report => { report.capture.summaries.comparisons.pop() },
    report => { report.capture.summaries.targets.pop() },
    report => { report.capture.summaries.comparisons.push(structuredClone(report.capture.summaries.comparisons[0])) },
    report => { report.capture.summaries.targets.push({ targetId: 'extraneous-target', narrative: null }) },
    report => { delete report.groups[0].comparisons[0].narrative },
    report => { delete report.groups[0].target.narrative },
    report => { delete report.groups[0].target.presentation },
    report => { report.groups[0].comparisons[0].dataKind = 'sample' },
    report => { report.groups[0].target.dataKind = 'sample' },
  ]
  for (const mutate of mutations) {
    const report = structuredClone(good)
    mutate(report)
    assert.throws(() => api.requireReportNarratives(report), undefined, mutate.toString())
  }
})

test('report capture must be gated before completed-only adaptation removes terminal reviews', () => {
  const input = withReportNarratives(realReportFixture({ scores: [90, 80, 70], statuses: ['complete', 'failed', 'cancelled'] }))
  const report = api.buildAnalysisReport(input)
  api.requireReportNarratives(report)
  assert.equal(report.groups[0].comparisons[1].narrative, undefined)
  assert.equal(report.groups[0].comparisons[2].narrative, undefined)
  const filtered = structuredClone(report)
  filtered.groups[0].comparisons = filtered.groups[0].comparisons.filter(comparison => comparison.status === 'complete')
  assert.throws(() => api.requireReportNarratives(filtered), /missing captured reviews/)
  for (const status of ['queued', 'running']) {
    assert.throws(() => api.buildAnalysisReport(withReportNarratives(realReportFixture({ scores: [90, 80], statuses: ['complete', status] }))), /ready narrative capture/)
  }
})

test('summary DTO validation requires current ready state and does not treat retained old publications as ready', () => {
  const response = reportSummariesFixture(realReportFixture())
  assert.equal(api.realAnalysisSummariesResponseSchema.safeParse(response).success, true)
  for (const kind of ['comparisons', 'targets']) for (const change of [
    state => { state.generationId += '-new' },
    state => { state.inputFingerprint = 'b'.repeat(64) },
    state => { state.published = null },
    state => { state.status = 'running' },
  ]) {
    const copy = structuredClone(response)
    change(copy[kind][0])
    assert.equal(api.realAnalysisSummariesResponseSchema.safeParse(copy).success, false, `${kind}:${change}`)
  }
})

test('opt-in shared fixture stamping preserves supplied prose and presentation with deterministic real or sample identities', () => {
  const real = realReportFixture({ scores: [90], targetCount: 2 })
  const candidate = {
    text: 'The saved resume documents investigations of operational problems using observations from delivered services. Those examples support analytical work within the recorded scope of responsibility. Evidence of broader organizational ownership is not established by those passages.',
    overview: 'The recorded investigations support analytical work, but broader organizational ownership remains unestablished.',
  }
  const target = { paragraphs: ['The reviewed passages show relevant operational investigation and analytical work. Broader organizational ownership remains a limitation of the documented examples.'] }
  real.comparisons[0].narrative = structuredClone(candidate)
  real.targets[0].narrative = structuredClone(target)
  real.targets[0].presentation = {
    title: 'Explicit fixture role - preserve internal dashes', organization: 'Separate fictional organization',
    description: 'Full saved fixture description.', grade: '', series: '', versionLabel: real.targets[0].versionLabel,
  }
  const original = JSON.stringify(real)
  const stamped = withReportNarratives(real, { targetId: real.targets[0].id })
  assert.deepEqual(withReadyReportNarratives(real, { targetId: real.targets[0].id }), stamped)
  assert.equal(JSON.stringify(real), original)
  assert.equal(stamped.comparisons[0].narrative.text, candidate.text)
  assert.equal(stamped.comparisons[0].narrative.overview, candidate.overview)
  assert.deepEqual(stamped.targets[0].narrative.paragraphs, target.paragraphs)
  assert.deepEqual(stamped.targets[0].presentation, real.targets[0].presentation)
  assert.deepEqual(withReportNarratives(real, { targetId: real.targets[0].id }), stamped)
  api.requireReportNarratives(api.buildAnalysisReport(stamped, { targetId: real.targets[0].id }))
  const changed = structuredClone(real)
  changed.comparisons[0].narrative.text = candidate.text.replace('using observations', 'using detailed observations')
  const changedStamp = withReportNarratives(changed, { targetId: real.targets[0].id })
  assert.notEqual(changedStamp.comparisons[0].narrative.revision, stamped.comparisons[0].narrative.revision)
  assert.notEqual(changedStamp.targets[0].narrative.inputFingerprint, stamped.targets[0].narrative.inputFingerprint)
  assert.notEqual(changedStamp.capture.summaries.revision, stamped.capture.summaries.revision)
  assert.equal(changedStamp.capture.summaries.comparisons[0].narrative.revision, changedStamp.comparisons[0].narrative.revision)

  const saved = api.buildSampleAnalysisReport(api.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const sample = {
    dataKind: 'sample', run: saved.run, capture: saved.capture, generatedAt: saved.generatedAt,
    targets: saved.groups.map(group => group.target),
    comparisons: saved.groups.flatMap(group => group.comparisons.map(comparison => {
      const copy = structuredClone(comparison)
      delete copy.rank
      delete copy.highlighted
      return copy
    })),
  }
  const sampleOriginal = JSON.stringify(sample)
  const sampleStamp = withReportNarratives(sample)
  assert.equal(JSON.stringify(sample), sampleOriginal)
  assert.equal(sampleStamp.capture.summaries.source, 'fixture')
  assert.equal(sampleStamp.capture.summaries.dataKind, 'sample')
  for (const [index, comparison] of sampleStamp.comparisons.entries()) {
    assert.equal(comparison.narrative.text, sample.comparisons[index].narrative.text)
    assert.equal(comparison.narrative.dataKind, 'sample')
    assert.equal(comparison.narrative.fixtureId, sampleStamp.capture.summaries.fixtureId)
    assert.equal(comparison.narrative.generationId, undefined)
    assert.equal(comparison.narrative.publishedAt, undefined)
  }
  api.requireReportNarratives(api.buildAnalysisReport(sampleStamp))
  assert.throws(() => reportSummariesFixture(sample), /Only a real-shaped test fixture/)
  const mixed = structuredClone(real)
  mixed.comparisons[0].narrative.dataKind = 'sample'
  assert.throws(() => withReportNarratives(mixed), /keep real and sample provenance separate/)
})

test('sample narratives are deterministic, explicitly fixture-only and isolated from the legacy summaries', () => {
  const run = api.createInitialWorkspace().runs[0]
  const original = JSON.stringify(run)
  const options = { generatedAt: REPORT_TEST_TIMESTAMP }
  const first = api.buildSampleAnalysisReport(run, options)
  const second = api.buildSampleAnalysisReport(run, options)
  assert.deepEqual(first, second)
  assert.deepEqual(api.buildSampleAnalysisReport(run, { ...options, capture: first.capture }), first)
  assert.equal(first.capture.summaries.dataKind, 'sample')
  assert.equal(first.capture.summaries.source, 'fixture')
  assert.ok(first.capture.summaries.fixtureId)
  api.requireReportNarratives(first)
  for (const group of first.groups) {
    assert.equal(group.target.narrative.dataKind, 'sample')
    assert.equal(group.target.narrative.fixtureId, first.capture.summaries.fixtureId)
    assert.equal(group.target.narrative.generationId, undefined)
    const target = run.targets.find(target => target.id === group.target.id)
    assert.equal(group.target.presentation.title, target.job?.title ?? target.rubric.name)
    assert.equal(group.target.presentation.organization, target.job?.organization ?? '')
    assert.equal(group.target.presentation.description, target.rubric.description)
    assert.deepEqual(api.targetNarrativeParagraphs(group.target), group.target.narrative.paragraphs)
    for (const comparison of group.comparisons) {
      const saved = run.comparisons.find(saved => saved.id === comparison.id)
      assert.equal(comparison.summary, saved.summary)
      assert.equal(comparison.overall.score, saved.score)
      assert.equal(comparison.resultSha256, null)
      assert.equal(comparison.narrative.dataKind, 'sample')
      assert.equal(comparison.narrative.fixtureId, first.capture.summaries.fixtureId)
      assert.ok(!/\.{3}|\u2026/.test(api.candidateNarrativeText(comparison)))
      assert.ok(api.candidateNarrativeOverview(comparison).length <= 220)
    }
  }
  assert.equal(JSON.stringify(run), original)
  const wrong = structuredClone(first)
  wrong.groups[0].comparisons[0].narrative.fixtureId = 'another-fixture'
  assert.throws(() => api.requireReportNarratives(wrong), /fixture provenance/)
  const foreign = structuredClone(first.capture)
  foreign.summaries.fixtureId = 'another-fixture'
  assert.throws(() => api.buildSampleAnalysisReport(run, { ...options, capture: foreign }), /does not match this frozen fixture/)
})

test('sample saved useful prose is reused, selected scopes stay exact and fallback metadata never affects real targets', () => {
  const run = api.createInitialWorkspace().runs[0]
  const comparison = run.comparisons[0]
  comparison.summary = 'The fictional resume describes the investigation of service problems using documented observations. These examples support the target analytical work within the scope of the saved fixture. The evidence does not establish broader organizational responsibility beyond those examples.'
  const report = api.buildSampleAnalysisReport(run, { generatedAt: REPORT_TEST_TIMESTAMP, targetId: comparison.targetId })
  assert.equal(report.capture.summaries.scope.targetId, comparison.targetId)
  assert.equal(report.groups.length, 1)
  const saved = report.groups[0].comparisons.find(saved => saved.id === comparison.id)
  assert.equal(api.candidateNarrativeText(saved), comparison.summary)
  const target = structuredClone(report.groups[0].target)
  delete target.presentation
  target.label = 'Fixture title - including internal dashes'
  const prior = JSON.stringify(target)
  assert.equal(api.reportTargetPresentation(target).title, target.label)
  assert.equal(JSON.stringify(target), prior)
  target.dataKind = 'real'
  assert.throws(() => api.reportTargetPresentation(target), /Frozen job title/)
})

test('report worker rejects narrative-free PDF, Word and PowerPoint requests before loading a writer or emitting progress', async () => {
  const bundled = await build({
    entryPoints: ['src/services/analysisReports/report.worker.ts'], bundle: true, write: false,
    format: 'iife', platform: 'browser', logLevel: 'silent',
  })
  const report = api.buildAnalysisReport(realReportFixture())
  for (const format of ['pdf', 'docx', 'pptx']) {
    let listener, resolve
    const result = new Promise(done => { resolve = done })
    const sent = []
    runInNewContext(bundled.outputFiles[0].text, {
      TextEncoder, TextDecoder, Intl, console,
      self: {
        addEventListener: (_type, callback) => { listener = callback },
        postMessage: message => { sent.push(message); resolve(message) },
      },
    })
    listener({ data: { type: 'generate', requestId: `gate-${format}`, format, report, options: {} } })
    const message = await result
    assert.equal(message.type, 'error')
    assert.match(message.message, /ready narrative capture/)
    assert.equal(sent.length, 1)
  }
})

test('additive presentation and narratives leave real and sample CSV output bytes unchanged', async () => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'ts',
      contents: "export { generateCsvReport } from './src/services/analysisReports/csv';",
    },
    bundle: true, write: false, format: 'iife', globalName: 'LegacyWriters', platform: 'browser', logLevel: 'silent',
  })
  const write = async (report) => {
    const sandbox = { Blob, TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout, console }
    runInNewContext(`
      const NativeDate = Date;
      Date = class extends NativeDate {
        constructor(...args) { if (args.length) super(...args); else super('${REPORT_TEST_TIMESTAMP}'); }
        static now() { return NativeDate.parse('${REPORT_TEST_TIMESTAMP}'); }
      };
      let random = 17;
      Math.random = () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296);
      ${bundled.outputFiles[0].text}
      globalThis.writer = LegacyWriters;
    `, sandbox)
    return Buffer.from(await sandbox.writer.generateCsvReport(report, {
      links: { origin: 'https://score.test', ...(report.workspaceId ? { workspaceId: report.workspaceId } : {}) },
    }))
  }
  const input = realReportFixture({ scores: [90, null, 0], targetCount: 2 })
  const sample = api.buildSampleAnalysisReport(api.createInitialWorkspace().runs[0], { generatedAt: REPORT_TEST_TIMESTAMP })
  const legacySample = structuredClone(sample)
  delete legacySample.capture.summaries
  for (const group of legacySample.groups) {
    delete group.target.narrative
    delete group.target.presentation
    for (const comparison of group.comparisons) delete comparison.narrative
  }
  for (const [legacy, enriched] of [
    [api.buildAnalysisReport(input), api.buildAnalysisReport(withReportNarratives(input))], [legacySample, sample],
  ]) {
    assert.deepEqual(await write(enriched), await write(legacy), `${legacy.dataKind} CSV`)
  }
})
