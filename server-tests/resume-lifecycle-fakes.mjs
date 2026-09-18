import { createRequire } from 'node:module'
import { build } from 'esbuild'

const compiled = await build({
  stdin: {
    contents: [
      "export * from './server/resumes/guards';",
      "export * from './server/resumes/validation';",
      "export {StoreConflictError} from './server/store';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
export const resumeLifecycleTesting = module.exports
const copy = value => structuredClone(value)

/** Adds the production validation/fences to the existing integration fixture's versioned record map. */
export function installResumeLifecycleFake(store, { values = store.values, StoreConflictError = resumeLifecycleTesting.StoreConflictError } = {}) {
  if (!(values instanceof Map)) throw new Error('Resume lifecycle fakes require a versioned record map.')
  const controls = new Map()
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  let revision = 0
  let fault
  store.controls = controls
  store.transactions ??= []
  store.failNextTransaction = (error, afterCommit = false) => { fault = { error, afterCommit } }
  store.get = async (workspaceId, id) => copy(values.get(key(workspaceId, id)))
  store.getControl = async (workspaceId, resumeId) => copy(controls.get(key(workspaceId, resumeLifecycleTesting.resumeControlId(resumeId))))
  store.listControls = async (workspaceId, token) => {
    const all = [...controls.values()].filter(value => value.record.workspaceId === workspaceId)
      .sort((left, right) => left.record.id.localeCompare(right.record.id))
    const offset = Number(token ?? 0)
    return { items: copy(all.slice(offset, offset + 50)),
      ...(offset + 50 < all.length ? { continuationToken: String(offset + 50) } : {}) }
  }
  store.pendingLifecycleWorkspaces = async limit => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid resume recovery limit.')
    return [...new Set([...controls.values()].filter(({ record }) => record.state === 'deleting' ||
      (record.operation && record.operation.status !== 'complete') ||
      Date.parse(record.preparation?.expiresAt) <= Date.now()).map(value => value.record.workspaceId))].slice(0, limit)
  }
  const prepare = async (workspaceId, operations, options) => {
    try { return await resumeLifecycleTesting.prepareResumeTransaction(store, workspaceId, operations, options) } catch (error) {
      if (error instanceof resumeLifecycleTesting.StoreConflictError) throw new StoreConflictError(error.message)
      throw error
    }
  }
  store.transact = async (workspaceId, operations, options = {}) => {
    if ((!operations.length && !options.controls?.length) || new Set(operations.map(value => value.record.id)).size !== operations.length) {
      throw new Error('Invalid resume fake transaction.')
    }
    for (const operation of operations) {
      if (!['create', 'replace', 'delete'].includes(operation.kind) || operation.record.workspaceId !== workspaceId) {
        throw new Error('Resume fake transaction crossed its ownership boundary.')
      }
      resumeLifecycleTesting.parseResumeEntity(operation.record)
    }
    const guarded = await prepare(workspaceId, operations, options)
    if (operations.length + guarded.length > 100 || Buffer.byteLength(JSON.stringify({ operations, guarded })) > 1_800_000) {
      throw new Error('Resume transaction budget exceeded.')
    }
    for (const operation of operations) {
      const current = values.get(key(workspaceId, operation.record.id))
      if (operation.kind === 'create' ? current : !current || current.etag !== operation.etag) throw new StoreConflictError('Resume changed.')
    }
    for (const control of guarded) {
      if (controls.get(key(workspaceId, control.record.id))?.etag !== control.etag) throw new StoreConflictError('Resume lifecycle fence changed.')
      resumeLifecycleTesting.parseResumeControl(control.record)
    }
    const failure = operations.length ? fault : undefined
    if (operations.length) fault = undefined
    if (failure && !failure.afterCommit) throw failure.error
    // All preconditions have been checked; commit records and controls without an intervening await.
    for (const operation of operations) {
      if (operation.kind === 'delete') values.delete(key(workspaceId, operation.record.id))
      else values.set(key(workspaceId, operation.record.id), {
        record: copy(resumeLifecycleTesting.parseResumeEntity(operation.record)), etag: `"resume-fake-${++revision}"`,
      })
    }
    for (const control of guarded) controls.set(key(workspaceId, control.record.id), {
      record: copy(control.record), etag: `"resume-control-${++revision}"`,
    })
    if (operations.length) store.transactions.push(copy(operations))
    if (failure) throw failure.error
  }
  store.create = async record => {
    const current = await store.get(record.workspaceId, record.id)
    if (current) {
      await prepare(record.workspaceId, [{ kind: 'create', record }])
      return { created: false, value: current }
    }
    await store.transact(record.workspaceId, [{ kind: 'create', record }])
    return { created: true, value: await store.get(record.workspaceId, record.id) }
  }
  store.replace = async (record, etag) => {
    await store.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
    return store.get(record.workspaceId, record.id)
  }
  store.listPending = async (now, limit) => copy([...values.values()].filter(({ record }) =>
    record.recordType === 'resume' && !resumeLifecycleTesting.resumeIsLocked(record.lifecycle) &&
    (controls.get(key(record.workspaceId, resumeLifecycleTesting.resumeControlId()))?.record.state ?? 'active') === 'active' &&
    (controls.get(key(record.workspaceId, resumeLifecycleTesting.resumeControlId(record.id)))?.record.state ?? 'active') === 'active' &&
    (!record.nextAttemptAt || record.nextAttemptAt <= now) &&
    (record.resume.status === 'queued' && !record.lease ||
      ['parsing', 'profiling'].includes(record.resume.status) && record.lease?.expiresAt <= now),
  ).sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt)).slice(0, limit))
  return store
}

export function installResumeBlobLifecycleFake(blobs) {
  const page = (prefix, token) => {
    const all = [...blobs.values.keys()].filter(name => name.startsWith(prefix)).sort()
    const offset = Number(token ?? 0)
    return { names: all.slice(offset, offset + 40), ...(offset + 40 < all.length ? { continuationToken: String(offset + 40) } : {}) }
  }
  blobs.listFamilies = async (workspaceId, token) => {
    const result = page(`${workspaceId}/`, token)
    return { resumeIds: [...new Set(result.names.map(name => name.split('/')[1]))],
      ...(result.continuationToken ? { continuationToken: result.continuationToken } : {}) }
  }
  blobs.listPage = async (workspaceId, resumeId, token) => page(`${workspaceId}/${resumeId}/`, token)
  blobs.delete = async name => {
    if (!resumeLifecycleTesting.isSafeResumeBlobName(name)) throw new Error('Invalid resume cleanup namespace.')
    blobs.values.delete(name)
  }
  blobs.putFenced = async (name, bytes, contentType, fence) => {
    if (fence.writer.blobName !== name || !resumeLifecycleTesting.isBlobInResumePrefix(name, fence.writer.workspaceId, fence.writer.resumeId)) {
      throw new Error('Resume Blob writer crossed its ownership boundary.')
    }
    fence.signal?.throwIfAborted()
    await fence.assertActive()
    fence.signal?.throwIfAborted()
    if (Date.parse(fence.writer.expiresAt) <= Date.now()) throw new resumeLifecycleTesting.StoreConflictError('Resume writer expired.')
    const current = blobs.values.get(name)
    if (current) return { created: false, blob: copy(current) }
    const blob = { bytes: Uint8Array.from(bytes), contentType, sha256: resumeLifecycleTesting.resumeSha256(bytes), etag: `"blob-${blobs.values.size + 1}"` }
    resumeLifecycleTesting.resumeBlobReference(name, blob)
    blobs.values.set(name, blob)
    return { created: true, blob: copy(blob) }
  }
  return blobs
}
