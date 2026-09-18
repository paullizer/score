import { gradeHeadId, type GradeEntity, type GradeHeadRecord, type VersionedGradeEntity } from '../../src/domain/real-grades'
import type { LifecycleAction, LifecycleImpact, LifecycleMetadata, LifecycleOperation } from '../../src/domain/lifecycle'
import type { LifecycleDependencies, WorkspaceLifecycleParticipant } from '../lifecycle/contracts'
import { conflict, notFound, unavailable } from '../errors'
import { StoreConflictError } from '../store'
import type { RealGradesDeps } from './service'
import type { GradeScopeOptions, GradeTransaction } from './store'
import { gradeControlId, gradeIsRemoved, updateGradeControl } from './guards'
import { blobInGrade, isGradeId } from './validation'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'

type Managed = Extract<GradeEntity, { recordType: 'grade-ladder' | 'grade-head' }>
export interface GradeLifecycleResult {
  deleted?: true
  pending?: true
  operation?: LifecycleOperation
  etag?: string
}

async function records(
  grades: RealGradesDeps, workspaceId: string, options: GradeScopeOptions,
  visit: (items: VersionedGradeEntity[]) => Promise<void>,
): Promise<void> {
  let continuationToken: string | undefined
  const tokens = new Set<string>()
  do {
    const page = await grades.store.listScope(workspaceId, { ...options, limit: 50, continuationToken })
    for (const { record } of page.items) {
      if (record.workspaceId !== workspaceId ||
        (options.ladderId && record.id !== options.ladderId && (!('ladderId' in record) || record.ladderId !== options.ladderId)) ||
        (options.grade !== undefined && ('grade' in record ? record.grade :
          record.recordType === 'grade-work' && 'grade' in record.input ? record.input.grade : undefined) !== options.grade)) {
        throw unavailable('Grade lifecycle query returned a record outside its scope.')
      }
    }
    await visit(page.items)
    continuationToken = page.continuationToken
    if (continuationToken && tokens.has(continuationToken)) throw unavailable('Grade lifecycle pagination did not advance.')
    if (continuationToken) tokens.add(continuationToken)
  } while (continuationToken)
}

async function save(grades: RealGradesDeps, workspaceId: string, operations: GradeTransaction[]): Promise<void> {
  let batch: GradeTransaction[] = []
  let bytes = 0
  for (const operation of operations) {
    const size = Buffer.byteLength(JSON.stringify(operation))
    if (batch.length && (batch.length >= 30 || bytes + size > 1_000_000)) {
      assertWorkspaceMutationLease(workspaceId)
      await grades.store.transact(workspaceId, batch, { lifecycle: true })
      batch = []
      bytes = 0
    }
    batch.push(operation)
    bytes += size
  }
  if (batch.length) {
    assertWorkspaceMutationLease(workspaceId)
    await grades.store.transact(workspaceId, batch, { lifecycle: true })
  }
}

async function cancelScope(grades: RealGradesDeps, workspaceId: string, timestamp: string, ladderId: string, grade?: number): Promise<void> {
  await records(grades, workspaceId, { ladderId, grade }, async items => {
    const operations: GradeTransaction[] = []
    for (const current of items) {
      const record = current.record
      if (record.recordType === 'grade-work' && ['queued', 'running'].includes(record.status)) {
        operations.push({ kind: 'replace', etag: current.etag,
          record: { ...record, status: 'cancelled', lease: undefined, nextAttemptAt: undefined, updatedAt: timestamp } })
      } else if (record.recordType === 'grade-head' && ['queued', 'processing'].includes(record.status)) {
        operations.push({ kind: 'replace', etag: current.etag, record: { ...record, status: 'cancelled', updatedAt: timestamp } })
      } else if (grade === undefined && record.recordType === 'grade-source' && ['queued', 'extracting'].includes(record.status)) {
        operations.push({ kind: 'replace', etag: current.etag, record: { ...record, status: 'cancelled', updatedAt: timestamp } })
      } else if (grade === undefined && record.recordType === 'grade-ladder' && ['discovering', 'generating'].includes(record.status)) {
        operations.push({ kind: 'replace', etag: current.etag, record: { ...record, status: 'cancelled', updatedAt: timestamp } })
      }
    }
    await save(grades, workspaceId, operations)
  })
}

