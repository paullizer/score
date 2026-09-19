import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { LifecycleMetadata } from '../../src/domain/lifecycle'
import { analysisRunCanScore, type RealAnalysisRunRecord } from '../../src/domain/real-analyses'
import { WORKSPACE_ID_PATTERN } from '../ids'
import { assertWorkspaceMutationLease } from '../lifecycle/lease'
import { StoreConflictError } from '../store'
import type {
  AnalysisBlobStore, AnalysisLifecycleControl, AnalysisStore, AnalysisTransaction, AnalysisTransactionOptions, RealAnalysesDeps,
} from './store'
import { analysisBlobInRun, analysisHash, assertAnalysis, isAnalysisId } from './validation'

export const ANALYSIS_WRITER_MILLISECONDS = 120_000
export const ANALYSIS_BLOB_REQUEST_MILLISECONDS = 30_000
export const ANALYSIS_BLOB_LEASE_SECONDS = 60

export function analysisControlId(runId?: string): string {
  return runId ? `analysis-lifecycle:${runId}` : 'analysis-workspace-lifecycle'
}
export function analysisIsLocked(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.archivedAt || lifecycle?.deletingAt || lifecycle?.deletedAt)
}
export function analysisIsRemoved(lifecycle?: LifecycleMetadata): boolean {
  return Boolean(lifecycle?.deletingAt || lifecycle?.deletedAt)
}
function denied(): never {
  throw new StoreConflictError('This analysis or workspace is archived, removed, or changed. Reload before starting new work.')
}
export function assertAnalysisRunWritable(run: RealAnalysisRunRecord): void {
  if (analysisIsLocked(run.lifecycle)) denied()
}
export async function assertAnalysisWorkspaceActive(store: AnalysisStore, workspaceId: string): Promise<void> {
  assertWorkspaceMutationLease(workspaceId)
  const control = await store.getControl(workspaceId)
  if (control && control.record.state !== 'active') denied()
}
export function newAnalysisControl(workspaceId: string, timestamp: string, runId?: string): AnalysisLifecycleControl {
  return {
    id: analysisControlId(runId), recordType: 'analysis-lifecycle', workspaceId,
    ...(runId ? { runId } : {}), state: 'active', updatedAt: timestamp,
  }
}

const timestamp = z.iso.datetime({ precision: 3 })
const controlSchema = z.strictObject({
  id: z.string(), recordType: z.literal('analysis-lifecycle'), workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  runId: z.string().refine(value => isAnalysisId(value, 'run')).optional(),
  state: z.enum(['active', 'archived', 'deleting', 'deleted']), updatedAt: timestamp,
  operation: z.strictObject({
    id: z.string().uuid(), action: z.enum(['archive', 'unarchive', 'delete']),
    status: z.enum(['pending', 'running', 'failed', 'complete']), updatedAt: timestamp,
    error: z.string().min(1).max(500).optional(),
  }).optional(),
  dependencies: z.strictObject({
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    targets: z.array(z.strictObject({
      kind: z.enum(['resume', 'job', 'rubric', 'ladder']),
      id: z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
    })).max(4000),
  }).optional(),
  writers: z.record(z.string().uuid(), z.strictObject({
    blobName: z.string().max(700), expiresAt: timestamp,
  })).optional(),
})
export function parseAnalysisControl(value: unknown): AnalysisLifecycleControl {
  const record = controlSchema.parse(value)
  assertAnalysis(record.id === analysisControlId(record.runId) && Buffer.byteLength(JSON.stringify(record)) <= 1_000_000,
    'Invalid analysis lifecycle identity or size.')
  assertAnalysis(record.runId || (!record.operation && !record.dependencies && !record.writers), 'Run controls require a run identity.')
  if (record.dependencies) assertAnalysis(record.state === 'deleting', 'Dependency recovery is only retained during deletion.')
  if (record.writers) assertAnalysis(Object.keys(record.writers).length <= 100 && Object.values(record.writers).every(writer =>
    analysisBlobInRun(writer.blobName, record.workspaceId, record.runId!)), 'Invalid analysis writer ownership.')
  return record
}

