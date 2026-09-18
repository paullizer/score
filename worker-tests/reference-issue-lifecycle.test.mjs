import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { fakeDi, htmlOriginal, immutableCache, pdfFixture, sha256, source } from './reference-fixtures.mjs'
import { context, fixture, htmlResponse, OPM_CATALOGS, urls } from './opm-fixtures.mjs'

const { extractReferenceDocument, getReferenceIssueTarget, reconcileReferenceIssues } = await loadWorker('../worker/references/index.ts')
const { discoverOpmSources } = await loadWorker('../worker/opm/index.ts')
const oldIssueId = (code, target, grade) => `opm-${createHash('sha256').update(`${code}:${target}:${grade ?? ''}`).digest('hex').slice(0, 20)}`
const policy = 'https://www.opm.gov/policy-data-oversight/classification-qualifications/general-schedule-qualification-policies/#e3'

function issue(code, target, changes = {}) {
  return {
    id: oldIssueId(code, target, changes.grade), code, scope: 'source', severity: 'blocker',
    message: 'An archived discovery message without any embedded target URL.', ...changes,
  }
}

function archivedSource(original, overrides = {}) {
  const input = source({
    origin: 'opm', authorityStatus: 'current',
    requestedUrl: 'https://www.opm.gov/public-fixtures/reference.pdf',
    ...overrides,
    sha256: sha256(original.bytes), bytes: original.bytes.byteLength, originalContentType: original.contentType,
  })
  input.originalBlobName = `${input.workspaceId}/${input.ladderId}/${input.id}/original.${original.contentType === 'application/pdf' ? 'pdf' : 'html'}`
  return input
}

function captured(source, extraction) {
  return {
    source: {
      ...source, status: 'ready', completeness: extraction.document.completeness,
      pageCount: extraction.document.pageCount, selectedPages: extraction.document.selectedPages,
      documentBlobName: `${source.workspaceId}/${source.ladderId}/${source.id}/document-v${source.documentVersion}.json`,
      extractionMethod: extraction.method, extractionVersion: extraction.extractionVersion,
    },
    document: extraction.document,
  }
}

const options = () => ({ documentIntelligence: fakeDi().options, ...immutableCache() })
const text = 'Qualification standards retain both education and experience alternatives. Experience is credited for the actual duties and level of work rather than only a job title.'

test('complete archived PDF extraction clears only its metadata-only self-capture notice and preserves provenance', async () => {
  const original = await pdfFixture(2)
  const input = archivedSource(original)
  input.issues = [
    issue('opm-pdf-content-review', input.requestedUrl, { severity: 'warning' }),
    issue('opm-aageg-illustrations', input.requestedUrl, { severity: 'warning' }),
    issue('opm-0340-grade-scope-conflict', input.requestedUrl, { scope: 'grade', grade: 9 }),
    issue('opm-draft-placeholder', input.requestedUrl),
    issue('opm-pdf-link-unresolved', input.requestedUrl, { severity: 'warning' }),
    issue('opm-agency-excluded', input.requestedUrl),
    issue('opm-0343-version-conflict', input.requestedUrl),
    issue('opm-source-budget-exhausted', input.requestedUrl),
  ]
  const before = structuredClone(input)
  const extraction = await extractReferenceDocument(input, original, options())
  const reconciled = reconcileReferenceIssues(input, extraction)
  assert.deepEqual(reconciled.issues, input.issues.slice(1))
  assert.equal(reconciled.resolved.length, 1)
  assert.deepEqual(reconciled.resolved[0], {
    issue: input.issues[0], reason: 'complete-source-extraction',
    evidence: { sourceId: input.id, documentId: input.documentId, documentVersion: 1, sha256: input.sha256 },
  })
  assert.deepEqual(input, before)
  assert.equal(input.coverage.state, 'conditional')
  assert.equal(input.authorityStatus, 'current')
})

test('partial selections, incomplete OCR and absent immutable original provenance cannot clear self-capture notices', async () => {
  const original = await pdfFixture(3)
  const input = archivedSource(original, { selectedPages: [1] })
  input.issues = [issue('opm-pdf-content-review', input.requestedUrl, { severity: 'warning' })]
  const selected = await extractReferenceDocument(input, original, options())
  assert.equal(selected.document.completeness, 'selected-pages')
  assert.deepEqual(reconcileReferenceIssues(input, selected).issues, input.issues)
  const incomplete = structuredClone(selected)
  incomplete.document.completeness = 'incomplete'
  assert.equal(reconcileReferenceIssues(input, incomplete).resolved.length, 0)
  const full = await extractReferenceDocument({ ...input, selectedPages: [] }, original, options())
  assert.equal(reconcileReferenceIssues({ ...input, selectedPages: [], sha256: undefined }, full).resolved.length, 0)
})

