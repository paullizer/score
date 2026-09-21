import { CosmosClient, ErrorResponse } from '@azure/cosmos'
import type { Container, OperationInput } from '@azure/cosmos'
import type { TokenCredential } from '@azure/identity'
import { z } from 'zod'
import { adminSettingsSchema } from '../../src/domain/admin-settings'
import type { SettingsRevision } from '../../src/domain/admin-settings'
import { StoreConflictError } from '../store'
import { GUID_PATTERN } from '../ids'
import { SETTINGS_APPLICATION_ID } from './store'
import type { SettingsConfig, SettingsReader, SettingsStore, StoredSettings } from './store'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const actor = z.union([
  z.strictObject({ tenantId: z.string().regex(GUID_PATTERN), oid: z.string().regex(GUID_PATTERN) }),
  z.strictObject({ system: z.literal('initialization') }),
])
export const settingsRevisionMetadataSchema = z.strictObject({
  revision: id, previousRevision: id.nullable(), createdAt: z.iso.datetime(), actor,
  reason: z.enum(['initialize', 'patch', 'restore', 'import']), restoredFrom: id.optional(),
  changes: z.array(z.strictObject({ path: z.string().max(300), before: z.unknown(), after: z.unknown() })).max(500),
})
export const settingsRevisionSchema: z.ZodType<SettingsRevision> = settingsRevisionMetadataSchema.extend({ settings: adminSettingsSchema })
const pointerSchema = z.strictObject({
  id: z.literal('current'), applicationId: z.literal(SETTINGS_APPLICATION_ID),
  recordType: z.literal('settings-current'), revision: id,
})
const revisionDocumentSchema = z.strictObject({
  id: z.string(), applicationId: z.literal(SETTINGS_APPLICATION_ID), recordType: z.literal('settings-revision'),
  revision: id, value: settingsRevisionSchema,
})
const auditSchema = z.strictObject({
  id: z.string(), applicationId: z.literal(SETTINGS_APPLICATION_ID), recordType: z.literal('settings-audit'),
  revision: id, value: settingsRevisionMetadataSchema,
})
const cosmosSystemFields = new Set(['_rid', '_self', '_etag', '_attachments', '_ts'])
function withoutSystemFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !cosmosSystemFields.has(key)))
}
function statusOf(error: unknown): number | undefined {
  return error instanceof ErrorResponse && typeof error.code === 'number' ? error.code : undefined
}

export function createAzureSettingsStore(config: SettingsConfig, credential: TokenCredential): SettingsStore {
  if (config.applicationId !== SETTINGS_APPLICATION_ID) throw new Error('Settings must use the isolated Score application partition.')
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createSettingsStoreFromContainer(client.database(config.database).container(config.container))
}

export function createAzureSettingsReader(
  config: Pick<SettingsConfig, 'cosmosEndpoint' | 'database' | 'container' | 'applicationId'>, credential: TokenCredential,
): SettingsReader {
  if (config.applicationId !== SETTINGS_APPLICATION_ID) throw new Error('Settings must use the isolated Score application partition.')
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createSettingsReaderFromContainer(client.database(config.database).container(config.container))
}

export function createSettingsReaderFromContainer(container: Pick<Container, 'item' | 'items'>): SettingsReader {
  const store = createSettingsStoreFromContainer(container)
  return { getCurrent: store.getCurrent, getRevision: store.getRevision }
}

