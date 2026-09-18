import { randomUUID } from 'node:crypto'
import { gradeHeadId, type GradeEntity, type GradeHeadRecord, type VersionedGradeEntity } from '../../src/domain/real-grades'
import type { LifecycleMetadata } from '../../src/domain/lifecycle'
import { StoreConflictError } from '../store'
import type {
  GradeBlobStore, GradeLifecycleControl, GradeStore, GradeTransaction, GradeTransactionOptions,
} from './store'
import { blobInGrade, gradeContentHash, isGradeId } from './validation'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'

export const GRADE_UPLOAD_TIMEOUT_MS = 60_000
export const GRADE_WRITER_LEASE_MS = 120_000
export const GRADE_PREPARATION_RETENTION_MS = 24 * 60 * 60_000

export function gradeControlId(ladderId?: string): string {
  return ladderId ? `grade-lifecycle-${ladderId}` : 'grade-lifecycle-workspace'
}

export function gradeIsLocked(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.archivedAt || lifecycle?.deletingAt || lifecycle?.deletedAt)
}

export function gradeIsRemoved(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.deletingAt || lifecycle?.deletedAt)
}

export function parseGradeControl(value: unknown): GradeLifecycleControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid grade lifecycle control.')
  const control = value as GradeLifecycleControl
  if (Object.keys(control).some(key => !['id', 'recordType', 'workspaceId', 'ladderId', 'state', 'updatedAt', 'writers', 'pending', 'preparation'].includes(key)) ||
    !WORKSPACE_ID_PATTERN.test(control.workspaceId) || control.recordType !== 'grade-lifecycle' ||
    (control.ladderId !== undefined && !isGradeId(control.ladderId, 'ladder')) ||
    control.id !== gradeControlId(control.ladderId) || !['active', 'archived', 'deleting', 'deleted'].includes(control.state) ||
    !Number.isFinite(Date.parse(control.updatedAt))) throw new Error('Invalid grade lifecycle control.')
  if (control.writers !== undefined && (!control.ladderId || !control.writers || typeof control.writers !== 'object' ||
    Array.isArray(control.writers) || Object.keys(control.writers).length > 100 ||
    Object.entries(control.writers).some(([id, writer]) => !isGradeId(`grade-work-${id}`, 'grade-work') ||
      !writer || typeof writer !== 'object' || Object.keys(writer).some(key => key !== 'expiresAt') ||
      !Number.isFinite(Date.parse(writer.expiresAt))))) throw new Error('Invalid grade upload reservations.')
  if (control.pending !== undefined && (!control.ladderId || !Array.isArray(control.pending) || control.pending.length > 16 ||
    control.pending.some(operation => !operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).some(key => !['action', 'grade', 'updatedAt'].includes(key)) ||
      !['archive', 'unarchive', 'delete'].includes(operation.action) ||
      (operation.grade !== undefined && (!Number.isInteger(operation.grade) || operation.grade < 1 || operation.grade > 15)) ||
      typeof operation.updatedAt !== 'string' || !Number.isFinite(Date.parse(operation.updatedAt))) ||
    new Set(control.pending.map(operation => operation.grade ?? 0)).size !== control.pending.length)) {
    throw new Error('Invalid pending grade lifecycle operations.')
  }
  if (control.preparation !== undefined && (!control.ladderId || !control.preparation || typeof control.preparation !== 'object' ||
    Array.isArray(control.preparation) || Object.keys(control.preparation).some(key => !['inputFingerprint', 'expiresAt'].includes(key)) ||
    typeof control.preparation.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(control.preparation.inputFingerprint) ||
    typeof control.preparation.expiresAt !== 'string' || !Number.isFinite(Date.parse(control.preparation.expiresAt)))) {
    throw new Error('Invalid unpublished grade preparation.')
  }
  const result = structuredClone(control)
  if (!result.pending?.length) delete result.pending
  if (result.preparation === undefined) delete result.preparation
  return result
}

function family(record: GradeEntity): string {
  return record.recordType === 'grade-ladder' ? record.id : record.ladderId
}

function recordGrade(record: GradeEntity): number | undefined {
  return 'grade' in record ? record.grade : record.recordType === 'grade-work' && 'grade' in record.input ? record.input.grade : undefined
}

function denied(): never {
  throw new StoreConflictError('This grade workflow is archived, removed, or changed. Reload before starting new work.')
}

