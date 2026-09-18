import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { buildGradeTestRuntime, seedRealJob, startGradeFixture } from '../src/services/gradeLadders.test-support.mjs'

let runtime
let pipeline
before(async () => {
  runtime = await buildGradeTestRuntime()
  const outfile = join(runtime.directory, 'pipeline.mjs')
  await build({
    stdin: {
      contents: [
        "export * from './server/app';",
        "export * from './server/grades/validation';",
        "export * from './worker/grades/runtime';",
        "export * from './worker/grades/model';",
        "export {opmDiscoveryIssueId} from './worker/opm/issues';",
      ].join('\n'),
      resolveDir: process.cwd(), loader: 'ts',
    },
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  pipeline = await import(pathToFileURL(outfile))
  runtime.api = pipeline
})
after(async () => runtime?.close())

function scope(grades = [9, 11]) {
  return { series: ['0801'], grades, functions: ['nonsupervisory'], state: 'confirmed', explanation: 'Explicit synthetic grade coverage used only by this integration test.' }
}

function invoker({ unsupportedGrade } = {}) {
  return async request => {
    const body = JSON.parse(request.user)
    const input = body.input
    const citationFor = (purpose, grade) => {
      const source = body.sources.find(source => source.purpose === purpose)
      const paragraph = source.sections.flatMap(section => section.paragraphs).find(paragraph => paragraph.heading === `GS-${grade}`)
      return {
        documentId: source.documentId, documentVersion: source.documentVersion, paragraphId: paragraph.id,
        page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
      }
    }
    let value
    if (input.operation === 'plan-competencies') {
      value = {
        competencies: [{
          id: 'engineering-methods', label: 'Engineering methods', description: 'Apply engineering methods to source-defined projects.',
          seedCriterionIds: input.seed.rubric.criteria.map(criterion => criterion.id), citations: [],
        }],
        issues: [],
      }
    } else if (input.operation === 'draft-grade') {
      const basis = citationFor('grading', input.grade)
      const qualification = citationFor('qualification', input.grade)
      const gap = input.grade === unsupportedGrade
      value = {
        description: `A source-grounded review draft for engineering work at GS-${input.grade}.`,
        criteria: [{
          competencyId: 'engineering-methods', key: 'technical',
          description: gap ? 'Additional work-level evidence is needed before defining this grade expectation.' : basis.quote,
          weight: gap ? 0 : 100, support: gap ? 'gap' : 'derived',
          sourceCitations: gap ? [] : [basis], gradeBasis: gap ? [] : [basis],
          interpretation: gap ? 'The selected evidence does not establish this grade distinction; no custom assumption is substituted.' :
            'This proposed criterion applies the cited engineering work scope to the seed role, without assigning an official grade or eligibility outcome.',
          guidance: gap ? 'Unassessed expectation: supply applicable grade-specific evidence before adding score guidance.' :
            '0: No demonstrated application; 1: Observes a defined task; 2: Assists with documented methods; 3: Applies source-defined methods independently; 4: Explains difficult project tradeoffs; 5: Sustains well-supported outcomes across applicable projects',
        }],
        qualifications: [{
          id: 'source-prerequisite', text: qualification.quote, support: 'direct', citations: [qualification],
          interpretation: 'The stated alternatives remain separate unscored prerequisite paths; this is not an eligibility determination.',
        }],
        issues: [],
      }
    } else if (input.operation === 'independent-grounding-review') {
      value = { outcome: input.version.grade === unsupportedGrade ? 'needs-sources' : 'supported', issues: [] }
    } else throw new Error(`Unexpected model operation: ${input.operation}`)
    return { content: JSON.stringify(value), model: 'test-only-grounded-model' }
  }
}

function workerDeps(fixture, options = {}) {
  const { store, blobs } = fixture.grades
  store.listPending = async (now, limit) => [...store.values.values()].filter(value => value.record.recordType === 'grade-work' &&
    ['queued', 'running'].includes(value.record.status) &&
    (!value.record.nextAttemptAt || value.record.nextAttemptAt <= now) &&
    (!value.record.lease || value.record.lease.expiresAt <= now)).slice(0, limit).map(value => structuredClone(value))
  return {
    store, blobs, now: fixture.now,
    discover: async context => ({
      series: context.series, seriesTitle: 'General Engineering', seriesStatus: 'listed', catalogVersion: 'pipeline-test-v1',
      candidates: ['grading', 'qualification', ...(options.referenceDependency ? ['background'] : [])].map(purpose => ({
        url: `https://www.opm.gov/test-only/${purpose}${purpose === 'background' ? '#e3' : ''}`,
        ...(purpose === 'background' ? { intendedSection: 'e3' } : {}),
        title: `Synthetic ${purpose} reference`,
        publisher: 'OPM test fixture', purpose,
        coverage: { ...scope(), state: options.conditionalSources ? 'conditional' : 'confirmed' }, authorityStatus: 'current',
        discoveryPath: ['https://www.opm.gov/test-only/catalog'],
        relatedLinks: [...Array.from({ length: options.relatedLinkCount ?? 0 }, (_, index) => ({
          url: `https://www.opm.gov/test-only/reference-${index}`, label: `Reference ${index}`, relation: 'background',
        })), ...(options.referenceDependency && purpose === 'qualification' ? [{
          url: 'https://www.opm.gov/test-only/background#e3', label: 'Applicable progression policy', relation: 'qualification',
        }] : [])],
        issues: options.referenceDependency && purpose === 'qualification' ? [{
          id: pipeline.opmDiscoveryIssueId('opm-traversal-limit', 'https://www.opm.gov/test-only/background#e3'),
          code: 'opm-traversal-limit', severity: 'blocker', scope: 'source',
          message: 'The exact progression-policy section must be captured and selected.',
        }] : [],
      })),
      issues: [],
    }),
    fetchOriginal: async source => ({
      bytes: Buffer.from(`<html><body>${source.title}: synthetic reference for integration only.</body></html>`),
      contentType: 'text/html', finalUrl: source.requestedUrl, redirects: [],
    }),
    extractReference: async source => ({
      document: {
        id: source.documentId, version: source.documentVersion, kind: 'reference', sample: false, title: source.title,
        pageCount: 1, selectedPages: [1], completeness: 'complete',
        paragraphs: source.purpose === 'background' ? [{
          id: 'p-e3', page: 1, heading: 'Progression policy', sectionId: 'e3',
          text: 'This synthetic policy preserves source-defined grade progression conditions.',
        }] : [9, 11].map(grade => ({
          id: `p-${grade}`, page: 1, heading: `GS-${grade}`, sectionId: `${source.purpose}-${grade}`,
          text: source.purpose === 'grading'
            ? `GS-${grade}: Apply engineering methods to ${grade === 9 ? 'defined assigned projects' : 'independent interdependent projects with documented tradeoffs'}.`
            : `GS-${grade} prerequisite in this synthetic reference: specified education OR documented equivalent experience.`,
        })),
      },
      method: 'html', extractionVersion: 'pipeline-test-v1', links: [], warnings: [],
    }),
    planCompetencies: pipeline.planGradeCompetencies,
    draftGrade: pipeline.draftGradeRubric,
    reviewGrade: pipeline.reviewGradeRubric,
    invokeModel: invoker(options),
    documentIntelligence: { endpoint: 'https://unused.cognitiveservices.azure.com', getToken: async () => { throw new Error('No external service calls in this test') } },
    parseSeed: pipeline.parseGradeSeedSnapshot,
    parseDocument: value => {
      assert.deepEqual(pipeline.validateReferenceDocument(value), [])
      return value
    },
    parseDiscovery: value => value,
    recordHash: pipeline.gradeRecordHash,
    validateVersion: pipeline.validateGradeVersion,
  }
}

async function executeWorkflow(fixture, options) {
  const client = runtime.client
  const deps = workerDeps(fixture, options)
  const seed = await seedRealJob(fixture)
  let detail = await client.createGradeLadder(fixture.workspaceId, {
    name: 'Integrated engineering family', jobId: seed.job.id, rubricId: seed.rubric.id, rubricVersion: 1, grades: [9, 11],
    context: { series: '0801', agency: 'Test agency', agencyType: 'other-federal', supervision: 'nonsupervisory', functions: [], specialty: 'Source-defined engineering projects', confirmed: true, answers: {} },
  }, randomUUID())
  await pipeline.runGradeWorker(deps, { maxItems: 20 })
  await pipeline.runGradeWorker(deps, { maxItems: 20 })
  detail = await client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
  assert.ok(detail.sources.every(source => source.status === 'ready'), JSON.stringify(detail.workItems.map(item => item.error)))
  detail = await client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, {
    decisions: detail.sources.map(source => ({ sourceId: source.id, selected: true, applicability: 'applicable', reason: 'Reviewed this test source and its explicit series and grade coverage.' })),
  }, detail.etag, randomUUID())
  detail = await client.generateGradeLadder(fixture.workspaceId, detail.ladder.id, detail.etag, randomUUID())
  for (let stage = 0; stage < 3; stage++) await pipeline.runGradeWorker(deps, { maxItems: 20 })
  detail = await client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
  return { detail, deps, seed }
}

test('actual API, store validators, durable worker and model functions create reviewed grade versions end-to-end', { timeout: 90000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { detail, deps, seed } = await executeWorkflow(fixture)
    assert.ok(detail.levels.every(level => level.head.status === 'ready-for-review'), JSON.stringify(detail.workItems.map(item => item.error)))
    for (const level of detail.levels) {
      assert.equal(level.review.outcome, 'supported')
      assert.equal(level.version.rubric.criteria[0].weight, 100)
      assert.equal(level.version.qualifications[0].citations[0].quote, level.version.qualifications[0].text)
      assert.equal(level.review.versionHash, level.version.contentHash)
    }
    const level = detail.levels.find(level => level.head.grade === 9)
    let approved = await runtime.client.approveGrade(fixture.workspaceId, detail.ladder.id, 9, {
      versionId: level.version.id, reviewId: level.review.id,
    }, level.etag)
    const approvedHead = approved.levels.find(level => level.head.grade === 9)
    assert.equal(approvedHead.head.status, 'approved')
    const edited = structuredClone(level.version.rubric)
    edited.name = 'Reviewer-named engineering standard'
    approved = await runtime.client.saveGradeDraft(fixture.workspaceId, detail.ladder.id, 9, {
      rubric: edited, qualifications: level.version.qualifications,
    }, approvedHead.etag)
    await pipeline.runGradeWorker(deps, { maxItems: 20 })
    const reread = await runtime.client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
    const current = reread.levels.find(level => level.head.grade === 9)
    assert.equal(current.head.status, 'ready-for-review', JSON.stringify(reread.workItems.map(item => item.error)))
    assert.equal(current.version.rubric.name, edited.name)
    assert.equal(current.version.version, 2)
    assert.equal(current.head.approvedVersionId, level.version.id)
    assert.equal((await fixture.jobs.store.get(fixture.workspaceId, seed.job.id)).record.job.rubricId, seed.rubric.id)
    assert.equal(fixture.state.saves.length, 0)
  } finally { restore(); await fixture.close() }
})

