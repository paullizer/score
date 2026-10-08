import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const {
  EVIDENCE_SCALE_VERSION, EVIDENCE_LEVELS, EXAMPLE_LEVELS, EVIDENCE_SCALE_V1, LEVEL_EXAMPLE_LIMITS,
  evidenceScale, evidenceStatusForLevel, checkCriterionLevels, renderEvidenceGuidance, parseCriterionLevels,
} = await loadWorker('../src/domain/evidence-scale.ts')

const baseExamples = [
  { level: 1, examples: 'Lists Excel training.' },
  { level: 2, examples: 'Built one staffing dashboard.' },
  { level: 3, examples: 'Maintained monthly staffing reports.' },
  { level: 4, examples: 'Designed sampling methods across programs.' },
  { level: 5, examples: 'Led organization-wide workforce analytics.' },
]

function examplesWith(level, text) {
  return baseExamples.map(item => item.level === level ? { ...item, examples: text } : item)
}

function codesFor(levels, options) {
  return checkCriterionLevels(levels, options).map(item => item.code)
}

function findingsFor(levels, options) {
  return checkCriterionLevels(levels, options)
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') assertDeepFrozen(child)
  }
}

test('scale version and wording are exact and deeply frozen', () => {
  assert.equal(EVIDENCE_SCALE_VERSION, 'score-evidence-ladder-v1')
  assert.deepEqual(EVIDENCE_LEVELS, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(EXAMPLE_LEVELS, [1, 2, 3, 4, 5])
  assert.deepEqual(EVIDENCE_SCALE_V1, {
    version: 'score-evidence-ladder-v1',
    levels: [
      {
        level: 0,
        label: 'No relevant evidence',
        description: 'The résumé shows no relevant evidence. This is a normal, neutral outcome, never a statement about ability.',
      },
      {
        level: 1,
        label: 'Mentioned only',
        description: 'Training, coursework or a listed skill, with no applied example.',
      },
      {
        level: 2,
        label: 'One applied example',
        description: 'One concrete example of doing the work.',
      },
      {
        level: 3,
        label: 'Repeated or ongoing work',
        description: 'Several examples, or a described ongoing duty.',
      },
      {
        level: 4,
        label: 'Broad or complex work',
        description: 'Independent responsibility, larger scope, or choosing or adapting methods.',
      },
      {
        level: 5,
        label: 'Leading or originating the work',
        description: 'Leading or originating the work, with described outcomes or organizational scale.',
      },
    ],
    tieRule: 'When evidence falls between two levels, choose the lower level.',
    basis: 'The level comes from the strongest cited evidence, plus how often and at what scope it appears.',
  })
  assertDeepFrozen(EVIDENCE_SCALE_V1)
  assertDeepFrozen(LEVEL_EXAMPLE_LIMITS)
})

test('evidenceScale looks up known versions and rejects unknown versions', () => {
  assert.equal(evidenceScale('score-evidence-ladder-v1'), EVIDENCE_SCALE_V1)
  assert.throws(() => evidenceScale('score-evidence-ladder-v2'), /Unknown evidence scale version "score-evidence-ladder-v2"\./)
})

test('evidence status maps levels and rejects invalid runtime values', () => {
  assert.deepEqual(EVIDENCE_LEVELS.map(level => evidenceStatusForLevel(level)), [
    'missing', 'partial', 'partial', 'supported', 'supported', 'supported',
  ])
  for (const level of [6, -1, 2.5, null]) {
    assert.throws(() => evidenceStatusForLevel(level), /integer 0-5/)
  }
})

test('criterion examples report structural errors', () => {
  assert.ok(codesFor('not levels').includes('invalid-levels'))
  assert.ok(codesFor(baseExamples.slice(1)).includes('invalid-levels'))
  assert.ok(codesFor([baseExamples[0], 7, ...baseExamples.slice(2)]).includes('invalid-levels'))
  assert.ok(codesFor([{ level: 6, examples: 'Built a report.' }, ...baseExamples.slice(1)]).includes('invalid-level'))
  assert.ok(codesFor(examplesWith(3, '   ')).includes('blank-examples'))
  assert.ok(codesFor(examplesWith(3, 'x'.repeat(LEVEL_EXAMPLE_LIMITS.maxCharacters + 1))).includes('examples-too-long'))

  const duplicateLevel = [
    baseExamples[0], baseExamples[1], { level: 2, examples: 'Created another dashboard.' }, baseExamples[3], baseExamples[4],
  ]
  assert.ok(codesFor(duplicateLevel).includes('duplicate-level'))

  const outOfOrder = [baseExamples[0], baseExamples[2], baseExamples[1], baseExamples[3], baseExamples[4]]
  assert.ok(codesFor(outOfOrder).includes('out-of-order'))

  const duplicateExamples = examplesWith(4, '  built one   staffing dashboard.  ')
  assert.ok(codesFor(duplicateExamples).includes('duplicate-examples'))
})

test('work-quality warnings flag judgments but allow documentable quality activities', () => {
  const positive = findingsFor(examplesWith(3, 'Produces acceptable summaries for routine use.'))
  assert.equal(positive.find(item => item.code === 'work-quality')?.match, 'acceptable')
  assert.match(positive.find(item => item.code === 'work-quality')?.message ?? '', /Level 3/)

  assert.equal(codesFor(examplesWith(3, 'Ran data quality reviews and quality assurance checks.')).includes('work-quality'), false)
  assert.equal(codesFor(examplesWith(3, 'Ran quality control checks for survey data.')).includes('work-quality'), false)
})

test('error-rate warnings flag editing burden but allow documentable error work', () => {
  const positive = findingsFor(examplesWith(2, 'Draft requires corrections before use.'))
  assert.equal(positive.find(item => item.code === 'error-rate')?.match, 'requires corrections')

  assert.equal(codesFor(examplesWith(2, 'Identified data entry errors during records audits.')).includes('error-rate'), false)
})

test('supervision-need warnings flag needed oversight but allow leadership and independence facts', () => {
  const positive = findingsFor(examplesWith(4, 'Performs analysis with minimal supervision.'))
  assert.equal(positive.find(item => item.code === 'supervision-need')?.match, 'with minimal supervision')

  for (const text of [
    'Supervised two analysts on a workforce dashboard.',
    'Independently designed samples for a customer survey.',
    'Ongoing monthly reporting for branch leaders.',
  ]) {
    assert.equal(codesFor(examplesWith(4, text)).includes('supervision-need'), false, text)
  }
})

test('attitude warnings flag motivation traits but allow documentable collaboration', () => {
  const positive = findingsFor(examplesWith(1, 'Shows willingness to learn budget analysis.'))
  assert.equal(positive.find(item => item.code === 'attitude')?.match, 'willingness')

  assert.equal(codesFor(examplesWith(1, 'Coordinated with teammates during weekly intake triage.')).includes('attitude'), false)
})

test('level-reference warnings flag score anchors but allow documentable scorecard work', () => {
  const positive = findingsFor(examplesWith(5, 'Meets level 5 expectations for analytics.'))
  assert.equal(positive.find(item => item.code === 'level-reference')?.match, 'level 5')

  assert.equal(codesFor(examplesWith(5, 'Created scorecards for eligibility decisions.')).includes('level-reference'), false)
})

test('quoted source exception allows exact posting quotes only when source text contains them', () => {
  const levels = examplesWith(2, 'Lists "acceptable statistical methods" as in the posting.')
  const flagged = findingsFor(levels)
  assert.equal(flagged.find(item => item.code === 'work-quality')?.match, 'acceptable')

  const allowed = findingsFor(levels, { sourceTexts: ['The posting requires acceptable statistical methods for survey estimates.'] })
  assert.equal(allowed.some(item => item.code === 'work-quality'), false)

  const curly = examplesWith(2, 'Lists “acceptable statistical methods” as in the posting.')
  const allowedCurly = findingsFor(curly, { sourceTexts: ['Requires acceptable statistical methods.'] })
  assert.equal(allowedCurly.some(item => item.code === 'work-quality'), false)
})

test('renderEvidenceGuidance produces deterministic scale lines with examples and tie rule', () => {
  const first = renderEvidenceGuidance(baseExamples)
  const second = renderEvidenceGuidance(baseExamples)
  assert.equal(first, second)

  const lines = first.split('\n')
  assert.equal(lines.length, 7)
  assert.equal(lines[0], '0: No relevant evidence. The résumé shows no relevant evidence. This is a normal, neutral outcome, never a statement about ability.')
  assert.equal(lines[1], '1: Mentioned only. Training, coursework or a listed skill, with no applied example. Examples: Lists Excel training.')
  assert.equal(lines[2].startsWith('2: One applied example. One concrete example of doing the work. Examples: '), true)
  assert.equal(lines[3].startsWith('3: Repeated or ongoing work. Several examples, or a described ongoing duty. Examples: '), true)
  assert.equal(lines[4].startsWith('4: Broad or complex work. Independent responsibility, larger scope, or choosing or adapting methods. Examples: '), true)
  assert.equal(lines[5].startsWith('5: Leading or originating the work. Leading or originating the work, with described outcomes or organizational scale. Examples: '), true)
  assert.equal(lines[6], 'When evidence falls between two levels, choose the lower level. The level comes from the strongest cited evidence, plus how often and at what scope it appears.')

  assert.doesNotThrow(() => renderEvidenceGuidance(examplesWith(3, 'Produces acceptable summaries.')))
  assert.throws(() => renderEvidenceGuidance(baseExamples.slice(1)), /exactly five entries/)
})

test('parseCriterionLevels normalizes examples and throws structural messages', () => {
  assert.deepEqual(parseCriterionLevels([
    { level: 1, examples: ' Lists   Excel training. ' },
    { level: 2, examples: ' Built one staffing dashboard. ' },
    { level: 3, examples: ' Maintained\nmonthly\tstaffing reports. ' },
    { level: 4, examples: ' Designed sampling methods across programs. ' },
    { level: 5, examples: ' Led organization-wide workforce analytics. ' },
  ]), [
    { level: 1, examples: 'Lists Excel training.' },
    { level: 2, examples: 'Built one staffing dashboard.' },
    { level: 3, examples: 'Maintained monthly staffing reports.' },
    { level: 4, examples: 'Designed sampling methods across programs.' },
    { level: 5, examples: 'Led organization-wide workforce analytics.' },
  ])

  assert.throws(() => parseCriterionLevels(examplesWith(3, ' ')), /Level 3 examples are blank/)
})