/** Every publication touches both controls in the same partition, including initial creation. */
export async function prepareAnalysisGuards(
  store: Pick<AnalysisStore, 'get' | 'getControl'>, workspaceId: string,
  operations: AnalysisTransaction[], options: AnalysisTransactionOptions = {},
): Promise<NonNullable<AnalysisTransactionOptions['controls']>> {
  assertWorkspaceMutationLease(workspaceId)
  const requested = new Map((options.controls ?? []).map(item => [item.record.id, item]))
  assertAnalysis(requested.size === (options.controls ?? []).length, 'Duplicate analysis lifecycle controls.')
  const families = new Set([
    ...operations.map(item => item.record.recordType === 'analysis-run' ? item.record.id : item.record.runId),
    ...(options.controls ?? []).flatMap(item => item.record.runId ? [item.record.runId] : []),
  ])
  assertAnalysis(families.size <= 1, 'An analysis transaction cannot mix runs.')
  const parent = operations.find(item => item.record.recordType === 'analysis-run')
  const nextRun = parent?.kind !== 'delete' && parent?.record.recordType === 'analysis-run' ? parent.record : undefined
  const cancellationOnly = Boolean(nextRun?.cancellation && nextRun.status === 'cancelled' &&
    operations.every(item => item.kind !== 'delete' &&
      (item.record.recordType === 'analysis-run' || item.record.status === 'cancelled')))
  const controls: NonNullable<AnalysisTransactionOptions['controls']> = []
  const control = async (runId?: string) => {
    const current = await store.getControl(workspaceId, runId)
    const id = analysisControlId(runId)
    const update = requested.get(id)
    if (update && (update.etag !== current?.etag || update.record.workspaceId !== workspaceId || update.record.runId !== runId)) denied()
    const record = parseAnalysisControl(update?.record ?? current?.record ?? newAnalysisControl(workspaceId, new Date().toISOString(), runId))
    if (current && ((current.record.state === 'deleted' && record.state !== 'deleted') ||
      (current.record.state === 'deleting' && !['deleting', 'deleted'].includes(record.state)))) denied()
    if (current?.record.dependencies && record.state !== 'deleted' &&
      analysisHash(current.record.dependencies) !== analysisHash(record.dependencies ?? null)) denied()
    if (!options.lifecycle) {
      if (record.state !== 'active' && !(cancellationOnly && record.state === 'archived')) denied()
      if (update && (record.state !== (current?.record.state ?? 'active') ||
        analysisHash(record.operation ?? null) !== analysisHash(current?.record.operation ?? null) ||
        analysisHash(record.dependencies ?? null) !== analysisHash(current?.record.dependencies ?? null))) denied()
    }
    controls.push({ record, ...(current ? { etag: current.etag } : {}) })
    return record
  }
  const workspace = await control()
  for (const runId of families) {
    assertAnalysis(isAnalysisId(runId, 'run'), 'Invalid analysis control run identity.')
    const guard = await control(runId)
    const current = await store.get(workspaceId, runId)
    assertAnalysis(!current || current.record.recordType === 'analysis-run', 'Invalid analysis run fence.')
    const oldRun = current?.record as RealAnalysisRunRecord | undefined
    if (!options.lifecycle && oldRun && analysisIsLocked(oldRun.lifecycle) &&
      !(cancellationOnly && !analysisIsRemoved(oldRun.lifecycle))) denied()
    if (!options.lifecycle && nextRun && analysisHash(oldRun?.lifecycle ?? null) !== analysisHash(nextRun.lifecycle ?? null)) denied()
    if (nextRun) {
      const expectedState = nextRun.lifecycle?.deletedAt ? 'deleted' : nextRun.lifecycle?.deletingAt ? 'deleting'
        : nextRun.lifecycle?.archivedAt ? 'archived' : 'active'
      if (guard.state !== expectedState) denied()
      if (oldRun?.lifecycle?.deletingAt && !nextRun.lifecycle?.deletingAt) denied()
      if (guard.state === 'deleted') denied()
    }
    for (const item of operations) {
      if (item.kind === 'delete') {
        if (!options.lifecycle || !oldRun?.lifecycle?.deletingAt || !['deleting', 'deleted'].includes(guard.state)) denied()
      } else if (item.record.recordType === 'analysis-comparison' &&
        (workspace.state !== 'active' || guard.state !== 'active' || analysisIsLocked(nextRun?.lifecycle ?? oldRun?.lifecycle)) &&
        item.record.status !== 'cancelled') denied()
      if (options.lifecycle && item.kind === 'create' &&
        (item.record.recordType !== 'analysis-comparison' || item.record.status !== 'cancelled' || !nextRun?.cancellation)) denied()
    }
  }
  assertAnalysis([...requested.keys()].every(id => controls.some(value => value.record.id === id)), 'Invalid analysis control scope.')
  return controls
}

