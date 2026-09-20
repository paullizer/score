import type { LifecycleAction, LifecycleImpact, LifecycleMetadata, LifecycleOperation } from '../../src/domain/lifecycle'
import { getDisplayName } from '../../src/domain/displayNames'
import type { RealResumeRecord, ResumeEntity, VersionedResumeEntity } from '../../src/domain/real-resumes'
import { conflict, notFound, unavailable } from '../errors'
import type { LifecycleDependencies, WorkspaceLifecycleParticipant } from '../lifecycle/contracts'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError } from '../store'
import {
  cancelResumeWork, resumeControlId, resumeIsRemoved, updateResumeControl,
} from './guards'
import type { RealResumesDeps, ResumeLifecycleControl, ResumeTransaction, StoredResumeControl } from './store'
import { isBlobInResumePrefix, isValidResumeId, parseResumeEntity } from './validation'

export interface ResumeLifecycleResult {
  deleted?: true
  pending?: true
  operation?: LifecycleOperation
  etag?: string
}

function nextToken(token: string | undefined, seen: Set<string>): string | undefined {
  if (token && seen.has(token)) throw unavailable('Resume lifecycle pagination did not advance.')
  if (token) seen.add(token)
  return token
}

async function records<K extends ResumeEntity['recordType']>(
  resumes: RealResumesDeps, workspaceId: string, recordType: K,
  visit: (items: VersionedResumeEntity<Extract<ResumeEntity, { recordType: K }>>[]) => Promise<void>,
): Promise<void> {
  const tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await resumes.store.list(workspaceId, { recordType, limit: 50, continuationToken })
    if (page.items.some(value => value.record.workspaceId !== workspaceId || value.record.recordType !== recordType)) {
      throw unavailable('Resume lifecycle enumeration crossed its ownership boundary.')
    }
    for (const value of page.items) parseResumeEntity(value.record)
    await visit(page.items)
    continuationToken = nextToken(page.continuationToken, tokens)
  } while (continuationToken)
}

async function controls(resumes: RealResumesDeps, workspaceId: string): Promise<StoredResumeControl[]> {
  const results: StoredResumeControl[] = []
  const tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await resumes.store.listControls(workspaceId, continuationToken)
    if (page.items.some(value => value.record.workspaceId !== workspaceId)) {
      throw unavailable('Resume lifecycle controls crossed their ownership boundary.')
    }
    results.push(...page.items)
    continuationToken = nextToken(page.continuationToken, tokens)
  } while (continuationToken)
  return results
}

async function families(resumes: RealResumesDeps, workspaceId: string): Promise<string[]> {
  const ids = new Set<string>()
  await records(resumes, workspaceId, 'resume', async items => {
    for (const { record } of items) ids.add(record.id)
  })
  for (const { record } of await controls(resumes, workspaceId)) if (record.resumeId) ids.add(record.resumeId)
  const tokens = new Set<string>()
  let continuationToken: string | undefined
  do {
    const page = await resumes.blobs.listFamilies(workspaceId, continuationToken)
    for (const id of page.resumeIds) {
      if (!isValidResumeId(id)) throw unavailable('Resume artifact inventory returned an invalid identity.')
      ids.add(id)
    }
    continuationToken = nextToken(page.continuationToken, tokens)
  } while (continuationToken)
  return [...ids]
}

async function currentResume(resumes: RealResumesDeps, workspaceId: string, id: string): Promise<VersionedResumeEntity<RealResumeRecord> | undefined> {
  if (!isValidResumeId(id)) throw notFound('The requested resume was not found.')
  const value = await resumes.store.get(workspaceId, id)
  if (!value) return undefined
  const record = parseResumeEntity(value.record)
  if (record.recordType !== 'resume' || record.workspaceId !== workspaceId || record.id !== id) {
    throw unavailable('The saved resume lifecycle target has invalid ownership.')
  }
  return { record, etag: value.etag }
}