async function blobFamilies(grades: RealGradesDeps, workspaceId: string): Promise<string[]> {
  const ids = new Set<string>()
  let token: string | undefined
  const tokens = new Set<string>()
  do {
    const page = await grades.blobs.listFamilies(workspaceId, token)
    for (const ladderId of page.ladderIds) {
      if (!isGradeId(ladderId, 'ladder')) throw unavailable('Grade preparation enumeration returned an invalid family.')
      ids.add(ladderId)
    }
    token = page.continuationToken
    if (token && tokens.has(token)) throw unavailable('Grade preparation enumeration did not advance.')
    if (token) tokens.add(token)
  } while (token)
  return [...ids]
}

async function artifactCount(grades: RealGradesDeps, workspaceId: string): Promise<number> {
  let count = 0
  for (const ladderId of await blobFamilies(grades, workspaceId)) {
    let token: string | undefined
    const tokens = new Set<string>()
    do {
      const page = await grades.blobs.listPage(workspaceId, ladderId, token)
      if (page.names.some(name => !blobInGrade(name, workspaceId, ladderId))) {
        throw unavailable('Grade artifact inventory crossed its ownership boundary.')
      }
      count += page.names.length
      token = page.continuationToken
      if (token && tokens.has(token)) throw unavailable('Grade artifact inventory did not advance.')
      if (token) tokens.add(token)
    } while (token)
  }
  return count
}

async function families(grades: RealGradesDeps, workspaceId: string): Promise<string[]> {
  const ids = new Set<string>()
  await records(grades, workspaceId, {}, async items => {
    for (const { record } of items) ids.add(record.recordType === 'grade-ladder' ? record.id : record.ladderId)
  })
  let token: string | undefined
  const tokens = new Set<string>()
  do {
    const page = await grades.store.listControls(workspaceId, token)
    for (const { record } of page.items) {
      if (record.workspaceId !== workspaceId) throw unavailable('Grade lifecycle control has invalid ownership.')
      if (record.ladderId) ids.add(record.ladderId)
    }
    token = page.continuationToken
    if (token && tokens.has(token)) throw unavailable('Grade lifecycle control pagination did not advance.')
    if (token) tokens.add(token)
  } while (token)
  for (const ladderId of await blobFamilies(grades, workspaceId)) ids.add(ladderId)
  return [...ids]
}

async function purgeRecords(grades: RealGradesDeps, workspaceId: string, ladderId: string, grade?: number): Promise<void> {
  // Restart a bounded page after each delete; continuation offsets are not stable while rows disappear.
  let continuationToken: string | undefined
  const tokens = new Set<string>()
  for (;;) {
    const page = await grades.store.listScope(workspaceId, { ladderId, grade, limit: 50, continuationToken })
    const owned = page.items.filter(value => value.record.recordType !== 'grade-ladder' &&
      (grade === undefined || value.record.recordType !== 'grade-head'))
    if (!owned.length) {
      continuationToken = page.continuationToken
      if (!continuationToken) return
      if (tokens.has(continuationToken)) throw unavailable('Grade cleanup did not advance.')
      tokens.add(continuationToken)
      continue
    }
    for (const { record } of owned) {
      if (record.workspaceId !== workspaceId || !('ladderId' in record) || record.ladderId !== ladderId ||
        (grade !== undefined && !(
          ('grade' in record && record.grade === grade) ||
          (record.recordType === 'grade-work' && 'grade' in record.input && record.input.grade === grade)
        ))) throw unavailable('Grade cleanup attempted to remove unrelated records.')
    }
    await save(grades, workspaceId, owned.map(value => ({ kind: 'delete', ...value })))
    continuationToken = undefined
    tokens.clear()
  }
}

