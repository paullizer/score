import { CosmosClient, ErrorResponse, type Container, type OperationInput } from '@azure/cosmos'
import type { TokenCredential } from '@azure/identity'
import { z } from 'zod'
import {
  promptActivationSchema, promptIdentifierSchema,
  type CurrentPromptBundle, type PromptActivation, type PromptBundleRevision, type PromptRevision,
} from '../../src/domain/prompt-versions'
import { StoreConflictError } from '../store'
import { SETTINGS_APPLICATION_ID, type SettingsConfig } from './store'
import { validatePromptBundle, validatePromptRevision } from './prompt-integrity'
import type { PromptRegistryReader, PromptRegistryStore } from './prompt-store'

const currentId = 'prompt:current'
const documentSchema = z.strictObject({
  id: z.string(), applicationId: z.literal(SETTINGS_APPLICATION_ID),
  recordType: z.enum(['prompt-revision', 'prompt-bundle', 'prompt-activation']),
  value: z.unknown(),
})
const pointerSchema = z.strictObject({
  id: z.literal(currentId), applicationId: z.literal(SETTINGS_APPLICATION_ID), recordType: z.literal('prompt-current'),
  bundleId: promptIdentifierSchema, activationId: promptIdentifierSchema,
})
const systemFields = new Set(['_rid', '_self', '_etag', '_attachments', '_ts'])
const statusOf = (error: unknown) => error instanceof ErrorResponse && typeof error.code === 'number' ? error.code : undefined
function exactEtag(value: string) {
  if (!value || value === '*' || value.startsWith('W/') || value.includes(',') || value.trim() !== value) {
    throw new StoreConflictError('A single exact prompt pointer ETag is required.')
  }
}
function document(recordType: 'prompt-revision' | 'prompt-bundle' | 'prompt-activation', id: string, value: unknown) {
  return { id, applicationId: SETTINGS_APPLICATION_ID, recordType, value: JSON.parse(JSON.stringify(value)) }
}

