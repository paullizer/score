import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { buildGradeTestRuntime, seedRealJob, startGradeFixture } from '../src/services/gradeLadders.test-support.mjs'
import { fixture as opmFixture, context as opmContext, urls, OPM_CATALOGS } from '../worker-tests/opm-fixtures.mjs'
import { fakeDi } from '../worker-tests/reference-fixtures.mjs'

let runtime
let pipeline
before(async () => {
  runtime = await buildGradeTestRuntime()
  const outfile = join(runtime.directory, 'conditional-pipeline.mjs')
  await build({
    stdin: {
      contents: [
        "export * from './server/app';",
        "export * from './server/grades/validation';",
        "export {runGradeWorker} from './worker/grades/runtime';",
        "export {planGradeCompetencies,draftGradeRubric,reviewGradeRubric} from './worker/grades/model';",
        "export {discoverOpmSources,parseOpmDiscoveryResult} from './worker/opm/index';",
        "export {fetchReferenceOriginal,extractReferenceDocument} from './worker/references/index';",
      ].join('\n'),
      resolveDir: process.cwd(), loader: 'ts',
    },
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  pipeline = await import(pathToFileURL(outfile))
  runtime.api = pipeline
})
after(async () => runtime?.close())

const guidance = '0: No demonstrated analytical work; 1: Observes a defined analytical task; 2: Assists with documented methods; 3: Applies established methods within the cited scope; 4: Explains defensible analytical choices; 5: Sustains evidence-based outcomes across applicable assignments'
const clone = value => structuredClone(value)

function modelInvoker(calls) {
  return async request => {
    const body = JSON.parse(request.user)
    const input = body.input
    if (body.repair) calls.push({ errors: body.repair.errors })
    assert.ok(!body.repair, JSON.stringify(body.repair?.errors))
    calls.push(input.operation)
    let value
    if (input.operation === 'plan-competencies') {
      value = {
        competencies: [{
          id: 'analysis-methods', label: 'Analytical methods',
          description: 'Apply source-defined analytical methods to assigned projects.',
          seedCriterionIds: input.seed.rubric.criteria.map(criterion => criterion.id), citations: [],
        }],
        issues: [],
      }
    } else if (input.operation === 'draft-grade') {
      const source = body.sources.find(source => source.purpose === 'grading')
      const paragraph = source.sections.flatMap(section => section.paragraphs)
        .find(paragraph => paragraph.heading === `GS-${input.grade}` && paragraph.text.includes('analytical methods'))
      assert.ok(paragraph, 'The actual PDF extractor must preserve the grade heading and OCR passage.')
      const citation = {
        documentId: source.documentId, documentVersion: source.documentVersion,
        paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
      }
      const qualificationSource = body.sources.find(source => source.purpose === 'qualification')
      const qualificationParagraphs = qualificationSource.sections.flatMap(section => section.paragraphs)
      const qualificationParagraph = qualificationParagraphs
        .find(paragraph => new RegExp(`\\bGS[-\\s]*${input.grade}\\b`).test(paragraph.text))
      assert.ok(qualificationParagraph, 'The actual HTML extractor must retain the selected qualification-group grade row.')
      const qualificationCitations = qualificationParagraphs.filter(paragraph =>
        paragraph === qualificationParagraph || paragraph.table?.row === 1 || /\bcombination\b/i.test(paragraph.text))
        .map(paragraph => ({
          documentId: qualificationSource.documentId, documentVersion: qualificationSource.documentVersion,
          paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
        }))
      const gap = input.grade === 11
      value = {
        description: `Source-grounded analytical work interpretation for GS-${input.grade}.`,
        criteria: [{
          competencyId: 'analysis-methods', key: 'analysis',
          description: gap ? 'Additional applicable work-level evidence is required before establishing this grade expectation.' : citation.quote,
          weight: gap ? 0 : 100, guidance: gap ? 'Unscored while applicable grade evidence remains unresolved.' : guidance,
          support: gap ? 'gap' : 'direct', sourceCitations: gap ? [] : [citation], gradeBasis: gap ? [] : [citation],
          interpretation: gap ? 'Reviewer-confirmed source applicability does not establish support for this grade; no custom rule is substituted.'
            : 'This reviewer-facing interpretation applies the cited analytical work scope without claiming official classification or eligibility.',
        }],
        qualifications: [{
          id: 'qualification-alternatives', text: qualificationCitations.map(citation => citation.quote).join('\n'),
          citations: qualificationCitations, support: 'direct',
          interpretation: 'This is a separate unscored source requirement. Preserve the education OR experience alternatives and any stated combination provision; scoring cannot replace eligibility.',
        }],
        issues: [],
      }
    } else if (input.operation === 'independent-grounding-review') {
      value = { outcome: input.version.grade === 11 ? 'needs-sources' : 'supported', issues: [] }
    } else throw new Error(`Unexpected model operation ${input.operation}`)
    return { content: JSON.stringify(value), model: 'conditional-pipeline-test-model' }
  }
}

async function discoverAndExtract(fixture) {
  const publicSources = await opmFixture()
  const calls = []
  const di = fakeDi({
    result(pages) {
      return {
        status: 'succeeded',
        analyzeResult: {
          pages: pages.map((_, index) => ({ pageNumber: index + 1 })),
          paragraphs: pages.flatMap((page, index) => [
            {
              content: [9, 11].includes(page) ? `GS-${page}` : 'Scope and supporting context',
              role: 'sectionHeading', spans: [{ offset: index * 300, length: 40 }],
              boundingRegions: [{ pageNumber: index + 1 }],
            },
            {
              content: page === 9
                ? 'Apply established analytical methods to assigned program projects and explain evidence-based findings.'
                : page === 11
                  ? 'Select analytical methods independently for varied program assignments and document justified conclusions.'
                  : 'This synthetic OCR service response supplies reference context for the pipeline test; it is not a production OPM quotation.',
              spans: [{ offset: index * 300 + 50, length: 200 }],
              boundingRegions: [{ pageNumber: index + 1 }],
            },
          ]),
        },
      }
    },
  })
  const { store, blobs } = fixture.grades
  store.listPending = async (now, limit) => [...store.values.values()].filter(({ record }) => record.recordType === 'grade-work' &&
    ['queued', 'running'].includes(record.status) && (!record.nextAttemptAt || record.nextAttemptAt <= now) &&
    (!record.lease || record.lease.expiresAt <= now)).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .slice(0, limit).map(clone)
  let discovery
  const deps = {
    store, blobs, now: fixture.now,
    sourceOptions: { fetcher: publicSources.fetcher },
    discover: async (context, options) => {
      discovery = await pipeline.discoverOpmSources(context, options)
      assert.equal(discovery.candidates.find(candidate => candidate.url === urls.adminGuide).coverage.state, 'conditional')
      return discovery
    },
    fetchOriginal: pipeline.fetchReferenceOriginal,
    extractReference: pipeline.extractReferenceDocument,
    documentIntelligence: di.options,
    planCompetencies: pipeline.planGradeCompetencies, draftGrade: pipeline.draftGradeRubric, reviewGrade: pipeline.reviewGradeRubric,
    invokeModel: modelInvoker(calls), parseSeed: pipeline.parseGradeSeedSnapshot,
    parseDiscovery: pipeline.parseOpmDiscoveryResult,
    parseDocument: value => {
      assert.deepEqual(pipeline.validateReferenceDocument(value), [])
      return value
    },
    recordHash: pipeline.gradeRecordHash, validateVersion: pipeline.validateGradeVersion,
  }
  const seed = await seedRealJob(fixture)
  const stored = await fixture.jobs.store.get(fixture.workspaceId, seed.job.id)
  await fixture.jobs.store.replace({
    ...stored.record, job: { ...stored.record.job, series: '0343', title: 'Management and program analyst' },
  }, stored.etag)
  let detail = await runtime.client.createGradeLadder(fixture.workspaceId, {
    name: 'Reviewed 0343 source family', jobId: seed.job.id, rubricId: seed.rubric.id, rubricVersion: 1,
    grades: [9, 11], context: opmContext('0343'),
  }, randomUUID())
  const discovered = await pipeline.runGradeWorker(deps, { maxItems: 20 })
  assert.equal(discovered.failed, 0, JSON.stringify([...store.values.values()].map(value => value.record.error)))
  const extracted = await pipeline.runGradeWorker(deps, { maxItems: 20 })
  assert.equal(extracted.failed, 0, JSON.stringify([...store.values.values()].map(value => value.record.error)))
  detail = await runtime.client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
  assert.ok(detail.sources.every(source => source.status === 'ready'))
  const guide = detail.sources.find(source => source.requestedUrl === urls.adminGuide)
  assert.equal(guide.coverage.state, 'conditional', 'Neither discovery nor extraction stamps this source confirmed.')
  assert.ok(di.submissions.length > 0, 'PDFs must pass through the reference OCR/extraction code.')
  assert.ok(publicSources.requested.includes(OPM_CATALOGS.classification))
  return { detail, guide, deps, calls, discovery }
}

test('0343 actual discovery, extraction, confirmation, worker and model pipeline consumes conditional AAGEG metadata', { timeout: 120000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const result = await discoverAndExtract(fixture)
    let { detail } = result
    const original = clone(result.guide)
    const decisions = detail.sources.map(source => ({
      sourceId: source.id,
      selected: source.origin === 'seed-job' || source.id === result.guide.id || source.intendedSection === 'GS-ADMIN',
      applicability: source.origin === 'seed-job' || source.id === result.guide.id || source.intendedSection === 'GS-ADMIN' ? 'applicable' : 'excluded',
      reason: source.authorityStatus === 'conflicting'
        ? 'Revision conflict remains unresolved; this source is not used as grading authority.'
        : 'Reviewed the captured source and its applicability to the confirmed nonsupervisory 0343 position context.',
    }))
    const rejected = await fixture.request(`/api/workspaces/${fixture.workspaceId}/grade-ladders/${detail.ladder.id}/source-set`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'if-match': detail.etag, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ decisions: decisions.map(decision => decision.sourceId === original.id ? { ...decision, reason: '' } : decision) }),
    })
    assert.equal(rejected.status, 400, 'Applicability requires an explicit recorded reason.')
    detail = await runtime.client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, { decisions }, detail.etag, randomUUID())
    const frozen = detail.sourceSet.sources.find(source => source.sourceId === original.id)
    assert.equal(frozen.coverage.state, 'confirmed')
    assert.deepEqual(frozen.coverage.grades, [9, 11])
    assert.match(frozen.coverage.explanation, /Reviewer-confirmed/)
    assert.equal(frozen.authorityStatus, 'current')
    assert.deepEqual(frozen.issues, original.issues.filter(issue => issue.code !== 'opm-pdf-content-review'))
    assert.deepEqual(frozen.issueResolutions.map(resolution => resolution.issue), original.issues.filter(issue => issue.code === 'opm-pdf-content-review'))
    assert.ok(frozen.issueResolutions.every(resolution => resolution.reason === 'complete-source-extraction' && resolution.evidence.sha256 === original.sha256))
    assert.equal((await fixture.grades.store.get(fixture.workspaceId, original.id)).record.coverage.state, 'conditional')
    assert.ok(detail.sourceSet.issues.some(issue => issue.code === 'reviewer-confirmed-scope' && issue.message.includes(original.coverage.explanation)))
    assert.ok(detail.sources.filter(source => source.authorityStatus === 'conflicting')
      .every(source => source.issues.some(issue => issue.code === 'opm-0343-version-conflict')))
    detail = await runtime.client.generateGradeLadder(fixture.workspaceId, detail.ladder.id, detail.etag, randomUUID())
    for (let stage = 0; stage < 3; stage++) {
      const work = await pipeline.runGradeWorker(result.deps, { maxItems: 20 })
      assert.equal(work.failed, 0, JSON.stringify({
        errors: [...fixture.grades.store.values.values()].map(value => value.record.error),
        diagnostics: result.calls.filter(value => typeof value !== 'string'),
      }))
    }
    detail = await runtime.client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
    const supported = detail.levels.find(level => level.head.grade === 9)
    const gap = detail.levels.find(level => level.head.grade === 11)
    assert.equal(supported.head.status, 'ready-for-review', JSON.stringify({
      head: supported.head.issues, version: supported.version?.issues, review: supported.review?.issues,
      sources: detail.sourceSet.sources.map(source => ({ title: source.title, coverage: source.coverage, issues: source.issues })),
    }))
    assert.equal(supported.review.outcome, 'supported')
    assert.equal(supported.review.versionHash, supported.version.contentHash)
    assert.equal(gap.head.status, 'needs-sources')
    assert.equal(gap.version.rubric.criteria[0].support, 'gap')
    assert.equal(gap.version.rubric.criteria[0].weight, 0)
    assert.equal(result.calls.filter(operation => operation === 'independent-grounding-review').length, 2)
    const approved = await runtime.client.approveGrade(fixture.workspaceId, detail.ladder.id, 9, {
      versionId: supported.version.id, reviewId: supported.review.id,
    }, supported.etag)
    assert.equal(approved.levels.find(level => level.head.grade === 9).head.status, 'approved')
    await assert.rejects(runtime.client.approveGrade(fixture.workspaceId, detail.ladder.id, 11, {
      versionId: gap.version.id, reviewId: gap.review.id,
    }, gap.etag), /support|review|gap|approv/i)
  } finally { restore(); await fixture.close() }
})

