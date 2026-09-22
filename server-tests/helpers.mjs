// Shared test support for server-tests/*.test.mjs. Not itself a test file (no ".test." in the
// name), so `node --test server-tests/*.test.mjs` does not try to run it directly.
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, WorkspaceRepository, StoreConflictError, StoreNotFoundError, defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor } from '../dist-server/app.mjs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIST_DIR = path.join(currentDir, 'fixtures', 'dist')

// Stable test identities; admission is determined by role claims, not an OID allowlist.
export const TENANT_ID = '228db43d-371a-49d8-864e-fa202d181ea5'
export const ALLOWED_OID = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
// A second admitted user for workspace isolation and sharing tests.
export const OTHER_ALLOWED_OID = '2f9b6a10-6a3d-4e26-9b8b-2a6f6e9d9a11'
export const NOT_ALLOWED_OID = '9c9c9c9c-9c9c-9c9c-9c9c-9c9c9c9c9c9c'
export const OTHER_TENANT_ID = '00000000-1111-2222-3333-444444444444'

export const APP_ORIGIN = 'https://app-score-test.azurewebsites.net'
export const CSRF_HEADER = { 'X-Score-Request': 'workspace' }

export { StoreConflictError, StoreNotFoundError, defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor }

/** Builds a membership doc with the exact deterministic id the real repository looks up by. */
export function membershipFor(workspaceId, { tenantId = TENANT_ID, oid, role, name, email }) {
  const principalId = principalKeyFor(tenantId, oid)
  return { id: membershipIdFor(principalId), workspaceId, principalId, principalType: 'user', role,
    ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) }
}

export function baseConfig(overrides = {}) {
  return {
    authMode: 'easyauth',
    tenantId: TENANT_ID,
    managedIdentityClientId: undefined,
    cosmos: { endpoint: 'https://example-cosmos.documents.azure.com:443/', database: 'score', container: 'workspaces' },
    storage: { accountUrl: 'https://example.blob.core.windows.net', containerName: 'workspace-state' },
    appOrigin: APP_ORIGIN,
    isProduction: false,
    isAppService: false,
    ...overrides,
  }
}

/** Builds a base64 x-ms-client-principal value shaped like real Azure App Service Easy Auth output. */
export function easyAuthPrincipalHeader(options = {}) {
  const {
    tenantId = TENANT_ID,
    oid = ALLOWED_OID,
    authType = 'aad',
    name = 'Test User',
    email = 'test.user@example.com',
    roles = ['Score.User'],
    extraClaims = [],
    useLongClaimUris = false,
  } = options
  const tenantClaimType = useLongClaimUris ? 'http://schemas.microsoft.com/identity/claims/tenantid' : 'tid'
  const oidClaimType = useLongClaimUris ? 'http://schemas.microsoft.com/identity/claims/objectidentifier' : 'oid'
  const principal = {
    auth_typ: authType,
    claims: [
      { typ: tenantClaimType, val: tenantId },
      { typ: oidClaimType, val: oid },
      { typ: 'name', val: name },
      { typ: 'preferred_username', val: email },
      ...roles.map(role => ({ typ: 'roles', val: role })),
      ...extraClaims,
    ],
    name_typ: 'name',
    role_typ: 'roles',
  }
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64')
}

export function authHeaders(options = {}) {
  const { principalIdHeader, ...principalOptions } = options
  const headers = { 'x-ms-client-principal': easyAuthPrincipalHeader(principalOptions) }
  if (principalIdHeader !== undefined) headers['x-ms-client-principal-id'] = principalIdHeader
  return headers
}

/**
 * In-memory stand-in for the real Cosmos-backed DirectoryStore. Implements the exact same
 * check-then-atomic-create contract (create fails/no-ops if the metadata already exists) so the
 * real repository/auth code under test observes the same semantics it would against Cosmos.
 */
