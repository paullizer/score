import { loadWorker } from './shared-model-loader.mjs'

const { renderEvidenceGuidance, EVIDENCE_SCALE_VERSION } = await loadWorker('../src/domain/evidence-scale.ts')
const { validateAnalysisAssessmentInput } = await loadWorker('../worker/analyses/model.ts')
const { createEvaluationSettings, evaluationHash } = await loadWorker('../worker/evals/index.ts')
const { createCompiledPromptBaseline } = await loadWorker('../server/settings/prompts.ts')
const { captureProcessingSettings } = await loadWorker('../src/domain/admin-settings.ts')

export const keys = ['relevantEvidence', 'appliedExample', 'repeatedOrOngoing', 'broadOrComplex', 'leadingOrOriginating', 'outcomesOrOrganizationalScale']
export const examples = [
  'Listed statistical training.', 'Applied regression in a study.', 'Performed ongoing survey analysis.',
  'Adapted methods for a multi-site study.', 'Originated a survey program across the organization.',
].map((examples, index) => ({ level: index + 1, examples }))

export function fixture(version = 'score-scale-b1-assessor-v1', maxCorrections = 2) {
  const citation = { documentId: 'job-document', documentVersion: 3, paragraphId: 'requirement', page: 2, heading: 'Duties', quote: 'Documented statistical analysis.' }
  const input = validateAnalysisAssessmentInput({
    resume: {
      id: 'resume-document', version: 7, kind: 'resume', sample: false, title: 'Synthetic profile',
      paragraphs: [
        { id: 'mention', page: 1, heading: 'Training', text: 'Completed statistical training.' },
        { id: 'work', page: 2, heading: 'Work', text: 'Applied regression in one study.' },
        { id: 'ongoing', page: 2, heading: 'Work', text: 'Conducted monthly surveys and adapted methods for multi-site data.' },
        { id: 'leading', page: 3, heading: 'Work', text: 'Originated a survey program across the organization.' },
      ],
    },
    rubric: {
      id: 'rubric', groupId: 'rubric-group', jobId: 'job', kind: 'job', dataKind: 'real',
      name: 'Statistics', description: 'Documented statistical analysis.', version: 4, createdAt: '2026-10-09T00:00:00Z',
      scaleVersion: EVIDENCE_SCALE_VERSION,
      criteria: [{
        id: 'statistics', key: 'custom', label: 'Statistical analysis', description: 'Documented statistical analysis.',
        weight: 100, requirementType: 'required', levels: examples,
        guidance: renderEvidenceGuidance(examples), sourceCitations: [citation],
      }],
    },
    qualifications: [], requirementEvidence: [{ kind: 'criterion', criterionId: 'statistics', citations: [citation] }],
  })
  const binding = { deploymentName: 'assessor', modelName: 'gpt-5-mini', modelVersion: '2025-08-07', reasoningEffort: 'low' }
  const initial = createEvaluationSettings({
    revision: 'offline-test', capturedAt: '2026-10-09T00:00:00Z',
    assessor: binding, reviewer: { ...binding, deploymentName: 'reviewer' },
  })
  const settings = structuredClone(initial.settings)
  settings.analyses.maxOutputCorrections = maxCorrections
  const snapshot = captureProcessingSettings(settings, initial.revision, initial.capturedAt, createCompiledPromptBaseline(initial.capturedAt))
  const price = { version: 'synthetic-price', currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 }
  const job = {
    suiteSha256: 'a'.repeat(64), repetition: 1,
    case: { id: 'case', familyId: 'family', jobId: 'job', split: 'development', inputSha256: evaluationHash(input), criterionIds: ['statistics'] },
    configuration: { id: 'candidate', algorithmVersion: version, settingsSha256: evaluationHash(snapshot) },
  }
  return { input, snapshot, job, prices: { assessor: price, reviewer: price } }
}

export function b1(level = 2) {
  return {
    criteria: [{
      criterionId: 'statistics', outcome: 'assessed', completeSourceReviewed: true,
      blockerCitations: [],
      rationale: 'The submitted document supports this fixed evidence level.', limitation: null, level,
      evidence: level === 0 ? [] : [{ passageId: level === 1 ? 1 : level === 2 ? 2 : level === 5 ? 4 : 3, kind: level === 1 ? 'mention' : 'applied-example' }],
    }], qualifications: [],
  }
}

export function b2(level = 2) {
  const yesKeys = keys.slice(0, level <= 3 ? level : level === 4 ? 4 : 6)
  const row = b1().criteria[0]
  delete row.level
  delete row.evidence
  row.checklist = Object.fromEntries(keys.map(key => [key, {
    answer: yesKeys.includes(key) ? 'yes' : 'no',
    evidence: yesKeys.includes(key) ? [{ passageId: key === 'relevantEvidence' ? 1 : key === 'appliedExample' ? 2 : key.includes('Or') && level === 5 ? 4 : 3, kind: key === 'relevantEvidence' ? 'mention' : 'applied-example' }] : [],
  }]))
  return { criteria: [row], qualifications: [] }
}

export const supported = { outcome: 'supported', issues: [] }
export const disputed = {
  outcome: 'needs-correction', issues: [{
    code: 'unsupported-score', message: 'Reconsider the cited evidence against the exact saved level.',
    criterionId: 'statistics', qualificationId: null, citations: [{ passageId: 2 }],
  }],
}

export function invocation(data, responses) {
  const calls = [], artifacts = [], diagnostics = [], attempts = []
  const options = {
    resumeSnapshotSha256: evaluationHash(data.input.resume),
    targetSnapshotSha256: evaluationHash({ rubric: data.input.rubric, qualifications: data.input.qualifications }),
    onDiagnostic: row => diagnostics.push(row),
    model: {
      endpoint: 'https://model.example/', deployment: 'bootstrap', modelName: 'gpt-5-mini',
      getToken: async () => 'synthetic-token', processingSettings: data.snapshot,
      fetch: async (url, init) => {
        const request = JSON.parse(init.body)
        const index = calls.length
        calls.push({ url: String(url), request, data: JSON.parse(request.messages[1].content) })
        if (index >= responses.length) throw new Error('Unexpected extra model request in deterministic test.')
        const response = responses[index]
        if (response instanceof Response) return response
        return Response.json({
          model: 'gpt-5-mini-2025-08-07',
          choices: [{ finish_reason: 'stop', message: { content: typeof response === 'string' ? response : JSON.stringify(response) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        })
      },
    },
  }
  const executionOptions = {
    input: data.input, processingSettings: data.snapshot, prices: data.prices, model: options.model,
    admitPaidWork: async () => {},
    recordAttempt: async row => attempts.push(row),
    recordPrivateResult: async () => {},
    recordPrivateDiagnostics: async rows => diagnostics.push(...rows),
    recordPrivateScaleArtifact: async row => artifacts.push(row),
  }
  return { calls, artifacts, diagnostics, attempts, options, executionOptions }
}