test('reviewed conditional sources preserve unknown/conflicting authority, explicit limits, exemptions and missing-section issues', { timeout: 120000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { guide, detail: initial } = await discoverAndExtract(fixture)
    let detail = initial
    const blockers = [
      { id: 'agency-exemption', code: 'agency-excluded', severity: 'blocker', scope: 'qualification', sourceId: guide.id, message: 'The reference exempts these agency positions.' },
      { id: 'missing-section', code: 'reference-section-missing', severity: 'blocker', scope: 'source', sourceId: guide.id, message: 'A required applicability section is missing.' },
      { id: 'gs11-gap', code: 'grade-support-gap', severity: 'blocker', scope: 'grade', grade: 11, sourceId: guide.id, message: 'GS-11 grading evidence remains unresolved.' },
    ]
    for (const override of [
      { authorityStatus: 'unknown' },
      { authorityStatus: 'conflicting' },
      { coverage: { ...guide.coverage, state: 'conflicting' } },
      { coverage: { ...guide.coverage, series: ['1102'] } },
      { coverage: { ...guide.coverage, functions: ['supervisor'] } },
      { coverage: { ...guide.coverage, grades: [11] }, issues: [...guide.issues, ...blockers] },
    ]) {
      const current = await fixture.grades.store.get(fixture.workspaceId, guide.id)
      const source = { ...guide, ...override, updatedAt: fixture.now().toISOString() }
      await fixture.grades.store.replace(source, current.etag)
      detail = await runtime.client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, {
        decisions: [{ sourceId: guide.id, selected: true, applicability: 'applicable', reason: 'Reviewed; this decision must not remove documented restrictions.' }],
      }, detail.etag, randomUUID())
      const frozen = detail.sourceSet.sources.find(value => value.sourceId === guide.id)
      assert.equal(frozen.authorityStatus, source.authorityStatus)
      assert.deepEqual(frozen.issues, source.issues.filter(issue => issue.code !== 'opm-pdf-content-review'))
      assert.deepEqual(frozen.issueResolutions.map(resolution => resolution.issue), source.issues.filter(issue => issue.code === 'opm-pdf-content-review'))
      if (override.issues) {
        assert.equal(frozen.coverage.state, 'confirmed')
        assert.deepEqual(frozen.coverage.grades, [11], 'Reviewer confirmation must not broaden explicit grade limits.')
        assert.equal(frozen.issues.find(issue => issue.id === 'gs11-gap').grade, 11)
        assert.ok(frozen.issues.some(issue => issue.id === 'agency-exemption' && issue.severity === 'blocker'))
        assert.ok(frozen.issues.some(issue => issue.id === 'missing-section' && issue.severity === 'blocker'))
      } else {
        assert.deepEqual(frozen.coverage, source.coverage)
        assert.ok(detail.sourceSet.issues.some(issue => issue.code === 'unresolved-applicability'))
      }
    }
    const current = await fixture.grades.store.get(fixture.workspaceId, guide.id)
    const previousDocument = await fixture.grades.blobs.read(current.record.documentBlobName)
    const partial = { ...JSON.parse(Buffer.from(previousDocument.bytes).toString()), version: 2, completeness: 'incomplete' }
    const documentBlobName = `${fixture.workspaceId}/${detail.ladder.id}/${guide.id}/document-v2.json`
    await fixture.grades.blobs.putImmutable(documentBlobName, Buffer.from(JSON.stringify(partial)), 'application/json')
    await fixture.grades.store.replace({
      ...guide, documentVersion: 2, documentBlobName, completeness: 'incomplete',
      issues: [...guide.issues, blockers[1]], updatedAt: fixture.now().toISOString(),
    }, current.etag)
    detail = await runtime.client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, {
      decisions: [{ sourceId: guide.id, selected: true, applicability: 'applicable', reason: 'Applicability reviewed; missing extraction content is still unresolved.' }],
    }, detail.etag, randomUUID())
    const incomplete = detail.sourceSet.sources.find(source => source.sourceId === guide.id)
    assert.equal(incomplete.coverage.state, 'confirmed')
    assert.equal(incomplete.completeness, 'incomplete')
    assert.equal(incomplete.documentVersion, 2)
    assert.ok(incomplete.issues.some(issue => issue.id === 'missing-section' && issue.severity === 'blocker'))
  } finally { restore(); await fixture.close() }
})