export function createFakeDirectoryStore() {
  const partitions = new Map()
  const clone = value => structuredClone(value)
  let etagCounter = 0
  let metadataReadCount = 0
  let accessError = null
  let transactionError = null
  const nextEtag = () => `"dir-etag-${(etagCounter += 1)}"`

  return {
    async getMetadata(workspaceId) {
      metadataReadCount++
      const entry = partitions.get(workspaceId)?.get('workspace')
      return entry ? { metadata: clone(entry.doc), etag: entry.etag } : undefined
    },
    async getMembership(workspaceId, membershipId) {
      const entry = partitions.get(workspaceId)?.get(membershipId)
      return entry ? clone(entry.doc) : undefined
    },
    async listMembershipsForPrincipal(principalKey) {
      const results = []
      for (const partition of partitions.values()) {
        for (const [id, entry] of partition) {
          if (id !== 'workspace' && entry.doc.principalType === 'user' && entry.doc.principalId === principalKey) results.push(clone(entry.doc))
        }
      }
      return results
    },
    async listMetadataForTenant(tenantId) {
      return [...partitions.values()].map(partition => partition.get('workspace'))
        .filter(entry => entry?.doc.tenantId === tenantId)
        .map(entry => ({ metadata: clone(entry.doc), etag: entry.etag }))
    },
    async listWorkspaceMemberships(workspaceId) {
      return [...(partitions.get(workspaceId)?.values() ?? [])]
        .filter(entry => entry.doc.principalType === 'user')
        .map(entry => ({ membership: clone(entry.doc), etag: entry.etag }))
    },
    async changeMembership({ metadata, expectedMetadataEtag, memberId, membership, expectedMemberEtag, audit }) {
      if (transactionError) throw transactionError
      const partition = partitions.get(metadata.workspaceId)
      const current = partition?.get('workspace')
      const member = partition?.get(memberId)
      if (!expectedMetadataEtag || expectedMetadataEtag === '*' || current?.etag !== expectedMetadataEtag ||
        (!membership && !expectedMemberEtag) ||
        (expectedMemberEtag ? member?.etag !== expectedMemberEtag : member !== undefined) ||
        partition.has(audit.id)) throw new StoreConflictError('Workspace access changed.')
      const etag = nextEtag()
      partition.set('workspace', { doc: clone(metadata), etag })
      if (membership) partition.set(memberId, { doc: clone(membership), etag: nextEtag() })
      else partition.delete(memberId)
      partition.set(audit.id, { doc: clone({ ...audit, workspaceId: metadata.workspaceId }), etag: nextEtag() })
      return { metadata: clone(metadata), etag }
    },
    async createWorkspace(metadata, membership) {
      // Synchronous check-then-write with no `await` in between: JavaScript's single-threaded
      // execution makes this atomic regardless of how many callers race to invoke it, the same
      // guarantee Cosmos's server-side item "create" gives against a duplicate id.
      let partition = partitions.get(metadata.workspaceId)
      if (!partition) {
        partition = new Map()
        partitions.set(metadata.workspaceId, partition)
      }
      if (partition.has('workspace')) return { created: false }
      partition.set('workspace', { doc: clone(metadata), etag: nextEtag() })
      partition.set(membership.id, { doc: clone(membership), etag: nextEtag() })
      return { created: true }
    },
    async renameWorkspace(workspaceId, name, updatedAt, expectedEtag) {
      const partition = partitions.get(workspaceId)
      const entry = partition?.get('workspace')
      if (!entry) throw new StoreNotFoundError('Workspace metadata not found.')
      if (entry.etag !== expectedEtag) throw new StoreConflictError('The workspace changed since it was last loaded.')
      const updated = { ...entry.doc, name, updatedAt }
      const etag = nextEtag()
      partition.set('workspace', { doc: updated, etag })
      return { metadata: clone(updated), etag }
    },
    async replaceMetadata(metadata, expectedEtag) {
      const partition = partitions.get(metadata.workspaceId)
      const entry = partition?.get('workspace')
      if (!entry) throw new StoreNotFoundError()
      if (entry.etag !== expectedEtag) throw new StoreConflictError()
      const etag = nextEtag()
      partition.set('workspace', { doc: clone(metadata), etag })
      if (metadata.deletedAt && metadata.lifecycleOperation?.action === 'delete' && metadata.lifecycleOperation.status === 'complete') {
        partition.delete(membershipIdFor(metadata.deletionRecoveryPrincipalId ?? metadata.ownerId))
      }
      return { metadata: clone(metadata), etag }
    },
    async deleteMemberships(workspaceId) {
      const partition = partitions.get(workspaceId)
      if (!partition) return
      const metadata = partition.get('workspace')?.doc
      if (!metadata) throw new StoreNotFoundError()
      const ownerId = membershipIdFor(metadata.deletionRecoveryPrincipalId ?? metadata.ownerId)
      for (const [id, entry] of partition) {
        if (entry.doc.principalType === 'user' && id !== ownerId) partition.delete(id)
      }
    },
    async listLifecycleOperations(limit) {
      return [...partitions.values()].map(partition => partition.get('workspace'))
        .filter(entry => entry?.doc.lifecycleOperation && entry.doc.lifecycleOperation.status !== 'complete')
        .slice(0, limit).map(entry => ({ metadata: clone(entry.doc), etag: entry.etag }))
    },
    async deleteWorkspace(workspaceId, ownerMembershipId) {
      const partition = partitions.get(workspaceId)
      if (!partition) return
      partition.delete('workspace')
      partition.delete(ownerMembershipId)
      if (partition.size === 0) partitions.delete(workspaceId)
    },
    async checkAccess() {
      if (accessError) throw accessError
    },
    // Test-only escape hatches (not part of the production DirectoryStore contract):
    _setAccessError(error) {
      accessError = error
    },
    _setTransactionError(error) {
      transactionError = error
    },
    _audits(workspaceId) {
      return [...(partitions.get(workspaceId)?.values() ?? [])]
        .filter(entry => entry.doc.actorId && entry.doc.action).map(entry => clone(entry.doc))
    },
    _addMembership(workspaceId, membership) {
      let partition = partitions.get(workspaceId)
      if (!partition) {
        partition = new Map()
        partitions.set(workspaceId, partition)
      }
      const previous = partition.get(membership.id)?.doc
      const ownerDelta = Number(membership.principalType === 'user' && membership.role === 'owner') -
        Number(previous?.principalType === 'user' && previous.role === 'owner')
      partition.set(membership.id, { doc: clone(membership), etag: nextEtag() })
      const metadata = partition.get('workspace')
      if (ownerDelta && typeof metadata?.doc.ownerCount === 'number') {
        partition.set('workspace', { doc: { ...metadata.doc, ownerCount: metadata.doc.ownerCount + ownerDelta }, etag: nextEtag() })
      }
    },
    _partitionCount(workspaceId) {
      return partitions.has(workspaceId) ? 1 : 0
    },
    _workspaceCount() {
      return [...partitions.values()].filter(partition => partition.has('workspace')).length
    },
    _metadataReadCount() {
      return metadataReadCount
    },
  }
}

