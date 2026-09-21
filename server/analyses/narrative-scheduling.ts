import type { RealAnalysisComparisonRecord, RealAnalysisRunRecord } from '../../src/domain/real-analyses'
import type { RealAnalysisTargetNarrativeRecord } from '../../src/domain/analysis-narratives'
import type { AnalysisStore, AnalysisTransaction } from './store'
import { analysisNarrativeId, assertAnalysis, parseAnalysisEntity } from './validation'
import {
  analysisNarrativeCanWork, narrativeGenerationId, narrativeTimestamp, newCandidateNarrative, newTargetNarrative,
} from './narrative-records'

/** Append these writes to the scoring CAS. Advance its mutable next-run timestamp to fence every new generation. */
export async function prepareAnalysisNarrativeTransitions(
  store: AnalysisStore, run: RealAnalysisRunRecord,
  transitions: readonly { previous: RealAnalysisComparisonRecord; next: RealAnalysisComparisonRecord }[], now: string,
): Promise<AnalysisTransaction[]> {
  if (!analysisNarrativeCanWork(run)) return []
  const timestamp = narrativeTimestamp(run, now)
  const operations: AnalysisTransaction[] = []
  const targets = new Map<string, { comparison: RealAnalysisComparisonRecord; completion: boolean }>()
  for (const { previous, next } of transitions) {
    const corrected = next.status === 'complete' && previous.status === 'complete' &&
      next.result?.sha256 !== previous.result?.sha256
    if (previous.status === next.status && !corrected) continue
    const completion = next.status === 'complete'
    const targetId = next.target.summary.id
    const existing = targets.get(targetId)
    targets.set(targetId, { comparison: next, completion: completion || Boolean(existing?.completion) })
    if (!completion) continue
    const id = analysisNarrativeId('candidate', run.id, next.id, next.resultRevision?.id)
    const value = await store.get(run.workspaceId, id)
    assertAnalysis(!value, 'A newly completed comparison already has a narrative sidecar.')
    const requestId = next.attemptId!
    const record = newCandidateNarrative(run, next, {
      requestId, requestedAt: timestamp, requestedBy: null, reason: corrected ? 'comparison-changed' : 'comparison-completed',
    })
    operations.push({ kind: 'create', record })
  }
  for (const { comparison, completion } of targets.values()) {
    const id = analysisNarrativeId('target', run.id, comparison.target.summary.id)
    const existing = await store.get(run.workspaceId, id)
    const parsed = existing ? parseAnalysisEntity(existing.record) : undefined
    if (parsed) assertAnalysis(parsed.recordType === 'analysis-target-narrative', 'Target narrative identity is invalid.')
    const previous = parsed?.recordType === 'analysis-target-narrative' ? parsed : undefined
    if (!previous && !completion) continue
    if (previous && previous.status === 'waiting' && analysisNarrativeCanWork(run, previous)) {
      const record: RealAnalysisTargetNarrativeRecord = {
        ...previous, updatedAt: timestamp, nextAttemptAt: timestamp, waitingFor: 'scoring',
      }
      operations.push({ kind: 'replace', record, etag: existing!.etag })
      continue
    }
    const requestId = completion ? comparison.attemptId! : narrativeGenerationId(run.id,
      `${comparison.id}:${comparison.status}:${comparison.retryCount}:${comparison.attempts}`)
    const record = newTargetNarrative(run, comparison.target, {
      requestId, requestedAt: timestamp, requestedBy: null, reason: completion ? 'comparison-completed' : 'comparison-changed',
    }, previous)
    operations.push(existing ? { kind: 'replace', record, etag: existing.etag } : { kind: 'create', record })
  }
  for (const operation of operations) {
    if (operation.record.updatedAt > run.updatedAt) run.updatedAt = operation.record.updatedAt
  }
  return operations
}