async function save(resumes: RealResumesDeps, workspaceId: string, operations: ResumeTransaction[]): Promise<void> {
  // Leave space for the workspace and per-resume transactional fences.
  for (let offset = 0; offset < operations.length; offset += 20) {
    assertWorkspaceMutationLease(workspaceId)
    await resumes.store.transact(workspaceId, operations.slice(offset, offset + 20), { lifecycle: true })
  }
}

async function cancelOne(resumes: RealResumesDeps, workspaceId: string, id: string, timestamp: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await currentResume(resumes, workspaceId, id)
    if (!current) return
    const record = cancelResumeWork(current.record, timestamp)
    if (record === current.record) return
    try {
      await save(resumes, workspaceId, [{ kind: 'replace', record, etag: current.etag }])
      return
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= 7) throw error
    }
  }
}

async function saveTarget(
  resumes: RealResumesDeps, current: VersionedResumeEntity<RealResumeRecord>, record: RealResumeRecord,
  operation?: LifecycleOperation,
): Promise<void> {
  const control = await resumes.store.getControl(record.workspaceId, record.id)
  const next: ResumeLifecycleControl = {
    ...(control?.record ?? { id: resumeControlId(record.id), recordType: 'resume-lifecycle', workspaceId: record.workspaceId,
      resumeId: record.id, state: 'active', updatedAt: record.updatedAt }),
    operation, updatedAt: record.updatedAt,
  }
  assertWorkspaceMutationLease(record.workspaceId)
  await resumes.store.transact(record.workspaceId, [{ kind: 'replace', record, etag: current.etag }], {
    lifecycle: true, controls: [{ record: next, etag: control?.etag }],
  })
}

async function finishArchive(
  resumes: RealResumesDeps, workspaceId: string, id: string, action: 'archive' | 'unarchive', timestamp: string,
): Promise<void> {
  // Even an interrupted archive must finish cancellation before its fence can be lifted.
  await cancelOne(resumes, workspaceId, id, timestamp)
  const current = await currentResume(resumes, workspaceId, id)
  if (!current) throw unavailable('The resume archive recovery target is missing.')
  if (resumeIsRemoved(current.record.lifecycle)) throw conflict('Resume deletion must finish before changing its archive state.')
  const lifecycle = { ...current.record.lifecycle }
  if (action === 'archive') lifecycle.archivedAt ??= timestamp
  else delete lifecycle.archivedAt
  await saveTarget(resumes, current, {
    ...current.record, updatedAt: [timestamp, current.record.updatedAt].sort().at(-1)!, lifecycle,
  })
}

async function purgeBlobs(resumes: RealResumesDeps, workspaceId: string, id: string): Promise<boolean> {
  const control = await resumes.store.getControl(workspaceId, id)
  if (!control || !['deleting', 'deleted'].includes(control.record.state)) throw conflict('Fence a resume before removing its sources.')
  if (Object.values(control.record.writers ?? {}).some(writer => Date.parse(writer.expiresAt) > Date.now())) return false
  // Offsets may shift during deletion. Completion needs an entirely empty verification sweep.
  for (let sweep = 0; sweep < 100; sweep++) {
    const tokens = new Set<string>()
    let continuationToken: string | undefined
    let removed = 0
    do {
      const page = await resumes.blobs.listPage(workspaceId, id, continuationToken)
      for (const name of page.names) {
        if (!isBlobInResumePrefix(name, workspaceId, id)) throw unavailable('Resume source cleanup crossed its ownership boundary.')
        assertWorkspaceMutationLease(workspaceId)
        await resumes.blobs.delete(name)
        removed++
      }
      continuationToken = nextToken(page.continuationToken, tokens)
    } while (continuationToken)
    if (!removed) return true
  }
  throw unavailable('Resume source cleanup could not verify an empty namespace.')
}

async function removeBatchReferences(resumes: RealResumesDeps, workspaceId: string, id: string, timestamp: string): Promise<void> {
  await records(resumes, workspaceId, 'resume-batch', async values => {
    const operations: ResumeTransaction[] = []
    for (const current of values) {
      const items = current.record.items.filter(item => item.resumeId !== id)
      if (items.length === current.record.items.length) continue
      operations.push({ kind: 'replace', etag: current.etag, record: {
        ...current.record, items, updatedAt: [timestamp, current.record.updatedAt].sort().at(-1)!,
        removedCount: (current.record.removedCount ?? 0) + current.record.items.length - items.length,
      } })
    }
    await save(resumes, workspaceId, operations)
  })
}

