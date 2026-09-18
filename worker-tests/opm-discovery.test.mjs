import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'
import { context, fixture, htmlResponse, OPM_CATALOGS, pdfResponse, qualificationUrl, urls } from './opm-fixtures.mjs'
import { pdfFixture } from './reference-fixtures.mjs'

const { discoverOpmSources, OPM_CATALOG_VERSION } = await loadWorker('../worker/opm/index.ts')
const allIssues = result => [...result.issues, ...result.candidates.flatMap(candidate => candidate.issues)]

test('arbitrary series discovery expands actual family lists instead of relying on demonstration-series mappings', async () => {
  const publicSources = await fixture()
  const result = await discoverOpmSources(context('1515'), publicSources)
  assert.equal(result.seriesStatus, 'listed')
  const standard = result.candidates.find(candidate => candidate.url === urls.math)
  assert.ok(standard)
  assert.deepEqual(standard.coverage.series, ['1515', '1520'])
  assert.deepEqual(standard.discoveryPath, [OPM_CATALOGS.classification, urls.math])
  assert.ok(result.catalogVersion.startsWith(`${OPM_CATALOG_VERSION}@`))
  assert.match(result.catalogVersion, /:[a-f0-9]{64}$/)
  assert.ok(result.candidates.some(candidate => candidate.intendedSection === 'GS-PROF'))
  assert.ok(!result.candidates.some(candidate => candidate.url === urls.adminGuide))
  assert.ok(result.candidates.length <= 15)
})

test('0340 preserves the grade-specific scope conflict without declaring all lower grades unlawful', async () => {
  const publicSources = await fixture()
  const result = await discoverOpmSources(context('0340'), publicSources)
  const standard = result.candidates.find(candidate => candidate.url === urls.classification340)
  assert.equal(standard.purpose, 'classification')
  assert.equal(standard.revision, 'May 2019')
  const conflicts = standard.issues.filter(issue => issue.code === 'opm-0340-grade-scope-conflict')
  assert.deepEqual(conflicts.map(issue => issue.grade), [9, 10, 11, 12])
  assert.ok(conflicts.every(issue => issue.scope === 'grade' && issue.severity === 'blocker'))
  assert.equal(standard.authorityStatus, 'current')
  assert.ok(!standard.issues.some(issue => issue.grade === 13 && issue.severity === 'blocker'))
  assert.ok(allIssues(result).some(issue => issue.code === 'opm-program-management-title'))
  assert.ok(allIssues(result).some(issue => issue.code === 'opm-aageg-illustrations'))
  assert.ok(!result.candidates.some(candidate => candidate.url === urls.supervisorGuide))
  assert.ok(standard.relatedLinks.some(link => link.url === urls.supervisorGuide && link.relation === 'exclusion'))
})

test('0343 discovers both catalog and legacy revisions through actual PDF annotations and retains a version conflict', async () => {
  const publicSources = await fixture()
  const result = await discoverOpmSources(context('0343'), publicSources)
  const catalog = result.candidates.find(candidate => candidate.url === urls.classification343)
  const legacy = result.candidates.find(candidate => candidate.url === urls.legacy343)
  assert.equal(catalog.revision, 'may 2024')
  assert.equal(legacy.revision, 'October 2024')
  assert.deepEqual(legacy.discoveryPath, [OPM_CATALOGS.classification, urls.classification340, urls.legacy343])
  assert.ok(publicSources.requested.includes(urls.current343))
  assert.equal(catalog.authorityStatus, 'conflicting')
  assert.equal(legacy.authorityStatus, 'conflicting')
  assert.ok(catalog.issues.some(issue => issue.code === 'opm-0343-version-conflict'))
  assert.ok(legacy.relatedLinks.some(link => link.url === urls.classification343 && link.relation === 'supersession'))
  const policy = result.candidates.find(candidate => candidate.url === `${urls.qualificationPolicy}#0343`)
  assert.deepEqual(policy.coverage.grades, [5, 7])
})

