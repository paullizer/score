import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorker } from './shared-model-loader.mjs'

const { EVIDENCE_SCALE_VERSION, renderEvidenceGuidance } = await loadWorker('../src/domain/evidence-scale.ts')
const { rubricQaChecks, rubricQaBlocks, RUBRIC_QA_VERSION } = await loadWorker('../src/domain/rubric-qa.ts')

const citation = (paragraphId, quote) => ({ documentId: 'document-1', documentVersion: 1, paragraphId, page: 1, heading: 'Duties', quote })
function levels(topic) {
  return [
    `Lists ${topic} in coursework or training.`,
    `Describes one ${topic} task the applicant completed.`,
    `Describes repeated or ongoing ${topic} work.`,
    `Describes choosing or adapting ${topic} methods for complex work.`,
    `Describes leading ${topic} work with stated outcomes.`,
  ].map((examples, index) => ({ level: index + 1, examples }))
}
function criterion(id, label, description, quote, paragraphId = `p-${id}`, extra = {}) {
  const examples = levels(label.toLowerCase())
  return {
    id, label, description, levels: examples, guidance: renderEvidenceGuidance(examples),
    sourceCitations: [citation(paragraphId, quote)], ...extra,
  }
}
const distinct = () => ({
  scaleVersion: EVIDENCE_SCALE_VERSION,
  criteria: [
    criterion('sampling', 'Survey sampling', 'Designs probability samples for household surveys.', 'Designs sample surveys'),
    criterion('reporting', 'Technical reporting', 'Writes technical reports explaining estimates to managers.', 'Prepares technical reports'),
    criterion('confidentiality', 'Disclosure review', 'Applies disclosure-avoidance rules before data release.', 'Reviews releases for disclosure risk'),
  ],
})

test('a scaled rubric with distinct, observable criteria has no QA findings', () => {
  assert.equal(RUBRIC_QA_VERSION, 'score-rubric-qa-v1')
  const findings = rubricQaChecks(distinct())
  assert.deepEqual(findings, [])
  assert.equal(rubricQaBlocks(findings), false)
})

test('scale structure problems block approval while wording findings only warn', () => {
  const broken = distinct()
  delete broken.criteria[0].levels
  const findings = rubricQaChecks(broken)
  assert.equal(findings[0].code, 'scale-structure')
  assert.equal(findings[0].severity, 'blocker')
  assert.equal(rubricQaBlocks(findings), true)
  const wording = distinct()
  wording.criteria[1].levels[2] = { level: 3, examples: 'Produces acceptable reports with minimal supervision.' }
  wording.criteria[1].guidance = renderEvidenceGuidance(wording.criteria[1].levels)
  const warnings = rubricQaChecks(wording)
  assert.deepEqual(warnings.map(row => [row.code, row.severity, row.criterionIds[0]]), [
    ['unobservable-wording', 'warning', 'reporting'], ['unobservable-wording', 'warning', 'reporting'],
  ])
  assert.equal(rubricQaBlocks(warnings), false)
  // Quoting the cited job text is allowed even when it contains flagged words.
  const quoted = distinct()
  quoted.criteria[1].sourceCitations = [citation('p-reporting', 'Prepares acceptable statistical reports')]
  quoted.criteria[1].levels[2] = { level: 3, examples: 'Describes producing "acceptable statistical reports" as an ongoing duty.' }
  quoted.criteria[1].guidance = renderEvidenceGuidance(quoted.criteria[1].levels)
  assert.deepEqual(rubricQaChecks(quoted), [])
})

test('criteria citing the same or nested job text are flagged as possible overlap', () => {
  const rubric = distinct()
  rubric.criteria[1] = criterion('reporting', 'Technical reporting', 'Writes technical reports explaining estimates to managers.',
    'Designs sample surveys and selects statistical methods', 'p-sampling')
  const findings = rubricQaChecks(rubric)
  assert.deepEqual(findings.map(row => [row.code, row.criterionIds]), [['shared-source-text', ['sampling', 'reporting']]])
  assert.equal(findings[0].match, 'Designs sample surveys')
  const separate = distinct()
  separate.criteria[1].sourceCitations = [citation('p-sampling', 'Prepares technical reports')]
  assert.deepEqual(rubricQaChecks(separate), [])
})

test('long shared-source diagnostics are bounded and Unicode-safe without changing complete citations', () => {
  const rubric = distinct()
  const quote = '\ud83d\ude00 Relevant source evidence. '.repeat(1000)
  assert.ok(quote.length > 20_000)
  rubric.criteria[0].sourceCitations = [citation('shared', quote)]
  rubric.criteria[1].sourceCitations = [citation('shared', quote)]
  const [finding] = rubricQaChecks(rubric)
  assert.equal(finding.code, 'shared-source-text')
  assert.equal(finding.severity, 'warning')
  assert.deepEqual(finding.criterionIds, ['sampling', 'reporting'])
  assert.ok(Array.from(finding.match).length <= 2000)
  assert.ok(finding.match.endsWith('...'))
  assert.equal(finding.match.isWellFormed(), true)
  assert.equal(rubric.criteria[0].sourceCitations[0].quote, quote)
  assert.equal(rubric.criteria[1].sourceCitations[0].quote, quote)
})

test('near-duplicate requirements and nested labels are flagged with their similarity', () => {
  const rubric = distinct()
  rubric.criteria.push(criterion('sampling-advanced', 'Advanced survey sampling',
    'Designs probability samples for national household surveys.', 'Leads sample redesigns'))
  const findings = rubricQaChecks(rubric)
  assert.deepEqual(findings.map(row => [row.code, row.criterionIds]), [
    ['similar-requirement', ['sampling', 'sampling-advanced']], ['similar-label', ['sampling', 'sampling-advanced']],
  ])
  assert.ok(findings[0].similarity >= 0.6)
})

test('GS grade gaps and exclusions are left out of wording and overlap checks, and legacy rubrics get overlap checks only', () => {
  const rubric = distinct()
  rubric.criteria.push({ ...criterion('excluded', 'Survey sampling', 'Designs probability samples for household surveys.', 'Designs sample surveys', 'p-sampling'),
    support: 'not-applicable', levels: undefined, guidance: 'Unscored: outside the covered work.' })
  delete rubric.criteria[3].levels
  assert.deepEqual(rubricQaChecks(rubric), [])
  const legacy = distinct()
  delete legacy.scaleVersion
  for (const row of legacy.criteria) {
    delete row.levels
    row.guidance = '0: Not documented. 1: Coursework. 2: Acceptable work. 3: Recurring. 4: Complex. 5: Led.'
  }
  legacy.criteria[2].label = 'Survey sampling review'
  assert.deepEqual(rubricQaChecks(legacy).map(row => row.code), ['similar-label'])
})
