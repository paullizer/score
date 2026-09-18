import type { AnalysisRun, Job, Rubric, Workspace } from './types'

export type LifecycleKind = 'workspace' | 'job' | 'resume' | 'rubric' | 'ladder' | 'analysis'
export type LifecycleAction = 'archive' | 'unarchive' | 'delete'
export type ArchiveFilter = 'default' | 'active' | 'archived' | 'all'

export interface LifecycleTarget {
  kind: LifecycleKind
  id: string
}

export interface LifecycleMetadata {
  archivedAt?: string
  deletingAt?: string
  deletedAt?: string
  parentKey?: string
}

export interface WorkspaceLifecycle {
  archivedAt?: string
  /** Local singleton-root incarnation, assigned only by explicit creation after root deletion. */
  epoch?: string
  entities: Record<string, LifecycleMetadata>
}

export interface LifecycleBlocker {
  kind: 'analysis' | 'ladder'
  id: string
  name: string
  href: string
}

export interface LifecycleImpact {
  target: LifecycleTarget
  name: string
  counts: Record<string, number>
  blockers: LifecycleBlocker[]
}

export interface LifecycleOperation {
  id: string
  action: LifecycleAction
  status: 'pending' | 'running' | 'failed' | 'complete'
  updatedAt: string
  error?: string
}

export interface WorkspaceLifecycleTransitionOptions {
  /** Permit only lifecycle management and cancellation, even before root archive metadata is overlaid. */
  lifecycleOnly?: boolean
}

export function lifecycleKey(target: LifecycleTarget): string {
  return `${target.kind}:${target.id}`
}

export function lifecycleIsRemoved(value: LifecycleMetadata | undefined): boolean {
  return Boolean(value?.deletingAt || value?.deletedAt)
}

export function normalizeLifecycleTarget(workspace: Workspace, target: LifecycleTarget): LifecycleTarget {
  if (target.kind === 'workspace' && workspace.lifecycle?.epoch) return { kind: 'workspace', id: workspace.lifecycle.epoch }
  if (target.kind === 'rubric') {
    const rubric = workspace.rubrics.find((item) => item.id === target.id)
    if (rubric) return { kind: 'rubric', id: rubric.groupId }
  }
  if (target.kind === 'ladder') {
    const rubric = workspace.rubrics.find((item) => item.kind === 'grade' && item.ladder === target.id)
    const parent = rubric && workspace.lifecycle?.entities[`rubric:${rubric.groupId}`]?.parentKey
    if (parent?.startsWith('ladder:')) return { kind: 'ladder', id: parent.slice('ladder:'.length) }
  }
  return target
}

export function getEntityLifecycle(workspace: Workspace, target: LifecycleTarget): LifecycleMetadata | undefined {
  const metadata = workspace.lifecycle?.entities[lifecycleKey(normalizeLifecycleTarget(workspace, target))]
  if (target.kind === 'workspace' && workspace.lifecycle?.archivedAt) {
    return { ...metadata, archivedAt: workspace.lifecycle.archivedAt }
  }
  return metadata
}

function targetFromKey(key: string): LifecycleTarget {
  const separator = key.indexOf(':')
  return { kind: key.slice(0, separator) as LifecycleKind, id: key.slice(separator + 1) }
}

function rubricParent(workspace: Workspace, rubric: Rubric): string | undefined {
  if (rubric.kind === 'job' && rubric.jobId) return `job:${rubric.jobId}`
  return workspace.lifecycle?.entities[`rubric:${rubric.groupId}`]?.parentKey ??
    (rubric.ladder ? `ladder:${rubric.ladder}` : undefined)
}

function parentKey(workspace: Workspace, target: LifecycleTarget): string | undefined {
  if (target.kind !== 'rubric') return undefined
  const rubric = workspace.rubrics.find((item) => item.groupId === target.id)
  return rubric ? rubricParent(workspace, rubric) : getEntityLifecycle(workspace, target)?.parentKey
}

function rootLifecycle(workspace: Workspace): LifecycleMetadata[] {
  const lifecycle = workspace.lifecycle
  if (lifecycle?.epoch) {
    const metadata = lifecycle.entities[`workspace:${lifecycle.epoch}`]
    return metadata ? [metadata] : []
  }
  return Object.entries(lifecycle?.entities ?? {}).filter(([key]) => key.startsWith('workspace:')).map(([, value]) => value)
}