test('a missing 0343 version-bridge annotation yields an explicit unresolved issue, never a synthesized legacy URL', async () => {
  const publicSources = await fixture()
  publicSources.responses.set(urls.classification340, pdfResponse((await pdfFixture(14)).bytes))
  const result = await discoverOpmSources(context('0343'), publicSources)
  assert.ok(result.issues.some(issue => issue.code === 'opm-version-path-unresolved'))
  assert.ok(!publicSources.requested.includes(urls.legacy343))
})

test('0801 uses explicit 0800 family coverage, the separate engineering IOR and its real named qualification group', async () => {
  const publicSources = await fixture()
  const result = await discoverOpmSources(context('0801', { supervision: 'supervisor', functions: ['research'] }), publicSources)
  const standard = result.candidates.find(candidate => candidate.url === urls.engineering)
  assert.deepEqual(standard.coverage.series, ['0801', '0803'])
  assert.ok(result.candidates.some(candidate => candidate.url === urls.engineeringIor && candidate.purpose === 'qualification'))
  assert.ok(result.candidates.some(candidate => candidate.url === urls.researchGuide))
  assert.ok(result.candidates.some(candidate => candidate.url === urls.supervisorGuide))
  assert.ok(!result.candidates.some(candidate => candidate.url === urls.leaderGuide))
  const group = result.candidates.find(candidate => candidate.intendedSection === 'GS-PROF')
  assert.ok(group)
  assert.equal(group.url, OPM_CATALOGS.groups)
  assert.ok(!result.candidates.some(candidate => candidate.intendedSection === 'GS-ADMIN'))
})

test('1102 keeps its DoD exclusion and explicit absence of a group standard; context is required', async () => {
  const publicSources = await fixture()
  const unknown = await discoverOpmSources(context('1102', { agency: '', agencyType: 'unknown' }), publicSources)
  assert.ok(allIssues(unknown).some(issue => issue.code === 'opm-agency-context-required'))
  assert.ok(!unknown.candidates.some(candidate => candidate.intendedSection?.startsWith('GS-')))
  const qualification = unknown.candidates.find(candidate => candidate.url === qualificationUrl('1102'))
  assert.match(qualification.coverage.explanation, /no Group Coverage Qualification Standard/)
  const dod = await discoverOpmSources(context('1102', { agency: 'Department of Defense', agencyType: 'dod' }), await fixture())
  assert.ok(allIssues(dod).some(issue => issue.code === 'opm-agency-excluded' && issue.scope === 'qualification'))
  const civilian = await discoverOpmSources(context('1102'), await fixture())
  assert.ok(!allIssues(civilian).some(issue => issue.code === 'opm-agency-context-required' || issue.code === 'opm-agency-excluded'))
})

test('2210 follows real current competency navigation, outside-main print content and issuance links without obsolete alternatives', async () => {
  const publicSources = await fixture()
  const result = await discoverOpmSources(context('2210'), publicSources)
  assert.equal(result.seriesStatus, 'listed')
  assert.ok(publicSources.requested.includes(urls.policyGroup))
  const classification = result.candidates.find(candidate => candidate.url === urls.policyPrint)
  const qualifications = result.candidates.find(candidate => candidate.url === urls.policyQual)
  assert.equal(classification.purpose, 'grading')
  assert.ok(classification.discoveryPath.includes(urls.policyClass))
  assert.equal(qualifications.purpose, 'qualification')
  assert.equal(classification.revision, 'April 2026')
  assert.equal(classification.authorityStatus, 'conflicting')
  assert.ok(classification.issues.some(issue => issue.code === 'opm-draft-placeholder'))
  assert.ok(result.candidates.some(candidate => candidate.url === urls.issuance && candidate.purpose === 'issuance'))
  assert.ok(!publicSources.requested.includes(urls.oldAlternative))
  assert.ok(!result.candidates.some(candidate => candidate.intendedSection === 'GS-ADMIN'))
  assert.ok(qualifications.relatedLinks.some(link => link.url === urls.oldAlternative && link.relation === 'supersession'))
})

test('retired series remain retired despite a stale qualification-index entry', async () => {
  const result = await discoverOpmSources(context('0892'), await fixture())
  assert.equal(result.seriesStatus, 'retired')
  assert.ok(result.issues.some(issue => issue.code === 'opm-series-retired'))
  assert.ok(result.issues.some(issue => issue.code === 'opm-retired-qualification-listing'))
  const retirementSource = result.candidates.find(candidate => candidate.url === urls.engineering)
  assert.ok(retirementSource)
  assert.ok(!retirementSource.coverage.series.includes('0892'))
  assert.equal(retirementSource.purpose, 'background')
  assert.ok(result.candidates.filter(candidate => candidate.purpose === 'qualification').every(candidate => candidate.authorityStatus === 'superseded'))
})

