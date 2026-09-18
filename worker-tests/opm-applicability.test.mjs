import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { context, fixture, htmlResponse, pdfResponse, qualificationUrl, urls } from './opm-fixtures.mjs'
import { pdfFixture } from './reference-fixtures.mjs'

const { discoverOpmSources, parseOpmDiscoveryResult } = await loadWorker('../worker/opm/index.ts')
const { prepareEvidence, isGradeEvidence } = await loadWorker('../worker/grades/model-evidence.ts')

function frozenEvidence(candidates, positionContext, grades = [9, 13], inherited = []) {
  const sources = candidates.map((candidate, index) => ({
    sourceId: `source-00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: candidate.title, origin: 'opm', purpose: candidate.purpose, publisher: candidate.publisher,
    documentId: `reference-${index + 1}`, documentVersion: 1,
    documentBlobName: `workspace-one/ladder-one/source-${index + 1}/document-v1.json`,
    originalBlobName: `workspace-one/ladder-one/source-${index + 1}/original.pdf`,
    sha256: 'a'.repeat(64), url: candidate.url, revision: candidate.revision,
    authorityStatus: candidate.authorityStatus, coverage: structuredClone(candidate.coverage),
    pageCount: 1, selectedPages: [1], completeness: 'complete',
    issues: structuredClone(candidate.issues),
  }))
  const documents = sources.map(source => ({
    id: source.documentId, version: 1, kind: 'reference', sample: false, title: source.title,
    pageCount: 1, selectedPages: [1], completeness: 'complete',
    paragraphs: grades.map(grade => ({
      id: `p-gs-${grade}`, page: 1, heading: `GS-${grade}`,
      text: `Synthetic source statement for GS-${grade} work. This fixture tests metadata eligibility, not a real grading determination.`,
    })),
  }))
  const sourceSet = {
    id: 'source-set-one', workspaceId: 'workspace-one', ladderId: 'ladder-one', recordType: 'grade-source-set',
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    revision: 1, context: positionContext, grades, seedBlobName: 'workspace-one/ladder-one/seed.json',
    sources, issues: inherited, contentHash: 'b'.repeat(64), confirmedBy: 'reviewer',
    decisions: sources.map(source => ({ sourceId: source.sourceId, selected: true, applicability: 'applicable', reason: 'Selected captured evidence.' })),
  }
  return {
    sourceSet, documents,
    citation: (index, grade) => {
      const paragraph = documents[index].paragraphs.find(value => value.heading === `GS-${grade}`)
      return {
        documentId: documents[index].id, documentVersion: 1, paragraphId: paragraph.id,
        page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
      }
    },
  }
}

test('uncomplicated catalog-backed standards are confirmed/current and pass the existing model eligibility gate', async () => {
  const positionContext = context('1515')
  const result = await discoverOpmSources(positionContext, await fixture())
  const standard = result.candidates.find(candidate => candidate.url === urls.math)
  assert.equal(standard.coverage.state, 'confirmed')
  assert.equal(standard.authorityStatus, 'current')
  assert.deepEqual(standard.coverage.functions, ['nonsupervisory'])
  assert.equal(result.candidates.find(candidate => candidate.intendedSection === 'GS-PROF').coverage.state, 'confirmed')
  const input = frozenEvidence([standard], positionContext)
  const evidence = prepareEvidence(input.sourceSet, input.documents, [], 9)
  assert.equal(isGradeEvidence(input.citation(0, 9), evidence, 9), true)
  assert.ok(!evidence.issues.some(issue => ['source-coverage-unresolved', 'grading-evidence-missing'].includes(issue.code)))
})

test('unconfirmed, unknown-function and specialized base-standard contexts do not get blanket confirmed coverage', async () => {
  for (const changes of [{ confirmed: false }, { supervision: 'unknown' }, { functions: ['research'] }, { agencyType: 'non-federal' }]) {
    const result = await discoverOpmSources(context('1515', changes), await fixture())
    assert.equal(result.candidates.find(candidate => candidate.url === urls.math).coverage.state, 'conditional')
  }
})

test('functional guides become confirmed through actual matched-series references, not merely a global catalog or context checkbox', async () => {
  const positionContext = context('0801', { supervision: 'supervisor', functions: ['research'] })
  const result = await discoverOpmSources(positionContext, await fixture())
  assert.equal(result.candidates.find(candidate => candidate.url === urls.engineering).coverage.state, 'conditional')
  for (const url of [urls.researchGuide, urls.supervisorGuide]) {
    const guide = result.candidates.find(candidate => candidate.url === url)
    assert.equal(guide.coverage.state, 'confirmed')
    assert.equal(guide.authorityStatus, 'current')
    const input = frozenEvidence([guide], positionContext)
    assert.equal(isGradeEvidence(input.citation(0, 13), prepareEvidence(input.sourceSet, input.documents, [], 13), 13), true)
  }
  const noReference = await fixture()
  noReference.responses.set(urls.engineering, pdfResponse((await pdfFixture(177)).bytes))
  const unresolved = await discoverOpmSources(positionContext, noReference)
  const guide = unresolved.candidates.find(candidate => candidate.url === urls.researchGuide)
  assert.equal(guide.coverage.state, 'conditional')
  const input = frozenEvidence([guide], positionContext)
  input.sourceSet.decisions[0].reason = 'The reviewer selected applicable, but there is no source-backed binding.'
  assert.equal(isGradeEvidence(input.citation(0, 13), prepareEvidence(input.sourceSet, input.documents, [], 13), 13), false)
})

test('0340 GS-9 through GS-12 blockers do not create unconfirmed metadata or blockers for GS-13', async () => {
  const positionContext = context('0340')
  const result = await discoverOpmSources(positionContext, await fixture())
  const flysheet = result.candidates.find(candidate => candidate.url === urls.classification340)
  const guide = result.candidates.find(candidate => candidate.url === urls.adminGuide)
  for (const candidate of [flysheet, guide]) {
    assert.equal(candidate.coverage.state, 'confirmed')
    assert.equal(candidate.authorityStatus, 'current')
  }
  assert.deepEqual(guide.coverage.grades, [9, 10, 11, 12, 13, 14, 15])
  const input = frozenEvidence([flysheet, guide], positionContext, [9, 13], result.issues)
  const higher = prepareEvidence(input.sourceSet, input.documents, [], 13)
  assert.ok(!higher.issues.some(issue => issue.severity === 'blocker'))
  assert.equal(isGradeEvidence(input.citation(1, 13), higher, 13), true)
  const lower = prepareEvidence(input.sourceSet, input.documents, [], 9)
  assert.ok(lower.issues.some(issue => issue.code === 'opm-0340-grade-scope-conflict' && issue.grade === 9))
  assert.ok(!lower.issues.some(issue => issue.code === 'source-coverage-unresolved'))
})

test('qualifications may have confirmed applicability without becoming weighted work-level basis', async () => {
  const positionContext = context('0801')
  const result = await discoverOpmSources(positionContext, await fixture())
  const requirements = result.candidates.filter(candidate => candidate.purpose === 'qualification')
  assert.ok(requirements.length >= 3)
  assert.ok(requirements.every(candidate => candidate.coverage.state === 'confirmed'))
  const input = frozenEvidence(requirements, positionContext)
  const evidence = prepareEvidence(input.sourceSet, input.documents, [], 9)
  assert.equal(isGradeEvidence(input.citation(0, 9), evidence, 9), false)
  assert.ok(evidence.issues.some(issue => issue.code === 'grading-evidence-missing'))
})

test('DoD exclusions and unresolved agency context override only the affected qualification coverage', async () => {
  for (const [changes, state] of [
    [{}, 'confirmed'],
    [{ agency: '', agencyType: 'unknown' }, 'conditional'],
    [{ agency: 'Department of Defense', agencyType: 'dod' }, 'conflicting'],
  ]) {
    const result = await discoverOpmSources(context('1102', changes), await fixture())
    const qualification = result.candidates.find(candidate => candidate.url === qualificationUrl('1102'))
    assert.equal(qualification.coverage.state, state)
    assert.equal(qualification.authorityStatus, 'current')
    assert.equal(result.candidates.find(candidate => candidate.url === urls.contracting).coverage.state, 'confirmed')
  }
})

test('real revision conflicts and draft placeholders remain conflicting; a clean policy standard can be confirmed', async () => {
  const conflicted = await discoverOpmSources(context('0343'), await fixture())
  for (const url of [urls.classification343, urls.legacy343]) {
    const candidate = conflicted.candidates.find(candidate => candidate.url === url)
    assert.equal(candidate.coverage.state, 'conflicting')
    assert.equal(candidate.authorityStatus, 'conflicting')
  }
  assert.equal(conflicted.candidates.find(candidate => candidate.url === urls.adminGuide).coverage.state, 'conditional')
  const publicSources = await fixture()
  const draft = await discoverOpmSources(context('2210'), publicSources)
  assert.equal(draft.candidates.find(candidate => candidate.url === urls.policyPrint).coverage.state, 'conflicting')
  const print = publicSources.responses.get(urls.policyPrint)
  publicSources.responses.set(urls.policyPrint, htmlResponse(Buffer.from(print.body).toString('utf8').replace('<p>DRAFT placeholder: insert date.</p>', '')))
  const clean = await discoverOpmSources(context('2210'), publicSources)
  assert.equal(clean.candidates.find(candidate => candidate.url === urls.policyPrint).coverage.state, 'confirmed')
  assert.equal(clean.candidates.find(candidate => candidate.url === urls.policyPrint).authorityStatus, 'current')
})

test('arbitrary linked supplements do not inherit confirmed grading applicability from an authoritative parent', async () => {
  const publicSources = await fixture()
  const supplement = 'https://www.opm.gov/public-fixtures/unmapped-grading-supplement.pdf'
  publicSources.responses.set(urls.math, pdfResponse((await pdfFixture(8, [{ page: 1, url: supplement, label: 'Grading supplement' }])).bytes))
  publicSources.responses.set(supplement, pdfResponse((await pdfFixture(1)).bytes))
  const result = await discoverOpmSources(context('1515'), publicSources)
  assert.equal(result.candidates.find(candidate => candidate.url === urls.math).coverage.state, 'confirmed')
  assert.equal(result.candidates.find(candidate => candidate.url === supplement).coverage.state, 'conditional')
})

test('agency evidence requires upstream source-backed coverage confirmation and remains supplied authority', async () => {
  const positionContext = context('0340')
  const result = await discoverOpmSources(positionContext, await fixture())
  const input = frozenEvidence([result.candidates.find(candidate => candidate.url === urls.adminGuide)], positionContext)
  const source = input.sourceSet.sources[0]
  source.origin = 'upload'
  source.purpose = 'agency'
  source.publisher = 'User-supplied agency reference'
  source.authorityStatus = 'supplied'
  source.coverage = { series: ['0340'], grades: [9, 13], functions: [], state: 'unknown', explanation: 'Applicability not assessed.' }
  source.issues = []
  input.sourceSet.decisions[0].reason = 'Selected as applicable; a decision alone is not an applicability assessment.'
  let evidence = prepareEvidence(input.sourceSet, input.documents, [], 9)
  assert.equal(isGradeEvidence(input.citation(0, 9), evidence, 9), false)
  assert.ok(evidence.issues.some(issue => issue.code === 'source-coverage-unresolved'))
  // This represents a separate, source-backed upstream assessment, not a production confirmation path.
  source.coverage = { ...source.coverage, state: 'confirmed', explanation: 'Synthetic fixture with explicit agency/series/grade scope for eligibility testing.' }
  evidence = prepareEvidence(input.sourceSet, input.documents, [], 9)
  assert.equal(isGradeEvidence(input.citation(0, 9), evidence, 9), true)
  assert.equal(source.authorityStatus, 'supplied')
})

test('retry decoding never retroactively upgrades an immutable pre-v2 coverage decision', async () => {
  const result = await discoverOpmSources(context('1515'), await fixture())
  assert.match(result.catalogVersion, /^score-opm-dom-v2@/)
  const prior = JSON.parse(JSON.stringify(result))
  prior.catalogVersion = prior.catalogVersion.replace('score-opm-dom-v2', 'score-opm-dom-v1')
  prior.candidates.forEach(candidate => { candidate.coverage.state = 'conditional' })
  assert.deepEqual(parseOpmDiscoveryResult(prior), prior)
})