test('a GS-ADMIN traversal issue targets E.3, not the group itself, and survives successful group extraction', async () => {
  const publicSources = await fixture()
  const allGroups = publicSources.responses.get(urls.allQualifications)
  publicSources.responses.set(urls.allQualifications, htmlResponse(Buffer.from(allGroups.body).toString('utf8').replace(
    '<h2><a name="GS-PROF">',
    `<p>Qualification requirements refer to <a href="${policy}">E.3.(p)</a> for crediting experience in positions with different lines of progression.</p><h2><a name="GS-PROF">`,
  )))
  const result = await discoverOpmSources(context('0343'), publicSources)
  const group = result.candidates.find(candidate => candidate.intendedSection === 'GS-ADMIN')
  const deferred = group.issues.find(value => value.code === 'opm-traversal-limit')
  assert.ok(deferred)
  assert.equal(getReferenceIssueTarget({ relatedLinks: group.relatedLinks }, deferred).url, policy)
  assert.ok(deferred.message.includes(policy))
  assert.match(deferred.message, /not this source's own extraction/)
  const original = htmlOriginal(Buffer.from(publicSources.responses.get(urls.allQualifications).body).toString('utf8'), urls.allQualifications)
  const input = archivedSource(original, { requestedUrl: group.url, intendedSection: group.intendedSection, issues: group.issues, relatedLinks: group.relatedLinks })
  const extraction = await extractReferenceDocument(input, original, options())
  assert.equal(extraction.document.completeness, 'complete')
  assert.ok(reconcileReferenceIssues(input, extraction).issues.some(value => value.id === deferred.id))
})

test('an exact selected target capture resolves only the cross-reference capture fact and records its version', async () => {
  const groupHtml = `<main><h2><a name="GS-ADMIN"></a>Administrative and Management Positions</h2>
    <table><tr><th>Grade</th><th>Education OR experience</th></tr><tr><td>GS-9</td><td>${text}</td></tr></table>
    <p>See <a href="${policy}">E.3.(p)</a> for crediting experience.</p></main>`
  const original = htmlOriginal(groupHtml, urls.allQualifications)
  const input = archivedSource(original, {
    requestedUrl: OPM_CATALOGS.groups, intendedSection: 'GS-ADMIN',
    relatedLinks: [{ url: policy, label: 'E.3.(p)', relation: 'qualification' }],
    issues: [
      issue('opm-traversal-limit', policy),
      issue('opm-linked-source-unresolved', policy),
      issue('opm-group-selection-unresolved', policy),
    ],
  })
  const extraction = await extractReferenceDocument(input, original, options())
  const targetOriginal = htmlOriginal(`<main><h2 id="e3">Experience Requirements</h2><p>${text}</p>
    <h2 id="e4">Other section</h2><p>Not the required evidence.</p></main>`, policy.split('#')[0])
  const target = archivedSource(targetOriginal, {
    id: 'source-22222222-2222-4222-8222-222222222222', documentId: 'reference-policy', documentVersion: 3,
    requestedUrl: policy, intendedSection: 'e3', authorityStatus: 'unknown',
  })
  const targetExtraction = await extractReferenceDocument(target, targetOriginal, options())
  const reconciled = reconcileReferenceIssues(input, extraction, [captured(target, targetExtraction)])
  assert.deepEqual(reconciled.issues, input.issues.slice(1))
  assert.equal(reconciled.resolved[0].reason, 'captured-reference-target')
  assert.equal(reconciled.resolved[0].evidence.targetUrl, policy)
  assert.equal(reconciled.resolved[0].evidence.intendedSection, 'e3')
  assert.equal(reconciled.resolved[0].evidence.documentVersion, 3)
  assert.equal(target.authorityStatus, 'unknown')
  assert.equal(target.coverage.state, 'conditional')
  assert.deepEqual(reconcileReferenceIssues(input, extraction).issues, input.issues, 'An unselected target cannot resolve a later source set.')
})

test('a wrong named fragment, anonymous upload, stale version or another workspace cannot satisfy an outgoing reference', async () => {
  const original = htmlOriginal(`<main><h1>Group requirements</h1><p>${text}</p><p><a href="${policy}">E.3</a></p></main>`, urls.allQualifications)
  const input = archivedSource(original, {
    requestedUrl: urls.allQualifications,
    relatedLinks: [{ url: policy, label: 'E.3', relation: 'qualification' }],
    issues: [issue('opm-traversal-limit', policy)],
  })
  const extraction = await extractReferenceDocument(input, original, options())
  const targetOriginal = htmlOriginal(`<main><h2 id="e4">Education Requirements</h2><p>${text}</p></main>`, policy.split('#')[0])
  const target = archivedSource(targetOriginal, {
    id: 'source-22222222-2222-4222-8222-222222222222', documentId: 'reference-other',
    requestedUrl: `${policy.split('#')[0]}#e4`, intendedSection: 'e4',
  })
  const targetExtraction = await extractReferenceDocument(target, targetOriginal, options())
  const evidence = captured(target, targetExtraction)
  assert.equal(reconcileReferenceIssues(input, extraction, [evidence]).resolved.length, 0)
  assert.equal(reconcileReferenceIssues(input, extraction, [{ ...evidence, source: { ...evidence.source, requestedUrl: undefined, finalUrl: undefined, origin: 'upload' } }]).resolved.length, 0)
  for (const mutation of [{ documentVersion: 2 }, { workspaceId: 'another-workspace' }, { ladderId: 'another-ladder' }]) {
    assert.throws(() => reconcileReferenceIssues(input, extraction, [{ ...evidence, source: { ...evidence.source, ...mutation } }]),
      error => error.code === 'reference-issue-evidence-mismatch')
  }
  assert.throws(() => reconcileReferenceIssues(input, { ...extraction, document: { ...extraction.document, version: 99 } }),
    error => error.code === 'reference-issue-evidence-mismatch')
})

test('a recovered named section clears its historical missing-capture notice without promoting unknown authority or coverage', async () => {
  const url = 'https://www.opm.gov/public-fixtures/policy/#343'
  const original = htmlOriginal(`<main><h2 id="343">GS-5/7 qualification exception</h2><p>${text}</p></main>`, url.split('#')[0])
  const input = archivedSource(original, {
    requestedUrl: url, intendedSection: '343', authorityStatus: 'unknown',
    coverage: { series: ['0343'], grades: [5, 7], functions: [], state: 'unknown', explanation: 'The named section was missing during discovery.' },
    issues: [
      issue('opm-linked-section-missing', url, { scope: 'grade', grade: 5 }),
      issue('opm-linked-section-missing', url, { scope: 'grade', grade: 7 }),
      issue('opm-0343-version-conflict', url),
    ],
  })
  const extraction = await extractReferenceDocument(input, original, options())
  const result = reconcileReferenceIssues(input, extraction)
  assert.deepEqual(result.resolved.map(value => [value.reason, value.issue.grade]), [['captured-named-section', 5], ['captured-named-section', 7]])
  assert.deepEqual(result.issues, input.issues.slice(2))
  assert.equal(input.authorityStatus, 'unknown')
  assert.equal(input.coverage.state, 'unknown')
})

test('unknown legacy issue targets and mismatched source ownership are retained rather than guessed from prose', async () => {
  const original = await pdfFixture(1)
  const input = archivedSource(original)
  input.issues = [
    issue('opm-traversal-limit', policy, { message: `It might refer to ${input.requestedUrl}, but messages are not identifiers.` }),
    issue('opm-pdf-content-review', input.requestedUrl, { severity: 'warning', sourceId: 'source-foreign' }),
    { ...issue('opm-pdf-content-review', input.requestedUrl, { severity: 'warning' }), id: 'opaque-legacy-id' },
  ]
  const extraction = await extractReferenceDocument(input, original, options())
  const result = reconcileReferenceIssues(input, extraction)
  assert.equal(getReferenceIssueTarget(input, input.issues[0]), undefined)
  assert.deepEqual(result.issues, input.issues)
  assert.equal(result.resolved.length, 0)
})

test('an outgoing PDF page target needs complete captured coverage, not the annotation’s referring page or a partial selection', async () => {
  const targetUrl = 'https://www.opm.gov/public-fixtures/supplement.pdf#page=2'
  const original = await pdfFixture(4, [{ page: 4, url: targetUrl, label: 'Qualification supplement' }])
  const input = archivedSource(original, { issues: [issue('opm-traversal-limit', targetUrl)] })
  const extraction = await extractReferenceDocument(input, original, options())
  const target = getReferenceIssueTarget(input, input.issues[0], extraction.links)
  assert.equal(target.page, 4, 'The URI annotation is on the referring document page, not the target page.')
  assert.equal(target.url, targetUrl)
  const targetOriginal = await pdfFixture(3)
  const targetSource = archivedSource(targetOriginal, {
    id: 'source-22222222-2222-4222-8222-222222222222', documentId: 'reference-supplement',
    requestedUrl: targetUrl, selectedPages: [2],
  })
  const partial = await extractReferenceDocument(targetSource, targetOriginal, options())
  assert.equal(reconcileReferenceIssues(input, extraction, [captured(targetSource, partial)]).resolved.length, 0)
  const wholeSource = { ...targetSource, selectedPages: [] }
  const complete = await extractReferenceDocument(wholeSource, targetOriginal, options())
  const result = reconcileReferenceIssues(input, extraction, [captured(wholeSource, complete)])
  assert.equal(result.issues.length, 0)
  assert.equal(result.resolved[0].evidence.targetUrl, targetUrl)
})

test('the E.3 named list section retains nested E.3(p) experience guidance needed by the group cross-reference', async () => {
  const sourceHtml = `<main><ol><li><a name="e3"></a><p><strong>Experience Requirements</strong></p>
    <ol type="a"><li>General experience requirements.</li><li>Specialized experience requirements.</li>
    <li value="16">For a two-grade interval series, evaluate experience against the actual established line of progression, including intervening even-numbered grades where applicable.</li>
    </ol></li><li><a name="e4"></a><p>Separate education requirements.</p></li></ol></main>`
  const original = htmlOriginal(sourceHtml, policy.split('#')[0])
  const input = archivedSource(original, { requestedUrl: policy, intendedSection: 'e3' })
  const extraction = await extractReferenceDocument(input, original, options())
  assert.ok(extraction.document.paragraphs.some(paragraph => paragraph.sectionId === 'e3' &&
    paragraph.text.includes('actual established line of progression')))
})