function rootRemoved(workspace: Workspace): boolean {
  return rootLifecycle(workspace).some(lifecycleIsRemoved)
}

function rootDeletedAndEmpty(workspace: Workspace): boolean {
  const metadata = rootLifecycle(workspace)
  return metadata.some((value) => value.deletedAt) && !metadata.some((value) => value.deletingAt && !value.deletedAt) &&
    !workspace.jobs.length && !workspace.resumes.length && !workspace.documents.length && !workspace.rubrics.length &&
    !workspace.runs.length && !sampleLifecycleTargets(workspace).length
}

export function isEntityRemoved(workspace: Workspace, target: LifecycleTarget): boolean {
  if (rootRemoved(workspace)) return true
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (lifecycleIsRemoved(getEntityLifecycle(workspace, normalized))) return true
  const parent = parentKey(workspace, normalized)
  return Boolean(parent && lifecycleIsRemoved(getEntityLifecycle(workspace, targetFromKey(parent))))
}

export function isEntityArchived(workspace: Workspace, target: LifecycleTarget): boolean {
  if (workspace.lifecycle?.archivedAt) return true
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (getEntityLifecycle(workspace, normalized)?.archivedAt) return true
  const parent = parentKey(workspace, normalized)
  return Boolean(parent && getEntityLifecycle(workspace, targetFromKey(parent))?.archivedAt)
}

export function matchesArchiveFilter(archived: boolean, query: string, filter: ArchiveFilter): boolean {
  if (filter === 'all' || (filter === 'default' && query.trim())) return true
  return filter === 'archived' ? archived : !archived
}

/** Includes logical rubric groups and illustrative ladders, never immutable version identities. */
export function sampleLifecycleTargets(workspace: Workspace): LifecycleTarget[] {
  const targets = new Map<string, LifecycleTarget>()
  const add = (target: LifecycleTarget) => { targets.set(lifecycleKey(target), target) }
  workspace.jobs.filter((job) => job.dataKind !== 'real').forEach((job) => add({ kind: 'job', id: job.id }))
  workspace.resumes.forEach((resume) => add({ kind: 'resume', id: resume.id }))
  workspace.runs.forEach((run) => add({ kind: 'analysis', id: run.id }))
  for (const rubric of workspace.rubrics.filter((item) => item.dataKind !== 'real')) {
    add({ kind: 'rubric', id: rubric.groupId })
    const parent = rubricParent(workspace, rubric)
    if (parent?.startsWith('ladder:')) add(targetFromKey(parent))
  }
  for (const [key, value] of Object.entries(workspace.lifecycle?.entities ?? {})) {
    if (key.startsWith('ladder:') && !lifecycleIsRemoved(value)) add(targetFromKey(key))
  }
  return [...targets.values()]
}

function targetExists(workspace: Workspace, target: LifecycleTarget): boolean {
  if (target.kind === 'workspace') return !rootRemoved(workspace)
  if (target.kind === 'job') return workspace.jobs.some((job) => job.id === target.id)
  if (target.kind === 'resume') return workspace.resumes.some((resume) => resume.id === target.id)
  if (target.kind === 'analysis') return workspace.runs.some((run) => run.id === target.id)
  if (target.kind === 'rubric') return workspace.rubrics.some((rubric) => rubric.groupId === target.id)
  return sampleLifecycleTargets(workspace).some((item) => item.kind === 'ladder' && item.id === target.id)
}

export function assertEntityWritable(workspace: Workspace, target: LifecycleTarget): void {
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (isEntityRemoved(workspace, normalized) || !targetExists(workspace, normalized)) {
    throw new Error(`This ${target.kind} was deleted or is no longer available. Refresh the library before continuing.`)
  }
  if (isEntityArchived(workspace, normalized)) {
    throw new Error(`This ${target.kind} is archived or belongs to an archived parent. Unarchive it and its parent before editing or starting new processing.`)
  }
}

function ownedRubrics(workspace: Workspace, target: LifecycleTarget): Rubric[] {
  return workspace.rubrics.filter((rubric) => rubric.dataKind !== 'real' && (
    target.kind === 'workspace' ||
    (target.kind === 'rubric' && rubric.groupId === target.id) ||
    (target.kind === 'job' && rubric.jobId === target.id) ||
    (target.kind === 'ladder' && rubricParent(workspace, rubric) === lifecycleKey(target))
  ))
}

