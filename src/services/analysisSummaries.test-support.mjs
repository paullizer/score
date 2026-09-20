import { createHash } from 'node:crypto'

export const summaryWorkspaceId = 'workspace-one'
export const summaryRunId = 'run-one'
export const summaryTimestamp = '2026-09-19T15:00:00.000Z'
export const candidateNarrativeText = 'The saved resume describes independent engineering work. Its documented project methods support the saved requirements. The limited source does not establish the breadth of every required skill.'
export const targetNarrativeText = 'The completed review documents applied engineering methods, with limited detail about the breadth of experience. The saved evidence supports a focused comparison, not a hiring or eligibility decision.'
const hash = 'a'.repeat(64)
const blob = { blobName: 'private/frozen.json', contentType: 'application/json', bytes: 123, sha256: hash }

export function analysisSummaryFixture({ workspaceId = summaryWorkspaceId, archived = false, firstStatus = 'complete', secondStatus = 'complete' } = {}) {
  const targets = [
    { id: 'target-job-v1', dataKind: 'real', workspaceId, kind: 'job', label: 'Saved engineering role',
      sublabel: 'Captured organization', rubricId: 'rubric-job', rubricVersion: 1, criterionCount: 1,
      selection: { kind: 'job', jobId: 'job-one', rubricId: 'rubric-job', rubricVersion: 1, rubricHash: hash,
        documentId: 'job-document', documentVersion: 1, documentSha256: hash } },
    { id: 'target-grade-v2', dataKind: 'real', workspaceId, kind: 'grade', label: 'Approved engineering GS-9',
      sublabel: 'Captured grade context', rubricId: 'rubric-grade', rubricVersion: 2, criterionCount: 1,
      selection: { kind: 'grade', ladderId: 'ladder-one', grade: 9, versionId: 'approved-v2', version: 2,
        versionHash: hash, approvalId: 'approval-two', reviewId: 'review-two', sourceSetId: 'sources-two', sourceSetHash: hash },
      context: { series: '0801', agency: 'Captured agency', agencyType: 'other-federal', supervision: 'nonsupervisory',
        specialty: 'Engineering', functions: [], answers: {}, confirmed: true }, approvedAt: summaryTimestamp },
  ]
  const selection = { resumeId: 'resume-one', documentId: 'resume-document', documentVersion: 1, documentSha256: hash }
  const resume = { workspaceId, dataKind: 'real', selection, name: 'Jordan Example', role: 'Engineering specialist',
    sourceLabel: 'saved-resume.pdf', capturedAt: summaryTimestamp }
  const resumeDocument = { id: 'resume-document', kind: 'resume', version: 1, sample: false, title: 'Saved resume',
    paragraphs: [{ id: 'resume-p1', page: 1, heading: 'Experience', text: 'Applied engineering methods independently.' }] }
  const jobDocument = { id: 'job-document', kind: 'job', version: 1, sample: false, title: 'Saved job requirements',
    paragraphs: [{ id: 'job-p1', page: 1, heading: 'Requirements', text: 'Apply engineering methods to projects.' }] }
  const resumeCitation = { documentId: 'resume-document', documentVersion: 1, paragraphId: 'resume-p1',
    page: 1, heading: 'Experience', quote: resumeDocument.paragraphs[0].text }
  const jobCitation = { documentId: 'job-document', documentVersion: 1, paragraphId: 'job-p1',
    page: 1, heading: 'Requirements', quote: jobDocument.paragraphs[0].text }
  const criterion = { id: 'criterion-one', key: 'custom', competencyId: 'engineering', label: 'Engineering methods',
    description: 'Apply documented engineering methods.', weight: 100, guidance: '3: Independent application.',
    requirementType: 'required', support: 'direct', sourceCitations: [jobCitation] }
  const overall = { status: 'available', score: 60 }
  const coverage = { totalCriteria: 1, supported: 1, partial: 0, missing: 0, notAssessed: 0, notApplicable: 0,
    assessedWeight: 100, totalWeight: 100 }
  const model = { model: 'fixture-model', deployment: 'fixture-deployment', promptVersion: 'fixture-v1',
    schemaVersion: 'fixture-v1', startedAt: summaryTimestamp, completedAt: summaryTimestamp, inputCharacters: 100 }
  const details = targets.map((target, index) => {
    const rubric = { id: target.rubricId, groupId: target.rubricId, kind: target.kind, dataKind: 'real',
      name: target.label, description: 'Frozen requirements.', version: target.rubricVersion,
      criteria: [criterion], createdAt: summaryTimestamp, ...(target.kind === 'job' ? { jobId: 'job-one' } : { grade: 'GS-9', ladder: 'Saved ladder' }) }
    const status = index === 0 ? firstStatus : secondStatus
    const resultSummary = { completion: 'limited', overall, coverage }
    const comparison = { id: `comparison-${index + 1}`, recordType: 'analysis-comparison', dataKind: 'real', workspaceId,
      runId: summaryRunId, index, status, createdAt: summaryTimestamp, updatedAt: summaryTimestamp, attempts: 1, retryCount: 0,
      resume: { snapshotId: 'resume-snapshot', blob, summary: resume },
      target: { snapshotId: `target-snapshot-${index}`, blob, summary: target },
      ...(status === 'complete' ? { result: blob, resultSummary } : {}) }
    return {
      etag: `"immutable-pair-${index}"`, comparison,
      resumeSnapshot: { schemaVersion: 1, dataKind: 'real', workspaceId, snapshotId: 'resume-snapshot',
        frozenAt: summaryTimestamp, selection, document: resumeDocument,
        extraction: { method: 'pdf', pagination: 'pdf-pages', version: 'fixture-v1', pageCount: 1, normalizedCharacters: 100,
          document: { ...blob, documentId: resumeDocument.id, documentVersion: 1 }, extractedAt: summaryTimestamp },
        resume: { id: 'resume-one', dataKind: 'real', name: resume.name, role: resume.role, sourceLabel: resume.sourceLabel } },
      targetSnapshot: { schemaVersion: 1, dataKind: 'real', workspaceId, snapshotId: `target-snapshot-${index}`,
        frozenAt: summaryTimestamp, kind: target.kind, summary: target, selection: target.selection,
        requirementEvidence: [{ kind: 'criterion', criterionId: criterion.id, citations: [jobCitation] }],
        ...(target.kind === 'job' ? { rubric, document: jobDocument, original: { ...blob, contentType: 'application/pdf' } } : {
          version: { id: 'approved-v2', version: 2, rubric, qualifications: [] },
          seed: { document: jobDocument }, approval: { id: 'approval-two' }, review: { id: 'review-two' },
          sourceSet: { id: 'sources-two' }, references: [],
        }) },
      result: status === 'complete' ? { schemaVersion: 1, dataKind: 'real', workspaceId, runId: summaryRunId,
        comparisonId: comparison.id, createdAt: summaryTimestamp, humanReviewRequired: true, ...resultSummary,
        summary: 'Original immutable scoring explanation.', limitations: [{ code: 'sparse-source', message: 'The saved source contains limited context.' }],
        criteria: [{ criterionId: criterion.id, weight: 100, evidenceStatus: 'supported', score: 3,
          rationale: 'The frozen passage documents independent engineering work.', citations: [resumeCitation], requirementCitations: [jobCitation] }],
        qualifications: [], provenance: { attemptId: 'attempt-one', manifestSha256: hash,
          resumeSnapshot: { snapshotId: 'resume-snapshot', sha256: hash }, targetSnapshot: { snapshotId: `target-snapshot-${index}`, sha256: hash },
          assessmentSha256: hash, assessment: model, groundingReviews: [{ id: 'review', outcome: 'supported', issues: [], provenance: model }],
          correctionCount: 0, calculationVersion: 'weighted-0-100-v1' } } : null,
    }
  })
  const progress = { total: details.length, initialized: details.length, queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0, scored: 0, unscored: 0 }
  for (const { comparison } of details) progress[comparison.status]++
  progress.scored = progress.complete
  const summary = { etag: '"immutable-run"', ...(archived ? { lifecycle: { archivedAt: summaryTimestamp } } : {}),
    run: { id: summaryRunId, recordType: 'analysis-run', workspaceId, dataKind: 'real', name: 'Saved narrative review',
      status: progress.running || progress.queued ? 'running' : 'complete', createdAt: summaryTimestamp, updatedAt: summaryTimestamp,
      createdBy: 'reviewer', manifest: blob, initialization: { nextComparisonIndex: 2, completedAt: summaryTimestamp },
      progress, attempts: 1, retryCount: 0 } }
  return { workspaceId, targets, resume, details, summary, detail: { ...summary, targets, resumes: [resume] } }
}