async function purgeResume(resumes: RealResumesDeps, workspaceId: string, id: string, timestamp: string): Promise<boolean> {
  await updateResumeControl(resumes.store, workspaceId, id, control => ({
    ...control, state: control.state === 'deleted' ? 'deleted' : 'deleting', updatedAt: timestamp,
    operation: { id, action: 'delete', status: 'pending', updatedAt: timestamp },
  }))
  const initial = await currentResume(resumes, workspaceId, id)
  if (initial && !resumeIsRemoved(initial.record.lifecycle)) {
    const lifecycle = { ...initial.record.lifecycle, deletingAt: timestamp }
    await saveTarget(resumes, initial, {
      ...initial.record, lifecycle, updatedAt: [timestamp, initial.record.updatedAt].sort().at(-1)!,
    }, { id, action: 'delete', status: 'pending', updatedAt: timestamp })
  }
  await cancelOne(resumes, workspaceId, id, timestamp)
  if (!await purgeBlobs(resumes, workspaceId, id)) return false
  await removeBatchReferences(resumes, workspaceId, id, timestamp)
  const current = await currentResume(resumes, workspaceId, id)
  const control = await resumes.store.getControl(workspaceId, id)
  if (!control) throw unavailable('The resume deletion fence is missing.')
  assertWorkspaceMutationLease(workspaceId)
  // The recovery row disappears only with a durable, noncontent, permanent key tombstone.
  await resumes.store.transact(workspaceId, current ? [{ kind: 'delete', ...current }] : [], {
    lifecycle: true, controls: [{ etag: control.etag, record: {
      id: control.record.id, recordType: 'resume-lifecycle', workspaceId, resumeId: id,
      state: 'deleted', updatedAt: timestamp,
    } }],
  })
  return true
}

async function cancelWorkspace(resumes: RealResumesDeps, workspaceId: string, timestamp: string): Promise<void> {
  const control = await resumes.store.getControl(workspaceId)
  if (!control || control.record.state === 'active') throw conflict('Fence the resume workspace before cancelling work.')
  await records(resumes, workspaceId, 'resume', async values => {
    for (const value of values) await cancelOne(resumes, workspaceId, value.record.id, timestamp)
  })
  if (control.record.state === 'archived') await updateResumeControl(resumes.store, workspaceId, undefined, value => ({
    ...value, updatedAt: timestamp, operation: undefined,
  }))
}

async function purgeWorkspace(resumes: RealResumesDeps, workspaceId: string, timestamp: string): Promise<void> {
  const control = await resumes.store.getControl(workspaceId)
  if (!control || !['deleting', 'deleted'].includes(control.record.state)) throw conflict('Fence the resume workspace before purging it.')
  for (const id of await families(resumes, workspaceId)) {
    if (!await purgeResume(resumes, workspaceId, id, timestamp)) throw unavailable('Resume source uploads are still draining. Retry deletion.')
  }
  // Restart enumeration after deletions; empty pages with a continuation are not completion.
  let continuationToken: string | undefined
  const tokens = new Set<string>()
  for (;;) {
    const page = await resumes.store.list(workspaceId, { recordType: 'resume-batch', limit: 20, continuationToken })
    if (page.items.length) {
      if (page.items.some(value => value.record.workspaceId !== workspaceId || value.record.recordType !== 'resume-batch')) {
        throw unavailable('Resume batch cleanup crossed its ownership boundary.')
      }
      await save(resumes, workspaceId, page.items.map(value => ({ kind: 'delete', ...value })))
      continuationToken = undefined
      tokens.clear()
    } else {
      continuationToken = nextToken(page.continuationToken, tokens)
      if (!continuationToken) break
    }
  }
}

