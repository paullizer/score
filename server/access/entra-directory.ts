import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { TokenCredential } from '@azure/core-auth'
import type { ApplicationRole, EligibleUser, EligibleUserPage } from '../../src/domain/access'
import { HttpError, invalidRequest } from '../errors'
import { GUID_PATTERN } from '../ids'
import type { EligibleUserDirectory } from './directory'
import type { AccessConfig } from './store'

const GRAPH_ORIGIN = 'https://graph.microsoft.com'
const GRAPH_ROOT = `${GRAPH_ORIGIN}/v1.0`
const PROFILE_FIELDS = 'id,displayName,mail,userPrincipalName'
const ROLE_ORDER: readonly ApplicationRole[] = ['Score.Admin', 'Score.User']

export class EntraDirectoryError extends HttpError {
  constructor(
    readonly reason: 'permission' | 'throttled' | 'timeout' | 'upstream' | 'configuration',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(503, 'unavailable', message)
    this.name = 'EntraDirectoryError'
  }
}

export interface EntraDirectoryOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<unknown>
  readonly pageSize?: number
  readonly requestTimeoutMs?: number
  readonly operationTimeoutMs?: number
  readonly continuationTtlMs?: number
}

type GraphObject = Record<string, unknown>
interface Snapshot {
  readonly query: string
  readonly users: EligibleUser[]
  readonly offset: number
  readonly expiresAt: number
}

function object(value: unknown): GraphObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EntraDirectoryError('upstream', 'The eligible-user directory returned an invalid response.')
  }
  return value as GraphObject
}

function graphUrl(value: string, expectedPath?: string): URL {
  let url: URL
  try { url = new URL(value) } catch {
    throw new EntraDirectoryError('upstream', 'The eligible-user directory returned an invalid continuation.')
  }
  if (url.origin !== GRAPH_ORIGIN || url.username || url.password || url.hash ||
    !url.pathname.startsWith('/v1.0/') || (expectedPath && url.pathname !== expectedPath)) {
    throw new EntraDirectoryError('upstream', 'The eligible-user directory returned an unsafe continuation.')
  }
  return url
}

function guid(value: unknown): string {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new EntraDirectoryError('upstream', 'The eligible-user directory returned an invalid object ID.')
  }
  return value.toLowerCase()
}

function displayField(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw new EntraDirectoryError('upstream', 'The eligible-user directory returned an invalid user profile.')
  return value
}

