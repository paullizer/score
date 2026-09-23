import { randomUUID } from 'node:crypto'
import { analysisSummaryFixture, summaryTimestamp } from './analysisSummaries.test-support.mjs'

export const qcFamilies = ['jobRubric', 'gradeCompetencies', 'gradeDraft', 'assessment']
export const qcGuidance = Object.fromEntries(qcFamilies.map(family => [family, `Frozen ${family} task guidance.`]))
export const qcAuthor = { principalId: 'reviewer', name: 'Fixture reviewer' }
const hash = 'a'.repeat(64)
const base = { workspaceId: 'workspace-one', createdAt: summaryTimestamp, updatedAt: summaryTimestamp }

export function qcScope(comparisonId = 'comparison-1', resultRevision = 'original') {
  return { runId: 'run-one', comparisonId, resultRevision, resultSha256: hash }
}
export function qcFeedback(overrides = {}) {
  return { criterionId: 'criterion-one', decision: 'disagree', reason: 'The cited passage does not establish the stated breadth.',
    recommendation: { kind: 'score', score: 0 }, issues: ['evidence'], evidenceParagraphIds: ['resume-p1'], ...overrides }
}
export function qcSubmission(overrides = {}) {
  return { ...base, id: 'submission-peer-1', recordType: 'qc-submission', headId: 'head-peer', scope: qcScope(),
    author: { principalId: 'peer', name: 'Independent peer' }, feedback: [qcFeedback()], submissionNumber: 1,
    peerIndependent: true, peerExposedAt: null, requestId: randomUUID(), requestHash: hash, ...overrides }
}
export function qcProposal() {
  return { summary: 'Test proposal: improve evidence scope without inferring missing skills.',
    findings: [{ description: 'One selected reviewer disputes the evidence interpretation.', reviewIds: ['submission-peer-1'] }],
    disagreements: ['The reviewers differ about breadth; neither opinion is assumed true.'],
    changes: [{ familyId: 'assessment', guidance: 'Describe the exact documented scope before assigning a numeric rating.', reason: 'Keep conclusions grounded in cited scope.' }],
    expectedEffects: 'More explicit evidence scope.', risks: 'A selected excerpt may not generalize.' }
}
export function qcPlanDetail({ status = 'draft', proposal = null, admin = false, id = 'plan-one' } = {}) {
  const plan = { ...base, id, recordType: 'qc-plan', name: 'Fixture improvement', objective: 'Make evidence interpretation more precise.',
    createdBy: qcAuthor, revision: 1, cases: [{ scope: qcScope(), purpose: 'drafting', note: 'One opinion only.',
      reviewIds: ['submission-peer-1'], referenceDecisions: [{ criterionId: 'criterion-one', score: 0, reason: 'Named reference “Scope check”: exact source scope.' }] }],
    excludedFeedback: [], casePack: { name: 'private/case-pack', sha256: hash, bytes: 1000 },
    baseline: { revision: 'release-baseline', etag: '"release-baseline"', guidance: qcGuidance },
    processingSettings: { revision: 'settings-one' }, proposal, status, workId: null, evaluation: null, activatedRevision: null,
    error: null, lastRequestId: randomUUID(), lastRequestHash: hash }
  const detail = { plan, etag: '"plan-1"', canEdit: true, canCancel: false, canActivate: false, evaluation: null, work: null }
  if (['planning', 'evaluating'].includes(status)) {
    plan.workId = `work-${id}`
    detail.canEdit = false; detail.canCancel = true
    detail.work = { ...base, id: plan.workId, recordType: 'qc-work', planId: id, planRevision: 1,
      kind: status === 'planning' ? 'plan' : 'evaluation', status: 'queued', requestedBy: qcAuthor,
      requestId: randomUUID(), requestHash: hash, attempts: 0, lease: null, nextAttemptAt: null, checkpoint: null, error: null }
  }
  if (status === 'ready') {
    const trial = { status: 'complete', error: null, findings: ['The fixed grounding check accepted this trial.'], reviewedCriteria: 1, exactAgreements: 1, absoluteDifference: 0 }
    detail.evaluation = { schemaVersion: 1, workspaceId: base.workspaceId, planId: id, planRevision: 1, planHash: hash,
      baselineRevision: plan.baseline.revision, settingsHash: hash, candidateHash: 'b'.repeat(64), createdAt: summaryTimestamp,
      completedAt: summaryTimestamp, cases: [{ scope: qcScope(), purpose: 'drafting', familyId: 'assessment',
        baseline: { ...trial, exactAgreements: 0, absoluteDifference: 3 }, candidate: trial }],
      eligible: true, limitations: ['Only one drafting case and no independent holdout; not a general accuracy estimate.'] }
    detail.canActivate = admin
    plan.evaluation = { name: 'private/evaluation', sha256: hash, bytes: 500 }
  }
  return detail
}

