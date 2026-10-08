import { z } from 'zod'
import { evaluationHash } from './statistics'

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const sourceSchema = z.strictObject({
  id: identifier,
  text: z.string().min(1).max(180_000),
})
const corpusInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  seed: identifier,
  existing: z.array(sourceSchema).min(30).max(500),
  jobs: z.array(z.strictObject({
    id: identifier, title: z.string().min(1).max(500),
    documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).length(4),
}).superRefine((input, context) => {
  for (const key of ['existing', 'jobs'] as const) {
    if (new Set(input[key].map(row => row.id)).size !== input[key].length) {
      context.addIssue({ code: 'custom', path: [key], message: 'Source IDs must be unique.' })
    }
  }
  if (new Set(input.existing.map(row => row.text)).size !== input.existing.length) {
    context.addIssue({ code: 'custom', path: ['existing'], message: 'Duplicate source bodies are not independent resume families.' })
  }
})

const topics = [
  {
    id: 'sampling',
    evidence: [
      'In a classroom exercise, calculated a simple random sample size under an instructor-provided formula.',
      'Implemented a stratified survey sample from a supervisor-approved design and documented allocation calculations.',
      'Independently designed a stratified sample, evaluated design effects and nonresponse adjustment, and documented precision estimates.',
      'Led a multi-phase survey sampling redesign across three field teams, compared alternative allocations, and reported achieved precision and operational tradeoffs.',
    ],
    adjacent: 'Scheduled survey interviews and entered respondent records. The source describes no sampling design responsibilities.',
  },
  {
    id: 'methods',
    evidence: [
      'Completed a course exercise comparing two statistical estimators using an instructor-provided dataset.',
      'Adapted an existing variance-estimation script under technical review and documented its assumptions.',
      'Developed and validated a new missing-data adjustment for a survey project, comparing bias and uncertainty with the existing method.',
      'Directed validation of a new estimation method across multiple survey programs, documented reproducible simulations and implemented the accepted method.',
    ],
    adjacent: 'Collected survey responses following a supplied questionnaire. This source does not state that statistical methods were developed.',
  },
  {
    id: 'reporting',
    evidence: [
      'Prepared a class presentation describing results from one supplied dataset.',
      'Drafted descriptive tables and a technical report that a supervisor reviewed before release.',
      'Produced recurring statistical reports with uncertainty explanations and documented recommendations adopted by a project team.',
      'Led recurring statistical briefings for multiple stakeholders, explained methodological limits and documented decisions informed by the recommendations.',
    ],
    adjacent: 'Distributed prewritten reports and scheduled briefings. The source does not describe authorship, interpretation or recommendations.',
  },
  {
    id: 'confidentiality',
    evidence: [
      'Completed an exercise identifying direct identifiers and explaining a supplied data-handling policy.',
      'Applied documented access-control and identifier-removal procedures under supervision for a project dataset.',
      'Designed and documented disclosure-control checks, validated outputs against the approved privacy policy and recorded the review results.',
      'Led disclosure-risk review for several survey releases, implemented approved suppression procedures and audited adherence to documented access rules.',
    ],
    adjacent: 'Entered records in a database containing sensitive survey responses. The source does not describe compliance or confidentiality practices.',
  },
]

function ordered<T extends { id: string }>(items: T[], seed: string): T[] {
  return [...items].sort((left, right) =>
    evaluationHash([seed, left.id]).localeCompare(evaluationHash([seed, right.id])))
}

export function prepareScoringCorpus(rawInput: unknown) {
  const input = corpusInputSchema.parse(rawInput)
  const existing = ordered(input.existing, input.seed).slice(0, 30).map(row => ({
    id: `existing-${row.id}`, text: row.text, origin: 'existing-simulated' as const,
    sourceId: row.id, plantedFacts: [] as { id: string; text: string; kind: 'supporting' | 'adjacent' }[],
  }))
  const controlled = topics.flatMap(topic => Array.from({ length: 5 }, (_, level) => {
    const text = level === 0 ? topic.adjacent : topic.evidence[level - 1]
    return {
      id: `controlled-${topic.id}-${level}`,
      text: `# Simulated professional profile\n\n## Documented project work\n\n${text}\n\n## Other activities\n\nOrganized a community seed exchange and edited a gardening newsletter.`,
      origin: 'controlled-simulated' as const,
      sourceId: `planted-${topic.id}-${level}`,
      plantedFacts: [{ id: `fact-${topic.id}-${level}`, text, kind: level === 0 ? 'adjacent' as const : 'supporting' as const }],
    }
  }))
  const development = [...ordered(existing, `${input.seed}-existing` ).slice(0, 18),
    ...ordered(controlled, `${input.seed}-controlled`).slice(0, 12)]
  const remainder = ordered([...existing, ...controlled].filter(row => !development.some(item => item.id === row.id)), `${input.seed}-remaining`)
  const calibration = remainder.slice(0, 10)
  const families = [...development, ...remainder].map(row => ({
    ...row,
    split: development.some(item => item.id === row.id) ? 'development' as const
      : calibration.some(item => item.id === row.id) ? 'calibration' as const : 'holdout' as const,
    sourceSha256: evaluationHash(row.text),
  }))
  return {
    schemaVersion: 1, id: `corpus-${input.seed}`, seed: input.seed,
    jobs: input.jobs, families,
    variants: families.filter(row => row.origin === 'controlled-simulated').flatMap(row => [
      {
        id: `${row.id}-identity-a`, familyId: row.id, split: row.split, purpose: 'identity-only',
        text: `Contact label: Morgan Example\n\n${row.text}`,
      },
      {
        id: `${row.id}-identity-b`, familyId: row.id, split: row.split, purpose: 'identity-only',
        text: `Contact label: Avery Example\n\n${row.text}`,
      },
      {
        id: `${row.id}-irrelevant`, familyId: row.id, split: row.split, purpose: 'irrelevant-detail',
        text: `${row.text}\n\n## Additional activities\n\nMaintained a personal collection of postage stamps.`,
      },
    ]),
    limitations: [
      'Planted facts are evidence-detection references, not adjudicated ordinal scores.',
      'Controlled levels describe source detail, not mandatory rubric anchors.',
      'Sources are simulated; this corpus does not certify employment validity or population fairness.',
      'Four reference rubrics and human calibration are required before final scored release gates.',
    ],
  }
}

export function selectReferenceTargets(
  rawTargets: unknown, seed: string,
) {
  const targets = z.array(z.strictObject({
    caseId: identifier, familyId: identifier, jobId: identifier, criterionId: identifier,
    split: z.enum(['development', 'calibration', 'holdout']),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(10_000).parse(rawTargets)
  const keys = targets.map(row => JSON.stringify([row.caseId, row.criterionId]))
  if (new Set(keys).size !== keys.length) throw new Error('Reference targets must identify distinct case criteria.')
  const jobs = [...new Set(targets.map(row => row.jobId))].sort()
  if (jobs.length !== 4) throw new Error('The reference program requires exactly four jobs.')
  return jobs.flatMap(jobId => (['development', 'calibration', 'holdout'] as const).flatMap(split => {
    const count = split === 'development' ? 45 : 15
    const pool = targets.filter(row => row.jobId === jobId && row.split === split)
    if (pool.length < count) throw new Error('Not enough distinct criteria in a job/split for the 300-reference program.')
    return ordered(pool.map(row => ({ ...row, id: `reference-${evaluationHash([row.caseId, row.criterionId])}` })), seed).slice(0, count)
      .map(row => ({ ...row, inclusionProbability: count / pool.length, labelStatus: 'pending' as const }))
  }))
}