/** In-memory stand-in for the real Blob-backed StateStore, with the same ETag-conditioned contract. */
export function createFakeStateStore() {
  const blobs = new Map()
  const leases = new Set()
  let etagCounter = 0
  let accessError = null
  const nextEtag = () => `"state-etag-${(etagCounter += 1)}"`

  return {
    async getState(workspaceId) {
      const entry = blobs.get(workspaceId)
      return entry ? { content: entry.content, etag: entry.etag } : undefined
    },
    async createState(workspaceId, content) {
      const existing = blobs.get(workspaceId)
      if (existing) return { created: false, etag: existing.etag }
      const etag = nextEtag()
      blobs.set(workspaceId, { content, etag })
      return { created: true, etag }
    },
    async putState(workspaceId, content, expectedEtag) {
      const entry = blobs.get(workspaceId)
      if (!entry || entry.etag !== expectedEtag) throw new StoreConflictError('The workspace state changed since it was last loaded.')
      const etag = nextEtag()
      blobs.set(workspaceId, { content, etag })
      return { etag }
    },
    async deleteState(workspaceId, expectedEtag) {
      if (expectedEtag !== undefined && blobs.has(workspaceId) && blobs.get(workspaceId).etag !== expectedEtag) {
        throw new StoreConflictError()
      }
      blobs.delete(workspaceId)
    },
    async acquireMutationLease(workspaceId) {
      if (leases.has(workspaceId)) throw new StoreConflictError('Another workspace change is in progress.')
      leases.add(workspaceId)
      return {
        async renew() { if (!leases.has(workspaceId)) throw new StoreConflictError('Lease lost.') },
        async release() { leases.delete(workspaceId) },
      }
    },
    async checkAccess() {
      if (accessError) throw accessError
    },
    // Test-only escape hatches:
    _setAccessError(error) {
      accessError = error
    },
    _setRawContent(workspaceId, content) {
      const existing = blobs.get(workspaceId)
      blobs.set(workspaceId, { content, etag: existing ? existing.etag : nextEtag() })
    },
  }
}

