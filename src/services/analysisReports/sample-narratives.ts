import type {
  SampleAnalysisCandidateNarrative, SampleAnalysisNarrativeReportCapture, SampleAnalysisTargetNarrative,
} from '../../domain/analysis-narratives'
import type { ReportComparison, ReportTarget } from '../../domain/analysis-reports'
import { narrativeSentences } from '../../domain/analysis-narrative-validation'
import { reportCandidateNarrativeSchema, reportTargetNarrativeSchema } from './narrative-schemas'

const disclaimer = 'This fictional assessment is a demonstration, not a hiring recommendation or an official eligibility decision.'
const phrase = (text: string) => text.length <= 100 && !/[.!?\n\r]|\u2026/u.test(text) ? text : undefined

// Fixture-owned change markers only; real publication revisions always come from the private store.
function fixtureRevision(value: unknown): string {
  const serialized = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619)
  return `fixture-v1-${(hash >>> 0).toString(16)}-${serialized.length}`
}

export function sampleReportFixtureId(runId: string): string {
  return `analysis-report-${fixtureRevision(runId)}`
}

function caveat(comparisons: ReportComparison[]): string {
  const criteria = comparisons.flatMap(comparison => comparison.criteria)
  const statements = [
    criteria.some(criterion => criterion.evidenceStatus === 'missing') ? 'some requirements have no mapped supporting evidence' : '',
    criteria.some(criterion => criterion.evidenceStatus === 'partial') ? 'some examples do not establish the full requested depth' : '',
    criteria.some(criterion => criterion.evidenceStatus === 'not-assessed') ? 'unassessed requirements remain unresolved' : '',
    comparisons.some(comparison => comparison.overall.status === 'withheld') ? 'the saved overall result remains withheld where evidence could not be assessed' : '',
  ].filter(Boolean)
  if (!statements.length) return 'The cited examples cover the assessed requirements, but the fixed fixture mapping does not verify real-world qualifications.'
  const text = statements.join('; ')
  return `${text[0].toUpperCase()}${text.slice(1)}.`
}

export function sampleCandidateNarrative(
  fixtureId: string, target: ReportTarget, comparison: ReportComparison,
): SampleAnalysisCandidateNarrative {
  if (target.dataKind !== 'sample' || comparison.dataKind !== 'sample' || comparison.status !== 'complete') {
    throw new Error('Fixture narratives require an exact completed sample comparison, never real analysis data.')
  }
  const evidence = [...comparison.criteria].filter(criterion => criterion.citations.length && criterion.score !== null && criterion.score > 0)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  const strongest = evidence[0]
  const label = strongest ? phrase(target.criteria.find(criterion => criterion.id === strongest.criterionId)!.label) : undefined
  const passage = evidence.flatMap(criterion => criterion.citations.flatMap(citation => narrativeSentences(citation.quote)))
    .find(sentence => sentence.length <= 195 && !/\.{3}|\u2026/u.test(sentence) &&
      /[.!?]["'\u2019\u201d)]*$/u.test(sentence) && (sentence.match(/\p{L}+/gu)?.length ?? 0) >= 3)
  const support = strongest
    ? `The synthetic resume provides cited examples${label ? ` relevant to ${label}` : ' relevant to this target\'s assessed requirements'}.`
    : 'The synthetic resume does not establish positive cited support for this target\'s saved requirements.'
  const detail = passage ? `The fixture passage states, "${passage}"` : strongest
    ? 'The supporting examples remain available in the saved fixture review for human inspection.'
    : 'The review leaves those requirements unresolved rather than inferring undocumented ability or experience.'
  const generated = `${support} ${detail} ${caveat([comparison])} ${disclaimer}`
  const overview = passage ? `Fixture evidence: ${passage}` : support
  const revision = fixtureRevision({ targetId: target.id, criteria: target.criteria, comparison })
  const metadata = { dataKind: 'sample' as const, fixtureId, revision, inputFingerprint: revision }
  const saved = comparison.summary ?? ''
  const reusable = !/\b\d+(?:\.\d+)?\s*\/\s*(?:5|100)\b|criterion evidence:|evidence-match total/iu.test(saved) &&
    reportCandidateNarrativeSchema.safeParse({ ...metadata, text: saved, overview }).success
  const narrative = { ...metadata, text: reusable ? saved : generated, overview }
  reportCandidateNarrativeSchema.parse(narrative)
  return narrative
}

export function sampleTargetNarrative(
  fixtureId: string, target: ReportTarget, comparisons: ReportComparison[],
): SampleAnalysisTargetNarrative {
  if (target.dataKind !== 'sample' || comparisons.some(comparison => comparison.dataKind !== 'sample' || comparison.targetId !== target.id)) {
    throw new Error('Fixture overviews require only sample comparisons for one exact target.')
  }
  const complete = comparisons.filter(comparison => comparison.status === 'complete')
  if (!complete.length) throw new Error('An unassessed sample target does not require an overview.')
  const supported = target.criteria.filter(criterion => complete.some(comparison => comparison.criteria.some(assessment =>
    assessment.criterionId === criterion.id && assessment.citations.length > 0 && assessment.score !== null && assessment.score > 0)))
    .map(criterion => phrase(criterion.label)).filter((label): label is string => label !== undefined).slice(0, 3)
  const strengths = supported.length
    ? `The saved fictional reviews contain cited examples relevant to ${supported.join(', ')}.`
    : 'The saved fictional reviews do not establish consistent cited support for this target\'s requirements.'
  const distinctions = complete.length > 1
    ? 'Differences between these examples concern the documented scope and completeness of experience, not a cross-job ranking or a prediction of performance.'
    : 'This review describes the documented scope of one fictional resume against the exact saved target, not a prediction of performance.'
  const unfinished = complete.length !== comparisons.length
    ? ' Comparisons without a completed assessment remain unassessed and are not evidence about those fictional candidates.' : ''
  const parts = [`${strengths} ${distinctions}`, `${caveat(complete)}${unfinished} ${disclaimer}`]
  const joined = parts.join(' ')
  const revision = fixtureRevision({ target, comparisons })
  const narrative: SampleAnalysisTargetNarrative = {
    dataKind: 'sample', fixtureId, revision, inputFingerprint: revision,
    paragraphs: joined.length <= 900 ? [joined] : parts,
  }
  reportTargetNarrativeSchema.parse(narrative)
  return narrative
}

export function sampleNarrativeCapture(
  fixtureId: string, targets: ReportTarget[], comparisons: ReportComparison[], targetId: string | null,
): SampleAnalysisNarrativeReportCapture {
  return {
    dataKind: 'sample', source: 'fixture', fixtureId, ready: true, scope: { targetId },
    revision: fixtureRevision({
      targetId,
      targets: targets.filter(target => targetId === null || target.id === targetId)
        .map(target => [target.id, target.narrative?.revision ?? null]),
      comparisons: comparisons.filter(comparison => targetId === null || comparison.targetId === targetId)
        .map(comparison => [comparison.id, comparison.status, comparison.narrative?.revision ?? null]),
    }),
  }
}