function referencesTarget(run: AnalysisRun, target: LifecycleTarget, rubrics: Rubric[]): boolean {
  if (target.kind === 'workspace') return true
  if (target.kind === 'resume') return run.resumes.some((snapshot) => snapshot.resume.id === target.id)
  const groups = new Set(rubrics.map((rubric) => rubric.groupId))
  const versions = new Set(rubrics.map((rubric) => rubric.id))
  if (target.kind === 'rubric') groups.add(target.id)
  return run.targets.some((snapshot) =>
    (target.kind === 'job' && (snapshot.job?.id === target.id || snapshot.rubric.jobId === target.id)) ||
    groups.has(snapshot.rubric.groupId) || versions.has(snapshot.id) || versions.has(snapshot.rubric.id) ||
    (snapshot.job?.rubricId !== null && snapshot.job?.rubricId !== undefined && versions.has(snapshot.job.rubricId)),
  )
}

function targetName(workspace: Workspace, target: LifecycleTarget): string {
  if (target.kind === 'workspace') return 'Sample workspace'
  if (target.kind === 'job') return workspace.jobs.find((job) => job.id === target.id)?.title ?? 'Job'
  if (target.kind === 'resume') return workspace.resumes.find((resume) => resume.id === target.id)?.name ?? 'Resume'
  if (target.kind === 'analysis') return workspace.runs.find((run) => run.id === target.id)?.name ?? 'Analysis'
  const rubrics = ownedRubrics(workspace, target).sort((a, b) => b.version - a.version)
  return target.kind === 'ladder' ? rubrics[0]?.ladder ?? 'Grade ladder' : rubrics[0]?.name ?? 'Rubric'
}

function deletionSet(workspace: Workspace, target: LifecycleTarget): LifecycleTarget[] {
  const targets = [target]
  if (target.kind === 'workspace') return [...targets, ...sampleLifecycleTargets(workspace)]
  for (const groupId of new Set(ownedRubrics(workspace, target).map((rubric) => rubric.groupId))) {
    if (target.kind !== 'rubric') targets.push({ kind: 'rubric', id: groupId })
  }
  return targets
}

function deletedDocuments(workspace: Workspace, targets: LifecycleTarget[]): Set<string> {
  const keys = new Set(targets.map(lifecycleKey))
  const documents = new Set<string>()
  const retainedDocuments = new Set<string>()
  for (const job of workspace.jobs) {
    (keys.has(`job:${job.id}`) ? documents : retainedDocuments).add(job.documentId)
  }
  for (const resume of workspace.resumes) {
    (keys.has(`resume:${resume.id}`) ? documents : retainedDocuments).add(resume.documentId)
  }
  if (targets.some((target) => target.kind === 'workspace')) {
    workspace.documents.filter((document) => document.sample).forEach((document) => documents.add(document.id))
  }
  return new Set([...documents].filter((id) => !retainedDocuments.has(id)))
}

export function getSampleLifecycleImpact(workspace: Workspace, target: LifecycleTarget): LifecycleImpact {
  const normalized = normalizeLifecycleTarget(workspace, target)
  const rubrics = ownedRubrics(workspace, normalized)
  const targets = deletionSet(workspace, normalized)
  const counts: Record<string, number> = {}
  for (const item of targets) {
    const label = item.kind === 'analysis' ? 'analyses' : item.kind === 'resume' ? 'resumes' : `${item.kind}s`
    counts[label] = (counts[label] ?? 0) + 1
  }
  if (rubrics.length) counts.rubricVersions = rubrics.length
  const documents = deletedDocuments(workspace, targets).size
  if (documents) counts.documents = documents
  if (normalized.kind === 'analysis') {
    const run = workspace.runs.find((item) => item.id === normalized.id)
    counts.comparisons = run?.comparisons.length ?? 0
    counts.snapshots = (run?.targets.length ?? 0) + (run?.resumes.length ?? 0)
  }
  const blockers: LifecycleBlocker[] = normalized.kind === 'analysis' ? [] : workspace.runs
    .filter((run) => referencesTarget(run, normalized, rubrics))
    .map((run) => ({ kind: 'analysis', id: run.id, name: run.name, href: `/analyses/${encodeURIComponent(run.id)}` }))
  return { target: normalized, name: targetName(workspace, normalized), counts, blockers }
}