function isConflict(error: unknown): boolean {
  return error instanceof StoreConflictError || error instanceof Error && error.name === 'StoreConflictError'
}
export async function updateAnalysisControl(
  store: AnalysisStore, workspaceId: string, runId: string | undefined,
  change: (record: AnalysisLifecycleControl) => AnalysisLifecycleControl, lifecycle = true,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await store.getControl(workspaceId, runId)
    const record = change(structuredClone(current?.record ?? newAnalysisControl(workspaceId, new Date().toISOString(), runId)))
    try {
      assertWorkspaceMutationLease(workspaceId)
      await store.transact(workspaceId, [], { lifecycle, controls: [{ record, etag: current?.etag }] })
      return
    } catch (error) { if (!isConflict(error)) throw error }
  }
  throw new StoreConflictError('The analysis lifecycle changed during its guarded write.')
}

/** Finite Blob leases fence the content PUT itself, not just the later Cosmos publication. */
export function fencedAnalysisBlobs(
  deps: RealAnalysesDeps, workspaceId: string, runId: string, signal?: AbortSignal,
): AnalysisBlobStore {
  const blobs = deps.blobs
  return {
    read: name => blobs.read(name),
    list: (ws, run, token) => blobs.list(ws, run, token),
    delete: (ws, run, name, etag) => blobs.delete(ws, run, name, etag),
    putFenced: (name, bytes, type, fence) => blobs.putFenced(name, bytes, type, fence),
    async putImmutable(name, bytes, contentType) {
      assertAnalysis(analysisBlobInRun(name, workspaceId, runId), 'Invalid analysis Blob writer scope.')
      signal?.throwIfAborted()
      const id = randomUUID()
      const expiresAt = new Date(Date.now() + ANALYSIS_WRITER_MILLISECONDS).toISOString()
      await updateAnalysisControl(deps.store, workspaceId, runId, record => ({
        ...record, writers: {
          ...Object.fromEntries(Object.entries(record.writers ?? {}).filter(([, writer]) => Date.parse(writer.expiresAt) > Date.now())),
          [id]: { blobName: name, expiresAt },
        },
      }), false)
      const assertActive = async () => {
        signal?.throwIfAborted()
        assertWorkspaceMutationLease(workspaceId)
        const [workspace, control, run] = await Promise.all([
          deps.store.getControl(workspaceId), deps.store.getControl(workspaceId, runId), deps.store.get(workspaceId, runId),
        ])
        const writer = control?.record.writers?.[id]
        if (Date.parse(expiresAt) <= Date.now() || workspace?.record.state !== 'active' || control?.record.state !== 'active' ||
          writer?.blobName !== name || writer.expiresAt !== expiresAt) denied()
        if (run?.record.recordType === 'analysis-run') assertAnalysisRunWritable(run.record)
        if (name.includes('/results/') || name.includes('/diagnostics/')) {
          if (run?.record.recordType !== 'analysis-run' || !analysisRunCanScore(run.record)) denied()
          const parts = name.split('/')
          const comparison = await deps.store.get(workspaceId, parts[3])
          if (comparison?.record.recordType !== 'analysis-comparison' || comparison.record.runId !== runId ||
            comparison.record.status !== 'running' || `${comparison.record.attemptId}.json` !== parts[4]) denied()
        }
        assertWorkspaceMutationLease(workspaceId)
      }
      // Uncertain/failed uploads retain their reservation until the bounded Blob request and lease have drained.
      const result = await blobs.putFenced(name, bytes, contentType, {
        id, workspaceId, runId, blobName: name, expiresAt, signal, assertActive,
      })
      await updateAnalysisControl(deps.store, workspaceId, runId, record => {
        if (!record.writers?.[id]) return record
        const writers = { ...record.writers }
        delete writers[id]
        return { ...record, writers: Object.keys(writers).length ? writers : undefined }
      })
      return result
    },
  }
}
