import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { context, fixture, OPM_CATALOGS, urls } from './opm-fixtures.mjs'

const { discoverOpmSources, parseOpmDiscoveryResult } = await loadWorker('../worker/opm/index.ts')
const invalidResult = error => error.code === 'opm-invalid-discovery-result' && error.stage === 'parsing' && error.retryable === false

function capturedResult() {
  return {
    series: '0343',
    seriesTitle: 'Management and Program Analysis',
    seriesStatus: 'listed',
    catalogVersion: 'score-opm-dom-v0@2025-01-01T00:00:00.000Z:prior-captured-version',
    candidates: [{
      url: urls.legacy343,
      title: 'Management and Program Analysis Series, 0343',
      purpose: 'classification',
      publisher: 'U.S. Office of Personnel Management',
      coverage: { series: ['0343'], grades: [9, 11, 12], functions: [], state: 'conditional', explanation: 'Captured applicability, pending review.' },
      discoveryPath: [OPM_CATALOGS.classification, urls.classification340, urls.legacy343],
      revision: 'October 2024',
      authorityStatus: 'conflicting',
      relatedLinks: [{ url: 'https://public.example/comparison#evidence', label: 'External comparison, not automatically followed', relation: 'background', page: 8 }],
      issues: [{
        id: 'opm-scope-nine', code: 'opm-scope-conflict', scope: 'grade', grade: 9, severity: 'blocker',
        message: 'Captured GS-9 scope issue.',
        citations: [{ documentId: 'reference-one', documentVersion: 1, paragraphId: 'ref-p0008-b00001', page: 8, heading: 'Coverage', quote: 'The captured quotation.' }],
      }],
    }],
    issues: [],
  }
}

test('archived discovery decodes synchronously without network access, refreshed versions, mutation or metadata loss', () => {
  const archived = capturedResult()
  const before = JSON.stringify(archived)
  const savedFetch = globalThis.fetch
  globalThis.fetch = () => assert.fail('Decoding an immutable discovery artifact must not fetch anything')
  try {
    const result = parseOpmDiscoveryResult(archived)
    assert.deepEqual(result, archived)
    assert.equal(result.catalogVersion, archived.catalogVersion)
    assert.equal(result.candidates[0].url, urls.legacy343)
    assert.equal(result.candidates[0].issues[0].grade, 9)
    assert.equal(JSON.stringify(archived), before)
    result.candidates[0].coverage.grades.push(13)
    assert.deepEqual(archived.candidates[0].coverage.grades, [9, 11, 12])
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('all representative discovery outputs round-trip through the same immutable-artifact validator', async () => {
  for (const series of ['0340', '0343', '2210', '0801', '1102', '0892', '1515', '9999']) {
    const result = await discoverOpmSources(context(series), await fixture())
    const archived = JSON.parse(JSON.stringify(result))
    assert.deepEqual(parseOpmDiscoveryResult(archived), archived, series)
  }
})

test('same-URL qualification groups preserve independent intended sections and array order', () => {
  const result = capturedResult()
  result.candidates = ['GS-PROF', 'GS-ADMIN'].map(intendedSection => ({
    ...result.candidates[0],
    url: OPM_CATALOGS.groups,
    discoveryPath: [OPM_CATALOGS.qualifications, OPM_CATALOGS.groups],
    intendedSection,
    issues: [],
  }))
  assert.deepEqual(parseOpmDiscoveryResult(result).candidates.map(candidate => candidate.intendedSection), ['GS-PROF', 'GS-ADMIN'])
  result.candidates[1].intendedSection = 'GS-PROF'
  assert.throws(() => parseOpmDiscoveryResult(result), invalidResult)
})

test('malformed, incomplete and excess-field artifacts fail explicitly rather than receiving defaults or lossy coercion', () => {
  for (const value of [null, [], '{}', {}, { ...capturedResult(), candidates: undefined }, { ...capturedResult(), approved: true }]) {
    assert.throws(() => parseOpmDiscoveryResult(value), invalidResult)
  }
  for (const mutate of [
    result => { result.seriesStatus = 'current' },
    result => { result.series = '0000' },
    result => { result.catalogVersion = '' },
    result => { result.candidates[0].coverage.grades = [9, 9] },
    result => { result.candidates[0].coverage.grades = [16] },
    result => { result.candidates[0].coverage.grades = ['9'] },
    result => { result.candidates[0].coverage.state = 'approved' },
    result => { result.candidates[0].issues[0].grade = 0 },
    result => { result.candidates[0].issues[0].severity = 'resolved' },
    result => { result.candidates[0].issues[0].citations[0].documentVersion = -1 },
    result => { result.candidates[0].relatedLinks[0].page = 0 },
    result => { result.candidates[0].relatedLinks[0].relation = 'approved' },
    result => { result.candidates[0].authorityStatus = 'supplied' },
    result => { result.candidates[0].discoveryPath = [] },
    result => { result.candidates[0].originalBlobName = 'outside-the-artifact-contract' },
  ]) {
    const result = capturedResult()
    mutate(result)
    assert.throws(() => parseOpmDiscoveryResult(result), invalidResult)
  }
})

test('OPM candidate and discovery-path authority cannot be acquired through malformed, credentialed or external URLs', () => {
  for (const url of ['not a URL', 'file:///private/source.pdf', 'https://opm.gov.evil.example/source.pdf', 'https://www.opm.gov:8443/source.pdf', 'https://user:password@www.opm.gov/source.pdf']) {
    const result = capturedResult()
    result.candidates[0].url = url
    assert.throws(() => parseOpmDiscoveryResult(result), invalidResult)
  }
  const externalPath = capturedResult()
  externalPath.candidates[0].discoveryPath = ['https://outside.example/invented-catalog']
  assert.throws(() => parseOpmDiscoveryResult(externalPath), invalidResult)
  const publisher = capturedResult()
  publisher.candidates[0].publisher = 'Unverified agency'
  assert.throws(() => parseOpmDiscoveryResult(publisher), invalidResult)
})

test('source-count, duplicate-issue and field bounds cannot be bypassed by an archived result', () => {
  const tooMany = capturedResult()
  tooMany.candidates = Array.from({ length: 16 }, (_, index) => ({ ...tooMany.candidates[0], url: `https://www.opm.gov/source-${index}.pdf` }))
  assert.throws(() => parseOpmDiscoveryResult(tooMany), invalidResult)
  const duplicateIssues = capturedResult()
  duplicateIssues.candidates[0].issues.push(structuredClone(duplicateIssues.candidates[0].issues[0]))
  assert.throws(() => parseOpmDiscoveryResult(duplicateIssues), invalidResult)
  const longUrl = capturedResult()
  longUrl.candidates[0].url = `https://www.opm.gov/${'a'.repeat(4096)}`
  assert.throws(() => parseOpmDiscoveryResult(longUrl), invalidResult)
})
