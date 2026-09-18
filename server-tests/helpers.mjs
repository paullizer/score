// Shared test support for server-tests/*.test.mjs. Not itself a test file (no ".test." in the
// name), so `node --test server-tests/*.test.mjs` does not try to run it directly.
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, StoreConflictError, StoreNotFoundError, defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor } from '../dist-server/app.mjs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIST_DIR = path.join(currentDir, 'fixtures', 'dist')

// Matches the tenant/OID supplied by the task: the real deployment's single authorized user.
export const TENANT_ID = '228db43d-371a-49d8-864e-fa202d181ea5'
export const ALLOWED_OID = '1d6312bd-3eaa-4586-8b74-e90eee126f78'
// A second, independently allow-listed user, used to test workspace isolation between two
// legitimately authorized principals (not just "authorized vs. unauthorized").
export const OTHER_ALLOWED_OID = '2f9b6a10-6a3d-4e26-9b8b-2a6f6e9d9a11'
export const NOT_ALLOWED_OID = '9c9c9c9c-9c9c-9c9c-9c9c-9c9c9c9c9c9c'
export const OTHER_TENANT_ID = '00000000-1111-2222-3333-444444444444'

export const APP_ORIGIN = 'https://app-score-test.azurewebsites.net'
export const CSRF_HEADER = { 'X-Score-Request': 'workspace' }

export { StoreConflictError, StoreNotFoundError, defaultPersonalWorkspaceId, isValidWorkspaceId, membershipIdFor, principalKeyFor }

/** Builds a membership doc with the exact deterministic id the real repository looks up by. */
export function membershipFor(workspaceId, { tenantId = TENANT_ID, oid, role }) {
  const principalId = principalKeyFor(tenantId, oid)
  return { id: membershipIdFor(principalId), workspaceId, principalId, principalType: 'user', role }
}

export function baseConfig(overrides = {}) {
  return {
    authMode: 'easyauth',
    tenantId: TENANT_ID,
    allowedUserIds: new Set([ALLOWED_OID, OTHER_ALLOWED_OID]),
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
  let etagCounter = 0
  let accessError = null
  const nextEtag = () => `"dir-etag-${(etagCounter += 1)}"`

  return {
    async getMetadata(workspaceId) {
      const entry = partitions.get(workspaceId)?.get('workspace')
      return entry ? { metadata: entry.doc, etag: entry.etag } : undefined
    },
    async getMembership(workspaceId, membershipId) {
      const entry = partitions.get(workspaceId)?.get(membershipId)
      return entry ? entry.doc : undefined
    },
    async listMembershipsForPrincipal(principalKey) {
      const results = []
      for (const partition of partitions.values()) {
        for (const [id, entry] of partition) {
          if (id !== 'workspace' && entry.doc.principalId === principalKey) results.push(entry.doc)
        }
      }
      return results
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
      partition.set('workspace', { doc: metadata, etag: nextEtag() })
      partition.set(membership.id, { doc: membership, etag: nextEtag() })
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
      return { metadata: updated, etag }
    },
    async replaceMetadata(metadata, expectedEtag) {
      const partition = partitions.get(metadata.workspaceId)
      const entry = partition?.get('workspace')
      if (!entry) throw new StoreNotFoundError()
      if (entry.etag !== expectedEtag) throw new StoreConflictError()
      const etag = nextEtag()
      partition.set('workspace', { doc: metadata, etag })
      if (metadata.deletedAt && metadata.lifecycleOperation?.action === 'delete' && metadata.lifecycleOperation.status === 'complete') {
        partition.delete(membershipIdFor(metadata.ownerId))
      }
      return { metadata, etag }
    },
    async deleteMemberships(workspaceId) {
      const partition = partitions.get(workspaceId)
      if (!partition) return
      const ownerId = membershipIdFor(partition.get('workspace').doc.ownerId)
      for (const [id, entry] of partition) {
        if (entry.doc.principalType === 'user' && id !== ownerId) partition.delete(id)
      }
    },
    async listLifecycleOperations(limit) {
      return [...partitions.values()].map(partition => partition.get('workspace'))
        .filter(entry => entry?.doc.lifecycleOperation && entry.doc.lifecycleOperation.status !== 'complete')
        .slice(0, limit).map(entry => ({ metadata: entry.doc, etag: entry.etag }))
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
    _addMembership(workspaceId, membership) {
      let partition = partitions.get(workspaceId)
      if (!partition) {
        partition = new Map()
        partitions.set(workspaceId, partition)
      }
      partition.set(membership.id, { doc: membership, etag: nextEtag() })
    },
    _partitionCount(workspaceId) {
      return partitions.has(workspaceId) ? 1 : 0
    },
    _workspaceCount() {
      return partitions.size
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

/** Starts the real Express app (built from server/app.ts) on an ephemeral local port for a test. */
export async function startTestServer(overrides = {}) {
  const directory = overrides.directory ?? createFakeDirectoryStore()
  const state = overrides.state ?? createFakeStateStore()
  const config = overrides.config ?? baseConfig()
  const distDir = overrides.distDir ?? FIXTURE_DIST_DIR
  const app = createApp({ config, directory, state, distDir, now: overrides.now, jobs: overrides.jobs, grades: overrides.grades })
  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  async function close() {
    await new Promise((resolve) => server.close(() => resolve()))
  }

  return { app, server, baseUrl, directory, state, config, close }
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