export async function prepareGradeTransaction(
  store: Pick<GradeStore, 'get' | 'getControl'>, workspaceId: string,
  input: GradeTransaction[], options: GradeTransactionOptions = {},
): Promise<{ operations: GradeTransaction[]; controls: NonNullable<GradeTransactionOptions['controls']> }> {
  assertWorkspaceMutationLease(workspaceId)
  const operations = new Map(input.map(operation => [operation.record.id, operation]))
  const reads = new Map<string, Promise<VersionedGradeEntity | undefined>>()
  const get = (id: string) => {
    if (!reads.has(id)) reads.set(id, store.get(workspaceId, id))
    return reads.get(id)!
  }
  const controls = new Map<string, NonNullable<GradeTransactionOptions['controls']>[number]>()
  const requested = new Map((options.controls ?? []).map(value => [value.record.id, value]))
  if (requested.size !== (options.controls ?? []).length) throw new Error('Duplicate grade lifecycle controls.')
  const control = async (ladderId?: string) => {
    const id = gradeControlId(ladderId)
    const current = await store.getControl(workspaceId, ladderId)
    if (!options.lifecycle && current && current.record.state !== 'active') denied()
    const next = requested.get(id)
    if (next && (next.record.workspaceId !== workspaceId || next.record.ladderId !== ladderId ||
      next.etag !== current?.etag)) denied()
    if (next && !options.lifecycle && next.record.state !== 'active') denied()
    if (next && !options.lifecycle && current?.record.preparation &&
      gradeContentHash(current.record.preparation) !== gradeContentHash(next.record.preparation ?? {})) denied()
    if (next && current && (
      (current.record.state === 'deleted' && next.record.state !== 'deleted') ||
      (current.record.state === 'deleting' && !['deleting', 'deleted'].includes(next.record.state))
    )) denied()
    const value = next ?? current ?? {
      record: { id, recordType: 'grade-lifecycle' as const, workspaceId, ...(ladderId ? { ladderId } : {}),
        state: 'active' as const, updatedAt: new Date().toISOString() },
    }
    controls.set(id, { ...value, record: parseGradeControl(value.record) })
    return controls.get(id)!
  }
  const workspace = await control()
  const families = new Set([
    ...input.map(operation => family(operation.record)),
    ...(options.controls ?? []).flatMap(value => value.record.ladderId ? [value.record.ladderId] : []),
  ])
  for (const ladderId of families) {
    const guard = await control(ladderId)
    const current = await get(ladderId)
    if (current && current.record.recordType !== 'grade-ladder') throw new Error('Invalid ladder guard identity.')
    if (!options.lifecycle && current?.record.recordType === 'grade-ladder' && gradeIsLocked(current.record.lifecycle)) denied()
    const ladderOperation = operations.get(ladderId)
    if (!options.lifecycle && !current && guard.record.preparation) {
      if (Date.parse(guard.record.preparation.expiresAt) <= Date.now()) denied()
      if (ladderOperation?.kind === 'create' && ladderOperation.record.recordType === 'grade-ladder') {
        if (ladderOperation.record.inputFingerprint !== guard.record.preparation.inputFingerprint) denied()
        delete guard.record.preparation
      }
    }
    if (options.lifecycle && ladderOperation?.kind !== 'delete' && ladderOperation?.record.recordType === 'grade-ladder' &&
      gradeContentHash(current?.record.recordType === 'grade-ladder' ? current.record.lifecycle ?? {} : {}) !==
        gradeContentHash(ladderOperation.record.lifecycle ?? {})) {
      const lifecycle = ladderOperation.record.lifecycle
      if (['deleting', 'deleted'].includes(guard.record.state) && !lifecycle?.deletingAt && !lifecycle?.deletedAt) denied()
      guard.record = { ...guard.record, updatedAt: ladderOperation.record.updatedAt,
        state: lifecycle?.deletedAt ? 'deleted' : lifecycle?.deletingAt ? 'deleting' : lifecycle?.archivedAt ? 'archived' : 'active' }
    }
    const grades = new Set(input.filter(value => family(value.record) === ladderId)
      .flatMap(value => recordGrade(value.record) === undefined ? [] : [recordGrade(value.record)!]))
    for (const grade of grades) {
      const id = gradeHeadId(ladderId, grade)
      const head = await get(id)
      if (head && head.record.recordType !== 'grade-head') throw new Error('Invalid grade-head guard identity.')
      const old = head?.record as GradeHeadRecord | undefined
      const change = operations.get(id)
      const next = change?.record.recordType === 'grade-head' && change.kind !== 'delete' ? change.record : old
      const revival = Boolean(options.reviveGrades?.includes(grade) && old?.lifecycle?.deletedAt &&
        !old.lifecycle.archivedAt && !old.lifecycle.deletingAt && next?.generationId &&
        next.generationId !== old.generationId && !gradeIsRemoved(next.lifecycle) &&
        !next.latestVersionId && !next.latestReviewId && !next.approvalId && !next.approvedVersionId)
      if (!options.lifecycle && gradeIsLocked(old?.lifecycle) && !revival) denied()
      for (const operation of input.filter(value => family(value.record) === ladderId && recordGrade(value.record) === grade)) {
        const record = operation.record
        if (operation.kind === 'delete' && workspace.record.state !== 'deleting' && workspace.record.state !== 'deleted' &&
          guard.record.state !== 'deleting' && guard.record.state !== 'deleted' && !old?.lifecycle?.deletingAt) denied()
        if (options.lifecycle) continue
        if (next && 'generationId' in record && record.recordType !== 'grade-head' && next.generationId !== record.generationId) denied()
        if (next && record.recordType === 'grade-work' && record.status !== 'cancelled' && 'generationId' in record.input &&
          next.generationId !== record.input.generationId) denied()
        if (next && (record.recordType === 'grade-review' || record.recordType === 'grade-approval')) {
          const version = operations.get(record.versionId)?.record ?? (await get(record.versionId))?.record
          if (!version || version.recordType !== 'grade-version' || version.generationId !== next.generationId) denied()
        }
        if (record.recordType === 'grade-head' &&
          gradeContentHash(old?.lifecycle ?? {}) !== gradeContentHash(record.lifecycle ?? {}) && !revival) denied()
      }
    }
    for (const operation of input.filter(value => family(value.record) === ladderId)) {
      if (options.lifecycle && operation.kind === 'create') throw new Error('Lifecycle cleanup cannot create grade content.')
      if (operation.kind === 'delete' && (!options.lifecycle ||
        (recordGrade(operation.record) === undefined && workspace.record.state !== 'deleting' && workspace.record.state !== 'deleted' &&
          guard.record.state !== 'deleting' && guard.record.state !== 'deleted'))) denied()
      if (!options.lifecycle && operation.record.recordType === 'grade-ladder' &&
        gradeContentHash(current?.record.recordType === 'grade-ladder' ? current.record.lifecycle ?? {} : {}) !==
          gradeContentHash(operation.record.lifecycle ?? {})) denied()
    }
  }
  if ([...requested.keys()].some(id => !controls.has(id))) throw new Error('Invalid grade lifecycle control scope.')
  return { operations: [...operations.values()], controls: [...controls.values()] }
}

