import type { VersionedQc } from '../../src/domain/quality-control'
import type { QcPlanRecord } from '../../src/domain/quality-improvement'
import type { WorkspaceLifecycleParticipant, WorkspaceLifecycleState } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError } from '../store'
import { unavailable } from '../errors'
import type { QcDeps, QcLifecycleControl, QcListOptions, QcRecord, QcTransaction } from './store'
import { parseQcRecord, qcAssert, qcControlId, qcRunIds } from './validation'
import { qcWorkDrain } from './fences'

const TYPES: QcRecord['recordType'][] = [
  'qc-review', 'qc-submission', 'qc-batch', 'qc-plan-revision', 'qc-work', 'qc-request', 'qc-artifacts', 'qc-writer', 'qc-plan',
]
async function each(
  deps: QcDeps, workspaceId: string, options: QcListOptions,
  callback: (value: VersionedQc<QcRecord>) => Promise<void>,
) {
  let continuationToken: string | undefined
  const seen = new Set<string>()
  do {
    const page = await deps.store.list(workspaceId, { ...options, limit: 50, continuationToken })
    for (const value of page.items) {
      parseQcRecord(value.record)
      qcAssert(value.record.workspaceId === workspaceId, 'QC lifecycle inventory escaped its workspace.')
      await callback(value)
    }
    continuationToken = page.continuationToken
    if (continuationToken) {
      qcAssert(!seen.has(continuationToken) && seen.size < 10_000, 'QC cleanup pagination did not advance.')
      seen.add(continuationToken)
    }
  } while (continuationToken)
}
async function control(
  deps: QcDeps, workspaceId: string, runId?: string,
): Promise<VersionedQc<QcLifecycleControl> | undefined> {
  const current = await deps.store.get(workspaceId, qcControlId(runId))
  if (!current) return undefined
  qcAssert(current.record.recordType === 'qc-control' && current.record.workspaceId === workspaceId)
  return current as VersionedQc<QcLifecycleControl>
}
async function update(
  deps: QcDeps, workspaceId: string, runId: string | undefined, timestamp: string,
  changes: Partial<Pick<QcLifecycleControl, 'state' | 'cleanupPending' | 'cancellationPending'>>,
) {
  const current = await control(deps, workspaceId, runId)
  const record: QcLifecycleControl = {
    ...(current?.record ?? {
      id: qcControlId(runId), recordType: 'qc-control', workspaceId,
      createdAt: timestamp, updatedAt: timestamp, state: 'active', ...(runId ? { runId } : {}),
    }), ...changes,
    generation: (current?.record.generation ?? 0) + Number(changes.state !== undefined && changes.state !== (current?.record.state ?? 'active')),
    updatedAt: timestamp > (current?.record.updatedAt ?? '') ? timestamp : current!.record.updatedAt,
  }
  assertWorkspaceMutationLease(workspaceId)
  await deps.store.transact(workspaceId, [
    current ? { kind: 'replace', record, etag: current.etag } : { kind: 'create', record },
  ], { lifecycle: true })
}
export async function setQcRunState(
  deps: QcDeps, workspaceId: string, runId: string, state: WorkspaceLifecycleState, timestamp: string,
): Promise<void> {
  await setState(deps, workspaceId, state, timestamp, runId)
}
async function setState(deps: QcDeps, workspaceId: string, state: WorkspaceLifecycleState, timestamp: string, runId?: string) {
  const current = await control(deps, workspaceId, runId)
  if (current?.record.state === 'deleted' && (state === 'deleting' || state === 'deleted')) return
  if (state === 'active' && current?.record.cancellationPending) await cancelScope(deps, workspaceId, timestamp, runId)
  await update(deps, workspaceId, runId, timestamp, {
    state, ...(['archived', 'deleting'].includes(state) ? { cancellationPending: true } : {}),
    ...(['deleting', 'deleted'].includes(state) ? { cleanupPending: true } : {}),
  })
}
export function createQcRunLifecycleHooks(deps: QcDeps) {
  return {
    async setRunState(workspaceId: string, runId: string, state: WorkspaceLifecycleState, timestamp: string): Promise<void> {
      await setQcRunState(deps, workspaceId, runId, state, timestamp)
      if (state !== 'active') await cancelQcRun(deps, workspaceId, runId, timestamp)
    },
    purgeRun: (workspaceId: string, runId: string, timestamp: string) => purgeQcRun(deps, workspaceId, runId, timestamp),
  }
}
async function cancelPlan(deps: QcDeps, current: VersionedQc<QcPlanRecord>, timestamp: string, invalidate: boolean) {
  const record = current.record
  const operations: QcTransaction[] = []
  if (record.workId) {
    const work = await deps.store.get(record.workspaceId, record.workId)
    if (work?.record.recordType === 'qc-work' && ['queued', 'running', 'failed'].includes(work.record.status)) {
      const drain = qcWorkDrain(work.record, qcRunIds(record), timestamp)
      if (drain) operations.push({ kind: 'create', record: drain })
      operations.push({
        kind: 'replace', etag: work.etag, record: {
          ...work.record, updatedAt: timestamp > work.record.updatedAt ? timestamp : work.record.updatedAt,
          status: 'cancelled', lease: null, nextAttemptAt: null, error: null,
        },
      })
    }
  }
  if (invalidate && record.status !== 'invalidated' || ['planning', 'evaluating'].includes(record.status)) {
    operations.push({
      kind: 'replace', etag: current.etag, record: {
        ...record, status: invalidate ? 'invalidated' : 'cancelled', error: null,
        updatedAt: timestamp > record.updatedAt ? timestamp : record.updatedAt,
      },
    })
  }
  if (operations.length) await deps.store.transact(record.workspaceId, operations, { lifecycle: true })
}
export async function cancelQcRun(deps: QcDeps, workspaceId: string, runId: string, timestamp: string): Promise<void> {
  await cancelScope(deps, workspaceId, timestamp, runId)
}
async function cancelScope(deps: QcDeps, workspaceId: string, timestamp: string, runId?: string) {
  const state = await control(deps, workspaceId, runId)
  await each(deps, workspaceId, { recordType: 'qc-plan', ...(runId ? { runId } : {}) }, async value => {
    qcAssert(value.record.recordType === 'qc-plan')
    await cancelPlan(deps, value as VersionedQc<QcPlanRecord>, timestamp, ['deleting', 'deleted'].includes(state?.record.state ?? ''))
  })
  await update(deps, workspaceId, runId, timestamp, { cancellationPending: false })
}
async function purgeOwner(deps: QcDeps, workspaceId: string, ownerId: string, timestamp: string) {
  const now = Math.max(Date.now(), Date.parse(timestamp))
  const writers: VersionedQc<QcRecord>[] = []
  await each(deps, workspaceId, { recordType: 'qc-writer', ownerId }, async value => { writers.push(value) })
  if (writers.some(value => value.record.recordType === 'qc-writer' && Date.parse(value.record.expiresAt) > now)) {
    throw unavailable('QC cleanup is waiting for bounded private artifact writers or worker leases to drain. Retry deletion; publication remains fenced.')
  }
  for (let pass = 0; pass < 10_000; pass++) {
    const page = await deps.blobs.list(workspaceId, ownerId)
    if (!page.items.length) {
      if (page.continuationToken) {
        let token: string | undefined = page.continuationToken
        const seen = new Set<string>()
        do {
          qcAssert(!seen.has(token!) && seen.size < 10_000, 'QC blob cleanup did not advance.')
          seen.add(token!)
          const next = await deps.blobs.list(workspaceId, ownerId, token)
          for (const item of next.items) await deps.blobs.delete(workspaceId, item.name, item.etag)
          token = next.continuationToken
        } while (token)
        continue
      }
      break
    }
    for (const item of page.items) await deps.blobs.delete(workspaceId, item.name, item.etag)
    if (pass === 9999) throw unavailable('QC cleanup must be resumed; publication remains fenced.')
  }
  for (const type of ['qc-work', 'qc-plan-revision'] as const) {
    await deleteRecords(deps, workspaceId, { recordType: type, planId: ownerId })
  }
  for (const type of ['qc-artifacts', 'qc-writer'] as const) {
    await deleteRecords(deps, workspaceId, { recordType: type, ownerId })
  }
  const plan = await deps.store.get(workspaceId, ownerId)
  if (plan) {
    qcAssert(plan.record.recordType === 'qc-plan' && plan.record.status === 'invalidated')
    await deps.store.transact(workspaceId, [{ kind: 'delete', record: plan.record, etag: plan.etag }], { lifecycle: true })
  }
}
async function deleteRecords(deps: QcDeps, workspaceId: string, options: QcListOptions) {
  for (let pass = 0; pass < 10_000; pass++) {
    let found = false
    const values: VersionedQc<QcRecord>[] = []
    // Inventory first: deleting under an offset cursor could skip retained private records.
    let token: string | undefined
    const seen = new Set<string>()
    do {
      const page = await deps.store.list(workspaceId, { ...options, limit: 25, continuationToken: token })
      values.push(...page.items)
      token = page.continuationToken
      if (token) { qcAssert(!seen.has(token) && seen.size < 10_000); seen.add(token) }
    } while (!values.length && token)
    if (!values.length) return
    for (const value of values) {
      if (value.record.recordType === 'qc-control') continue
      found = true
      await deps.store.transact(workspaceId, [{ kind: 'delete', record: value.record, etag: value.etag }], { lifecycle: true })
    }
    if (!found) return
  }
  throw unavailable('QC cleanup is incomplete. Retry deletion; publication remains fenced.')
}
export async function purgeQcRun(deps: QcDeps, workspaceId: string, runId: string, timestamp: string): Promise<void> {
  await purgeScope(deps, workspaceId, timestamp, runId)
}
async function purgeScope(deps: QcDeps, workspaceId: string, timestamp: string, runId?: string) {
  const state = await control(deps, workspaceId, runId)
  if (!state || !['deleting', 'deleted'].includes(state.record.state)) throw new StoreConflictError('QC deletion must be fenced before cleanup.')
  await cancelScope(deps, workspaceId, timestamp, runId)
  const owners = new Set<string>()
  await each(deps, workspaceId, { recordType: 'qc-artifacts', ...(runId ? { runId } : {}) }, async value => {
    if (value.record.recordType === 'qc-artifacts') owners.add(value.record.ownerId)
  })
  await each(deps, workspaceId, { recordType: 'qc-plan', ...(runId ? { runId } : {}) }, async value => {
    owners.add(value.record.id)
  })
  await each(deps, workspaceId, { recordType: 'qc-writer', ...(runId ? { runId } : {}) }, async value => {
    if (value.record.recordType === 'qc-writer') owners.add(value.record.ownerId)
  })
  for (const ownerId of owners) await purgeOwner(deps, workspaceId, ownerId, timestamp)
  for (const recordType of TYPES) {
    await deleteRecords(deps, workspaceId, { recordType, ...(runId ? { runId } : {}) })
  }
  if (!runId) {
    // Includes orphan artifacts from an interrupted create, never an independent training corpus.
    for (let pass = 0; pass < 10_000; pass++) {
      const page = await deps.blobs.list(workspaceId)
      if (!page.items.length && !page.continuationToken) break
      if (!page.items.length) throw unavailable('QC artifact cleanup must resume after a storage progress page.')
      for (const item of page.items) await deps.blobs.delete(workspaceId, item.name, item.etag)
      if (pass === 9999) throw unavailable('QC artifact cleanup must be resumed.')
    }
    await each(deps, workspaceId, { recordType: 'qc-control' }, async value => {
      if (value.record.recordType === 'qc-control' && value.record.runId) {
        await update(deps, workspaceId, value.record.runId, timestamp, { state: 'deleted', cleanupPending: false, cancellationPending: false })
      }
    })
  }
  await update(deps, workspaceId, runId, timestamp, { state: 'deleted', cleanupPending: false, cancellationPending: false })
}
export function createQcLifecycleParticipant(deps: QcDeps): WorkspaceLifecycleParticipant {
  return {
    setState: (workspaceId, state, timestamp) => setState(deps, workspaceId, state, timestamp),
    cancel: (workspaceId, timestamp) => cancelScope(deps, workspaceId, timestamp),
    purge: (workspaceId, timestamp) => purgeScope(deps, workspaceId, timestamp),
    async counts(workspaceId) {
      const counts = { qcReviews: 0, qcSubmissions: 0, qcPlans: 0 }
      await each(deps, workspaceId, {}, async value => {
        if (value.record.recordType === 'qc-review') counts.qcReviews++
        if (value.record.recordType === 'qc-submission') counts.qcSubmissions++
        if (value.record.recordType === 'qc-plan') counts.qcPlans++
      })
      return counts
    },
    pendingWorkspaces: limit => deps.store.pendingLifecycle(limit),
    async resume(workspaceId, timestamp) {
      const workspace = await control(deps, workspaceId)
      if (workspace?.record.cleanupPending) { await purgeScope(deps, workspaceId, timestamp); return }
      if (workspace?.record.cancellationPending) await cancelScope(deps, workspaceId, timestamp)
      const values: QcLifecycleControl[] = []
      await each(deps, workspaceId, { recordType: 'qc-control' }, async value => {
        if (value.record.recordType === 'qc-control' && value.record.runId) values.push(value.record)
      })
      for (const value of values) {
        if (value.cleanupPending) await purgeScope(deps, workspaceId, timestamp, value.runId)
        else if (value.cancellationPending) await cancelScope(deps, workspaceId, timestamp, value.runId)
      }
    },
  }
}
export { qcRunIds }
