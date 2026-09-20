import { randomUUID } from 'node:crypto'
import type { LifecycleMetadata } from '../../src/domain/lifecycle'
import type { RealResumeRecord, ResumeEntity, VersionedResumeEntity } from '../../src/domain/real-resumes'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError, StoreNotFoundError } from '../store'
import type {
  ResumeBlobStore, ResumeLifecycleControl, ResumeStore, ResumeTransaction, ResumeTransactionOptions,
} from './store'
import { isBlobInResumePrefix, isResumeUuid, isValidResumeId, resumeContentHash } from './validation'

export const RESUME_BLOB_REQUEST_MS = 60_000
export const RESUME_BLOB_LEASE_SECONDS = 60
export const RESUME_WRITER_LEASE_MS = 180_000
export const RESUME_PREPARATION_RETENTION_MS = 24 * 60 * 60_000
const same = (left: unknown, right: unknown) => resumeContentHash(left) === resumeContentHash(right)

export function resumeControlId(resumeId?: string): string {
  return resumeId ? `resume-lifecycle-${resumeId}` : 'resume-lifecycle-workspace'
}

export function resumeIsLocked(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.archivedAt || lifecycle?.deletingAt || lifecycle?.deletedAt)
}

export function resumeIsRemoved(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.deletingAt || lifecycle?.deletedAt)
}

