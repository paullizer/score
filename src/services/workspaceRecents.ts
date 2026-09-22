import type { WorkspaceSummary } from '../domain/cloud'
import { readLastWorkspaceId } from './cloudWorkspace'

export interface RecentWorkspace {
  id: string
  lastOpenedAt: string | null
}

export const MAX_RECENT_WORKSPACES = 10

function preferenceKey(tenantId: string, userId: string): string {
  return `score-cloud-recent-workspaces:${tenantId}:${userId}`
}

function isRecentWorkspace(value: unknown): value is RecentWorkspace {
  if (!value || typeof value !== 'object' || !('id' in value) || !('lastOpenedAt' in value)) return false
  return typeof value.id === 'string' && /^[\w-]{1,128}$/.test(value.id) &&
    (value.lastOpenedAt === null || (typeof value.lastOpenedAt === 'string' && Number.isFinite(Date.parse(value.lastOpenedAt))))
}

function normalize(entries: readonly RecentWorkspace[]): RecentWorkspace[] {
  const sorted = [...entries].sort((a, b) =>
    (b.lastOpenedAt === null ? -Infinity : Date.parse(b.lastOpenedAt)) -
    (a.lastOpenedAt === null ? -Infinity : Date.parse(a.lastOpenedAt)) || a.id.localeCompare(b.id))
  return sorted.filter((entry, index) => sorted.findIndex((item) => item.id === entry.id) === index)
    .slice(0, MAX_RECENT_WORKSPACES).map(({ id, lastOpenedAt }) => ({ id, lastOpenedAt }))
}

export function readRecentWorkspaces(tenantId: string, userId: string): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(preferenceKey(tenantId, userId))
    if (raw !== null) {
      if (raw.length > 16_384) throw new SyntaxError('Recent workspace preference is too large.')
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
        !('entries' in value) || !Array.isArray(value.entries)) throw new SyntaxError('Invalid recent workspace preference.')
      const entries: unknown[] = value.entries
      if (entries.some((entry) => !isRecentWorkspace(entry)) || entries.length > MAX_RECENT_WORKSPACES) {
        console.warn('Score ignored invalid or excess recent workspace preferences.')
      }
      return normalize(entries.filter(isRecentWorkspace))
    }
    const previous = readLastWorkspaceId(tenantId, userId)
    return previous && isRecentWorkspace({ id: previous, lastOpenedAt: null }) ? [{ id: previous, lastOpenedAt: null }] : []
  } catch (error) {
    if (!(error instanceof DOMException) && !(error instanceof SyntaxError)) throw error
    console.warn('Score could not read recent workspace preferences. Cloud content is unaffected.', error.name)
    return []
  }
}

export function writeRecentWorkspaces(tenantId: string, userId: string, entries: readonly RecentWorkspace[]): void {
  try {
    localStorage.setItem(preferenceKey(tenantId, userId), JSON.stringify({ version: 1, entries: normalize(entries) }))
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    console.warn('Score could not remember recent workspaces. Cloud content is unaffected.', error.name)
  }
}

export function pruneRecentWorkspaces(entries: readonly RecentWorkspace[], workspaces: readonly WorkspaceSummary[]): RecentWorkspace[] {
  const available = new Set(workspaces.filter((item) => !item.deletedAt).map((item) => item.id))
  return normalize(entries.filter((entry) => available.has(entry.id)))
}

export function recordWorkspaceVisit(entries: readonly RecentWorkspace[], id: string, lastOpenedAt = new Date().toISOString()): RecentWorkspace[] {
  const visit = { id, lastOpenedAt }
  if (!isRecentWorkspace(visit)) throw new Error('A workspace visit requires a valid workspace ID and timestamp.')
  return normalize([visit, ...entries.filter((entry) => entry.id !== id)])
}

export function isActiveWorkspace(workspace: WorkspaceSummary): boolean {
  return !workspace.archivedAt && !workspace.deletedAt && (!workspace.lifecycleOperation || workspace.lifecycleOperation.status === 'complete')
}
