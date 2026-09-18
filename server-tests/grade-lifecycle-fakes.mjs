import { build } from 'esbuild'

const compiled = await build({
  stdin: {
    contents: [
      "export * from './server/grades/guards';",
      "export * from './server/grades/lifecycle';",
      "export * from './server/grades/service';",
      "export * from './server/grades/validation';",
      "export {StoreConflictError} from './server/store';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  plugins: [{
    name: 'resolve-installed-packages',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => ({
        path: args.path.startsWith('node:') ? args.path : import.meta.resolve(args.path), external: true,
      }))
    },
  }],
})

export const gradeLifecycleTesting = await import(`data:text/javascript;base64,${Buffer.from(`${compiled.outputFiles[0].text}\n//# sourceURL=grade-lifecycle-test-runtime.mjs`).toString('base64')}`)

const copy = value => structuredClone(value)

export function installGradeLifecycleFake(store, { values, remove, StoreConflictError }) {
  const controls = new Map()
  let revision = 0
  const key = (workspaceId, id) => `${workspaceId}/${id}`
  const currentRecords = () => [...values.values()].map(value => value.record ?? value)
  const rawTransact = store.transact.bind(store)
  store.controls = controls
  store.lifecycleBatches = []
  store.pendingLifecycleWorkspaces = async limit => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid grade lifecycle recovery limit.')
    return [...new Set([
      ...[...controls.values()].filter(({ record }) => record.ladderId && (record.state === 'deleting' || record.pending?.length ||
        (record.preparation && Date.parse(record.preparation.expiresAt) <= Date.now())))
        .map(({ record }) => record.workspaceId),
      ...currentRecords().filter(record => ['grade-ladder', 'grade-head'].includes(record.recordType) && record.lifecycle?.deletingAt)
        .map(record => record.workspaceId),
    ])].slice(0, limit)
  }
  store.getControl = async (workspaceId, ladderId) => copy(controls.get(key(workspaceId, gradeLifecycleTesting.gradeControlId(ladderId))))
  store.listControls = async (workspaceId, token) => {
    const found = [...controls.values()].filter(value => value.record.workspaceId === workspaceId)
      .sort((a, b) => a.record.id.localeCompare(b.record.id))
    const start = Number(token ?? 0)
    return { items: copy(found.slice(start, start + 50)), ...(start + 50 < found.length ? { continuationToken: String(start + 50) } : {}) }
  }
  store.listScope = async (workspaceId, options) => {
    const found = currentRecords().filter(record => record.workspaceId === workspaceId &&
      (!options.ladderId || record.id === options.ladderId || record.ladderId === options.ladderId) &&
      (options.grade === undefined || record.grade === options.grade || (record.recordType === 'grade-work' && record.input.grade === options.grade)))
      .sort((a, b) => a.id.localeCompare(b.id))
    const start = Number(options.continuationToken ?? 0)
    const limit = options.limit ?? 50
    return { items: await Promise.all(found.slice(start, start + limit).map(record => store.get(workspaceId, record.id))),
      ...(start + limit < found.length ? { continuationToken: String(start + limit) } : {}) }
  }
  store.transact = async (workspaceId, operations, options = {}) => {
    let guarded
    try { guarded = await gradeLifecycleTesting.prepareGradeTransaction(store, workspaceId, operations, options) } catch (error) {
      if (error instanceof gradeLifecycleTesting.StoreConflictError) throw new StoreConflictError(error.message)
      throw error
    }
    if (guarded.operations.length + guarded.controls.length > 100 ||
      Buffer.byteLength(JSON.stringify(guarded)) > 1_800_000) throw new Error('Grade transaction budget exceeded.')
    store.lifecycleBatches.push(copy(guarded))
    for (const control of guarded.controls) {
      if (controls.get(key(workspaceId, control.record.id))?.etag !== control.etag) throw new StoreConflictError('Guard changed.')
    }
    for (const operation of guarded.operations.filter(value => value.kind === 'delete')) {
      if ((await store.get(workspaceId, operation.record.id))?.etag !== operation.etag) throw new StoreConflictError('Delete changed.')
    }
    const writes = guarded.operations.filter(value => value.kind !== 'delete')
    const publishControls = () => {
      for (const operation of guarded.operations.filter(value => value.kind === 'delete')) remove(workspaceId, operation.record.id)
      for (const control of guarded.controls) controls.set(key(workspaceId, control.record.id),
        { record: copy(control.record), etag: `"control-${++revision}"` })
    }
    try {
      if (writes.length) await rawTransact(workspaceId, writes, options)
    } catch (error) {
      const committed = await Promise.all(writes.map(async operation => {
        const current = await store.get(workspaceId, operation.record.id)
        return current && (operation.kind === 'create' || current.etag !== operation.etag) &&
          gradeLifecycleTesting.gradeContentHash(current.record) === gradeLifecycleTesting.gradeContentHash(operation.record)
      }))
      if (committed.length && committed.every(Boolean) &&
        guarded.controls.every(control => controls.get(key(workspaceId, control.record.id))?.etag === control.etag)) publishControls()
      throw error
    }
    publishControls()
  }
  store.replace = async (record, etag) => {
    await store.transact(record.workspaceId, [{ kind: 'replace', record, etag }])
    return store.get(record.workspaceId, record.id)
  }
  store.create = async record => {
    const previous = await store.get(record.workspaceId, record.id)
    if (previous) return { created: false, value: previous }
    await store.transact(record.workspaceId, [{ kind: 'create', record }])
    return { created: true, value: await store.get(record.workspaceId, record.id) }
  }
  return store
}

export function installGradeBlobLifecycleFake(blobs) {
  blobs.listFamilies = async (workspaceId, token) => {
    const names = [...blobs.values.keys()].filter(name => name.startsWith(`${workspaceId}/`)).sort()
    const start = Number(token ?? 0)
    return { ladderIds: [...new Set(names.slice(start, start + 40).map(name => name.split('/')[1]))],
      ...(start + 40 < names.length ? { continuationToken: String(start + 40) } : {}) }
  }
  blobs.listPage = async (workspaceId, ladderId, token) => {
    const names = [...blobs.values.keys()].filter(name => name.startsWith(`${workspaceId}/${ladderId}/`)).sort()
    const start = Number(token ?? 0)
    return { names: names.slice(start, start + 40), ...(start + 40 < names.length ? { continuationToken: String(start + 40) } : {}) }
  }
  blobs.delete = async name => { blobs.values.delete(name) }
  return blobs
}