test('a listed series without a specific standard is not declared invalid; groups and unknown series remain unresolved', async () => {
  const listed = await discoverOpmSources(context('0921'), await fixture())
  assert.equal(listed.seriesStatus, 'listed')
  assert.ok(listed.issues.some(issue => issue.code === 'opm-grading-source-unresolved'))
  for (const [series, code] of [['0800', 'opm-group-not-series'], ['9999', 'opm-series-unresolved']]) {
    const result = await discoverOpmSources(context(series), await fixture())
    assert.equal(result.seriesStatus, 'unknown')
    assert.ok(result.issues.some(issue => issue.code === code))
    assert.ok(result.candidates.length === 0)
  }
})

test('catalog structural failures fail loudly instead of substituting readable overview text or model memory', async () => {
  for (const [url, expected] of [
    [OPM_CATALOGS.classification, 'opm-classification-catalog-changed'],
    [urls.allQualifications, 'opm-qualification-catalog-changed'],
    [OPM_CATALOGS.competency, 'opm-policy-catalog-changed'],
  ]) {
    const publicSources = await fixture()
    publicSources.responses.set(url, htmlResponse('<main><h1>OPM overview</h1><p>Reference navigation has changed. This is not a verified catalog.</p></main>'))
    await assert.rejects(discoverOpmSources(context('1515'), publicSources), error => error.code === expected)
  }
})

test('two-hop traversal retains unexamined relevant links as explicit blockers and never follows external links automatically', async () => {
  const publicSources = await fixture()
  const second = 'https://www.opm.gov/public-fixtures/second.pdf'
  const third = 'https://www.opm.gov/public-fixtures/third.pdf'
  const external = 'https://outside.example/untrusted.pdf'
  publicSources.responses.set(urls.math, pdfResponse((await pdfFixture(8, [
    { page: 1, url: second, label: 'Grading standard supplement' },
    { page: 2, url: external, label: 'Grading supplement outside OPM' },
  ])).bytes))
  publicSources.responses.set(second, pdfResponse((await pdfFixture(2, [{ page: 1, url: third, label: 'Qualification standard supplement' }])).bytes))
  const result = await discoverOpmSources(context('1515'), publicSources)
  assert.ok(result.candidates.some(candidate => candidate.url === second))
  assert.ok(allIssues(result).some(issue => issue.code === 'opm-traversal-limit'))
  assert.ok(!publicSources.requested.includes(third))
  assert.ok(!publicSources.requested.includes(external))
  assert.ok(result.candidates.find(candidate => candidate.url === urls.math).relatedLinks.some(link => link.url === external))
})

test('source-count exhaustion is explicit and excludes the seed from the 15-supporting-source budget', async () => {
  const publicSources = await fixture()
  const annotations = []
  const small = await pdfFixture(1)
  for (let index = 0; index < 20; index += 1) {
    const url = `https://www.opm.gov/public-fixtures/supplement-${index}.pdf`
    annotations.push({ page: index + 1, url, label: `Grading supplement ${index}` })
    publicSources.responses.set(url, pdfResponse(small.bytes))
  }
  publicSources.responses.set(urls.math, pdfResponse((await pdfFixture(20, annotations)).bytes))
  const result = await discoverOpmSources(context('1515'), publicSources)
  assert.equal(result.candidates.length, 15)
  assert.ok(result.issues.some(issue => issue.code === 'opm-source-budget-exhausted' && /seed is not counted/.test(issue.message)))
})

test('discovery cancellation prevents public requests and source authority never comes from a model', async () => {
  const publicSources = await fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(discoverOpmSources(context('1515'), { ...publicSources, signal: controller.signal }), error => error.code === 'cancelled')
  assert.equal(publicSources.requested.length, 0)
  await assert.rejects(discoverOpmSources(context('Program Manager'), publicSources), error => error.code === 'opm-invalid-series')
})

