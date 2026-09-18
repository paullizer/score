import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzePdf,
  documentIntelligenceParagraphs,
  extractHtml,
  generateGroundedRubric,
  validateModelRubric,
  workerConstants,
} from '../dist-worker/runtime.mjs'

const jobId = 'job-11111111-1111-4111-8111-111111111111'
const document = {
  id: 'document-11111111-1111-4111-8111-111111111111',
  title: 'Platform Engineer',
  kind: 'job',
  version: 1,
  sample: false,
  paragraphs: [
    { id: 'p-0001', page: 1, heading: 'Requirements', text: 'Five years of TypeScript experience is required.' },
    { id: 'p-0002', page: 2, heading: 'Preferred', text: 'Azure operations experience is preferred.' },
  ],
}

const guidance = '0: no evidence; 1: minimal; 2: limited; 3: capable; 4: strong; 5: expert.'
const validResult = {
  isJobPosting: true,
  rejectionReason: null,
  title: 'Platform Engineer',
  organization: null,
  location: null,
  arrangement: null,
  employmentType: null,
  grade: null,
  series: null,
  description: 'Source-grounded evaluation rubric.',
  warnings: ['Location is not stated.'],
  criteria: [
    {
      label: 'TypeScript experience',
      description: 'Professional TypeScript experience.',
      weight: 60,
      guidance,
      requirementType: 'required',
      sourceParagraphId: 'p-0001',
      quote: 'Five years of TypeScript experience is required.',
    },
    {
      label: 'Azure operations',
      description: 'Experience operating services on Azure.',
      weight: 40,
      guidance,
      requirementType: 'preferred',
      sourceParagraphId: 'p-0002',
      quote: 'Azure operations experience is preferred.',
    },
  ],
}