async function resumeWorkspace(resumes: RealResumesDeps, workspaceId: string, timestamp: string): Promise<void> {
  const workspace = await resumes.store.getControl(workspaceId)
  if (workspace && ['deleting', 'deleted'].includes(workspace.record.state)) {
    await purgeWorkspace(resumes, workspaceId, timestamp)
    return
  }
  if (workspace?.record.state === 'archived' && workspace.record.operation) await cancelWorkspace(resumes, workspaceId, timestamp)
  for (const { record } of await controls(resumes, workspaceId)) {
    if (!record.resumeId) continue
    if (record.state === 'deleting' || record.operation?.action === 'delete') {
      if (!await purgeResume(resumes, workspaceId, record.resumeId, timestamp)) throw unavailable('Resume uploads are still draining.')
    } else if (record.operation && record.operation.status !== 'complete') {
      await finishArchive(resumes, workspaceId, record.resumeId, record.operation.action, timestamp)
    } else if (record.preparation && Date.parse(record.preparation.expiresAt) <= Date.now()) {
      if (await currentResume(resumes, workspaceId, record.resumeId)) {
        await updateResumeControl(resumes.store, workspaceId, record.resumeId, value => ({ ...value, preparation: undefined }))
      } else if (!await purgeResume(resumes, workspaceId, record.resumeId, timestamp)) {
        throw unavailable('Unpublished resume source uploads are still draining.')
      }
    }
  }
}

export class ResumeLifecycleService {
  constructor(private readonly resumes: RealResumesDeps, private readonly dependencies?: LifecycleDependencies,
    private readonly now: () => Date = () => new Date()) {}

  async impact(workspaceId: string, id: string): Promise<LifecycleImpact> {
    const current = await currentResume(this.resumes, workspaceId, id)
    if (!current) throw notFound('The requested resume was not found.')
    const target = { kind: 'resume' as const, id }
    const record = current.record
    const workspace = await this.resumes.store.getControl(workspaceId)
    const removed = resumeIsRemoved(record.lifecycle) ||
      (workspace !== undefined && ['deleting', 'deleted'].includes(workspace.record.state))
    return {
      target, name: removed ? 'Resume pending deletion' : getDisplayName(record, record.resume.name ?? record.source.displayName),
      counts: { resumes: 1, originals: record.capture ? 1 : 0, documents: record.extraction ? 1 : 0, profiles: record.profileBlob ? 1 : 0 },
      blockers: this.dependencies ? await this.dependencies.impact(workspaceId, target) : [],
    }
  }

