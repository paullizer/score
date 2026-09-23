import type { QcWorkRecord } from '../../src/domain/quality-improvement'
import { StoreConflictError } from '../store'
import type { QcBlobWriter, QcControlFence, QcStore, QcTransaction } from './store'
import { qcAssert, qcControlId, qcId, qcValueHash } from './validation'

export function qcScopeControlIds(runIds: string[]): string[] {
  return [qcControlId(), ...[...new Set(runIds)].map(qcControlId)].sort()
}
export function qcWorkDrain(work: QcWorkRecord, runIds: string[], timestamp: string): QcBlobWriter | undefined {
  if (work.status !== 'running' || !work.lease || Date.parse(work.lease.expiresAt) <= Date.parse(timestamp)) return undefined
  return {
    id: qcId('drain', work.id, work.lease.id), recordType: 'qc-writer',
    workspaceId: work.workspaceId, ownerId: work.planId, runIds: [...new Set(runIds)],
    createdAt: timestamp, updatedAt: timestamp, expiresAt: work.lease.expiresAt,
  }
}
export async function captureQcControlFences(
  store: Pick<QcStore, 'get'>, workspaceId: string, runIds: string[],
): Promise<QcControlFence[]> {
  return Promise.all(qcScopeControlIds(runIds).map(async controlId => {
    const current = await store.get(workspaceId, controlId)
    if (!current || current.record.recordType !== 'qc-control' || current.record.state !== 'active' ||
      current.record.cleanupPending || current.record.cancellationPending) {
      throw new StoreConflictError('QC work cannot be accepted until its lifecycle controls are active.')
    }
    return { controlId, generation: current.record.generation ?? 0 }
  }))
}
export async function qcAcceptedControlFences(
  store: Pick<QcStore, 'get'>, work: QcWorkRecord, runIds: string[], operations: QcTransaction[] = [],
): Promise<QcControlFence[]> {
  const id = qcId('request', work.requestedBy.principalId, work.requestId)
  const receipt = operations.find(operation => operation.kind !== 'delete' && operation.record.id === id)?.record ??
    (await store.get(work.workspaceId, id))?.record
  qcAssert(receipt?.recordType === 'qc-request' && receipt.workspaceId === work.workspaceId &&
    receipt.actorId === work.requestedBy.principalId && receipt.requestId === work.requestId &&
    receipt.requestHash === work.requestHash && receipt.targetId === work.planId &&
    [work.kind === 'plan' ? 'draft-plan' : 'evaluate-plan', 'retry-plan'].includes(receipt.action) &&
    receipt.controlFences && qcValueHash(receipt.controlFences.map(fence => fence.controlId).sort()) ===
      qcValueHash(qcScopeControlIds(runIds)), 'QC work has no exact immutable lifecycle acceptance fence.')
  return receipt.controlFences
}
