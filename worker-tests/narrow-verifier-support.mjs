import { loadWorker } from './shared-model-loader.mjs'
import { fixture, b1, b2, invocation } from './scale-candidate-support.mjs'

const {
  freezeScaleProposal, prepareNarrowVerification, DEFAULT_VERIFICATION_POLICY,
  NARROW_VERIFIER_VERSION, FIXED_SCALE_REVIEWER_VERSION, evaluationHash, scoringSuiteSchema,
} = await loadWorker('../worker/evals/index.ts')

export function narrowFixture(candidate = 'B1', level = 2, maxCorrections = 2) {
  const data = fixture(NARROW_VERIFIER_VERSION, maxCorrections)
  const choice = candidate === 'B1' ? b1(level) : b2(level)
  const policy = structuredClone(DEFAULT_VERIFICATION_POLICY)
  const proposal = freezeScaleProposal('case', data.input, choice, candidate)
  const suite = scoringSuiteSchema.parse({
    schemaVersion: 1, id: 'fixed-scale-review', purpose: 'smoke', sourceVersion: 'synthetic-v1', repetitions: 2,
    configurations: [data.job.configuration, { ...data.job.configuration, id: 'current', algorithmVersion: FIXED_SCALE_REVIEWER_VERSION }],
    cases: [data.job.case],
  })
  data.job.suiteSha256 = evaluationHash(suite)
  const prepared = prepareNarrowVerification(data.input, proposal, policy)
  return { ...data, choice, proposal, policy, suite, prepared, inputs: [{ id: 'case', input: data.input }] }
}

export function cleanAnswer(prepared) {
  const selected = prepared.scope.criteria.filter(row => row.selected)
  return {
    inspectedPassageIds: prepared.scope.completeSourcePassageIds,
    citations: selected.flatMap(row => row.citations.map(citation => ({
      criterionId: row.criterionId, citationId: citation.citationId, verdict: 'relevant',
    }))),
    claims: selected.flatMap(row => row.claims.map(claim => ({
      criterionId: row.criterionId, claimId: claim.claimId, verdict: 'supported', passageIds: [1],
    }))),
    omittedEvidence: selected.filter(row => row.omittedEvidenceScan).map(row => ({
      criterionId: row.criterionId, outcome: 'none-found',
    })),
    findings: [],
  }
}

export function narrowInvocation(data, responses) {
  const mock = invocation(data, responses)
  const artifacts = [], reviews = [], failures = []
  let admissions = 0
  return {
    ...mock, artifacts, reviews, failures, admissions: () => admissions,
    execution: {
      ...mock.executionOptions, proposal: data.proposal, policy: data.policy,
      admitPaidWork: async () => { admissions++ },
      recordPrivateArtifact: async artifact => artifacts.push(artifact),
      recordPrivateReview: async review => reviews.push(review),
      recordPrivateFailure: async failure => failures.push(failure),
    },
  }
}