async function purgeBlobs(grades: RealGradesDeps, workspaceId: string, ladderId: string): Promise<boolean> {
  const control = await grades.store.getControl(workspaceId, ladderId)
  if (Object.values(control?.record.writers ?? {}).some(writer => Date.parse(writer.expiresAt) > Date.now())) return false
  // Deletion can shift page offsets; require an exhausted, entirely empty verification sweep.
  for (let sweep = 0; sweep < 100; sweep++) {
    let continuationToken: string | undefined
    const tokens = new Set<string>()
    let removed = 0
    do {
      const page = await grades.blobs.listPage(workspaceId, ladderId, continuationToken)
      for (const name of page.names) {
        if (!blobInGrade(name, workspaceId, ladderId)) throw unavailable('Grade blob cleanup crossed its ownership boundary.')
        await grades.blobs.delete(name)
        removed++
      }
      continuationToken = page.continuationToken
      if (continuationToken && tokens.has(continuationToken)) throw unavailable('Grade blob cleanup did not advance.')
      if (continuationToken) tokens.add(continuationToken)
    } while (continuationToken)
    if (!removed) return true
  }
  throw unavailable('Grade blob cleanup could not verify an empty family.')
}

async function purgeFamily(grades: RealGradesDeps, workspaceId: string, ladderId: string, timestamp: string): Promise<boolean> {
  await updateGradeControl(grades.store, workspaceId, ladderId, control => ({
    ...control, state: control.state === 'deleted' ? 'deleted' : 'deleting', updatedAt: timestamp,
  }))
  await cancelScope(grades, workspaceId, timestamp, ladderId)
  await purgeRecords(grades, workspaceId, ladderId)
  if (!await purgeBlobs(grades, workspaceId, ladderId)) return false
  const root = await grades.store.get(workspaceId, ladderId)
  if (root && root.record.recordType !== 'grade-ladder') throw unavailable('Invalid ladder cleanup identity.')
  await records(grades, workspaceId, { ladderId }, async items => {
    if (items.some(value => value.record.id !== ladderId)) throw unavailable('Grade records remain after family cleanup.')
  })
  const control = await grades.store.getControl(workspaceId, ladderId)
  if (!control) throw unavailable('The family deletion fence is missing.')
  assertWorkspaceMutationLease(workspaceId)
  await grades.store.transact(workspaceId, root ? [{ kind: 'delete', ...root }] : [], {
    lifecycle: true, controls: [{ etag: control.etag,
      record: { ...control.record, state: 'deleted', updatedAt: timestamp, writers: undefined, pending: undefined, preparation: undefined } }],
  })
  return true
}

export async function discardGradePreparation(
  grades: RealGradesDeps, workspaceId: string, ladderId: string, timestamp: string,
): Promise<boolean> {
  // Read the family CAS before proving absence; concurrent publication changes this same control.
  const control = await grades.store.getControl(workspaceId, ladderId)
  if (await grades.store.get(workspaceId, ladderId)) throw conflict('A published ladder cannot be discarded as an unpublished preparation.')
  assertWorkspaceMutationLease(workspaceId)
  await grades.store.transact(workspaceId, [], {
    lifecycle: true, controls: [{
      etag: control?.etag,
      record: {
        ...(control?.record ?? {
          id: gradeControlId(ladderId), recordType: 'grade-lifecycle', workspaceId, ladderId,
        }),
        state: control?.record.state === 'deleted' ? 'deleted' : 'deleting', updatedAt: timestamp,
      },
    }],
  })
  return purgeFamily(grades, workspaceId, ladderId, timestamp)
}

async function managed(grades: RealGradesDeps, workspaceId: string, ladderId: string, grade?: number): Promise<VersionedGradeEntity<Managed>> {
  const root = await grades.store.get(workspaceId, ladderId)
  if (!root || root.record.recordType !== 'grade-ladder' || root.record.workspaceId !== workspaceId) {
    throw notFound('The requested grade ladder was not found.')
  }
  if (grade === undefined) return root as VersionedGradeEntity<Managed>
  const head = await grades.store.get(workspaceId, gradeHeadId(ladderId, grade))
  if (!head || head.record.recordType !== 'grade-head' || head.record.workspaceId !== workspaceId ||
    head.record.ladderId !== ladderId || head.record.grade !== grade) throw notFound('The requested grade rubric was not found.')
  return head as VersionedGradeEntity<Managed>
}