export function createQcFixture({ role = 'reviewer', admin = false, submitted = false, admissionEnabled = true, workerEnabled = true } = {}) {
  const analysis = analysisSummaryFixture({ secondStatus: 'failed' })
  analysis.summary.run.status = 'partial'
  const state = {
    analysis, role, admin, admissionEnabled, workerEnabled, requests: [], heads: new Map(), submissions: [], batchRecords: [], memo: new Map(),
    plans: new Map(), histories: new Map(), calls: { submitted: 0, createdPlans: 0, paid: 0, activated: 0, restored: 0 },
    current: { revision: 'release-baseline', etag: '"release-baseline"', guidance: structuredClone(qcGuidance) },
    promptHistory: [{ revision: 'release-old', createdAt: summaryTimestamp, actor: 'Fixture admin', reason: 'Prior audited activation.', guidance: { ...qcGuidance, assessment: 'Previous compatible assessment guidance.' } }],
    override: null,
  }
  state.context = (comparisonId = 'comparison-1', revision = 'original') => {
    const detail = analysis.details.find(item => item.comparison.id === comparisonId)
    const scope = qcScope(comparisonId, revision)
    return {
      workspaceId: base.workspaceId, scope, analysis: structuredClone(detail), writable: true,
      isCoordinator: state.admin || ['owner', 'editor'].includes(state.role),
      canSeePeers: state.admin || ['owner', 'editor'].includes(state.role) || Boolean(state.heads.get(comparisonId)?.record.submittedId),
      myReview: structuredClone(state.heads.get(comparisonId) ?? null), submissionCount: state.submissions.length + 1,
      diagnostics: { status: 'recorded', message: null, criteria: [{ criterionId: 'criterion-one', confidence: 'low',
        explanation: 'The final accepted model call recorded ambiguous breadth.', ambiguities: [{ kind: 'rubric-anchors', message: 'The anchor does not specify breadth.' }], alternativeScores: [2, 3] }] },
    }
  }
  state.seedSubmission = () => {
    const submission = qcSubmission({ id: 'submission-own-1', headId: 'head-own', author: qcAuthor })
    state.submissions.push(submission)
    state.heads.set('comparison-1', { record: { ...base, id: 'head-own', recordType: 'qc-review', scope: qcScope(), author: qcAuthor,
      feedback: submission.feedback, submittedId: submission.id, submissionNumber: 1, peerExposedAt: null,
      lastRequestId: randomUUID(), lastRequestHash: hash }, etag: '"head-1"' })
  }
  if (submitted) state.seedSubmission()
  state.respond = async (url, init = {}) => {
    const parsed = new URL(url, 'https://score.test')
    const path = parsed.pathname
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    const headers = new Headers(init.headers)
    const key = headers.get('Idempotency-Key')
    const reply = value => Response.json(structuredClone(value))
    if (!state.admissionEnabled && ['POST', 'PUT'].includes(method) && path.includes('/qc/') &&
      !path.endsWith('/qc/peers') && !/\/qc\/plans\/[^/]+\/cancel$/.test(path)) {
      return Response.json({ error: { code: 'unavailable', message: 'New QC changes are disabled.' } }, { status: 503 })
    }
    if (key && state.memo.has(`${path}:${key}`)) return reply(state.memo.get(`${path}:${key}`))
    const remember = value => { if (key) state.memo.set(`${path}:${key}`, structuredClone(value)); return reply(value) }
    const projectPlan = value => state.admissionEnabled ? value : { ...value, canEdit: false, canActivate: false }
    if (path.endsWith('/qc/capabilities')) return reply({ reviews: true, improvements: state.admissionEnabled && state.workerEnabled,
      admissionEnabled: state.admissionEnabled, applicationAdmin: state.admin,
      coordinator: state.admin || ['owner', 'editor'].includes(state.role), writable: true,
      message: state.admissionEnabled ? state.workerEnabled ? null : 'The dedicated improvement worker is not enabled.'
        : 'New QC reviews and improvement changes are disabled. Saved QC remains readable and accepted work can still be cancelled.' })
    if (path.endsWith('/analyses')) return reply({ runs: [analysis.summary] })
    if (path.endsWith('/comparisons')) return reply({ comparisons: analysis.details.map(({ comparison, etag }) => ({ comparison, etag })) })
    if (path.endsWith('/qc/context')) return reply(state.context(parsed.searchParams.get('comparisonId'), parsed.searchParams.get('resultRevision') ?? 'original'))
    if (/\/qc\/reviews(?:\/submit)?$/.test(path)) {
      const previous = state.heads.get(body.scope.comparisonId)
      if (previous && headers.get('If-Match') !== previous.etag) return Response.json({ error: { code: 'conflict', message: 'A newer saved draft exists; keep your fields and inspect the current version.' } }, { status: 409 })
      const isSubmit = path.endsWith('/submit')
      const number = (previous?.record.submissionNumber ?? 0) + (isSubmit ? 1 : 0)
      const head = { record: { ...base, id: previous?.record.id ?? 'head-own', recordType: 'qc-review', scope: body.scope,
        author: qcAuthor, feedback: body.feedback, submittedId: isSubmit ? `submission-own-${number}` : previous?.record.submittedId ?? null,
        submissionNumber: number, peerExposedAt: previous?.record.peerExposedAt ?? null, lastRequestId: key, lastRequestHash: hash },
      etag: `"head-${state.requests.length}"` }
      state.heads.set(body.scope.comparisonId, head)
      if (isSubmit) { state.calls.submitted++; state.submissions.push(qcSubmission({ id: head.record.submittedId, scope: body.scope,
        author: qcAuthor, feedback: body.feedback, submissionNumber: number, peerIndependent: !head.record.peerExposedAt })) }
      return remember(head)
    }
    if (path.endsWith('/qc/reviews/history')) return reply({ items: state.submissions.map(record => ({ record, etag: `"${record.id}"` })) })
    if (path.endsWith('/qc/peers')) {
      const context = state.context(body.comparisonId, body.resultRevision)
      if (!context.canSeePeers) return Response.json({ error: { code: 'forbidden', message: 'Submit your independent review first.' } }, { status: 403 })
      const previous = state.heads.get(body.comparisonId)
      if (!previous?.record.peerExposedAt) state.heads.set(body.comparisonId, {
        record: { ...(previous?.record ?? { ...base, id: 'head-own', recordType: 'qc-review', scope: body, author: qcAuthor,
          feedback: [], submittedId: null, submissionNumber: 0, lastRequestId: randomUUID(), lastRequestHash: hash }),
        peerExposedAt: summaryTimestamp, updatedAt: summaryTimestamp },
        etag: `"head-exposed-${state.requests.length}"`,
      })
      return remember({ scope: body, coordinatorView: context.isCoordinator,
        submissions: [qcSubmission({ scope: body }), ...state.submissions.filter(item => item.scope.comparisonId === body.comparisonId)] })
    }
    if (path.endsWith('/qc/batches')) {
      if (method === 'GET') return reply({ items: state.batchRecords })
      const value = { record: { ...base, id: randomUUID(), recordType: 'qc-batch', createdBy: qcAuthor, ...body }, etag: '"batch-one"' }
      state.batchRecords.push(value)
      return remember(value)
    }
    if (path.endsWith('/qc/prompts/history')) return reply({ items: state.promptHistory })
    if (path.endsWith('/qc/prompts/restore')) {
      state.calls.restored++
      state.current = { revision: 'release-restored', etag: '"release-restored"', guidance: state.promptHistory.find(item => item.revision === body.revision).guidance }
      return remember(state.current)
    }
    if (path.endsWith('/qc/prompts')) return reply(state.current)
    if (path.endsWith('/qc/plans')) {
      if (method === 'GET') return reply({ items: [...state.plans.values()].map(detail => ({ record: detail.plan, etag: detail.etag })) })
      state.calls.createdPlans++
      const value = qcPlanDetail()
      Object.assign(value.plan, body)
      state.plans.set(value.plan.id, value)
      return remember(value)
    }
    const match = path.match(/\/qc\/plans\/([^/]+)(?:\/([^/]+))?$/)
    if (match) {
      const value = state.plans.get(match[1])
      if (!value) return Response.json({ error: { code: 'not_found', message: 'Saved plan not found.' } }, { status: 404 })
      if (match[2] === 'history') return reply({ items: state.histories.get(match[1]) ?? [] })
      if (method === 'GET') return reply(projectPlan(value))
      if (method === 'PUT') {
        value.plan.proposal = body.proposal; value.plan.revision++; value.plan.status = 'draft'
        value.plan.evaluation = null; value.evaluation = null; value.canActivate = false
        value.etag = `"plan-${value.plan.revision}"`
      } else if (match[2] === 'activate') {
        state.calls.activated++; value.plan.status = 'activated'; value.plan.activatedRevision = 'release-activated'; value.canActivate = false
      } else if (match[2] === 'cancel') {
        value.plan.status = 'cancelled'; value.canEdit = true; value.canCancel = false
        if (value.work) value.work.status = 'cancelled'
      } else {
        state.calls.paid++
        const kind = match[2] === 'evaluate' ? 'evaluation' : match[2] === 'retry' ? value.work?.kind ?? 'plan' : 'plan'
        value.plan.status = kind === 'evaluation' ? 'evaluating' : 'planning'
        value.canEdit = false; value.canCancel = true
        value.work = { ...base, id: 'work-one', recordType: 'qc-work', planId: value.plan.id, planRevision: value.plan.revision,
          kind, status: 'queued', requestedBy: qcAuthor, requestId: key, requestHash: hash, attempts: 0, lease: null,
          nextAttemptAt: null, checkpoint: null, error: null }
      }
      value.plan.lastRequestId = key
      return remember(projectPlan(value))
    }
    throw new Error(`Unexpected QC test request: ${method} ${url}`)
  }
  state.fetch = async (url, init = {}) => {
    state.requests.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : null, signal: init.signal })
    return await state.override?.(url, init) ?? state.respond(url, init)
  }
  return state
}