export class LifecycleBlockedError extends Error {
  readonly impact: LifecycleImpact

  constructor(impact: LifecycleImpact) {
    super(`Delete the retained ${impact.blockers.map((item) => `${item.kind} "${item.name}"`).join(', ')} before deleting "${impact.name}". Archived analyses and historical rubric versions still count.`)
    this.name = 'LifecycleBlockedError'
    this.impact = impact
  }
}

function jobUnfinished(job: Job): boolean {
  return job.status === 'queued' || job.status === 'parsing' || job.status === 'generating'
}

function cancelledJob(job: Job, reason: string): Job {
  return {
    ...job, status: 'cancelled', error: reason,
    errorStage: job.status === 'generating' ? 'rubric' : 'parsing',
  }
}

function cancelRun(run: AnalysisRun, reason: string): AnalysisRun {
  if (!run.comparisons.some((item) => item.status === 'queued' || item.status === 'running')) return run
  return {
    ...run,
    comparisons: run.comparisons.map((item) => item.status === 'queued' || item.status === 'running' ? {
      ...item, status: 'cancelled', score: null, criteria: [], error: reason, summary: reason,
    } : item),
  }
}

function cancelArchivedWork(workspace: Workspace): Workspace {
  const reason = 'Processing stopped because this item or its parent was archived. Completed results are preserved. Unarchiving does not restart work.'
  return {
    ...workspace,
    jobs: workspace.jobs.map((job) => {
      const rubricArchived = workspace.rubrics.some((rubric) => rubric.jobId === job.id &&
        isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId }))
      return jobUnfinished(job) && (isEntityArchived(workspace, { kind: 'job', id: job.id }) || rubricArchived)
        ? cancelledJob(job, reason) : job
    }),
    runs: workspace.runs.map((run) => isEntityArchived(workspace, { kind: 'analysis', id: run.id }) ? cancelRun(run, reason) : run),
  }
}

export function setWorkspaceArchive(workspace: Workspace, archived: boolean, timestamp: string): Workspace {
  const lifecycle = { ...workspace.lifecycle, entities: { ...workspace.lifecycle?.entities } }
  if (archived) lifecycle.archivedAt ??= timestamp
  else delete lifecycle.archivedAt
  const next = { ...workspace, lifecycle }
  return archived ? cancelArchivedWork(next) : next
}

export function applySampleLifecycle(
  workspace: Workspace, target: LifecycleTarget, action: LifecycleAction, timestamp: string,
): Workspace {
  const normalized = normalizeLifecycleTarget(workspace, target)
  if (isEntityRemoved(workspace, normalized) || !targetExists(workspace, normalized)) {
    throw new Error(`This ${target.kind} was deleted or is no longer available. Refresh before trying again.`)
  }
  if ((normalized.kind === 'job' && workspace.jobs.some((job) => job.id === normalized.id && job.dataKind === 'real')) ||
    (normalized.kind === 'rubric' && workspace.rubrics.some((rubric) => rubric.groupId === normalized.id && rubric.dataKind === 'real'))) {
    throw new Error('Real records must use their server-owned lifecycle operation, not sample persistence.')
  }
  if (normalized.kind === 'workspace' && action !== 'delete') {
    return setWorkspaceArchive(workspace, action === 'archive', timestamp)
  }
  const key = lifecycleKey(normalized)
  const metadata = { ...getEntityLifecycle(workspace, normalized) }
  const parent = parentKey(workspace, normalized)
  if (parent) metadata.parentKey = parent
  const entities = { ...workspace.lifecycle?.entities }
  if (action !== 'delete') {
    if (action === 'archive') metadata.archivedAt ??= timestamp
    else delete metadata.archivedAt
    entities[key] = metadata
    const next = { ...workspace, lifecycle: { ...workspace.lifecycle, entities } }
    return action === 'archive' ? cancelArchivedWork(next) : next
  }

  const impact = getSampleLifecycleImpact(workspace, normalized)
  if (impact.blockers.length) throw new LifecycleBlockedError(impact)
  const targets = deletionSet(workspace, normalized)
  const removed = new Set(targets.map(lifecycleKey))
  const documents = deletedDocuments(workspace, targets)
  for (const item of targets) {
    const owner = parentKey(workspace, item)
    entities[lifecycleKey(item)] = { deletedAt: timestamp, ...(owner ? { parentKey: owner } : {}) }
  }
  // Keep an empty illustrative ladder after deleting its final rubric.
  if (parent?.startsWith('ladder:') && !entities[parent]) entities[parent] = {}
  const deletedJobRubrics = new Set(ownedRubrics(workspace, normalized).flatMap((rubric) => rubric.jobId ? [rubric.jobId] : []))
  return {
    ...workspace,
    lifecycle: { ...workspace.lifecycle, entities },
    jobs: workspace.jobs.filter((job) => !removed.has(`job:${job.id}`)).map((job) => deletedJobRubrics.has(job.id) ? {
      ...job, rubricId: null, rubricDeletedAt: timestamp, status: 'ready', error: undefined, errorStage: undefined,
    } : job),
    resumes: workspace.resumes.filter((resume) => !removed.has(`resume:${resume.id}`)),
    rubrics: workspace.rubrics.filter((rubric) => !removed.has(`rubric:${rubric.groupId}`)),
    documents: workspace.documents.filter((document) => !documents.has(document.id)),
    runs: workspace.runs.filter((run) => !removed.has(`analysis:${run.id}`)),
  }
}

