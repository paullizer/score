import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  JOB_RUBRIC_ASSIST_SYSTEM_PROMPT,
  JOB_RUBRIC_COMPILED_PROMPT,
  jobRubricAssistProfile,
  rubricAssistResponseSchema,
} from '../dist-server/app.mjs'

const document = {
  id: 'document-11111111-1111-4111-8111-111111111111',
  title: 'Platform Engineer',
  kind: 'job',
  version: 7,
  sample: false,
  paragraphs: [
    { id: 'p-0001', page: 1, heading: 'Requirements', text: 'Five years of TypeScript experience is required.' },
    { id: 'p-0002', page: 2, heading: 'Preferred', text: 'Azure operations experience is preferred.' },
    { id: 'p-0003', page: 3, heading: 'Duties', text: 'Build reliable APIs and improve deployment automation.' },
  ],
}

const guidance = '0: No supporting evidence in the submitted resume for this criterion; 1: Documents a bounded example; 2: Documents practice with regular review; 3: Documents independent work within the stated scope; 4: Documents complex work with clear outcomes; 5: Documents repeated complex work with validated outcomes.'

function baseDraft(extra = {}) {
  return {
    name: 'Platform Engineer rubric',
    description: 'Evaluate platform engineering requirements.',
    criteria: [
      {
        id: 'criterion-01',
        label: 'TypeScript experience',
        description: 'Professional TypeScript experience.',
        guidance,
        weight: 100,
        requirementType: 'required',
        citation: { paragraphId: 'p-0001', quote: 'Five years of TypeScript experience is required.' },
      },
    ],
    ...extra,
  }
}