export function createFakeAccessStore(grants = []) {
  const values = new Map()
  const audits = new Map()
  let sequence = 0, readError, writeError
  const key = (tenantId, userId) => `${tenantId}:${userId}`
  const save = grant => values.set(key(grant.tenantId, grant.userId), {
    grant: structuredClone(grant), etag: `"access-${++sequence}"`,
  })
  for (const grant of grants) {
    save({ id: `grant-${grant.userId}`, tenantId: TENANT_ID, canCreateWorkspaces: true, ...grant })
  }
  return {
    async getGrant(tenantId, userId) {
      if (readError) throw readError
      return structuredClone(values.get(key(tenantId, userId)))
    },
    async setGrant(grant, expectedEtag, audit) {
      if (writeError) throw writeError
      const existing = values.get(key(grant.tenantId, grant.userId))
      if ((expectedEtag ? existing?.etag !== expectedEtag : existing !== undefined) || audits.has(audit.id)) {
        throw new StoreConflictError('Creation permission changed.')
      }
      save(grant)
      audits.set(audit.id, structuredClone(audit))
    },
    _audits() { return [...audits.values()].map(value => structuredClone(value)) },
    _setReadError(error) { readError = error },
    _setWriteError(error) { writeError = error },
  }
}

export function createFakeEligibleUsers(users = [
  { id: ALLOWED_OID, name: 'Test User', email: 'test.user@example.com', applicationRoles: ['Score.User'] },
  { id: OTHER_ALLOWED_OID, name: 'Other User', email: 'other.user@example.com', applicationRoles: ['Score.User'] },
]) {
  const values = new Map(users.map(user => [user.id, structuredClone(user)]))
  const calls = []
  let error
  return {
    calls,
    async get(userId) {
      calls.push({ method: 'get', userId })
      if (error) throw error
      return structuredClone(values.get(userId))
    },
    async search(query, continuation) {
      calls.push({ method: 'search', query, continuation })
      if (error) throw error
      const matching = [...values.values()].filter(user =>
        `${user.name} ${user.email}`.toLowerCase().includes(query.toLowerCase()))
      return { users: structuredClone(matching) }
    },
    _setError(value) { error = value },
    _set(user) { values.set(user.id, structuredClone(user)) },
    _remove(userId) { values.delete(userId) },
  }
}

/** Explicit feature fixture, independent of session reads and creation-grant API policy. */
export async function seedWorkspace({ directory, state, now }, options = {}) {
  const { tenantId = TENANT_ID, oid = ALLOWED_OID, name = 'Fixture workspace' } = options
  const principal = {
    tenantId, oid, principalKey: principalKeyFor(tenantId, oid),
    name: options.ownerName ?? 'Test User', email: options.ownerEmail ?? 'test.user@example.com',
    applicationRoles: options.applicationRoles ?? ['Score.User'],
  }
  return new WorkspaceRepository({ directory, state, now }).createWorkspace(principal, name)
}

/** Empty by default. Feature tests opt into a fixture with { seedWorkspace: true }. */
export async function startTestServer(overrides = {}) {
  const directory = overrides.directory ?? createFakeDirectoryStore()
  const state = overrides.state ?? createFakeStateStore()
  const config = overrides.config ?? baseConfig()
  const distDir = overrides.distDir ?? FIXTURE_DIST_DIR
  const accessStore = overrides.accessStore ?? createFakeAccessStore()
  const eligibleUsers = overrides.eligibleUsers ?? createFakeEligibleUsers()
  const fixtureWorkspace = overrides.seedWorkspace
    ? await seedWorkspace({ directory, state, now: overrides.now }, overrides.seedWorkspace === true ? {} : overrides.seedWorkspace)
    : undefined
  const app = createApp({
    config, directory, state, distDir, accessStore, eligibleUsers, now: overrides.now,
    jobs: overrides.jobs, grades: overrides.grades, resumes: overrides.resumes,
    analyses: overrides.analyses, settings: overrides.settings,
  })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  async function close() {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  return { app, server, baseUrl, directory, state, config, accessStore, eligibleUsers, fixtureWorkspace, close }
}

export function sampleWorkspaceBody() {
  return {
    schemaVersion: 1,
    jobs: [],
    resumes: [],
    documents: [],
    rubrics: [],
    runs: [],
  }
}