/** Explicit sample reset keeps deletion markers but replaces all content with fresh identities. */
export function withSampleResetTombstones(
  previous: Workspace, fresh: Workspace, timestamp: string, newWorkspaceEpoch?: string,
): Workspace {
  if (newWorkspaceEpoch) {
    if (!rootDeletedAndEmpty(previous) || previous.lifecycle?.epoch === newWorkspaceEpoch ||
      previous.lifecycle?.entities[`workspace:${newWorkspaceEpoch}`]) {
      throw new Error('Create a new demo workspace only after the previous workspace is fully deleted, using a fresh workspace epoch.')
    }
  } else {
    assertEntityWritable(previous, { kind: 'workspace', id: 'sample' })
  }
  const entities = { ...previous.lifecycle?.entities, ...fresh.lifecycle?.entities }
  for (const target of sampleLifecycleTargets(previous)) {
    const parent = parentKey(previous, target)
    entities[lifecycleKey(target)] = { deletedAt: timestamp, ...(parent ? { parentKey: parent } : {}) }
  }
  const epoch = newWorkspaceEpoch ?? previous.lifecycle?.epoch
  return { ...fresh, lifecycle: { ...fresh.lifecycle, ...(epoch ? { epoch } : {}), entities } }
}

function sameValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    }
    return value
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function cancellationOnly(previous: AnalysisRun, next: AnalysisRun): boolean {
  const comparisons = previous.comparisons.map((comparison) => {
    const candidate = next.comparisons.find((item) => item.id === comparison.id)
    if ((comparison.status === 'queued' || comparison.status === 'running') && candidate?.status === 'cancelled') {
      return { ...comparison, status: 'cancelled', score: null, criteria: [], error: candidate.error, summary: candidate.summary }
    }
    return comparison
  })
  return sameValue({ ...previous, comparisons }, next)
}