function counts(items) {
  const value = { total: items.length, missing: 0, waiting: 0, queued: 0, running: 0, ready: 0, stale: 0, failed: 0, cancelled: 0, notRequired: 0 }
  for (const item of items) value[item.status === 'not-required' ? 'notRequired' : item.status]++
  return value
}

export function summaryResponse(fixture, {
  targetId = null, candidateStatus = 'missing', targetStatus = 'missing', states = {}, previous = false,
  text = candidateNarrativeText, paragraphs = [targetNarrativeText], revisionTag = 'initial', canGenerate = true, reason = null,
  uninitializedIds = [],
} = {}) {
  const selectedTargets = fixture.targets.filter((target) => targetId === null || target.id === targetId)
  const selected = fixture.details.filter(({ comparison }) => targetId === null || comparison.target.summary.id === targetId)
  const state = (kind, id, targetId, defaultStatus) => {
    const options = states[id] ?? {}
    const status = options.status ?? defaultStatus
    const published = status === 'ready' || (options.previous ?? previous)
      ? { dataKind: 'real', revision: createHash('sha256').update(`${id}:${options.text ?? text}:${revisionTag}`).digest('hex'),
        inputFingerprint: hash, generationId: `${id}:published`, publishedAt: summaryTimestamp,
        ...(kind === 'candidate' ? { text: options.text ?? text, overview: 'Documented engineering work is relevant, with limited evidence about breadth.' }
          : { paragraphs: options.paragraphs ?? paragraphs }) } : null
    return { kind, ...(kind === 'candidate' ? { comparisonId: id } : {}), targetId, status,
      generationId: status === 'ready' ? published.generationId : `${id}:requested`,
      inputFingerprint: hash, waitingFor: status === 'waiting' ? (options.waitingFor ?? 'candidate-narratives') : null,
      attempts: 1, retryCount: 0, nextAttemptAt: null, updatedAt: summaryTimestamp, published,
      error: status === 'failed' ? { code: 'grounding-failed', stage: 'grounding',
        message: options.error ?? 'Summary grounding needs an explicit retry.', retryable: false } : null }
  }
  const comparisons = selected.map(({ comparison }) => ({
    ...state('candidate', comparison.id, comparison.target.summary.id,
      comparison.status === 'complete' ? candidateStatus : ['queued', 'running'].includes(comparison.status) ? 'waiting' : 'not-required'),
    comparisonStatus: comparison.status,
  }))
  const targets = selectedTargets.map((target) => state('target', target.id, target.id, targetStatus))
  const scoring = { total: selected.length, initialized: selected.filter(({ comparison }) => !uninitializedIds.includes(comparison.id)).length,
    queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0 }
  for (const { comparison } of selected) scoring[comparison.status]++
  const ready = scoring.initialized === scoring.total && scoring.queued + scoring.running === 0 &&
    [...comparisons, ...targets].every((item) => ['ready', 'not-required'].includes(item.status))
  const revision = createHash('sha256').update(JSON.stringify({ targetId, scoring, comparisons, targets, revisionTag })).digest('hex')
  const pin = (item) => item.published ? { revision: item.published.revision, inputFingerprint: item.published.inputFingerprint } : null
  return {
    schemaVersion: 1, dataKind: 'real', workspaceId: fixture.workspaceId, runId: summaryRunId,
    scope: { targetId }, revision, etag: `"${revision}"`, ready, scoring,
    counts: { candidates: counts(comparisons), targets: counts(targets) }, comparisons, targets,
    capabilities: { canGenerate, reason },
    capture: { dataKind: 'real', scope: { targetId }, revision, ready,
      comparisons: comparisons.map((item) => ({ comparisonId: item.comparisonId, targetId: item.targetId,
        status: item.comparisonStatus, resultSha256: item.comparisonStatus === 'complete' ? hash : null, narrative: pin(item) })),
      targets: targets.map((item) => ({ targetId: item.targetId, narrative: pin(item) })) },
  }
}