async function saveLifecycleTarget(
  grades: RealGradesDeps, current: VersionedGradeEntity<Managed>, record: Managed, action?: LifecycleAction,
): Promise<void> {
  const workspaceId = record.workspaceId
  const ladderId = record.recordType === 'grade-ladder' ? record.id : record.ladderId
  const grade = record.recordType === 'grade-head' ? record.grade : undefined
  const control = await grades.store.getControl(workspaceId, ladderId)
  const pending = (control?.record.pending ?? []).filter(operation => operation.grade !== grade)
  if (action) pending.push({ action, ...(grade !== undefined ? { grade } : {}), updatedAt: record.updatedAt })
  assertWorkspaceMutationLease(workspaceId)
  await grades.store.transact(workspaceId, [{ kind: 'replace', etag: current.etag, record }], {
    lifecycle: true, controls: [{
      etag: control?.etag,
      record: {
        ...(control?.record ?? {
          id: gradeControlId(ladderId), recordType: 'grade-lifecycle', workspaceId, ladderId, state: 'active',
        }),
        updatedAt: record.updatedAt, pending: pending.length ? pending : undefined,
      },
    }],
  })
}

async function purgeGrade(grades: RealGradesDeps, workspaceId: string, ladderId: string, grade: number, timestamp: string): Promise<void> {
  await cancelScope(grades, workspaceId, timestamp, ladderId, grade)
  await purgeRecords(grades, workspaceId, ladderId, grade)
  const latest = await managed(grades, workspaceId, ladderId, grade)
  const head: GradeHeadRecord = {
    id: latest.record.id, workspaceId, recordType: 'grade-head', ladderId, grade, status: 'draft',
    createdAt: latest.record.createdAt, updatedAt: timestamp, issues: [],
    lifecycle: { ...(latest.record.lifecycle?.archivedAt ? { archivedAt: latest.record.lifecycle.archivedAt } : {}),
      deletedAt: timestamp },
  }
  await saveLifecycleTarget(grades, latest, head)
}

async function finishArchive(
  grades: RealGradesDeps, workspaceId: string, ladderId: string, grade: number | undefined,
  action: 'archive' | 'unarchive', timestamp: string,
): Promise<void> {
  const current = await managed(grades, workspaceId, ladderId, grade)
  if (current.record.lifecycle?.deletingAt) throw conflict('A deleting grade target cannot change archive state.')
  if (current.record.lifecycle?.archivedAt) await cancelScope(grades, workspaceId, timestamp, ladderId, grade)
  const latest = await managed(grades, workspaceId, ladderId, grade)
  const lifecycle = { ...latest.record.lifecycle }
  if (action === 'unarchive') delete lifecycle.archivedAt
  await saveLifecycleTarget(grades, latest, { ...latest.record, lifecycle, updatedAt: timestamp })
}

async function resumeWorkspace(grades: RealGradesDeps, workspaceId: string, timestamp: string): Promise<void> {
  const pending = new Map<string, { family: boolean; preparation: boolean; operations: Map<number, LifecycleAction> }>()
  const family = (ladderId: string) => {
    if (!pending.has(ladderId)) pending.set(ladderId, { family: false, preparation: false, operations: new Map() })
    return pending.get(ladderId)!
  }
  let token: string | undefined
  const tokens = new Set<string>()
  do {
    const page = await grades.store.listControls(workspaceId, token)
    for (const { record } of page.items) {
      if (record.workspaceId !== workspaceId) throw unavailable('Grade recovery returned a foreign workspace.')
      if (!record.ladderId) continue
      const scope = family(record.ladderId)
      if (record.state === 'deleting') scope.family = true
      if (record.preparation && record.preparation.expiresAt <= timestamp) scope.preparation = true
      for (const operation of record.pending ?? []) {
        if (operation.action === 'delete' && operation.grade === undefined) scope.family = true
        else scope.operations.set(operation.grade ?? 0, operation.action)
      }
    }
    token = page.continuationToken
    if (token && tokens.has(token)) throw unavailable('Grade recovery pagination did not advance.')
    if (token) tokens.add(token)
  } while (token)
  await records(grades, workspaceId, {}, async items => {
    for (const { record } of items) {
      if (record.recordType === 'grade-ladder' && record.lifecycle?.deletingAt) family(record.id).family = true
      if (record.recordType === 'grade-head' && record.lifecycle?.deletingAt) {
        family(record.ladderId).operations.set(record.grade, 'delete')
      }
    }
  })
  for (const [ladderId, scope] of pending) {
    if (scope.family) {
      if (!await purgeFamily(grades, workspaceId, ladderId, timestamp)) throw unavailable('Grade uploads are still draining.')
      continue
    }
    if (scope.preparation) {
      const published = await grades.store.get(workspaceId, ladderId)
      if (published) {
        await updateGradeControl(grades.store, workspaceId, ladderId, control => ({ ...control, preparation: undefined }))
      } else {
        if (!await discardGradePreparation(grades, workspaceId, ladderId, timestamp)) throw unavailable('Grade preparation uploads are still draining.')
        continue
      }
    }
    for (const [value, action] of scope.operations) {
      const grade = value || undefined
      if (action === 'delete' && grade !== undefined) {
        const current = await managed(grades, workspaceId, ladderId, grade)
        if (current.record.lifecycle?.deletingAt) await purgeGrade(grades, workspaceId, ladderId, grade, timestamp)
        else await saveLifecycleTarget(grades, current, current.record)
      } else if (action === 'archive' || action === 'unarchive') {
        await finishArchive(grades, workspaceId, ladderId, grade, action, timestamp)
      }
    }
  }
}