function denied(): never {
  throw new StoreConflictError('This resume or workspace is archived, removed, or changed. Reload before starting new work.')
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function parseResumeControl(value: unknown): ResumeLifecycleControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resume lifecycle control.')
  const control = value as ResumeLifecycleControl
  if (Object.keys(control).some(key => ![
    'id', 'recordType', 'workspaceId', 'resumeId', 'state', 'updatedAt', 'operation', 'preparation', 'writers',
  ].includes(key)) || !WORKSPACE_ID_PATTERN.test(control.workspaceId) || control.recordType !== 'resume-lifecycle' ||
    (control.resumeId !== undefined && !isValidResumeId(control.resumeId)) ||
    control.id !== resumeControlId(control.resumeId) || !['active', 'archived', 'deleting', 'deleted'].includes(control.state) ||
    !timestamp(control.updatedAt)) throw new Error('Invalid resume lifecycle control.')
  if (control.operation !== undefined) {
    const operation = control.operation
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).some(key => !['id', 'action', 'status', 'updatedAt', 'error'].includes(key)) ||
      operation.id !== (control.resumeId ?? control.workspaceId) || !['archive', 'unarchive', 'delete'].includes(operation.action) ||
      !['pending', 'running', 'failed', 'complete'].includes(operation.status) || !timestamp(operation.updatedAt) ||
      (operation.error !== undefined && (typeof operation.error !== 'string' || operation.error.length > 2000))) {
      throw new Error('Invalid resume lifecycle operation.')
    }
  }
  if (control.preparation !== undefined) {
    const preparation = control.preparation
    if (!control.resumeId || !preparation || typeof preparation !== 'object' || Array.isArray(preparation) ||
      Object.keys(preparation).some(key => !['inputFingerprint', 'expiresAt'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(preparation.inputFingerprint) || !timestamp(preparation.expiresAt)) {
      throw new Error('Invalid resume import preparation.')
    }
  }
  if (control.writers !== undefined && (!control.resumeId || !control.writers || typeof control.writers !== 'object' ||
    Array.isArray(control.writers) || Object.keys(control.writers).length > 64 ||
    Object.entries(control.writers).some(([id, writer]) => !isResumeUuid(id) || !writer || typeof writer !== 'object' ||
      Object.keys(writer).some(key => !['blobName', 'expiresAt'].includes(key)) ||
      !isBlobInResumePrefix(writer.blobName, control.workspaceId, control.resumeId!) || !timestamp(writer.expiresAt)))) {
    throw new Error('Invalid resume Blob writer reservations.')
  }
  return structuredClone(control)
}

export function cancelResumeWork(record: RealResumeRecord, time: string): RealResumeRecord {
  if (!['queued', 'parsing', 'profiling'].includes(record.resume.status)) return record
  const updatedAt = [time, record.updatedAt].sort().at(-1)!
  const next: RealResumeRecord = {
    ...record, updatedAt, resume: { ...record.resume, status: 'cancelled' }, cancelledAt: updatedAt,
  }
  for (const field of ['lease', 'attemptId', 'nextAttemptAt', 'completedAt', 'error'] as const) delete next[field]
  return next
}

export function checkResumeReplacement(
  current: VersionedResumeEntity | undefined, record: ResumeEntity, etag: string, lifecycle = false,
): void {
  if (!current) throw new StoreNotFoundError('The resume record was not found.')
  if (current.etag !== etag) throw new StoreConflictError('The resume record changed.')
  const previous = current.record
  if (previous.recordType !== record.recordType || previous.id !== record.id ||
    previous.workspaceId !== record.workspaceId || previous.createdAt !== record.createdAt ||
    previous.createdBy !== record.createdBy || previous.batchId !== record.batchId) {
    throw new Error('Resume identity, ownership, batch, and creation metadata are immutable.')
  }
  if (record.updatedAt < previous.updatedAt) throw new Error('Resume update timestamps cannot move backwards.')
  if (previous.recordType === 'resume-batch' && record.recordType === 'resume-batch') {
    const retained = previous.items.filter(item => record.items.some(next => same(item, next)))
    if (previous.inputCount !== record.inputCount || (lifecycle
      ? !same(retained, record.items) ||
        (record.removedCount ?? 0) !== (previous.removedCount ?? 0) + previous.items.length - retained.length
      : previous.removedCount !== record.removedCount || previous.items.length > record.items.length ||
        previous.items.some((item, index) => !same(item, record.items[index])))) {
      throw new Error('Batch declarations and admissions are immutable except for fenced lifecycle removal.')
    }
    return
  }
  if (previous.recordType !== 'resume' || record.recordType !== 'resume') return
  if (lifecycle) {
    const expected = record.resume.status === 'cancelled' ? cancelResumeWork(previous, record.updatedAt) : previous
    if (!same({ ...expected, updatedAt: record.updatedAt, lifecycle: record.lifecycle }, record)) {
      throw new Error('Resume lifecycle changes cannot modify captured input, evidence, profile, or processing history.')
    }
    return
  }
  if (resumeIsLocked(previous.lifecycle) || !same(previous.lifecycle ?? {}, record.lifecycle ?? {})) denied()
  const metadataOnly = same({ ...previous, displayName: record.displayName, updatedAt: record.updatedAt }, record)
  if (metadataOnly) return
  if (previous.displayName !== record.displayName) {
    throw new Error('Display-name edits cannot change resume sources, profile, evidence, lifecycle, or processing state.')
  }
  if (previous.idempotencyKey !== record.idempotencyKey || previous.inputFingerprint !== record.inputFingerprint ||
    !same(previous.source, record.source) || previous.resume.documentId !== record.resume.documentId ||
    previous.resume.documentVersion !== record.resume.documentVersion) throw new Error('Captured resume input is immutable.')
  for (const field of ['capture', 'captureManifest', 'extraction', 'profileBlob'] as const) {
    if (previous[field] !== undefined && (record[field] === undefined || !same(previous[field], record[field]))) {
      throw new Error('Captured originals, manifests, extractions, and profiles must be preserved unchanged.')
    }
  }
  if (previous.profileBlob && (['name', 'role', 'location', 'experience'] as const).some(
    field => previous.resume[field] !== record.resume[field],
  )) throw new Error('Captured profile display metadata is immutable.')
  if (previous.resume.status === 'ready' && !same(previous, record)) throw new Error('Completed resume records are immutable.')
  const manualRetry = ['error', 'cancelled'].includes(previous.resume.status) && record.resume.status === 'queued'
  if (manualRetry) {
    if (record.retryCount !== previous.retryCount + 1 || record.attempts !== 0 || record.attemptId || record.lease ||
      record.completedAt || record.cancelledAt || record.error || !record.nextAttemptAt) {
      throw new Error('A manual retry must start a new bounded attempt cycle without discarding captured evidence.')
    }
  } else {
    if (record.retryCount !== previous.retryCount || record.attempts < previous.attempts ||
      record.attempts > previous.attempts + 1) throw new Error('Resume attempts or retry cycle changed unexpectedly.')
    if (['error', 'cancelled'].includes(previous.resume.status) && !same(previous, record)) {
      throw new Error('Failed or cancelled resumes are immutable until an explicit retry cycle.')
    }
  }
  if (record.lease && previous.attemptId !== record.attemptId) {
    if (record.attempts !== previous.attempts + 1 ||
      (previous.lease && record.lease.heartbeatAt < previous.lease.expiresAt)) {
      throw new StoreConflictError('An unexpired resume lease cannot be taken over.')
    }
  } else if (previous.lease && record.lease && (record.lease.owner !== previous.lease.owner ||
    record.lease.heartbeatAt < previous.lease.heartbeatAt || record.lease.expiresAt < previous.lease.expiresAt)) {
    throw new Error('A live resume attempt must retain and extend its own lease.')
  }
}

export async function prepareResumeTransaction(
  store: Pick<ResumeStore, 'get' | 'getControl'>, workspaceId: string,
  input: ResumeTransaction[], options: ResumeTransactionOptions = {},
): Promise<NonNullable<ResumeTransactionOptions['controls']>> {
  assertWorkspaceMutationLease(workspaceId)
  const controls = new Map<string, NonNullable<ResumeTransactionOptions['controls']>[number]>()
  const requested = new Map((options.controls ?? []).map(value => [value.record.id, value]))
  if (requested.size !== (options.controls ?? []).length) throw new Error('Duplicate resume lifecycle controls.')
  const control = async (resumeId?: string) => {
    const id = resumeControlId(resumeId)
    if (controls.has(id)) return controls.get(id)!
    const current = await store.getControl(workspaceId, resumeId)
    if (!options.lifecycle && current && current.record.state !== 'active') denied()
    const next = requested.get(id)
    if (next && (next.record.workspaceId !== workspaceId || next.record.resumeId !== resumeId || next.etag !== current?.etag)) denied()
    if (next && !options.lifecycle && next.record.state !== 'active') denied()
    if (next && current && ((current.record.state === 'deleted' && next.record.state !== 'deleted') ||
      (current.record.state === 'deleting' && !['deleting', 'deleted'].includes(next.record.state)))) denied()
    const value = next ?? current ?? { record: {
      id, recordType: 'resume-lifecycle' as const, workspaceId, ...(resumeId ? { resumeId } : {}),
      state: 'active' as const, updatedAt: new Date().toISOString(),
    } }
    controls.set(id, { ...value, record: parseResumeControl(value.record) })
    return controls.get(id)!
  }
  const workspace = await control()
  for (const value of requested.values()) if (value.record.resumeId) await control(value.record.resumeId)
  for (const operation of input) {
    const previous = await store.get(workspaceId, operation.record.id)
    if (operation.kind === 'replace') checkResumeReplacement(previous, operation.record, operation.etag, options.lifecycle)
    if (options.lifecycle && operation.kind === 'create') throw new Error('Lifecycle cleanup cannot create resume content.')
    if (operation.kind === 'delete' && !options.lifecycle) denied()
    if (operation.record.recordType === 'resume') {
      const record = operation.record
      const guard = await control(record.id)
      if (!options.lifecycle) {
        if (resumeIsLocked(record.lifecycle) ||
          (previous?.record.recordType === 'resume' && resumeIsLocked(previous.record.lifecycle))) denied()
        if (guard.record.preparation && (Date.parse(guard.record.preparation.expiresAt) <= Date.now() ||
          guard.record.preparation.inputFingerprint !== record.inputFingerprint)) denied()
        if (operation.kind === 'create') delete guard.record.preparation
      } else if (operation.kind === 'delete') {
        if (!['deleting', 'deleted'].includes(workspace.record.state) &&
          !['deleting', 'deleted'].includes(guard.record.state)) denied()
      } else {
        const state = record.lifecycle?.deletedAt ? 'deleted' : record.lifecycle?.deletingAt ? 'deleting'
          : record.lifecycle?.archivedAt ? 'archived' : 'active'
        if (['deleting', 'deleted'].includes(guard.record.state) && !['deleting', 'deleted'].includes(state)) denied()
        guard.record = { ...guard.record, state: guard.record.state === 'deleted' && state === 'deleting' ? 'deleted' : state,
          updatedAt: record.updatedAt }
      }
    } else if (operation.kind === 'delete') {
      if (!['deleting', 'deleted'].includes(workspace.record.state)) denied()
    } else {
      const batch = operation.record
      const oldItems = previous?.record.recordType === 'resume-batch' ? previous.record.items : []
      const items = options.lifecycle ? oldItems.filter(item => !batch.items.some(next => same(item, next)))
        : batch.items.filter(item => !oldItems.some(old => same(old, item)))
      for (const item of items) {
        const guard = await control(item.resumeId)
        if (options.lifecycle && !['deleting', 'deleted'].includes(workspace.record.state) &&
          !['deleting', 'deleted'].includes(guard.record.state)) denied()
      }
    }
  }
  if ([...requested.keys()].some(id => !controls.has(id))) throw new Error('Invalid resume lifecycle control scope.')
  assertWorkspaceMutationLease(workspaceId)
  return [...controls.values()]
}

export async function assertResumeWritable(store: ResumeStore, workspaceId: string, resumeId?: string): Promise<void> {
  assertWorkspaceMutationLease(workspaceId)
  const workspace = await store.getControl(workspaceId)
  if (workspace && workspace.record.state !== 'active') denied()
  if (resumeId) {
    const [control, current] = await Promise.all([store.getControl(workspaceId, resumeId), store.get(workspaceId, resumeId)])
    if ((control && control.record.state !== 'active') ||
      (!current && control?.record.preparation && Date.parse(control.record.preparation.expiresAt) <= Date.now()) ||
      (current?.record.recordType === 'resume' && resumeIsLocked(current.record.lifecycle))) denied()
  }
  assertWorkspaceMutationLease(workspaceId)
}

export async function updateResumeControl(
  store: ResumeStore, workspaceId: string, resumeId: string | undefined,
  update: (control: ResumeLifecycleControl) => ResumeLifecycleControl, lifecycle = true,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await store.getControl(workspaceId, resumeId)
    const record = parseResumeControl(update(current?.record ?? {
      id: resumeControlId(resumeId), recordType: 'resume-lifecycle', workspaceId, ...(resumeId ? { resumeId } : {}),
      state: 'active', updatedAt: new Date().toISOString(),
    }))
    try {
      assertWorkspaceMutationLease(workspaceId)
      await store.transact(workspaceId, [], { lifecycle, controls: [{ record, etag: current?.etag }] })
      return
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= 15) throw error
    }
  }
}

