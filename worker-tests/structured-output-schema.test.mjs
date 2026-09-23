import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { loadWorker } from './shared-model-loader.mjs'
import { assertStrictSchema, UNSUPPORTED_STRICT_KEYWORDS } from './strict-schema-test-support.mjs'

const {
  assertStrictStructuredOutputSchema, strictStructuredOutputSchema, UNSUPPORTED_STRICT_SCHEMA_KEYWORDS,
} = await loadWorker('../worker/structured-output-schema.ts')
const { analysisStructuredSchema, evidenceGapSelectionSchemaForInput } = await loadWorker('../worker/analyses/model-schema.ts')
const { narrativeReviewSelectionSchema } = await loadWorker('../worker/analyses/narrative-model-schema.ts')
const { summaryCandidateContentSchema, summaryTargetContentSchema, summaryReviewOutputSchema } =
  await loadWorker('../src/domain/analysis-summary-history.ts')
const grades = await loadWorker('../worker/grades/model-schema.ts')
const { qcPlanProposalSchema } = await loadWorker('../src/domain/quality-improvement.ts')

const rejects = (schema, path) => assert.throws(() => assertStrictStructuredOutputSchema(schema),
  error => error.name === 'StructuredOutputSchemaError' && error.path === path && /strict mode/.test(error.message))
const object = (properties, extra = {}) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...extra,
})

test('the production checker and the independent test mirror reject the same strict-mode keywords', () => {
  assert.deepEqual([...UNSUPPORTED_STRICT_SCHEMA_KEYWORDS].sort(), [...UNSUPPORTED_STRICT_KEYWORDS].sort())
})

test('evidence-gap reviews are sent as anyOf, never the oneOf that Azure strict mode rejects', () => {
  const local = evidenceGapSelectionSchemaForInput(['criterion-a', 'criterion-b'], 3)
  const schema = analysisStructuredSchema(local)
  assert.doesNotMatch(JSON.stringify(schema), /"oneOf"/)
  assertStrictSchema(schema)
  const branches = schema.properties.decisions.items.anyOf
  assert.deepEqual(branches.map(branch => branch.properties.outcome.const), ['confirmed-missing', 'evidence-found', 'blocked'])
  assert.deepEqual(branches.map(branch => branch.properties.citations.maxItems), [0, 8, 8])
  assert.deepEqual(branches.map(branch => branch.properties.citations.minItems), [0, 1, undefined])
  assert.equal(schema.properties.decisions.minItems, 2)
  assert.equal(schema.properties.decisions.maxItems, 2)

  // Relaxing the wire keyword cannot admit a response the local discriminated contract rejects.
  const decision = (outcome, citations, blockerCode = null) => ({ criterionId: 'criterion-a', message: 'Reviewed.', outcome, citations, blockerCode })
  assert.equal(local.safeParse({ decisions: [decision('confirmed-missing', []), decision('evidence-found', [{ passageId: 2 }])] }).success, true)
  for (const invalid of [
    decision('confirmed-missing', [{ passageId: 1 }]),
    decision('evidence-found', []),
    decision('blocked', [], null),
    decision('confirmed-missing', [], 'unusable-source'),
  ]) {
    assert.equal(local.safeParse({ decisions: [invalid, decision('confirmed-missing', [])] }).success, false)
  }
})

test('the strict-mode checker rejects every schema shape Azure strict mode refuses, with its exact location', () => {
  for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
    rejects(object({ value: { type: 'string', [keyword]: keyword === 'minProperties' ? 1 : {} } }), `/properties/value/${keyword}`)
  }
  rejects(object({ value: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }), '/properties/value/additionalProperties')
  rejects(object({ value: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'], additionalProperties: false } }),
    '/properties/value/required')
  rejects(object({ value: {} }), '/properties/value')
  rejects(object({ value: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: {} }] } } }),
    '/properties/value/items/anyOf/1/additionalProperties')
  rejects({ anyOf: [object({ a: { type: 'string' } })] }, '')
  rejects({ ...object({ a: { type: 'string' } }), anyOf: [] }, '/anyOf')
  rejects({ type: 'array', items: { type: 'string' } }, '')
  rejects(object({ list: { type: 'array', items: [true] } }), '/properties/list/items/0')

  assert.throws(() => strictStructuredOutputSchema(z.strictObject({ values: z.record(z.string(), z.string()) })),
    error => error.name === 'StructuredOutputSchemaError')
  assert.throws(() => strictStructuredOutputSchema(z.strictObject({ value: z.string().optional() })),
    error => error.name === 'StructuredOutputSchemaError' && error.path === '/required')
  assert.throws(() => strictStructuredOutputSchema(z.object({ value: z.string() }).passthrough()),
    error => error.name === 'StructuredOutputSchemaError' && error.path === '/additionalProperties')
})

test('the strict-mode checker walks schema positions, so keyword-like property names are accepted', () => {
  const schema = object({
    not: { type: 'string' }, if: { type: ['string', 'null'] }, contains: { enum: ['a', 'b'] },
    nested: { $ref: '#/$defs/item' },
  }, { $defs: { item: object({ oneOf: { type: 'boolean' } }) } })
  assert.doesNotThrow(() => assertStrictStructuredOutputSchema(schema))
  assert.throws(() => assertStrictStructuredOutputSchema({ ...schema, $defs: { item: { type: 'object', oneOf: [] } } }),
    error => error.path === '/$defs/item/oneOf')
})

test('normalization converts nested discriminated unions without mutating the local contract', () => {
  const inner = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('a'), value: z.string() }),
    z.strictObject({ kind: z.literal('b'), value: z.number() }),
  ])
  const local = z.strictObject({ items: z.array(inner), single: inner.nullable() })
  const schema = strictStructuredOutputSchema(local)
  assert.doesNotMatch(JSON.stringify(schema), /"oneOf"|"\$schema"/)
  assertStrictSchema(schema)
  assert.equal(schema.properties.items.items.anyOf.length, 2)
  assert.equal(local.safeParse({ items: [{ kind: 'a', value: 1 }], single: null }).success, false)
  assert.equal(local.safeParse({ items: [{ kind: 'b', value: 1 }], single: { kind: 'a', value: 'x' } }).success, true)
})

test('every structured-output response schema built by Score passes strict-mode validation', () => {
  const scope = { sourceIds: ['source-1'], criterionIds: ['criterion-1'], grade: 12 }
  const schemas = {
    evidenceGaps: analysisStructuredSchema(evidenceGapSelectionSchemaForInput(['criterion-1'], 1)),
    narrativeReview: analysisStructuredSchema(narrativeReviewSelectionSchema(4)),
    summaryCandidate: analysisStructuredSchema(summaryCandidateContentSchema),
    summaryTarget: analysisStructuredSchema(summaryTargetContentSchema),
    summaryReview: analysisStructuredSchema(summaryReviewOutputSchema),
    gradePlan: grades.structuredSchema(grades.planSchema),
    gradeDraft: grades.structuredSchema(grades.draftSchemaForDocuments(['document-1'], scope)),
    gradeReview: grades.structuredSchema(grades.reviewSchemaForScope(scope)),
    qcPlan: z.toJSONSchema(qcPlanProposalSchema, { target: 'draft-7' }),
  }
  for (const [name, schema] of Object.entries(schemas)) {
    assert.doesNotThrow(() => assertStrictStructuredOutputSchema(schema), name)
    assertStrictSchema(schema)
  }
})
