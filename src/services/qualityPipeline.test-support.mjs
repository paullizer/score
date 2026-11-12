export const pipelineWorkspace = {
  id: 'workspace-one', name: 'Example workspace', kind: 'personal', role: 'owner',
  accessSource: 'application-admin', membershipRole: 'viewer', etag: '"workspace-one"',
  createdAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z',
}
export const pipelineUser = { id: 'admin-one', tenantId: 'tenant-one', name: 'Example administrator', email: '' }
export function pipelineFixture() {
  const hash = 'a'.repeat(64), timestamp = '2026-11-11T12:00:00.000Z'
  const scope = comparisonId => ({ runId: 'run-one', comparisonId, resultRevision: 'original', resultSha256: hash })
  const detail = {
    plan: { id: 'plan-one', workspaceId: pipelineWorkspace.id, name: 'Assessment guidance candidate', revision: 4, status: 'ready', updatedAt: timestamp },
    casePackSha256: hash,
    cases: [
      { scope: scope('comparison-one'), purpose: 'drafting', includedReviews: 2 },
      { scope: scope('comparison-two'), purpose: 'holdout', includedReviews: 1 },
    ],
    excludedReviews: 1, changedFamilies: ['assessment'],
    tasks: ['jobRubric', 'gradeCompetencies', 'gradeDraft', 'assessment'].map(family => ({
      family, deployment: 'captured-model', model: 'model-fixture', modelVersion: null,
    })),
    settings: { revision: 'settings-one', capturedAt: timestamp },
    baseline: { id: 'bundle-baseline', sha256: hash },
    candidate: { id: 'bundle-candidate', sha256: 'b'.repeat(64) },
    evaluation: { sha256: 'c'.repeat(64), completedAt: timestamp, eligibleAtCompletion: true, trials: 2, holdoutTrials: 1, failedBaselineTrials: 0, failedCandidateTrials: 0 },
    work: { kind: 'evaluation', status: 'complete', attempts: 1, nextAttemptAt: null },
    activatedBundleId: null,
  }
  const state = {
    detail, requests: [], override: null,
    release: {
      activeBundleId: 'bundle-baseline', activeBundleSha256: hash, etag: '"bundle-baseline"', supported: true,
      generation: 'fixture-generation', pending: false, retryAllowed: false,
      message: 'Current instructions are compatible. Native activation still rechecks the exact candidate.', deploymentVerified: true,
    },
    async fetch(input, init = {}) {
      const url = new URL(input, 'https://score.test')
      state.requests.push({ path: url.pathname, method: init.method ?? 'GET', query: url.search })
      if (state.override) {
        const response = await state.override(url, init)
        if (response) return response
      }
      if (url.pathname === '/api/admin/settings/prompt-release') return Response.json(state.release)
      if (url.pathname === '/api/admin/quality-pipeline/workspaces/workspace-one/plans') {
        return Response.json({ workspaceId: 'workspace-one', items: [state.detail.plan] })
      }
      if (url.pathname === '/api/admin/quality-pipeline/workspaces/workspace-one/plans/plan-one') return Response.json(state.detail)
      return Response.json({ error: { code: 'not_found', message: `Unexpected fixture request: ${url.pathname}` } }, { status: 404 })
    },
  }
  return state
}