function newAnalysisErrors(previous: Workspace, next: Workspace, run: AnalysisRun): string[] {
  const errors: string[] = []
  const context = `New analysis "${run.name}"`
  const eligible = (target: LifecycleTarget) => {
    const owner = parentKey(next, normalizeLifecycleTarget(next, target))
    if (!targetExists(next, normalizeLifecycleTarget(next, target)) || isEntityRemoved(previous, target) || isEntityRemoved(next, target)) {
      errors.push(`${context} uses a deleted or missing ${target.kind}. Refresh its selections.`)
    } else if (isEntityArchived(previous, target) || isEntityArchived(next, target) ||
      (owner && (isEntityArchived(previous, targetFromKey(owner)) || isEntityRemoved(previous, targetFromKey(owner))))) {
      errors.push(`${context} uses an archived ${target.kind}. Unarchive the input and its parent before starting a new analysis.`)
    }
  }
  eligible({ kind: 'workspace', id: 'sample' })
  for (const snapshot of run.resumes) {
    eligible({ kind: 'resume', id: snapshot.resume.id })
    const liveCapture = [previous, next].some((workspace) => {
      const resume = workspace.resumes.find((item) => item.id === snapshot.resume.id)
      const document = workspace.documents.find((item) => item.id === resume?.documentId)
      return sameValue(snapshot.resume, resume) && sameValue(snapshot.document, document)
    })
    if (!liveCapture) {
      errors.push(`${context} must capture a live resume and source document, not an old or fabricated snapshot.`)
    }
  }
  for (const snapshot of run.targets) {
    eligible({ kind: 'rubric', id: snapshot.rubric.groupId })
    const rubric = next.rubrics.find((item) => item.id === snapshot.rubric.id)
    if (rubric?.dataKind === 'real' || snapshot.job?.dataKind === 'real') {
      errors.push(`${context} cannot use real records in the sample scorer.`)
    }
    if (!sameValue(snapshot.rubric, rubric)) errors.push(`${context} must capture a retained live rubric version.`)
    if (snapshot.kind === 'job') {
      const jobId = snapshot.job?.id ?? snapshot.rubric.jobId ?? ''
      eligible({ kind: 'job', id: jobId })
      // A debounced save may contain a new capture followed by an ordinary rubric edit.
      const liveCapture = [previous, next].some((workspace) => {
        const job = workspace.jobs.find((item) => item.id === jobId)
        const document = workspace.documents.find((item) => item.id === job?.documentId)
        return job?.status === 'ready' && !job.rubricDeletedAt && job.rubricId === snapshot.rubric.id &&
          sameValue(snapshot.job, job) && sameValue(snapshot.document, document)
      })
      if (!liveCapture) {
        errors.push(`${context} requires a ready, current job rubric and its live source. A job with No rubric cannot be selected.`)
      }
    } else if (![previous, next].some((workspace) => workspace.rubrics.some((item) => item.id === snapshot.rubric.id) &&
      !workspace.rubrics.some((item) => item.groupId === snapshot.rubric.groupId && item.version > snapshot.rubric.version))) {
      errors.push(`${context} must use the latest version of its grade rubric.`)
    }
  }
  return errors
}

/**
 * Validates an entire sample-state replacement, including callers that already obtained a fresh ETag.
 * Root archive authorization and real-store dependencies remain the server coordinator's responsibility.
 */