/** Read-only Graph adapter. Authorization for using it belongs to the API routes, not the browser. */
export function createEntraDirectory(
  config: AccessConfig,
  credential: TokenCredential,
  options: EntraDirectoryOptions = {},
): EligibleUserDirectory {
  if (!GUID_PATTERN.test(config.servicePrincipalId)) throw new Error('The Score service principal must be an object-ID GUID.')
  const servicePrincipalId = config.servicePrincipalId.toLowerCase()
  const fetchGraph = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const pageSize = options.pageSize ?? 50
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const operationTimeoutMs = options.operationTimeoutMs ?? 120_000
  const continuationTtlMs = options.continuationTtlMs ?? 300_000
  for (const value of [pageSize, requestTimeoutMs, operationTimeoutMs, continuationTtlMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Directory limits must be positive integers.')
  }
  const continuations = new Map<string, Snapshot>()

  async function read(url: URL, deadline: number, missingUserAllowed = false): Promise<GraphObject | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new EntraDirectoryError('timeout', 'Eligible-user lookup timed out. Retry the search.')
      const signal = AbortSignal.timeout(Math.min(requestTimeoutMs, remaining))
      let response: Response
      try {
        const token = await credential.getToken(`${GRAPH_ORIGIN}/.default`, { abortSignal: signal })
        if (!token?.token) throw new EntraDirectoryError('permission', 'The API managed identity could not obtain a directory token.')
        response = await fetchGraph(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
          redirect: 'error',
          signal,
        })
        if (response.ok) return object(await response.json())
      } catch (error) {
        if (error instanceof EntraDirectoryError) throw error
        if (signal.aborted) throw new EntraDirectoryError('timeout', 'Eligible-user lookup timed out. Retry the search.')
        throw new EntraDirectoryError('upstream', 'Eligible-user lookup failed. Retry after directory connectivity is restored.')
      }
      await response.body?.cancel()
      if (missingUserAllowed && response.status === 404) return undefined
      if (response.status === 401 || response.status === 403) {
        throw new EntraDirectoryError('permission',
          'Directory access was denied. Verify the API identity read-only Graph consent; hidden-membership groups additionally require explicitly approved Member.Read.Hidden.')
      }
      if (response.status === 429 || response.status === 503) {
        const retryHeader = response.headers.get('retry-after')
        const seconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) :
          retryHeader ? Math.max(0, Math.ceil((Date.parse(retryHeader) - now()) / 1000)) : 1
        const waitSeconds = Number.isFinite(seconds) ? seconds : 1
        if (attempt < 2 && waitSeconds <= 5 && now() + waitSeconds * 1000 < deadline) {
          await sleep(waitSeconds * 1000)
          continue
        }
        throw new EntraDirectoryError('throttled', 'The directory is busy. Retry the eligible-user lookup later.', waitSeconds)
      }
      throw new EntraDirectoryError('upstream', 'The directory could not complete eligible-user lookup. No partial result was returned.')
    }
    throw new EntraDirectoryError('upstream', 'Eligible-user lookup failed.')
  }

  async function* collection(path: string, deadline: number): AsyncGenerator<GraphObject> {
    let next: string | undefined = `${GRAPH_ROOT}${path}`
    const expectedPath = graphUrl(next).pathname
    const visited = new Set<string>()
    while (next) {
      const url = graphUrl(next, expectedPath)
      if (visited.has(url.href)) throw new EntraDirectoryError('upstream', 'The directory repeated a continuation. Retry the search.')
      visited.add(url.href)
      const page = (await read(url, deadline))!
      if (!Array.isArray(page.value)) throw new EntraDirectoryError('upstream', 'The directory returned an invalid result page.')
      for (const entry of page.value) yield object(entry)
      const continuation = page['@odata.nextLink']
      if (continuation !== undefined && (typeof continuation !== 'string' || !continuation.length)) {
        throw new EntraDirectoryError('upstream', 'The directory returned an invalid continuation.')
      }
      next = continuation as string | undefined
    }
  }

  async function eligibleIds(deadline: number): Promise<Map<string, Set<ApplicationRole>>> {
    const principal = (await read(graphUrl(`${GRAPH_ROOT}/servicePrincipals/${servicePrincipalId}?$select=id,appRoles,appRoleAssignmentRequired`), deadline))!
    if (guid(principal.id) !== servicePrincipalId || principal.appRoleAssignmentRequired !== true || !Array.isArray(principal.appRoles)) {
      throw new EntraDirectoryError('configuration', 'Score must require Enterprise Application assignment with enabled user application roles.')
    }
    const roleIds = new Map<string, ApplicationRole>()
    for (const entry of principal.appRoles) {
      const role = object(entry)
      if (!ROLE_ORDER.includes(role.value as ApplicationRole)) continue
      if (role.isEnabled !== true || !Array.isArray(role.allowedMemberTypes) ||
        role.allowedMemberTypes.length !== 1 || role.allowedMemberTypes[0] !== 'User' ||
        [...roleIds.values()].includes(role.value as ApplicationRole)) {
        throw new EntraDirectoryError('configuration', 'Score application roles must be unique, enabled, and user/group-only.')
      }
      roleIds.set(guid(role.id), role.value as ApplicationRole)
    }
    if (roleIds.size !== ROLE_ORDER.length) throw new EntraDirectoryError('configuration', 'Both Score.User and Score.Admin application roles must be provisioned.')
    const users = new Map<string, Set<ApplicationRole>>()
    const groups = new Map<string, Set<ApplicationRole>>()
    function merge(target: Map<string, Set<ApplicationRole>>, id: string, roles: Iterable<ApplicationRole>) {
      const set = target.get(id) ?? new Set<ApplicationRole>()
      for (const role of roles) set.add(role)
      target.set(id, set)
    }
    for await (const assignment of collection(`/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$select=principalId,principalType,appRoleId,resourceId`, deadline)) {
      if (typeof assignment.resourceId !== 'string' || assignment.resourceId.toLowerCase() !== servicePrincipalId) continue
      const role = typeof assignment.appRoleId === 'string' ? roleIds.get(assignment.appRoleId.toLowerCase()) : undefined
      if (!role || (assignment.principalType !== 'User' && assignment.principalType !== 'Group')) continue
      merge(assignment.principalType === 'User' ? users : groups, guid(assignment.principalId), [role])
    }
    for (const [id, roles] of groups) {
      // Deliberately not transitive: nested groups do not confer Enterprise Application admission.
      for await (const member of collection(`/groups/${id}/members?$select=id`, deadline)) {
        if (member['@odata.type'] === '#microsoft.graph.user') merge(users, guid(member.id), roles)
        else if (typeof member['@odata.type'] !== 'string') {
          throw new EntraDirectoryError('upstream', 'The directory did not identify an assigned group member type.')
        }
      }
    }
    return users
  }

  async function profile(id: string, roles: Set<ApplicationRole>, deadline: number): Promise<EligibleUser | undefined> {
    const user = await read(graphUrl(`${GRAPH_ROOT}/users/${id}?$select=${PROFILE_FIELDS}`), deadline, true)
    if (!user) return undefined
    if (guid(user.id) !== id || (user['@odata.type'] !== undefined && user['@odata.type'] !== '#microsoft.graph.user')) {
      throw new EntraDirectoryError('upstream', 'The directory returned an inconsistent user profile.')
    }
    return {
      id, name: displayField(user.displayName), email: displayField(user.mail) || displayField(user.userPrincipalName),
      applicationRoles: ROLE_ORDER.filter(role => roles.has(role)),
    }
  }

  function page(snapshot: Snapshot): EligibleUserPage {
    const users = snapshot.users.slice(snapshot.offset, snapshot.offset + pageSize).map(user => ({
      ...user, applicationRoles: [...user.applicationRoles],
    }))
    if (snapshot.offset + pageSize >= snapshot.users.length) return { users }
    for (const [key, value] of continuations) if (value.expiresAt <= now()) continuations.delete(key)
    // Bound cached searches, not directory/user results. Evicted continuations fail explicitly.
    if (continuations.size >= 100) continuations.delete(continuations.keys().next().value!)
    const continuation = randomBytes(24).toString('base64url')
    continuations.set(continuation, { ...snapshot, offset: snapshot.offset + pageSize })
    return { users, continuation }
  }

  return {
    async search(query, continuation) {
      if (typeof query !== 'string' || query.length > 200) throw invalidRequest('Directory search must be at most 200 characters.')
      const normalized = query.trim().toLowerCase()
      if (continuation !== undefined) {
        const snapshot = continuations.get(continuation)
        if (!snapshot || snapshot.expiresAt <= now() || snapshot.query !== normalized) {
          throw invalidRequest('This directory search expired or changed. Start a new search.')
        }
        return page(snapshot)
      }
      const deadline = now() + operationTimeoutMs
      const ids = await eligibleIds(deadline)
      const users: EligibleUser[] = []
      const entries = [...ids]
      let index = 0
      await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (index < entries.length) {
          const [id, roles] = entries[index++]
          const user = await profile(id, roles, deadline)
          if (user && (!normalized || `${user.name}\n${user.email}`.toLowerCase().includes(normalized))) users.push(user)
        }
      }))
      users.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email) || a.id.localeCompare(b.id))
      return page({ query: normalized, users, offset: 0, expiresAt: now() + continuationTtlMs })
    },
    async get(userId) {
      if (!GUID_PATTERN.test(userId)) throw invalidRequest('An Entra user object-ID GUID is required.')
      const id = userId.toLowerCase()
      const deadline = now() + operationTimeoutMs
      // Do not trust a search snapshot when granting access: re-read current assignments/membership.
      const roles = (await eligibleIds(deadline)).get(id)
      return roles ? profile(id, roles, deadline) : undefined
    },
  }
}
