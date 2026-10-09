import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildResumeAnalysisTestRuntime, jsonResponse, processingStubs, resumeParagraphs } from './resumeAnalysis.test-support.mjs'
import { completeReference, finishWork, referencePdf } from './gradeLadders.test-support.mjs'

export const jobRequirement = 'Apply engineering methods to defined projects and communicate findings.'
export const markdownJob = Buffer.from(`\ufeff# Engineering specialist\r\n\r\n## Requirements\r\n\r\n${jobRequirement}\r\n`)
export const markdownResume = Buffer.from(resumeParagraphs.map((paragraph, index) =>
  index === 0 ? `# ${paragraph.text}` : `## ${paragraph.heading}\n\n${paragraph.text}`).join('\n\n'))

export function buildMarkdownRuntime(options = {}) {
  return buildResumeAnalysisTestRuntime({
    ...options,
    serverExports: `
export * as jobWorker from './worker/runtime.ts'
export { validateRealRubric } from './server/jobs/validation.ts'
`,
  })
}

export async function importMarkdown(fixture, kind, bytes, name, { key = randomUUID(), batchId = randomUUID(), inputCount = 1 } = {}) {
  assert.ok(kind === 'jobs' || kind === 'resumes')
  const response = await fixture.request(`/api/workspaces/${fixture.workspaceId}/${kind}/markdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/markdown', 'X-File-Name': encodeURIComponent(name),
      'Idempotency-Key': key, 'X-Import-Batch': batchId,
      ...(kind === 'resumes' ? { 'X-Import-Count': String(inputCount) } : {}),
    },
    body: bytes,
  })
  const result = await jsonResponse(response, [200, 202])
  return { summary: kind === 'jobs' ? result.job : result.resume, key, batchId }
}

export function markdownProcessingStubs(fixture) {
  const levels = [
    'Lists engineering methods from coursework or training.',
    'Describes one defined project that applied engineering methods.',
    'Describes repeated or ongoing engineering project work.',
    'Describes choosing or adapting methods for complex projects.',
    'Describes leading engineering projects with stated outcomes.',
  ].map((examples, index) => ({ level: index + 1, examples }))
  const stubs = processingStubs(fixture, {
    onModelRequest(request) {
      if (request.response_format.json_schema.name === 'score_job_rubric_review') {
        return Response.json({
          model: 'gpt-5-mini-markdown-fixture',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            summary: 'The rubric matches its job source and evidence scale.', findings: [],
          }) } }],
        })
      }
      if (request.response_format.json_schema.name !== 'job_rubric') return undefined
      // The generator sends a passage catalog; the rubric cites the requirement by passage ID.
      const content = request.messages[1].content
      const catalog = JSON.parse(content.slice(content.lastIndexOf('SOURCE PASSAGE CATALOG JSON:\n') + 'SOURCE PASSAGE CATALOG JSON:\n'.length))
      const requirement = catalog.paragraphs.find(paragraph => paragraph.passages.map(([, text]) => text).join('').trim() === jobRequirement)
      assert.ok(requirement, 'The rubric must cite the actual extracted Markdown requirement.')
      return Response.json({
        model: 'gpt-5-mini-markdown-fixture',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          isJobPosting: true, rejectionReason: null, title: 'Engineering specialist',
          organization: null, location: null, arrangement: null, employmentType: null, grade: null, series: null,
          description: 'Evaluate the stated independent engineering work.', warnings: [],
          criteria: [{
            label: 'Engineering methods', description: jobRequirement, weight: 100, requirementType: 'required',
            sourcePassageIds: requirement.passages.map(([id]) => id), levels,
          }],
        }) } }],
      })
    },
  })
  return {
    ...stubs,
    jobs: {
      ...fixture.jobs,
      store: {
        ...fixture.jobs.store,
        async listPending(now, limit) {
          return [...fixture.jobs.records.values()].filter(({ record }) =>
            ['queued', 'parsing', 'generating'].includes(record.job.status) &&
            (!record.nextAttemptAt || record.nextAttemptAt <= now) && (!record.lease || record.lease.expiresAt <= now))
            .slice(0, limit).map(value => structuredClone(value))
        },
      },
      model: stubs.resumes.model, documentIntelligence: stubs.resumes.documentIntelligence,
      browser: stubs.resumes.browser, safeFetchOptions: stubs.resumes.safeFetchOptions,
      clock: fixture.clock, owner: `markdown-job-${randomUUID()}`, validateRealRubric: fixture.runtime.api.validateRealRubric,
    },
  }
}

export async function processMarkdownJobs(fixture, stubs) {
  for (let pass = 0; pass < 10; pass++) {
    if (![...fixture.jobs.records.values()].some(({ record }) => ['queued', 'parsing', 'generating'].includes(record.job.status))) {
      // A workspace owner approves each new rubric, as new analyses and ladders require by default.
      for (const { record } of [...fixture.jobs.records.values()]) {
        if (record.job.status === 'ready' && record.job.rubricId && !record.rubricApproval) fixture.jobs.store._approve(record.workspaceId, record.id)
      }
      return
    }
    await fixture.runtime.api.jobWorker.runWorker(stubs.jobs, { maxJobs: 10 })
    fixture.advanceClock(120_000)
  }
  assert.fail('Markdown jobs did not reach a terminal state.')
}

export async function markdownSeedLadder(fixture, job) {
  const client = fixture.runtime.client
  const restore = fixture.installClientFetch()
  try {
    let detail = await client.createGradeLadder(fixture.workspaceId, {
      name: 'Markdown engineering family', jobId: job.job.id, rubricId: job.rubric.id, rubricVersion: job.rubric.version,
      context: {
        series: '0801', agency: 'Integration test agency', agencyType: 'other-federal',
        supervision: 'nonsupervisory', functions: [], specialty: 'Defined engineering projects', confirmed: true, answers: {},
      },
      grades: [9],
    }, randomUUID())
    await finishWork(fixture, detail.ladder.id, ['discover'])
    detail = await client.uploadGradeSourcePdf(fixture.workspaceId, detail.ladder.id, await referencePdf(), randomUUID(), [178, 204])
    await completeReference(fixture, detail, detail.sources.find(source => source.origin === 'upload').id)
    detail = await client.getGradeLadder(fixture.workspaceId, detail.ladder.id)
    return await client.confirmGradeSources(fixture.workspaceId, detail.ladder.id, {
      decisions: detail.sources.map(source => ({
        sourceId: source.id, selected: true, applicability: 'applicable', reason: 'Reviewed fixture source coverage.',
      })),
    }, detail.etag, randomUUID())
  } finally { restore() }
}