export async function assertGradeWritable(store: GradeStore, workspaceId: string, ladderId?: string, grade?: number): Promise<void> {
  const workspace = await store.getControl(workspaceId)
  if (workspace && workspace.record.state !== 'active') denied()
  if (!ladderId) return
  const [control, ladder, head] = await Promise.all([
    store.getControl(workspaceId, ladderId), store.get(workspaceId, ladderId),
    grade === undefined ? undefined : store.get(workspaceId, gradeHeadId(ladderId, grade)),
  ])
  if ((control && control.record.state !== 'active') ||
    (!ladder && control?.record.preparation && Date.parse(control.record.preparation.expiresAt) <= Date.now()) ||
    (ladder?.record.recordType === 'grade-ladder' && gradeIsLocked(ladder.record.lifecycle)) ||
    (head?.record.recordType === 'grade-head' && gradeIsLocked(head.record.lifecycle))) denied()
}

export async function updateGradeControl(
  store: GradeStore, workspaceId: string, ladderId: string | undefined,
  update: (control: GradeLifecycleControl) => GradeLifecycleControl, lifecycle = true,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await store.getControl(workspaceId, ladderId)
    const record = update(current?.record ?? {
      id: gradeControlId(ladderId), workspaceId, recordType: 'grade-lifecycle',
      ...(ladderId ? { ladderId } : {}), state: 'active', updatedAt: new Date().toISOString(),
    })
    try {
      assertWorkspaceMutationLease(workspaceId)
      await store.transact(workspaceId, [], { lifecycle, controls: [{ record, etag: current?.etag }] })
      return
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= 7) throw error
    }
  }
}

export function guardedGradeBlobs(store: GradeStore, blobs: GradeBlobStore): GradeBlobStore {
  return {
    read: name => blobs.read(name),
    listFamilies: (workspaceId, token) => blobs.listFamilies(workspaceId, token),
    listPage: (workspaceId, ladderId, token) => blobs.listPage(workspaceId, ladderId, token),
    delete: name => blobs.delete(name),
    async putImmutable(name, bytes, contentType, options) {
      const [workspaceId, ladderId] = name.split('/')
      if (!blobInGrade(name, workspaceId, ladderId)) throw new Error('Invalid grade upload ownership.')
      const writerId = randomUUID()
      await updateGradeControl(store, workspaceId, ladderId, control => ({
        ...control, writers: {
          ...Object.fromEntries(Object.entries(control.writers ?? {}).filter(([, writer]) => Date.parse(writer.expiresAt) > Date.now())),
          [writerId]: { expiresAt: new Date(Date.now() + GRADE_WRITER_LEASE_MS).toISOString() },
        },
      }), false)
      const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(GRADE_UPLOAD_TIMEOUT_MS)])
        : AbortSignal.timeout(GRADE_UPLOAD_TIMEOUT_MS)
      let release = false
      try {
        const result = await blobs.putImmutable(name, bytes, contentType, { signal })
        // The reservation remains until a fenced upload is removed, so purge cannot finish early.
        try { await assertGradeWritable(store, workspaceId, ladderId) } catch (error) {
          if (result.created) await blobs.delete(name)
          release = true
          throw error
        }
        release = true
        return result
      } finally {
        if (release) {
          await updateGradeControl(store, workspaceId, ladderId, control => {
            const writers = { ...control.writers }
            delete writers[writerId]
            return { ...control, writers }
          })
        }
      }
    },
  }
}