export function workspaceLifecycleTransitionErrors(
  previous: Workspace, next: Workspace, options: WorkspaceLifecycleTransitionOptions = {},
): string[] {
  const errors: string[] = []
  const epochChanged = previous.lifecycle?.epoch !== next.lifecycle?.epoch
  const recreated = Boolean(epochChanged && next.lifecycle?.epoch && rootDeletedAndEmpty(previous) &&
    !rootRemoved(next) && !next.lifecycle?.archivedAt)
  if (epochChanged && !recreated) {
    errors.push('The workspace epoch cannot be replaced or rewound by a stale save. Create a new demo workspace only after fully deleting the previous one.')
  }
  const availablePrevious: Workspace = recreated ? {
    ...previous,
    lifecycle: { ...previous.lifecycle, entities: { ...previous.lifecycle?.entities }, archivedAt: undefined, epoch: next.lifecycle?.epoch },
  } : previous
  const beforeTargets = sampleLifecycleTargets(previous)
  const afterTargets = sampleLifecycleTargets(next)
  const beforeKeys = new Set(beforeTargets.map(lifecycleKey))
  const afterKeys = new Set(afterTargets.map(lifecycleKey))
  const nextEntries = next.lifecycle?.entities ?? {}
  const removedKeys = new Set([...beforeKeys].filter((key) => !afterKeys.has(key)))
  const rootLocked = Boolean(options.lifecycleOnly || availablePrevious.lifecycle?.archivedAt || next.lifecycle?.archivedAt || rootRemoved(availablePrevious) || rootRemoved(next))
  const locked = (target: LifecycleTarget) => {
    if (rootLocked) return true
    const owners = [parentKey(availablePrevious, normalizeLifecycleTarget(availablePrevious, target)), parentKey(next, normalizeLifecycleTarget(next, target))]
    return [target, ...owners.filter((key): key is string => key !== undefined).map(targetFromKey)].some((entity) =>
      isEntityArchived(availablePrevious, entity) || isEntityArchived(next, entity) || isEntityRemoved(availablePrevious, entity) || isEntityRemoved(next, entity))
  }

  for (const [key, metadata] of Object.entries(previous.lifecycle?.entities ?? {})) {
    const updated = nextEntries[key]
    if (metadata.deletedAt && updated?.deletedAt !== metadata.deletedAt) {
      errors.push(`The permanent deletion marker for ${key} must be preserved. Reload the latest workspace instead of overwriting it with an older copy.`)
    } else if (metadata.deletingAt && !updated?.deletedAt && updated?.deletingAt !== metadata.deletingAt) {
      errors.push(`Deletion of ${key} is in progress. Its removal marker cannot be cleared or replaced.`)
    }
  }
  for (const target of afterTargets) {
    const key = lifecycleKey(target)
    if (lifecycleIsRemoved(nextEntries[key]) || isEntityRemoved(availablePrevious, target)) {
      errors.push(`The deleted ${target.kind} "${target.id}" cannot be restored by saving an old workspace. Reload the latest state.`)
    }
    if (!beforeKeys.has(key) && rootLocked) errors.push(`The workspace is archived or being deleted. New ${target.kind} records are not allowed.`)
  }
  for (const target of beforeTargets) {
    const key = lifecycleKey(target)
    if (!removedKeys.has(key)) continue
    if (!nextEntries[key]?.deletedAt) {
      errors.push(`Deleting ${target.kind} "${targetName(previous, target)}" requires its permanent deletion marker. Use the lifecycle delete action.`)
    }
    const blockers = getSampleLifecycleImpact({ ...previous, runs: next.runs }, target).blockers
    if (blockers.length) errors.push(new LifecycleBlockedError({ target, name: targetName(previous, target), counts: {}, blockers }).message)
  }
  for (const [key, metadata] of Object.entries(nextEntries)) {
    if (key.startsWith('workspace:') && lifecycleIsRemoved(metadata) && !lifecycleIsRemoved(previous.lifecycle?.entities[key]) && previous.runs.length) {
      errors.push('Delete all analyses explicitly before permanently deleting the workspace. Archived analyses also block workspace deletion.')
    }
    const previousParent = previous.lifecycle?.entities[key]?.parentKey
    if (previousParent && metadata.parentKey !== previousParent) {
      errors.push(`The ownership of ${key} cannot be changed to bypass its parent's archive or deletion state.`)
    }
  }

  for (const job of previous.jobs) {
    const candidate = next.jobs.find((item) => item.id === job.id)
    if (!candidate) continue
    const deletedRubric = previous.rubrics.some((rubric) => rubric.jobId === job.id && removedKeys.has(`rubric:${rubric.groupId}`))
    let permitted = job
    if (deletedRubric) {
      if (!candidate.rubricDeletedAt || candidate.rubricId !== null || next.rubrics.some((rubric) => rubric.jobId === job.id)) {
        errors.push(`Deleting the rubric for "${job.title}" must remove every version and leave its source in the explicit No rubric state.`)
      }
      permitted = { ...permitted, rubricId: null, rubricDeletedAt: candidate.rubricDeletedAt, status: 'ready', error: undefined, errorStage: undefined }
    } else if (job.rubricDeletedAt !== candidate.rubricDeletedAt) {
      errors.push(`The intentional rubric-removal marker for "${job.title}" cannot be changed without deleting its complete rubric group.`)
    }
    if (locked({ kind: 'job', id: job.id })) {
      if (jobUnfinished(job) && candidate.status === 'cancelled' && !deletedRubric) {
        permitted = { ...permitted, status: 'cancelled', error: candidate.error, errorStage: candidate.errorStage }
      }
      if (!sameValue(permitted, candidate)) errors.push(`Archived job "${job.title}" is read-only. Only cancelling unfinished work or deleting its rubric is allowed.`)
    }
    if ((isEntityArchived(next, { kind: 'job', id: job.id }) || next.rubrics.some((rubric) =>
      rubric.jobId === job.id && isEntityArchived(next, { kind: 'rubric', id: rubric.groupId }))) && jobUnfinished(candidate)) {
      errors.push(`Archive must cancel unfinished processing for job "${job.title}". Unarchive does not restart it.`)
    }
  }
  for (const resume of previous.resumes) {
    const candidate = next.resumes.find((item) => item.id === resume.id)
    if (candidate && locked({ kind: 'resume', id: resume.id }) && !sameValue(resume, candidate)) {
      errors.push(`Archived resume "${resume.name}" is read-only.`)
    }
  }
  for (const rubric of previous.rubrics) {
    const candidate = next.rubrics.find((item) => item.id === rubric.id)
    if (!candidate && !removedKeys.has(`rubric:${rubric.groupId}`)) {
      errors.push(`Delete the complete rubric group "${rubric.name}", not individual versions. Older versions must not become current again.`)
    } else if (candidate && !sameValue(rubric, candidate)) {
      errors.push(`Saved rubric version "${rubric.name}" is immutable. Save a new version instead of rewriting historical content.`)
    }
  }
  for (const rubric of next.rubrics) {
    if (!previous.rubrics.some((item) => item.id === rubric.id) && locked({ kind: 'rubric', id: rubric.groupId })) {
      errors.push(`Archived rubric "${rubric.name}" cannot receive new versions. Unarchive it and its parent first.`)
    }
    const old = previous.rubrics.find((item) => item.groupId === rubric.groupId)
    if (old && rubricParent(previous, old) !== rubricParent(next, rubric)) {
      errors.push(`Rubric "${rubric.name}" cannot be moved to another owner to bypass lifecycle restrictions.`)
    }
  }
  for (const document of previous.documents) {
    const candidate = next.documents.find((item) => item.id === document.id)
    const owners: LifecycleTarget[] = [
      ...previous.jobs.filter((job) => job.documentId === document.id).map((job): LifecycleTarget => ({ kind: 'job', id: job.id })),
      ...previous.resumes.filter((resume) => resume.documentId === document.id).map((resume): LifecycleTarget => ({ kind: 'resume', id: resume.id })),
    ]
    if (candidate && (rootLocked || owners.some(locked)) && !sameValue(document, candidate)) {
      errors.push(`Source document "${document.title}" belongs to archived content and is read-only.`)
    }
    if (!candidate && !owners.some((owner) => removedKeys.has(lifecycleKey(owner)))) {
      const deletingRoot = Object.entries(nextEntries).some(([key, metadata]) => key.startsWith('workspace:') && metadata.deletedAt)
      if (!deletingRoot) errors.push(`Source document "${document.title}" may only be removed with its owning job or resume.`)
    }
    if (candidate && owners.some((owner) => removedKeys.has(lifecycleKey(owner))) &&
      !next.jobs.some((job) => job.documentId === document.id) && !next.resumes.some((resume) => resume.documentId === document.id)) {
      errors.push(`Deleting the last owner of source document "${document.title}" must remove its unused document as well.`)
    }
  }
  for (const document of next.documents) {
    if (!previous.documents.some((item) => item.id === document.id)) {
      if (rootLocked) errors.push(`The archived workspace cannot receive new source document "${document.title}".`)
      if (!next.jobs.some((job) => job.documentId === document.id) && !next.resumes.some((resume) => resume.documentId === document.id)) {
        errors.push(`New source document "${document.title}" needs a live owning job or resume; deleted source artifacts cannot be restored alone.`)
      }
    }
  }
  for (const run of next.runs) {
    const old = previous.runs.find((item) => item.id === run.id)
    if (!old) {
      errors.push(...newAnalysisErrors(availablePrevious, next, run))
      continue
    }
    if (!sameValue(old.targets, run.targets) || !sameValue(old.resumes, run.resumes)) {
      errors.push(`Analysis "${run.name}" must preserve its captured source snapshots. Create a new analysis to use other inputs.`)
    }
    for (const comparison of old.comparisons.filter((item) => item.status === 'complete')) {
      if (!sameValue(comparison, run.comparisons.find((item) => item.id === comparison.id))) {
        errors.push(`Analysis "${run.name}" must preserve its completed results.`)
      }
    }
    if (locked({ kind: 'analysis', id: run.id }) && !cancellationOnly(old, run)) {
      errors.push(`Archived analysis "${run.name}" is read-only. Only cancelling unfinished comparisons or deleting the analysis is allowed.`)
    }
    if (isEntityArchived(next, { kind: 'analysis', id: run.id }) && run.comparisons.some((item) => item.status === 'queued' || item.status === 'running')) {
      errors.push(`Archive must cancel unfinished comparisons in "${run.name}". Unarchive does not restart them.`)
    }
  }
  return [...new Set(errors)]
}

export function isLifecycleManagementTransition(previous: Workspace, next: Workspace): boolean {
  return workspaceLifecycleTransitionErrors(previous, next, { lifecycleOnly: true }).length === 0
}