test('one unsupported grade stays an editable unapproved draft while another grade can be approved', { timeout: 90000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { detail } = await executeWorkflow(fixture, { unsupportedGrade: 11 })
    const supported = detail.levels.find(level => level.head.grade === 9)
    const gap = detail.levels.find(level => level.head.grade === 11)
    assert.equal(supported.head.status, 'ready-for-review', JSON.stringify(detail.workItems.map(item => item.error)))
    assert.equal(gap.head.status, 'needs-sources', JSON.stringify(detail.workItems.map(item => item.error)))
    assert.equal(gap.version.rubric.criteria[0].weight, 0)
    assert.equal(gap.review.outcome, 'needs-sources')
    await assert.rejects(runtime.client.approveGrade(fixture.workspaceId, detail.ladder.id, 11, {
      versionId: gap.version.id, reviewId: gap.review.id,
    }, gap.etag), /support|review|gap|approv/i)
    const next = await runtime.client.approveGrade(fixture.workspaceId, detail.ladder.id, 9, {
      versionId: supported.version.id, reviewId: supported.review.id,
    }, supported.etag)
    assert.equal(next.levels.find(level => level.head.grade === 9).head.status, 'approved')
    assert.equal(next.levels.find(level => level.head.grade === 11).head.status, 'needs-sources')
  } finally { restore(); await fixture.close() }
})