test('broken qualification-index exceptions remain scoped to their listed grades without substituting another section', async () => {
  const publicSources = await fixture()
  publicSources.responses.set(urls.qualificationPolicy, htmlResponse('<main><h1>Qualification Policies</h1><p>The old numeric anchors no longer exist. An unrelated current overview is not the missing grade-specific exception.</p></main>'))
  const result = await discoverOpmSources(context('1102'), publicSources)
  const broken = result.candidates.find(candidate => candidate.url === `${urls.qualificationPolicy}#1102`)
  assert.equal(result.seriesStatus, 'listed')
  assert.equal(broken.authorityStatus, 'unknown')
  const failures = broken.issues.filter(issue => issue.code === 'opm-linked-section-missing')
  assert.deepEqual(failures.map(issue => [issue.scope, issue.grade]), [['grade', 5], ['grade', 7]])
  assert.ok(!failures.some(issue => issue.grade === 9 || issue.scope === 'context'))
})

test('research context does not automatically imply research-grants administration', async () => {
  const publicSources = await fixture()
  const current = publicSources.responses.get(OPM_CATALOGS.classification)
  publicSources.responses.set(OPM_CATALOGS.classification, htmlResponse(Buffer.from(current.body).toString('utf8').replace(
    '<section class="tab-content" title="Functional Guides"><table>',
    '<section class="tab-content" title="Functional Guides"><table><tr><td><a href="https://www.opm.gov/public-fixtures/research-grants.pdf">Research Grants Grade-Evaluation Guide</a></td></tr>',
  )))
  const result = await discoverOpmSources(context('0801', { functions: ['research'] }), publicSources)
  assert.ok(result.candidates.some(candidate => candidate.url === urls.researchGuide))
  assert.ok(!result.candidates.some(candidate => /research-grants/.test(candidate.url)))
})

test('current-policy traversal prioritizes actual series issuance over generic assessment and conditional supervisory resources', async () => {
  const publicSources = await fixture()
  const issued = 'https://www.opm.gov/chcoc/latest-memos/issuance-of-classification-standard-2210.pdf'
  const general = 'https://www.opm.gov/chcoc/latest-memos/designing-an-assessment-strategy.pdf'
  publicSources.responses.set(urls.issuance, pdfResponse((await pdfFixture(3, [
    { page: 1, url: issued, label: 'Issuance of Classification Standard 2210' },
    { page: 2, url: general, label: 'Designing an Assessment Strategy' },
  ])).bytes))
  publicSources.responses.set(issued, pdfResponse((await pdfFixture(2)).bytes))
  const qualification = publicSources.responses.get(urls.policyQual)
  publicSources.responses.set(urls.policyQual, htmlResponse(Buffer.from(qualification.body).toString('utf8').replace(
    '</div>', '<p>For supervisory qualifications, see <a href="https://www.opm.gov/public-fixtures/supervisory-qualification-guide/">Supervisory Qualification Guide</a>.</p></div>',
  )))
  const result = await discoverOpmSources(context('2210'), publicSources)
  assert.ok(result.candidates.some(candidate => candidate.url === issued && candidate.purpose === 'issuance'))
  assert.ok(!publicSources.requested.includes(general))
  assert.ok(!publicSources.requested.some(url => url.includes('supervisory-qualification-guide')))
  assert.ok(result.candidates.find(candidate => candidate.url === urls.issuance).relatedLinks.some(link => link.url === general && link.relation === 'background'))
})

test('new contradictory current-series listings are surfaced instead of blindly applying a reviewed retirement rule', async () => {
  const publicSources = await fixture()
  const classification = publicSources.responses.get(OPM_CATALOGS.classification)
  publicSources.responses.set(OPM_CATALOGS.classification, htmlResponse(Buffer.from(classification.body).toString('utf8').replace(
    '<li>0803, Safety Engineering</li>', '<li>0803, Safety Engineering</li><li>0892, Ceramic Engineering</li>',
  )))
  const result = await discoverOpmSources(context('0892'), publicSources)
  assert.equal(result.seriesStatus, 'conflicting')
  assert.ok(result.issues.some(issue => issue.code === 'opm-series-status-conflict'))
})