function modelResponse(result, model = 'gpt-5-mini-2026-08-01') {
  return new Response(JSON.stringify({
    model,
    choices: [{ message: { content: JSON.stringify(result) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('Document Intelligence layout preserves page-aware paragraphs and table rows', () => {
  const paragraphs = documentIntelligenceParagraphs({
    status: 'succeeded',
    analyzeResult: {
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
      paragraphs: [
        { role: 'title', content: 'Platform Engineer', spans: [{ offset: 0 }], boundingRegions: [{ pageNumber: 1 }] },
        { role: 'sectionHeading', content: 'Requirements', spans: [{ offset: 20 }], boundingRegions: [{ pageNumber: 1 }] },
        { content: 'Build reliable APIs.', spans: [{ offset: 40 }], boundingRegions: [{ pageNumber: 1 }] },
      ],
      tables: [{
        spans: [{ offset: 60 }],
        boundingRegions: [{ pageNumber: 2 }],
        cells: [
          { rowIndex: 0, columnIndex: 0, content: 'Skill' },
          { rowIndex: 0, columnIndex: 1, content: 'Level' },
          { rowIndex: 1, columnIndex: 0, content: 'Azure' },
          { rowIndex: 1, columnIndex: 1, content: 'Required' },
        ],
      }],
    },
  })
  assert.deepEqual(paragraphs.map(value => [value.id, value.page, value.heading, value.text]), [
    ['p-0001', 1, 'Platform Engineer', 'Platform Engineer'],
    ['p-0002', 1, 'Requirements', 'Requirements'],
    ['p-0003', 1, 'Requirements', 'Build reliable APIs.'],
    ['p-0004', 2, 'Requirements - table', 'Skill | Level\nAzure | Required'],
  ])
})

test('HTML extraction prefers JobPosting data and does not execute source scripts', () => {
  globalThis.__sourceScriptRan = false
  const html = `<html><head><title>Shell</title>
    <script>globalThis.__sourceScriptRan = true</script>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Data Engineer',
      hiringOrganization: { name: 'Contoso' },
      description: '<h2>Role</h2><p>Build governed data products for public services.</p>',
      qualifications: 'Strong SQL and Python experience is required.',
      responsibilities: 'Own delivery, monitoring, documentation, and incident response for production pipelines.',
    })}</script></head><body><div id="root"></div></body></html>`
  const result = extractHtml(html, 'https://jobs.example/1')
  assert.equal(result.title, 'Data Engineer')
  assert.equal(result.paragraphs.some(value => value.text.includes('Strong SQL')), true)
  assert.equal(globalThis.__sourceScriptRan, false)
  delete globalThis.__sourceScriptRan
})

test('grounded rubric generation repairs protected criteria once and preserves exact citations', async () => {
  const invalid = structuredClone(validResult)
  invalid.criteria[0].label = 'Young engineer'
  invalid.criteria[0].description = 'Must be under age 30.'
  invalid.organization = 'Fabricated Incorporated'
  let calls = 0
  const generated = await generateGroundedRubric(document, {
    endpoint: 'https://model.example',
    deployment: 'rubric-deployment',
    modelName: 'gpt-5-mini',
    reasoningEffort: 'low',
    getToken: async scope => {
      assert.equal(scope, workerConstants.cognitiveScope)
      return 'token'
    },
    fetch: async (_url, init) => {
      calls += 1
      const body = JSON.parse(init.body)
      assert.equal(body.model, 'rubric-deployment')
      assert.equal(body.reasoning_effort, 'low')
      assert.equal(body.response_format.json_schema.strict, true)
      if (calls === 2) {
        assert.match(body.messages[1].content, /protected/)
        assert.match(body.messages[1].content, /organization is not grounded/)
      }
      return modelResponse(calls === 1 ? invalid : validResult)
    },
  }, () => [], jobId, '2026-09-17T12:00:00.000Z')
  assert.equal(calls, 2)
  assert.equal(generated.rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0), 100)
  assert.deepEqual(generated.rubric.criteria[0].sourceCitations[0], {
    documentId: document.id,
    documentVersion: 1,
    paragraphId: 'p-0001',
    page: 1,
    heading: 'Requirements',
    quote: 'Five years of TypeScript experience is required.',
  })
  assert.deepEqual(generated.rubric.provenance, {
    kind: 'generated',
    model: 'gpt-5-mini-2026-08-01',
    promptVersion: 'score-job-rubric-v2',
  })
  assert.deepEqual(generated.warnings, ['Location is not stated.'])
})

test('invalid weights or fabricated quotes remain errors after one repair attempt', async () => {
  const invalid = structuredClone(validResult)
  invalid.criteria[0].weight = 50
  invalid.criteria[0].quote = 'A qualification not found in the source.'
  const errors = validateModelRubric(invalid, document).join(' ')
  assert.match(errors, /not 100/)
  assert.match(errors, /not an exact substring/)
  let calls = 0
  await assert.rejects(generateGroundedRubric(document, {
    endpoint: 'https://model.example',
    deployment: 'rubric',
    modelName: 'gpt-5-mini',
    getToken: async () => 'token',
    fetch: async () => {
      calls += 1
      return modelResponse(invalid)
    },
  }, () => [], jobId, '2026-09-17T12:00:00.000Z'), error => error.code === 'invalid-rubric')
  assert.equal(calls, 2)
})

test('PDF analysis enforces byte bounds and cancellation before network access', async () => {
  const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
  await assert.rejects(analyzePdf(oversized, {
    endpoint: 'https://di.example',
    getToken: async () => 'token',
  }), error => error.code === 'pdf-too-large')

  const controller = new AbortController()
  controller.abort()
  let fetched = false
  await assert.rejects(analyzePdf(Buffer.from('%PDF-1.7'), {
    endpoint: 'https://di.example',
    getToken: async () => 'token',
    signal: controller.signal,
    fetch: async () => {
      fetched = true
      return new Response()
    },
  }), error => error.code === 'cancelled')
  assert.equal(fetched, false)
})