test('explicitly reviewed conditional source coverage supports real discovery inputs without skipping semantic review', { timeout: 90000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { detail } = await executeWorkflow(fixture, { conditionalSources: true })
    assert.ok(detail.levels.every(level => level.head.status === 'ready-for-review'),
      JSON.stringify({ sources: detail.sourceSet.sources.map(source => ({ coverage: source.coverage, issues: source.issues })), tasks: detail.workItems.map(item => item.error) }))
    assert.ok(detail.levels.every(level => level.review?.outcome === 'supported'))
    assert.ok(detail.sourceSet.decisions.every(decision => decision.applicability === 'applicable' && decision.reason.length > 0))
    assert.ok(detail.levels.every(level => !level.approval))
  } finally { restore(); await fixture.close() }
})

test('real-sized qualification reference graphs are preserved past 100 links in source records', { timeout: 90000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { detail } = await executeWorkflow(fixture, { relatedLinkCount: 128 })
    const sources = detail.sources.filter(source => source.origin !== 'seed-job')
    assert.equal(sources.length, 2)
    assert.ok(sources.every(source => source.relatedLinks.length === 128))
    assert.ok(detail.levels.every(level => level.head.status === 'ready-for-review'))
  } finally { restore(); await fixture.close() }
})

test('frozen source sets resolve exact captured dependencies and restore the gap when a target is deselected', { timeout: 90000 }, async () => {
  const fixture = await startGradeFixture(runtime)
  const restore = fixture.installClientFetch()
  try {
    const { detail } = await executeWorkflow(fixture, { referenceDependency: true })
    assert.ok(detail.levels.every(level => level.head.status === 'ready-for-review'),
      JSON.stringify(detail.workItems.map(work => work.error)))
    const proposed = detail.sources.find(source => source.purpose === 'qualification')
    const target = detail.sources.find(source => source.purpose === 'background')
    assert.ok(proposed.issues.some(issue => issue.code === 'opm-traversal-limit'))
    const frozen = detail.sourceSet.sources.find(source => source.sourceId === proposed.id)
    assert.ok(!frozen.issues.some(issue => issue.code === 'opm-traversal-limit'))
    assert.equal(frozen.issueResolutions[0].reason, 'captured-reference-target')
    assert.equal(frozen.issueResolutions[0].evidence.sourceId, target.id)
    assert.equal(frozen.issueResolutions[0].evidence.sha256, target.sha256)
    const second = await runtime.client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, {
      decisions: detail.sources.map(source => ({
        sourceId: source.id, selected: source.id !== target.id,
        applicability: source.id === target.id ? 'excluded' : 'applicable',
        reason: 'Create a different explicit source selection for this regression.',
      })),
    }, detail.etag, randomUUID())
    assert.ok(second.sourceSet.sources.find(source => source.sourceId === proposed.id).issues.some(issue => issue.code === 'opm-traversal-limit'))
    const history = await runtime.client.getGradeSourceSet(fixture.workspaceId, detail.ladder.id, detail.sourceSet.id)
    assert.equal(history.sources.find(source => source.sourceId === proposed.id).issueResolutions[0].evidence.sourceId, target.id)
  } finally { restore(); await fixture.close() }
})