export function createAzurePromptStore(
  config: Pick<SettingsConfig, 'cosmosEndpoint' | 'database' | 'container' | 'applicationId'>, credential: TokenCredential,
): PromptRegistryStore {
  if (config.applicationId !== SETTINGS_APPLICATION_ID) throw new Error('Prompts must use the Score application-settings partition.')
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential })
  return createPromptStoreFromContainer(client.database(config.database).container(config.container))
}
export function createAzurePromptReader(
  config: Pick<SettingsConfig, 'cosmosEndpoint' | 'database' | 'container' | 'applicationId'>, credential: TokenCredential,
): PromptRegistryReader {
  const store = createAzurePromptStore(config, credential)
  return { getCurrent: store.getCurrent, getBundle: store.getBundle, getRevision: store.getRevision }
}
export function createPromptReaderFromContainer(container: Pick<Container, 'item' | 'items'>): PromptRegistryReader {
  const store = createPromptStoreFromContainer(container)
  return { getCurrent: store.getCurrent, getBundle: store.getBundle, getRevision: store.getRevision }
}
export function createPromptStoreFromContainer(container: Pick<Container, 'item' | 'items'>): PromptRegistryStore {
  async function read(id: string) {
    let result
    try { result = await container.item(id, SETTINGS_APPLICATION_ID).read<Record<string, unknown>>() } catch (error) {
      if (statusOf(error) === 404) return undefined
      throw error
    }
    if (result.statusCode === 404) return undefined
    if (result.statusCode < 200 || result.statusCode >= 300 || !result.resource || typeof result.resource._etag !== 'string') {
      throw new Error('Prompt storage returned an invalid document response.')
    }
    exactEtag(result.resource._etag)
    return { etag: result.resource._etag, body: Object.fromEntries(Object.entries(result.resource).filter(([key]) => !systemFields.has(key))) }
  }
  async function readValue(kind: 'prompt-revision' | 'prompt-bundle' | 'prompt-activation', id: string) {
    const result = await read(id)
    if (!result) return undefined
    const doc = documentSchema.parse(result.body)
    if (doc.id !== id || doc.recordType !== kind) throw new Error('The immutable prompt record has inconsistent identity.')
    return doc.value
  }
  async function getRevision(id: string) {
    promptIdentifierSchema.parse(id)
    const value = await readValue('prompt-revision', `prompt:revision:${id}`)
    if (value === undefined) return undefined
    const revision = validatePromptRevision(value)
    if (revision.revisionId !== id) throw new Error('The immutable prompt revision has inconsistent identity.')
    return revision
  }
  async function getBundle(id: string) {
    promptIdentifierSchema.parse(id)
    const value = await readValue('prompt-bundle', `prompt:bundle:${id}`)
    if (value === undefined) return undefined
    const bundle = validatePromptBundle(value)
    if (bundle.bundleId !== id) throw new Error('The immutable prompt bundle has inconsistent identity.')
    return bundle
  }
  async function getCurrent(): Promise<CurrentPromptBundle | undefined> {
    const stored = await read(currentId)
    if (!stored) return undefined
    const pointer = pointerSchema.parse(stored.body)
    const bundle = await getBundle(pointer.bundleId)
    const value = await readValue('prompt-activation', `prompt:activation:${pointer.activationId}`)
    if (!bundle || value === undefined) throw new Error('The active prompt pointer references missing immutable history.')
    const activation = promptActivationSchema.parse(value)
    if (activation.activationId !== pointer.activationId || activation.bundleId !== bundle.bundleId ||
      activation.bundleSha256 !== bundle.bundleSha256) throw new Error('The active prompt pointer has inconsistent bindings.')
    return { bundle, activation, etag: stored.etag }
  }
  function draftOperations(bundle: PromptBundleRevision, revisions: PromptRevision[]): OperationInput[] {
    validatePromptBundle(bundle)
    return [
      ...revisions.map(value => ({ operationType: 'Create' as const, resourceBody: document(
        'prompt-revision', `prompt:revision:${value.revisionId}`, validatePromptRevision(value),
      ) })),
      { operationType: 'Create', resourceBody: document('prompt-bundle', `prompt:bundle:${bundle.bundleId}`, bundle) },
    ]
  }
  function activationOperations(bundle: PromptBundleRevision, value: PromptActivation, etag?: string): OperationInput[] {
    validatePromptBundle(bundle)
    const activation = promptActivationSchema.parse(value)
    if (activation.bundleId !== bundle.bundleId || activation.bundleSha256 !== bundle.bundleSha256) {
      throw new Error('Activation does not select this exact immutable prompt bundle.')
    }
    const pointer = {
      id: currentId, applicationId: SETTINGS_APPLICATION_ID, recordType: 'prompt-current',
      bundleId: bundle.bundleId, activationId: activation.activationId,
    }
    return [
      etag === undefined ? { operationType: 'Create', resourceBody: pointer }
        : { operationType: 'Replace', id: currentId, ifMatch: etag, resourceBody: pointer },
      { operationType: 'Create', resourceBody: document('prompt-activation', `prompt:activation:${activation.activationId}`, activation) },
    ]
  }
  async function batch(operations: OperationInput[], initialize = false): Promise<string | undefined> {
    let result
    try { result = await container.items.batch(operations, SETTINGS_APPLICATION_ID) } catch (error) {
      if ([409, 412].includes(statusOf(error) ?? 0)) {
        if (initialize && await getCurrent()) return undefined
        throw new StoreConflictError('The prompt registry changed; reload the exact active pointer before trying again.')
      }
      throw error
    }
    const rows = result.result ?? []
    const failed = rows.find(row => row.statusCode >= 400 && row.statusCode !== 424)?.statusCode ?? result.code
    if (rows.length !== operations.length || rows.some(row => row.statusCode < 200 || row.statusCode >= 300) ||
      result.code !== undefined && (result.code < 200 || result.code >= 300)) {
      if (initialize && rows[0]?.statusCode === 409 && await getCurrent()) return undefined
      if (!initialize && [404, 409, 412].includes(failed ?? 0)) throw new StoreConflictError('The prompt registry changed before publication.')
      throw new Error('The immutable prompt transaction did not succeed.')
    }
    return rows[0]?.eTag ?? ''
  }
  return {
    getCurrent, getRevision, getBundle,
    async initialize(bundle, revisions, activation) {
      const etag = await batch([...activationOperations(bundle, activation), ...draftOperations(bundle, revisions)], true)
      if (etag === undefined) return false
      exactEtag(etag)
      return true
    },
    async createDraft(bundle, revisions) { await batch(draftOperations(bundle, revisions)) },
    async activate(bundle, activation, expectedEtag, beforePublish) {
      exactEtag(expectedEtag)
      const saved = await getBundle(bundle.bundleId)
      if (!saved || saved.bundleSha256 !== bundle.bundleSha256) throw new Error('The evaluated immutable prompt bundle is missing or changed.')
      const operations = activationOperations(bundle, activation, expectedEtag)
      await beforePublish?.()
      const etag = await batch(operations)
      if (!etag) throw new Error('Prompt activation returned no active-pointer ETag.')
      exactEtag(etag)
      return { bundle: structuredClone(bundle), activation: structuredClone(activation), etag }
    },
    async history(limit, before) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Prompt history page size must be from 1 to 100.')
      if (before !== undefined) promptIdentifierSchema.parse(before)
      const response = await container.items.query<Record<string, unknown>>({
        query: `SELECT TOP @limit * FROM c WHERE c.recordType = @type${before ? ' AND c.value.activationId < @before' : ''} ORDER BY c.value.activationId DESC`,
        parameters: [{ name: '@limit', value: limit + 1 }, { name: '@type', value: 'prompt-activation' },
          ...(before ? [{ name: '@before', value: before }] : [])],
      }, { partitionKey: SETTINGS_APPLICATION_ID }).fetchAll()
      const activations = response.resources.map(resource => {
        const doc = documentSchema.parse(Object.fromEntries(Object.entries(resource).filter(([key]) => !systemFields.has(key))))
        const value = promptActivationSchema.parse(doc.value)
        if (doc.recordType !== 'prompt-activation' || doc.id !== `prompt:activation:${value.activationId}`) {
          throw new Error('Prompt activation history has inconsistent identity.')
        }
        return value
      })
      return { activations: activations.slice(0, limit), ...(activations.length > limit ? { nextBefore: activations[limit - 1].activationId } : {}) }
    },
  }
}
