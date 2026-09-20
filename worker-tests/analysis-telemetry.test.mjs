import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { analysisResponseRequestId, emitAnalysisTelemetry, logAnalysisTelemetry } = await loadWorker('../worker/analyses/telemetry.ts')
const { createAnalysisEvidenceCatalog } = await loadWorker('../worker/analyses/evidence-passages.ts')
const { analysisSelectionCitationDiagnostics } = await loadWorker('../worker/analyses/citation-diagnostics.ts')
const { analysisSchemaDiagnostics } = await loadWorker('../worker/analyses/diagnostics.ts')

function event() {
  return {
    event: 'validation-failed', timestamp: '2026-09-18T12:00:00.000Z', stage: 'assessment',
    workspaceId: 'workspace-one', runId: 'run-one', comparisonId: 'comparison-one', attemptId: 'attempt-one',
    modelCallId: 'call-one', deployment: 'job-rubric', model: 'actual-model', correctionCount: 0,
    code: 'invalid-citation',
    rawOutput: 'PRIVATE-MODEL-SENTINEL', authorization: 'PRIVATE-TOKEN-SENTINEL',
    sourcePassages: [{ passageId: 1, paragraphId: 'paragraph-one', text: 'PRIVATE-SOURCE-SENTINEL' }],
    invalidSelection: { passageId: 'PRIVATE-IDENTITY-SENTINEL' }, unknownPassageId: 987654321,
    citationDiagnostics: {
      findings: [{
        reason: 'duplicate-citation', scope: 'criteria', rowIndex: 0, criterionId: 'criterion-one',
        citationIndex: 0, paragraphId: 'paragraph-one', quoteLength: 8, paragraphLength: 40,
        passageId: 1, passageCount: 4, startOffset: 0, endOffset: 8,
        quote: 'PRIVATE-QUOTE-SENTINEL', text: 'PRIVATE-SOURCE-SENTINEL',
        invalidPassageId: 'PRIVATE-IDENTITY-SENTINEL', selection: { passageId: 'PRIVATE-TOKEN-SENTINEL' },
      }],
      omittedFindings: 0, sourcePassages: [{ passageId: 1, text: 'PRIVATE-SOURCE-SENTINEL' }],
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
  assert.equal(events[0].citationDiagnostics.findings[0].passageId, 1)
  assert.equal(events[0].citationDiagnostics.findings[0].passageCount, 4)
  assert.equal(events[0].citationDiagnostics.findings[0].startOffset, 0)
  assert.equal(events[0].citationDiagnostics.findings[0].endOffset, 8)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|987654321|authorization|rawOutput|sourcePassages|invalidSelection|"quote":|"text":/)
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  logAnalysisTelemetry(event())
  assert.equal(lines.length, 1)
  const logged = JSON.parse(lines[0])
  assert.equal(logged.component, 'score-analysis')
  assert.equal(logged.event, 'validation-failed')
  assert.equal(logged.workspaceId, 'workspace-one')
  assert.doesNotMatch(lines[0], /PRIVATE|987654321|authorization|rawOutput|sourcePassages|invalidSelection|"quote":|"text":/)
})

test('catalog and resolution telemetry retain only approved hashes, versions and numeric counts', t => {
  const catalog = {
    catalogVersion: 'score-analysis-passages-v1',
    resumeDocumentSha256: 'a'.repeat(64), resumeSnapshotSha256: 'b'.repeat(64), targetSnapshotSha256: 'c'.repeat(64),
    sourceCharacters: 8_041, paragraphCount: 3, passageCount: 5,
  }
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  for (const [name, fields] of [
    ['evidence-catalog', catalog],
    ['citations-resolved', { citationCount: 3 }],
  ]) {
    const value = {
      ...event(), ...fields, event: name,
      resume: { title: 'PRIVATE-TITLE-SENTINEL', paragraphs: [{ text: 'PRIVATE-SOURCE-SENTINEL' }] },
      catalog: { passages: [{ passageId: 'PRIVATE-IDENTITY-SENTINEL', text: 'PRIVATE-SOURCE-SENTINEL' }] },
      sourceCharactersByParagraph: { 'PRIVATE-IDENTITY-SENTINEL': 20 },
      resolvedCitations: [{ quote: 'PRIVATE-QUOTE-SENTINEL' }], accessToken: 'PRIVATE-TOKEN-SENTINEL',
    }
    const events = []
    emitAnalysisTelemetry(safe => events.push(safe), value)
    logAnalysisTelemetry(value)
    const logged = JSON.parse(lines.at(-1))
    assert.equal(events[0].event, name)
    assert.equal(logged.event, name)
    for (const [key, expected] of Object.entries(fields)) {
      assert.equal(events[0][key], expected)
      assert.equal(logged[key], expected)
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|987654321|"quote":|"text":|"resume":|"catalog":|accessToken|resolvedCitations/)
    assert.doesNotMatch(lines.at(-1), /PRIVATE|987654321|"quote":|"text":|"resume":|"catalog":|accessToken|resolvedCitations/)
  }
})