export function createSettingsStoreFromContainer(container: Pick<Container, 'item' | 'items'>): SettingsStore {
  async function read(documentId: string): Promise<{ body: Record<string, unknown>; etag: string } | undefined> {
    let response
    try { response = await container.item(documentId, SETTINGS_APPLICATION_ID).read<Record<string, unknown>>() } catch (error) {
      if (statusOf(error) === 404) return undefined
      throw error
    }
    if (response.statusCode === 404) return undefined
    if (response.statusCode < 200 || response.statusCode >= 300 || !response.resource || typeof response.resource._etag !== 'string') {
      throw new Error('Settings storage returned an invalid document response.')
    }
    return { body: withoutSystemFields(response.resource), etag: response.resource._etag }
  }
  async function getRevision(revision: string): Promise<SettingsRevision | undefined> {
    id.parse(revision)
    const result = await read(`revision:${revision}`)
    if (!result) return undefined
    const doc = revisionDocumentSchema.parse(result.body)
    if (doc.id !== `revision:${revision}` || doc.revision !== revision || doc.value.revision !== revision) {
      throw new Error('The immutable settings revision has inconsistent identity.')
    }
    return doc.value
  }
  async function getCurrent(): Promise<StoredSettings | undefined> {
    const result = await read('current')
    if (!result) return undefined
    const pointer = pointerSchema.parse(result.body)
    const revision = await getRevision(pointer.revision)
    if (!revision) throw new Error('The current settings pointer references a missing immutable revision.')
    return { revision, etag: result.etag }
  }
  async function commit(value: SettingsRevision, expectedEtag?: string): Promise<string | undefined> {
    const revision = settingsRevisionSchema.parse(value)
    const pointer = { id: 'current', applicationId: SETTINGS_APPLICATION_ID, recordType: 'settings-current', revision: revision.revision }
    const metadata = Object.fromEntries(Object.entries(revision).filter(([key]) => key !== 'settings'))
    const operations: OperationInput[] = [
      expectedEtag === undefined
        ? { operationType: 'Create', resourceBody: pointer }
        : { operationType: 'Replace', id: 'current', ifMatch: expectedEtag, resourceBody: pointer },
      { operationType: 'Create', resourceBody: {
        id: `revision:${revision.revision}`, applicationId: SETTINGS_APPLICATION_ID, recordType: 'settings-revision',
        revision: revision.revision, value: JSON.parse(JSON.stringify(revision)),
      } },
      { operationType: 'Create', resourceBody: {
        id: `audit:${revision.revision}`, applicationId: SETTINGS_APPLICATION_ID, recordType: 'settings-audit',
        revision: revision.revision, value: JSON.parse(JSON.stringify(metadata)),
      } },
    ]
    let response
    try { response = await container.items.batch(operations, SETTINGS_APPLICATION_ID) } catch (error) {
      if (statusOf(error) === 409 || statusOf(error) === 412) throw new StoreConflictError('Application settings changed. Reload and review your draft.')
      throw error
    }
    const results = response.result ?? []
    const failure = results.find(result => result.statusCode >= 400 && result.statusCode !== 424)?.statusCode ?? response.code
    if (results.length !== 3 || results.some(result => result.statusCode < 200 || result.statusCode >= 300) ||
      (response.code !== undefined && (response.code < 200 || response.code >= 300))) {
      // A duplicate immutable revision/audit is not proof another initializer won the pointer.
      if (expectedEtag === undefined && results[0]?.statusCode === 409) return undefined
      if (expectedEtag !== undefined && (failure === 412 || failure === 409 || failure === 404)) {
        throw new StoreConflictError('Application settings changed. Reload and review your draft.')
      }
      throw new Error('The settings pointer, revision and audit transaction did not succeed.')
    }
    const etag = results[0]?.eTag
    if (!etag) throw new Error('Settings publication returned no current-pointer ETag.')
    return etag
  }
  return {
    getCurrent, getRevision,
    async initialize(revision) {
      try { return (await commit(revision)) !== undefined } catch (error) {
        if (error instanceof StoreConflictError) {
          // Even a top-level duplicate error is accepted only after confirming a valid pointer.
          if (await getCurrent()) return false
        }
        throw error
      }
    },
    async publish(revision, expectedEtag) {
      if (!expectedEtag || expectedEtag === '*' || expectedEtag.startsWith('W/')) throw new StoreConflictError('An exact current-pointer ETag is required.')
      const etag = await commit(revision, expectedEtag)
      if (!etag) throw new Error('Settings publication returned no current-pointer ETag.')
      return { revision: structuredClone(revision), etag }
    },
    async history(limit, before) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('History page size must be between 1 and 100.')
      if (before !== undefined) id.parse(before)
      const response = await container.items.query<Record<string, unknown>>({
        query: `SELECT TOP @limit * FROM c WHERE c.recordType = @type${before ? ' AND c.revision < @before' : ''} ORDER BY c.revision DESC`,
        parameters: [{ name: '@limit', value: limit + 1 }, { name: '@type', value: 'settings-audit' },
          ...(before ? [{ name: '@before', value: before }] : [])],
      }, { partitionKey: SETTINGS_APPLICATION_ID }).fetchAll()
      const values = response.resources.map(resource => {
        const doc = auditSchema.parse(withoutSystemFields(resource))
        if (doc.id !== `audit:${doc.revision}` || doc.value.revision !== doc.revision) throw new Error('Settings audit identity is inconsistent.')
        return doc.value
      })
      return { revisions: values.slice(0, limit), ...(values.length > limit ? { nextBefore: values[limit - 1].revision } : {}) }
    },
  }
}