function context(overrides = {}) {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  let index = 0
  const draft = overrides.draft ?? baseDraft()
  return {
    document,
    jobTitle: 'Platform Engineer',
    draft,
    focusCriterionId: draft.criteria[0]?.id ?? null,
    maxCriteria: 2,
    savedCriterionIds: new Set(draft.criteria.map(criterion => criterion.id)),
    newId: () => ids[index++] ?? `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    ...overrides,
  }
}

function validAddOutput(overrides = {}) {
  return {
    outcome: 'changed',
    reply: 'Added Azure operations because the posting states it is preferred.',
    rubric: { name: null, description: null },
    criteria: [
      {
        action: 'update',
        ref: 'C1',
        afterRef: null,
        label: null,
        description: null,
        guidance: null,
        weight: 60,
        requirementType: null,
        paragraphId: null,
        quote: null,
      },
      {
        action: 'add',
        ref: null,
        afterRef: 'C1',
        label: 'Azure operations',
        description: 'Experience operating services on Azure.',
        guidance,
        weight: 40,
        requirementType: 'preferred',
        paragraphId: 'p-0002',
        quote: 'Azure operations experience is preferred.',
      },
    ],
    warnings: [],
    ...overrides,
  }
}

function validate(output, ctx = context()) {
  return jobRubricAssistProfile.validate(output, ctx)
}

function assertValidationError(output, pattern, ctx = context()) {
  const result = validate(output, ctx)
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), pattern)
}

function assertStrictSchema(node, path = 'schema') {
  if (!node || typeof node !== 'object') return
  if (node.type === 'object' || node.properties) {
    assert.equal(node.additionalProperties, false, `${path} must reject additional properties`)
    assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties ?? {})), `${path} must require every key`)
    for (const [key, value] of Object.entries(node.properties ?? {})) assertStrictSchema(value, `${path}.${key}`)
  }
  if (node.type === 'array') assertStrictSchema(node.items, `${path}[]`)
}

test('buildPrompt keeps source first and includes draft refs, focus, conversation, correction, and instruction', () => {
  const ctx = context()
  const prompt = jobRubricAssistProfile.buildPrompt({
    context: ctx,
    instruction: 'Add Azure if supported.',
    conversation: [{ role: 'user', text: 'Earlier request' }, { role: 'assistant', text: 'Earlier response' }],
    correction: ['C2 quote is invalid.'],
  })
  assert.equal(prompt.source, '<document title=""Platform Engineer"">\n<paragraph id="p-0001" page="1" heading=""Requirements"">Five years of TypeScript experience is required.</paragraph>\n<paragraph id="p-0002" page="2" heading=""Preferred"">Azure operations experience is preferred.</paragraph>\n<paragraph id="p-0003" page="3" heading=""Duties"">Build reliable APIs and improve deployment automation.</paragraph>\n</document>')
  assert.equal(prompt.user.startsWith(prompt.source), true)
  assert.ok(prompt.user.indexOf('CURRENT DRAFT') > prompt.source.length)
  assert.match(prompt.user, /"ref": "C1"/)
  assert.match(prompt.user, /"quoteMatchesSource": true/)
  assert.match(prompt.user, /FOCUSED REF: C1/)
  assert.match(prompt.user, /USER: Earlier request/)
  assert.match(prompt.user, /ASSISTANT: Earlier response/)
  assert.match(prompt.user, /The previous result was invalid\. Correct all of these errors:/)
  assert.match(prompt.user, /C2 quote is invalid\./)
  assert.match(prompt.user, /REVIEWER INSTRUCTION:\nAdd Azure if supported\./)
  assert.match(prompt.system, /Stay within 2 criteria/)
})

test('JSON schema is strict-mode compatible at every object', () => {
  const schema = jobRubricAssistProfile.jsonSchema(context())
  assertStrictSchema(schema)
  assert.equal(schema.properties.criteria.maxItems, 40)
  assert.deepEqual(schema.properties.criteria.items.properties.requirementType.enum, ['required', 'preferred', null])
})

test('assist prompt retains rule parity with the pinned generation prompt', () => {
  assert.equal(createHash('sha256').update(JOB_RUBRIC_COMPILED_PROMPT.system).digest('hex'), '193a455fb93fbd42225c4da1df26d54f92bd9b66b41a7f8f1e4c3227e83857b0')
  for (const phrase of [
    'No supporting evidence in the submitted resume for this criterion',
    'protected characteristics',
    'verbatim quote',
    'preferred',
    'location, hybrid arrangements, salary',
    'never invent',
  ]) {
    assert.match(JOB_RUBRIC_ASSIST_SYSTEM_PROMPT.toLowerCase(), new RegExp(phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(JOB_RUBRIC_COMPILED_PROMPT.system.toLowerCase(), new RegExp(phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('valid changed output builds citations, deterministic IDs, warnings, and response-compatible operations', () => {
  const result = validate(validAddOutput())
  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'changed')
  assert.deepEqual(result.value.operations.map(operation => operation.type), ['updateCriterion', 'addCriterion'])
  assert.equal(result.value.operations[1].criterion.id, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(result.value.operations[1].criterion.sourceCitations[0], {
    documentId: document.id,
    documentVersion: 7,
    paragraphId: 'p-0002',
    page: 2,
    heading: 'Preferred',
    quote: 'Azure operations experience is preferred.',
  })
  assert.deepEqual(result.value.warnings, [])
  rubricAssistResponseSchema.parse({ ...result.value, assistant: { promptVersion: 'score-rubric-assist-v1', model: 'test-model' } })
})

test('explained and clarify outcomes cannot carry changes', () => {
  const explained = validate({
    outcome: 'explained',
    reply: 'The posting supports TypeScript only.',
    rubric: { name: null, description: null },
    criteria: [],
    warnings: [],
  })
  assert.equal(explained.ok, true)
  assert.deepEqual(explained.value.operations, [])

  assertValidationError({ ...validAddOutput(), outcome: 'clarify' }, /Only changed outcomes/)
})

test('no-op fields are dropped and changed requires an effective operation', () => {
  assertValidationError({
    outcome: 'changed',
    reply: 'No material change.',
    rubric: { name: 'Platform Engineer rubric', description: null },
    criteria: [{
      action: 'update',
      ref: 'C1',
      afterRef: null,
      label: 'TypeScript experience',
      description: null,
      guidance: null,
      weight: 100,
      requirementType: 'required',
      paragraphId: 'p-0001',
      quote: 'Five years of TypeScript experience is required.',
    }],
    warnings: [],
  }, /at least one effective operation/)
})

test('validation rejects malformed refs, duplicate targets, bad citations, protected criteria, missing anchors, and invalid removals', () => {
  assertValidationError(validAddOutput({ criteria: [{ ...validAddOutput().criteria[0], ref: 'criterion-01' }] }), /Unknown criterion ref criterion-01/)
  assertValidationError(validAddOutput({ criteria: [validAddOutput().criteria[0], { ...validAddOutput().criteria[0], weight: 50 }] }), /targeted more than once/)
  assertValidationError(validAddOutput({ criteria: [{ ...validAddOutput().criteria[1], quote: 'Fabricated quote.' }] }), /not an exact substring/)
  assertValidationError(validAddOutput({ criteria: [{ ...validAddOutput().criteria[1], label: 'Young engineer', description: 'Must be under age 30.' }] }), /protected/)
  assertValidationError(validAddOutput({ criteria: [{ ...validAddOutput().criteria[1], guidance: '0: none; 1: some evidence.' }] }), /anchor scores 2, 3, 4, 5/)
  assertValidationError({
    outcome: 'changed',
    reply: 'Removed the only criterion.',
    rubric: { name: null, description: null },
    criteria: [{
      action: 'remove',
      ref: 'C1',
      afterRef: null,
      label: null,
      description: null,
      guidance: null,
      weight: null,
      requirementType: null,
      paragraphId: null,
      quote: null,
    }],
    warnings: [],
  }, /At least one criterion must remain/)
})

test('max-criteria policy applies only when resulting draft contains unsaved criterion IDs', () => {
  const oversizedDraft = baseDraft({
    criteria: [
      ...baseDraft().criteria,
      {
        id: 'criterion-02',
        label: 'Azure operations',
        description: 'Experience operating services on Azure.',
        guidance,
        weight: 25,
        requirementType: 'preferred',
        citation: { paragraphId: 'p-0002', quote: 'Azure operations experience is preferred.' },
      },
      {
        id: 'criterion-03',
        label: 'API reliability',
        description: 'Builds reliable APIs.',
        guidance,
        weight: 25,
        requirementType: 'required',
        citation: { paragraphId: 'p-0003', quote: 'Build reliable APIs and improve deployment automation.' },
      },
    ],
  })
  const output = {
    outcome: 'changed',
    reply: 'Renamed the first criterion.',
    rubric: { name: null, description: null },
    criteria: [{
      action: 'update',
      ref: 'C1',
      afterRef: null,
      label: 'TypeScript delivery',
      description: null,
      guidance: null,
      weight: null,
      requirementType: null,
      paragraphId: null,
      quote: null,
    }],
    warnings: [],
  }
  assert.equal(validate(output, context({ draft: oversizedDraft, maxCriteria: 2, savedCriterionIds: new Set(oversizedDraft.criteria.map(criterion => criterion.id)) })).ok, true)
  assertValidationError(output, /cannot exceed 2 criteria/, context({
    draft: oversizedDraft,
    maxCriteria: 2,
    savedCriterionIds: new Set(['criterion-01', 'criterion-02']),
  }))
})

test('weight totals and incomplete existing criteria become bounded warnings', () => {
  const incompleteDraft = baseDraft({
    criteria: [{
      ...baseDraft().criteria[0],
      label: '',
      guidance: '',
      requirementType: null,
      citation: null,
      weight: 70,
    }],
  })
  const result = validate({
    outcome: 'changed',
    reply: 'Updated the rubric name.',
    rubric: { name: 'Platform Engineering rubric', description: null },
    criteria: [],
    warnings: ['Review source wording.'],
  }, context({ draft: incompleteDraft }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.warnings, [
    'Review source wording.',
    'Weights now total 70%. Rebalance to 100% before saving.',
    'C1 still needs a label.',
    'C1 still needs scoring guidance.',
    'C1 still needs a required or preferred classification.',
    'C1 still needs an exact source quotation.',
  ])
})