export class GradeLifecycleService {
  constructor(private readonly grades: RealGradesDeps, private readonly dependencies?: LifecycleDependencies,
    private readonly now: () => Date = () => new Date()) {}

  async etag(workspaceId: string, ladderId: string, grade?: number): Promise<string> {
    return (await managed(this.grades, workspaceId, ladderId, grade)).etag
  }

  async impact(workspaceId: string, ladderId: string, grade?: number): Promise<LifecycleImpact> {
    const current = await managed(this.grades, workspaceId, ladderId, grade)
    const target = { kind: grade === undefined ? 'ladder' as const : 'rubric' as const, id: current.record.id }
    const counts: Record<string, number> = {}
    await records(this.grades, workspaceId, { ladderId, grade }, async items => {
      for (const { record } of items) {
        if (record.recordType === 'grade-head' && gradeIsRemoved(record.lifecycle)) continue
        counts[record.recordType] = (counts[record.recordType] ?? 0) + 1
      }
    })
    const root = current.record.recordType === 'grade-ladder' ? current.record : (await managed(this.grades, workspaceId, ladderId)).record
    return { target, name: 'name' in root ? grade === undefined ? root.name : `${root.name} · GS-${grade}` : `GS-${grade}`,
      counts, blockers: this.dependencies ? await this.dependencies.impact(workspaceId, target) : [] }
  }

  async change(workspaceId: string, ladderId: string, action: LifecycleAction, etag: string, grade?: number): Promise<GradeLifecycleResult> {
    const current = await managed(this.grades, workspaceId, ladderId, grade)
    if (!etag.trim() || etag === '*' || etag.includes(',') || current.etag !== etag) throw conflict('This lifecycle target changed. Reload its current ETag.')
    if (action !== 'delete' && current.record.lifecycle?.deletingAt) throw conflict('Finish permanent deletion before changing this item.')
    if (action === 'delete') {
      if (!this.dependencies) throw unavailable('Grade deletion requires the workspace dependency coordinator.')
      const impact = await this.impact(workspaceId, ladderId, grade)
      if (impact.blockers.length) throw conflict('Retained analyses reference this ladder or rubric. Delete the blocking analyses first.')
    }
    const timestamp = this.now().toISOString()
    const operation: LifecycleOperation = { id: current.record.id, action, status: 'running', updatedAt: timestamp }
    let fenced = Boolean(current.record.lifecycle?.archivedAt || current.record.lifecycle?.deletingAt)
    try {
      if (action === 'unarchive') {
        if (!current.record.lifecycle?.archivedAt) return {}
        await saveLifecycleTarget(this.grades, current, { ...current.record, updatedAt: timestamp }, action)
        await finishArchive(this.grades, workspaceId, ladderId, grade, action, timestamp)
        return {}
      }
      const lifecycle: LifecycleMetadata = { ...current.record.lifecycle,
        ...(action === 'archive' ? { archivedAt: current.record.lifecycle?.archivedAt ?? timestamp }
          : { deletingAt: current.record.lifecycle?.deletingAt ?? timestamp }) }
      await saveLifecycleTarget(this.grades, current, { ...current.record, lifecycle, updatedAt: timestamp }, action)
      fenced = true
      if (action === 'archive') {
        await finishArchive(this.grades, workspaceId, ladderId, grade, action, timestamp)
        return {}
      }
      if (grade === undefined) {
        if (!await purgeFamily(this.grades, workspaceId, ladderId, timestamp)) {
          const latest = await managed(this.grades, workspaceId, ladderId)
          return { pending: true, etag: latest.etag, operation: { ...operation, status: 'pending' } }
        }
        return { deleted: true }
      }
      await purgeGrade(this.grades, workspaceId, ladderId, grade, timestamp)
      return {}
    } catch (error) {
      const latest = await this.grades.store.get(workspaceId, current.record.id)
      if (action === 'delete' && grade === undefined && !latest &&
        (await this.grades.store.getControl(workspaceId, ladderId))?.record.state === 'deleted') return { deleted: true }
      if (latest?.record.recordType === current.record.recordType && 'lifecycle' in latest.record &&
        (latest.record.lifecycle?.deletingAt || latest.record.lifecycle?.archivedAt)) fenced = true
      if (!fenced) {
        if (error instanceof StoreConflictError) throw conflict('The grade workflow changed before its lifecycle transition.')
        throw error
      }
      console.error('Grade lifecycle operation incomplete:', {
        workspaceId, ladderId, grade, action, name: error instanceof Error ? error.name : 'UnknownError',
      })
      return { pending: true, ...(latest ? { etag: latest.etag } : {}),
        operation: { ...operation, status: 'failed', error: 'Cleanup is incomplete. Retry this lifecycle action; the item remains fenced.' } }
    }
  }
}

