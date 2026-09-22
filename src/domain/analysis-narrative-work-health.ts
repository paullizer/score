import { LEGACY_SETTINGS_REVISION } from './admin-settings-defaults'
import type {
  AnalysisNarrativeStatus, AnalysisNarrativeSummaryBase, AnalysisNarrativeWaitReason, AnalysisNarrativeWorkHealth,
  AnalysisNarrativeWorkHealthState, RealAnalysisNarrativeRecord,
} from './analysis-narratives'

export function deriveAnalysisNarrativeWorkHealth(
  record: RealAnalysisNarrativeRecord, status: AnalysisNarrativeStatus, now: string,
  waitingFor: AnalysisNarrativeWaitReason | null = record.waitingFor ?? null,
): AnalysisNarrativeWorkHealth {
  const leaseExpiresAt = record.lease?.expiresAt ?? null
  const futureRetry = Boolean(record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.parse(now))
  const eligible = status === 'queued' || status === 'waiting' && waitingFor === null
  const state: AnalysisNarrativeWorkHealthState = status === 'waiting' && waitingFor !== null ? 'waiting-prerequisites'
    : eligible ? futureRetry
      ? record.error?.diagnostic?.httpStatus === 429 ? 'throttled' : 'retry-scheduled'
      : 'awaiting-worker'
      : status === 'running' ? leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.parse(now) ? 'running' : 'interrupted'
        : status === 'failed' ? 'failed' : 'inactive'
  const model = record.processingSettings?.tasks[record.recordType === 'analysis-candidate-narrative' ? 'candidateSummary' : 'targetSummary']
  return {
    state, requestedAt: record.requestedAt,
    lastActivityAt: record.lease && record.lease.heartbeatAt > record.updatedAt ? record.lease.heartbeatAt : record.updatedAt,
    leaseExpiresAt, attempt: record.attempts,
    nextEligibleAt: eligible ? record.nextAttemptAt ?? record.requestedAt
      : state === 'interrupted' ? leaseExpiresAt : null,
    capturedSettings: {
      revision: record.processingSettings?.revision ?? LEGACY_SETTINGS_REVISION,
      modelName: model?.modelName ?? null, reasoningEffort: model?.reasoningEffort ?? null,
    },
  }
}

export type AnalysisNarrativeDisplayWorkState = AnalysisNarrativeWorkHealthState | 'unverified-running'

export function analysisNarrativeDisplayWorkState(
  summary: AnalysisNarrativeSummaryBase, now = Date.now(),
): AnalysisNarrativeDisplayWorkState {
  if (summary.workHealth) return summary.workHealth.state
  if (summary.status === 'waiting') return 'waiting-prerequisites'
  if (summary.status === 'queued') {
    if (summary.nextAttemptAt && Date.parse(summary.nextAttemptAt) > now) {
      return summary.error?.diagnostic?.httpStatus === 429 ? 'throttled' : 'retry-scheduled'
    }
    return 'awaiting-worker'
  }
  // Older API responses have no lease evidence; do not imply that a worker is still alive.
  if (summary.status === 'running') return 'unverified-running'
  return summary.status === 'failed' ? 'failed' : 'inactive'
}

export function analysisNarrativeWorkLabel(summary: AnalysisNarrativeSummaryBase): string {
  switch (analysisNarrativeDisplayWorkState(summary)) {
    case 'waiting-prerequisites': return 'Waiting for prerequisites'
    case 'awaiting-worker': return 'Queued - awaiting worker'
    case 'retry-scheduled': return summary.attempts > 0 ? 'Retry scheduled' : 'Scheduled'
    case 'throttled': return 'Rate-limit cooldown'
    case 'running': return 'Active generation'
    case 'interrupted': return 'Interrupted - worker lease expired'
    case 'failed': return 'Summary failed'
    case 'unverified-running': return 'Running - lease status unavailable'
    case 'inactive': return 'No pending work'
  }
}

export function analysisNarrativeWorkCounts(summaries: readonly AnalysisNarrativeSummaryBase[]) {
  const counts: Record<AnalysisNarrativeDisplayWorkState, number> = {
    'waiting-prerequisites': 0, 'awaiting-worker': 0, 'retry-scheduled': 0, throttled: 0,
    running: 0, interrupted: 0, failed: 0, inactive: 0, 'unverified-running': 0,
  }
  for (const summary of summaries) counts[analysisNarrativeDisplayWorkState(summary)]++
  return counts
}

export function analysisNarrativePollingRevision(value: { revision: string; workRevision?: string }): string {
  return value.workRevision ? `${value.revision}:${value.workRevision}` : value.revision
}