export async function prepareResumeImport(store: ResumeStore, workspaceId: string, resumeId: string, inputFingerprint: string): Promise<void> {
  await assertResumeWritable(store, workspaceId, resumeId)
  await updateResumeControl(store, workspaceId, resumeId, control => {
    if (control.preparation && (control.preparation.inputFingerprint !== inputFingerprint ||
      Date.parse(control.preparation.expiresAt) <= Date.now())) denied()
    return { ...control, preparation: control.preparation ?? {
      inputFingerprint, expiresAt: new Date(Date.now() + RESUME_PREPARATION_RETENTION_MS).toISOString(),
    } }
  }, false)
}

export async function putResumeBlob(
  store: ResumeStore, blobs: ResumeBlobStore, name: string, bytes: Uint8Array, contentType: string,
  options: { signal?: AbortSignal; assertActive?: () => Promise<unknown> } = {},
) {
  const [workspaceId, resumeId] = name.split('/')
  if (!isBlobInResumePrefix(name, workspaceId, resumeId)) throw new Error('Invalid resume Blob ownership.')
  const writer = { id: randomUUID(), workspaceId, resumeId, blobName: name,
    expiresAt: new Date(Date.now() + RESUME_WRITER_LEASE_MS).toISOString() }
  const check = async () => {
    options.signal?.throwIfAborted()
    await assertResumeWritable(store, workspaceId, resumeId)
    await options.assertActive?.()
    assertWorkspaceMutationLease(workspaceId)
  }
  await check()
  await updateResumeControl(store, workspaceId, resumeId, control => ({
    ...control, writers: {
      ...Object.fromEntries(Object.entries(control.writers ?? {}).filter(([, value]) => Date.parse(value.expiresAt) > Date.now())),
      [writer.id]: { blobName: name, expiresAt: writer.expiresAt },
    },
  }), false)
  // Uncertain writes keep their reservation. Cleanup must drain the finite content lease first.
  const result = await blobs.putFenced(name, bytes, contentType, {
    writer, signal: options.signal,
    assertActive: async () => {
      await check()
      const control = await store.getControl(workspaceId, resumeId)
      const saved = control?.record.writers?.[writer.id]
      if (Date.parse(writer.expiresAt) <= Date.now() || saved?.blobName !== name || saved.expiresAt !== writer.expiresAt) denied()
      assertWorkspaceMutationLease(workspaceId)
    },
  })
  await check()
  await updateResumeControl(store, workspaceId, resumeId, control => {
    const writers = { ...control.writers }
    delete writers[writer.id]
    return { ...control, writers }
  })
  return result
}
