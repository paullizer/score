import { z } from 'zod'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import type { OpmDiscoveryResult } from '../../src/domain/real-grades'
import { citationSchema } from '../../server/grades/validation'
import { WorkerError } from '../runtime'
import { referenceUrl } from '../references/transport'

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
const text = (max: number) => z.string().max(max).refine(value => value.trim().length > 0, 'Must not be blank.')
const unique = <T>(values: T[]) => new Set(values).size === values.length
const series = z.string().regex(/^\d{4}$/)
const grade = z.number().int().min(1).max(GRADE_LADDER_LIMITS.maxGrades)
const publicUrl = (opmOnly: boolean) => z.string().max(GRADE_LADDER_LIMITS.maxUrlLength).refine(value => {
  try {
    referenceUrl(value, undefined, opmOnly)
    return true
  } catch {
    return false
  }
}, opmOnly ? 'Must be an OPM HTTP(S) URL without credentials or nonstandard ports.' : 'Must be an HTTP(S) URL without credentials or nonstandard ports.')
const opmUrl = publicUrl(true)

const issueSchema = z.strictObject({
  id: identifier,
  code: identifier,
  severity: z.enum(['blocker', 'warning']),
  scope: z.enum(['context', 'source', 'grade', 'criterion', 'qualification']),
  message: text(8_000),
  sourceId: identifier.optional(),
  grade: grade.optional(),
  criterionId: identifier.optional(),
  citations: z.array(citationSchema).max(30).optional(),
})
const issues = z.array(issueSchema).max(2_000).refine(values => unique(values.map(value => value.id)), 'Issue IDs must be unique within their scope.')
const coverageSchema = z.strictObject({
  series: z.array(series).max(300).refine(unique, 'Covered series must be unique.'),
  grades: z.array(grade).max(GRADE_LADDER_LIMITS.maxGrades).refine(unique, 'Covered grades must be unique.'),
  functions: z.array(text(100)).max(20).refine(unique, 'Covered functions must be unique.'),
  state: z.enum(['confirmed', 'conditional', 'unknown', 'conflicting']),
  explanation: text(4_000),
})
const referenceLinkSchema = z.strictObject({
  url: publicUrl(false),
  label: text(GRADE_LADDER_LIMITS.maxUrlLength),
  relation: z.enum(['grading', 'qualification', 'exclusion', 'supersession', 'background']),
  page: z.number().int().min(1).max(100_000).optional(),
})
const sourceCandidateSchema = z.strictObject({
  url: opmUrl,
  title: text(500),
  purpose: z.enum(['grading', 'classification', 'qualification', 'agency', 'job-context', 'background', 'issuance']),
  intendedSection: z.string().max(2_000).optional(),
  publisher: text(300).refine(value => /\bopm\b|office of personnel management/i.test(value), 'An OPM candidate must retain its OPM publisher.'),
  coverage: coverageSchema,
  discoveryPath: z.array(opmUrl).min(1).max(30),
  revision: text(1_000).optional(),
  authorityStatus: z.enum(['current', 'superseded', 'unknown', 'conflicting']),
  relatedLinks: z.array(referenceLinkSchema).max(GRADE_LADDER_LIMITS.maxReferenceLinks),
  issues,
})

function candidateKey(candidate: { url: string; intendedSection?: string }): string {
  const url = new URL(candidate.url)
  const section = candidate.intendedSection ?? url.hash.slice(1)
  url.hash = ''
  return `${url.href}#${section}`
}

const discoveryResultSchema = z.strictObject({
  series: series.refine(value => value !== '0000', 'An occupational series must be specified.'),
  seriesTitle: text(500).optional(),
  seriesStatus: z.enum(['listed', 'retired', 'unknown', 'conflicting']),
  catalogVersion: text(200),
  candidates: z.array(sourceCandidateSchema).max(GRADE_LADDER_LIMITS.maxSources),
  issues,
}).superRefine((result, context) => {
  const keys = new Set<string>()
  for (const [index, candidate] of result.candidates.entries()) {
    // URL refinements may already have failed; never let a URL constructor escape the structured validation error.
    let key: string
    try {
      key = candidateKey(candidate)
    } catch {
      continue
    }
    if (keys.has(key)) context.addIssue({
      code: 'custom', path: ['candidates', index], message: 'Duplicate source and intended-section identity.',
    })
    keys.add(key)
  }
})

/** Decodes captured discovery evidence without fetching, normalizing, or reinterpreting a newer catalog. */
export function parseOpmDiscoveryResult(value: unknown): OpmDiscoveryResult {
  const parsed = discoveryResultSchema.safeParse(value)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join('.') || 'root'
    throw new WorkerError('opm-invalid-discovery-result', `The captured OPM discovery result is invalid at ${path}.`, false, 'parsing', { cause: parsed.error })
  }
  return parsed.data
}