test('selection diagnostics exclude invalid identities and unknown passage values before production logging', t => {
  const input = {
    resume: {
      id: 'saved-resume', version: 1, kind: 'resume', sample: false, title: 'PRIVATE-TITLE-SENTINEL',
      paragraphs: [{ id: 'saved-paragraph', page: 1, heading: 'PRIVATE-HEADING-SENTINEL', text: 'PRIVATE-SOURCE-SENTINEL' }],
    },
    rubric: { criteria: [{ id: 'saved-criterion' }] },
    qualifications: [{ id: 'saved-qualification' }],
  }
  const catalog = createAnalysisEvidenceCatalog(input.resume)
  const value = {
    criteria: [
      { criterionId: 'saved-criterion', citations: [{ passageId: 987654321 }, { passageId: 'PRIVATE-SELECTION-SENTINEL' }] },
      { criterionId: 'PRIVATE-CRITERION-SENTINEL', citations: [{ passageId: 1, quote: 'PRIVATE-QUOTE-SENTINEL' }] },
      { criterionId: 'saved-criterion', citations: [{ passageId: 1 }, { passageId: 1 }] },
    ],
    qualifications: [{
      qualificationId: 'saved-qualification', citations: [{ passageId: 'PRIVATE-TOKEN-SENTINEL' }],
    }],
  }
  const diagnostics = analysisSelectionCitationDiagnostics(value, input, catalog, 'assessment')
  assert.equal(diagnostics.findings[0].reason, 'unknown-passage')
  assert.equal(diagnostics.findings[0].passageId, undefined)
  assert.equal(diagnostics.findings[0].criterionId, 'saved-criterion')
  assert.equal(diagnostics.findings[2].criterionId, undefined)
  assert.equal(diagnostics.findings[3].reason, 'duplicate-citation')
  assert.equal(diagnostics.findings[3].passageId, 1)
  assert.equal(diagnostics.findings[3].paragraphId, 'saved-paragraph')
  assert.equal(diagnostics.findings[4].qualificationId, 'saved-qualification')
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  logAnalysisTelemetry({ ...event(), citationDiagnostics: diagnostics })
  const logged = JSON.parse(lines[0])
  assert.equal(logged.citationDiagnostics.findings[3].startOffset, 0)
  assert.equal(logged.citationDiagnostics.findings[3].endOffset, input.resume.paragraphs[0].text.length)
  assert.doesNotMatch(lines[0], /PRIVATE|987654321|"quote":|"text":|sourcePassages|authorization/)

  const review = { issues: [{
    criterionId: 'PRIVATE-CRITERION-SENTINEL', qualificationId: 'saved-qualification',
    citations: [{ passageId: 'PRIVATE-TOKEN-SENTINEL' }],
  }] }
  const reviewDiagnostics = analysisSelectionCitationDiagnostics(review, input, catalog, 'grounding')
  logAnalysisTelemetry({ ...event(), stage: 'grounding', citationDiagnostics: reviewDiagnostics })
  assert.equal(JSON.parse(lines[1]).citationDiagnostics.findings[0].qualificationId, 'saved-qualification')
  assert.doesNotMatch(lines[1], /PRIVATE|987654321|"quote":|"text":|sourcePassages|authorization/)
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

test('semantic review telemetry retains only allowed reason codes and saved scopes, never reviewer prose or drafts', t => {
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  logAnalysisTelemetry({
    event: 'validation-failed', timestamp: '2026-09-19T12:00:00.000Z', stage: 'grounding',
    code: 'grounding-failed', reason: 'grounding-disagreement', reviewOutcome: 'needs-correction',
    reviewIssueCount: 2,
    reviewIssues: [
      { code: 'unsupported-score', criterionId: 'saved-criterion', message: 'PRIVATE-REVIEW-SENTINEL', citations: [{ quote: 'PRIVATE-QUOTE-SENTINEL' }] },
      { code: 'PRIVATE-UNTRUSTED-CODE', message: 'PRIVATE-REVIEW-SENTINEL' },
    ],
    assessments: [{ rationale: 'PRIVATE-ASSESSMENT-SENTINEL' }],
    review: { issues: [{ message: 'PRIVATE-REVIEW-SENTINEL' }] },
  })
  const logged = JSON.parse(lines[0])
  assert.deepEqual(logged.reviewIssues, [{ code: 'unsupported-score', criterionId: 'saved-criterion' }])
  assert.equal(logged.reviewIssueCount, 2)
  assert.equal(logged.reason, 'grounding-disagreement')
  assert.doesNotMatch(lines[0], /PRIVATE|assessments|"review":|"message":|"quote":/)
})

test('schema findings expose bounded field locations without raw parser messages, values or arbitrary keys', t => {
  const findings = analysisSchemaDiagnostics(Array.from({ length: 40 }, () => ({
    code: 'invalid_value', path: ['criteria', 2, 'score'],
    message: 'PRIVATE-PARSER-SENTINEL', values: ['PRIVATE-VALUE-SENTINEL'],
  })))
  assert.equal(findings.findings.length, 32)
  assert.equal(findings.omittedFindings, 8)
  assert.deepEqual(findings.findings[0], { code: 'invalid_value', path: ['criteria', 2, 'score'] })
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  logAnalysisTelemetry({
    event: 'validation-failed', timestamp: '2026-09-19T12:00:00.000Z', stage: 'assessment',
    reason: 'schema-mismatch',
    schemaDiagnostics: {
      findings: [{
        code: 'PRIVATE-CODE-SENTINEL', path: ['criteria', 0, 'PRIVATE-FIELD-SENTINEL'],
        message: 'PRIVATE-PARSER-SENTINEL', values: ['PRIVATE-VALUE-SENTINEL'],
      }],
      omittedFindings: 0,
    },
  })
  assert.deepEqual(JSON.parse(lines[0]).schemaDiagnostics.findings, [{
    code: 'custom', path: ['criteria', 0, 'unknown-field'],
  }])
  assert.doesNotMatch(lines[0], /PRIVATE|"message":|"values":/)
})

test('a failed diagnostic sink is reported without exposing its exception or changing assessment behavior', t => {
  const warnings = []
  t.mock.method(console, 'error', (...args) => warnings.push(args))
  assert.doesNotThrow(() => emitAnalysisTelemetry(() => { throw new Error('PRIVATE-SINK-SENTINEL') }, event()))
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1].code, 'analysis-telemetry-failed')
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE/)
})