export function createGradeLifecycleParticipant(grades: RealGradesDeps): WorkspaceLifecycleParticipant {
  return {
    pendingWorkspaces: limit => grades.store.pendingLifecycleWorkspaces(limit),
    resume: (workspaceId, timestamp) => resumeWorkspace(grades, workspaceId, timestamp),
    async setState(workspaceId, state, timestamp) {
      const current = await grades.store.getControl(workspaceId)
      if (current && ['deleting', 'deleted'].includes(current.record.state) && !['deleting', 'deleted'].includes(state)) {
        throw conflict('A deleting workspace cannot reactivate its grade data.')
      }
      if (state === 'active' && current?.record.state === 'archived') {
        for (const ladderId of await families(grades, workspaceId)) await cancelScope(grades, workspaceId, timestamp, ladderId)
      }
      await updateGradeControl(grades.store, workspaceId, undefined, control => ({
        ...control, state: control.state === 'deleted' && state === 'deleting' ? 'deleted' : state, updatedAt: timestamp,
      }))
    },
    async cancel(workspaceId, timestamp) {
      const control = await grades.store.getControl(workspaceId)
      if (!control || control.record.state === 'active') throw conflict('Fence the grade workspace before cancelling its work.')
      for (const ladderId of await families(grades, workspaceId)) await cancelScope(grades, workspaceId, timestamp, ladderId)
    },
    async purge(workspaceId, timestamp) {
      const control = await grades.store.getControl(workspaceId)
      if (!control || !['deleting', 'deleted'].includes(control.record.state)) throw conflict('Fence the grade workspace before purging it.')
      for (const ladderId of await families(grades, workspaceId)) {
        if (!await purgeFamily(grades, workspaceId, ladderId, timestamp)) throw unavailable('Grade uploads are still draining. Retry workspace deletion.')
      }
    },
    async counts(workspaceId) {
      const counts: Record<string, number> = { ladders: 0, rubrics: 0, rubricVersions: 0, sourceArtifacts: 0 }
      const rubricGroups = new Set<string>()
      const keys: Record<GradeEntity['recordType'], string> = {
        'grade-ladder': 'ladders', 'grade-head': 'gradeSlots', 'grade-version': 'rubricVersions',
        'grade-review': 'reviews', 'grade-approval': 'approvals', 'grade-work': 'workItems',
        'grade-source': 'referenceSources', 'grade-source-set': 'sourceSets', 'grade-competency-plan': 'competencyPlans',
      }
      await records(grades, workspaceId, {}, async items => {
        for (const { record } of items) {
          const key = keys[record.recordType]
          counts[key] = (counts[key] ?? 0) + 1
          if (record.recordType === 'grade-version') rubricGroups.add(record.rubric.groupId)
        }
      })
      counts.rubrics = rubricGroups.size
      counts.sourceArtifacts = await artifactCount(grades, workspaceId)
      return counts
    },
  }
}
