import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { analysisResponseRequestId, emitAnalysisTelemetry, logAnalysisTelemetry } = await loadWorker('../worker/analyses/telemetry.ts')

function event() {
  return {
    event: 'validation-failed', timestamp: '2026-09-18T12:00:00.000Z', stage: 'assessment',
    workspaceId: 'workspace-one', runId: 'run-one', comparisonId: 'comparison-one', attemptId: 'attempt-one',
    modelCallId: 'call-one', deployment: 'job-rubric', model: 'actual-model', correctionCount: 0,
    code: 'invalid-citation',
    rawOutput: 'PRIVATE-MODEL-SENTINEL', authorization: 'PRIVATE-TOKEN-SENTINEL',
    citationDiagnostics: {
      findings: [{
        reason: 'quote-not-found', scope: 'criteria', rowIndex: 0, criterionId: 'criterion-one',
        citationIndex: 0, paragraphId: 'paragraph-one', quoteLength: 8, paragraphLength: 40,
        quote: 'PRIVATE-QUOTE-SENTINEL', text: 'PRIVATE-SOURCE-SENTINEL',
      }],
      omittedFindings: 0, sourceParagraphs: [{ text: 'PRIVATE-SOURCE-SENTINEL' }],
    },
  }
}

test('analysis event sinks and the production console logger allowlist nested payloads', t => {
  const events = []
  emitAnalysisTelemetry(value => events.push(value), event())
  assert.equal(events.length, 1)
  assert.equal(events[0].code, 'invalid-citation')
  assert.equal(events[0].citationDiagnostics.findings[0].paragraphId, 'paragraph-one')
  assert.equal(events[0].citationDiagnostics.findings[0].quoteLength, 8)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|authorization|rawOutput|sourceParagraphs|"quote":|"text":/)
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  logAnalysisTelemetry(event())
  assert.equal(lines.length, 1)
  const logged = JSON.parse(lines[0])
  assert.equal(logged.component, 'score-analysis')
  assert.equal(logged.event, 'validation-failed')
  assert.equal(logged.workspaceId, 'workspace-one')
  assert.doesNotMatch(lines[0], /PRIVATE|authorization|rawOutput|sourceParagraphs|"quote":|"text":/)
})

test('only bounded request ID formats are retained from upstream headers', () => {
  const uuid = '12345678-1234-4234-8234-123456789abc'
  assert.equal(analysisResponseRequestId(new Headers({ 'apim-request-id': uuid })), uuid)
  const request = `req_${'a'.repeat(24)}`
  assert.equal(analysisResponseRequestId(new Headers({ 'x-request-id': request })), request)
  assert.equal(analysisResponseRequestId(new Headers({
    'apim-request-id': 'PRIVATE-SENTINEL secret@example', 'x-request-id': request,
  })), request)
  for (const value of ['PRIVATE-SENTINEL', 'secret@example', `req_${'a'.repeat(100)}`, '../private']) {
    assert.equal(analysisResponseRequestId(new Headers({ 'x-request-id': value })), undefined)
  }
})

test('a failed diagnostic sink is reported without exposing its exception or changing assessment behavior', t => {
  const warnings = []
  t.mock.method(console, 'error', (...args) => warnings.push(args))
  assert.doesNotThrow(() => emitAnalysisTelemetry(() => { throw new Error('PRIVATE-SINK-SENTINEL') }, event()))
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1].code, 'analysis-telemetry-failed')
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE/)
})