  async change(workspaceId: string, id: string, action: LifecycleAction, etag: string): Promise<ResumeLifecycleResult> {
    const current = await currentResume(this.resumes, workspaceId, id)
    if (!current) throw notFound('The requested resume was not found.')
    if (!etag || etag.trim() !== etag || etag === '*' || etag.startsWith('W/') || /[\r\n,]/.test(etag) ||
      etag.length > 1024 || current.etag !== etag) throw conflict('This resume changed. Reload its current ETag.')
    if (!['archive', 'unarchive', 'delete'].includes(action)) throw conflict('Unsupported resume lifecycle action.')
    if (action !== 'delete' && resumeIsRemoved(current.record.lifecycle)) throw conflict('Finish permanent deletion before changing this resume.')
    if (action === 'delete') {
      if (!this.dependencies) throw unavailable('Resume deletion requires the workspace dependency coordinator.')
      if ((await this.impact(workspaceId, id)).blockers.length) {
        throw conflict('Retained analyses reference this resume. Delete the blocking analyses, including archived analyses and old versions, first.')
      }
    }
    const timestamp = [this.now().toISOString(), current.record.updatedAt].sort().at(-1)!
    const operation: LifecycleOperation = { id, action, status: 'running', updatedAt: timestamp }
    let fenced = false
    try {
      if (action === 'unarchive' && !current.record.lifecycle?.archivedAt &&
        !(await this.resumes.store.getControl(workspaceId, id))?.record.operation) return {}
      const lifecycle: LifecycleMetadata = { ...current.record.lifecycle,
        ...(action === 'archive' ? { archivedAt: current.record.lifecycle?.archivedAt ?? timestamp }
          : action === 'delete' ? { deletingAt: current.record.lifecycle?.deletingAt ?? timestamp } : {}) }
      await saveTarget(this.resumes, current, { ...current.record, lifecycle, updatedAt: timestamp }, operation)
      fenced = true
      if (action !== 'delete') {
        await finishArchive(this.resumes, workspaceId, id, action, timestamp)
        return {}
      }
      if (await purgeResume(this.resumes, workspaceId, id, timestamp)) return { deleted: true }
      const latest = await currentResume(this.resumes, workspaceId, id)
      return { pending: true, ...(latest ? { etag: latest.etag } : {}), operation: { ...operation, status: 'pending' } }
    } catch (error) {
      const control = await this.resumes.store.getControl(workspaceId, id).catch(() => undefined)
      if (action === 'delete' && control?.record.state === 'deleted' && !control.record.operation) return { deleted: true }
      const latest = await currentResume(this.resumes, workspaceId, id).catch(() => undefined)
      if (control && !control.record.operation && latest &&
        !['queued', 'parsing', 'profiling'].includes(latest.record.resume.status) &&
        ((action === 'archive' && control.record.state === 'archived' && latest.record.lifecycle?.archivedAt) ||
          (action === 'unarchive' && control.record.state === 'active' && !latest.record.lifecycle?.archivedAt &&
            !resumeIsRemoved(latest.record.lifecycle)))) return {}
      fenced ||= control?.record.operation?.action === action
      if (!fenced) {
        if (error instanceof StoreConflictError) throw conflict('The resume changed before its lifecycle transition.')
        throw error
      }
      const failed: LifecycleOperation = { ...operation, status: 'failed',
        error: 'Cleanup is incomplete. Retry this lifecycle action; the resume remains fenced.' }
      await updateResumeControl(this.resumes.store, workspaceId, id, value => ({ ...value, operation: failed })).catch(() => undefined)
      return { pending: true, ...(latest ? { etag: latest.etag } : {}), operation: failed }
    }
  }
}

export function createResumeLifecycleParticipant(resumes: RealResumesDeps): WorkspaceLifecycleParticipant {
  return {
    pendingWorkspaces: limit => resumes.store.pendingLifecycleWorkspaces(limit),
    resume: (workspaceId, timestamp) => resumeWorkspace(resumes, workspaceId, timestamp),
    async setState(workspaceId, state, timestamp) {
      const current = await resumes.store.getControl(workspaceId)
      if (state === 'active' && current?.record.state === 'archived') await cancelWorkspace(resumes, workspaceId, timestamp)
      await updateResumeControl(resumes.store, workspaceId, undefined, control => ({
        ...control, state: control.state === 'deleted' && state === 'deleting' ? 'deleted' : state, updatedAt: timestamp,
        operation: state === 'archived' || (state === 'deleting' && control.state !== 'deleted')
          ? { id: workspaceId, action: state === 'archived' ? 'archive' : 'delete', status: 'pending', updatedAt: timestamp } : undefined,
      }))
    },
    cancel: (workspaceId, timestamp) => cancelWorkspace(resumes, workspaceId, timestamp),
    purge: (workspaceId, timestamp) => purgeWorkspace(resumes, workspaceId, timestamp),
    async counts(workspaceId) {
      const counts = { resumes: 0, resumeBatches: 0, sourceArtifacts: 0 }
      await records(resumes, workspaceId, 'resume', async items => { counts.resumes += items.length })
      await records(resumes, workspaceId, 'resume-batch', async items => { counts.resumeBatches += items.length })
      for (const id of await families(resumes, workspaceId)) {
        const tokens = new Set<string>()
        let continuationToken: string | undefined
        do {
          const page = await resumes.blobs.listPage(workspaceId, id, continuationToken)
          if (page.names.some(name => !isBlobInResumePrefix(name, workspaceId, id))) {
            throw unavailable('Resume artifact counts crossed their ownership boundary.')
          }
          counts.sourceArtifacts += page.names.length
          continuationToken = nextToken(page.continuationToken, tokens)
        } while (continuationToken)
      }
      return counts
    },
  }
}
