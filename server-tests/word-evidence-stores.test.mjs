import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { api, evidenceOriginal, sha } from './real-analyses.test-support.mjs'

function container() {
  const values = new Map()
  const uploads = []
  const metadata = {}
  return {
    values, uploads, metadata,
    getBlockBlobClient(name) {
      return {
        async upload(bytes, length, options) {
          uploads.push({ name, length, options })
          assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
          if (values.has(name)) throw Object.assign(new Error('Already captured'), { statusCode: 412 })
          assert.equal(length, bytes.byteLength)
          values.set(name, { bytes: Buffer.from(bytes), contentType: options.blobHTTPHeaders.blobContentType, etag: '"private-original"' })
          return { etag: '"private-original"' }
        },
        async download() {
          const value = values.get(name)
          if (!value) throw Object.assign(new Error('Missing'), { statusCode: 404 })
          return {
            readableStreamBody: Readable.from([value.bytes]), etag: value.etag,
            contentLength: value.bytes.byteLength, contentType: value.contentType, ...metadata,
          }
        },
      }
    },
  }
}

for (const [kind, createStore, prefix, filename] of [
  ['analysis', api.createAnalysisBlobStoreFromContainer, `workspace-one/analysis-run-${randomUUID()}/evidence`, (bytes, format) => `${sha(bytes)}.${format}`],
  ['grade seed', api.createGradeBlobStoreFromContainer, `workspace-one/ladder-${randomUUID()}/source-${randomUUID()}`, (_bytes, format) => `original.${format}`],
]) {
  for (const format of ['docx', 'doc']) {
    test(`${kind} ${format.toUpperCase()} private blob round-trips unchanged with bounded canonical metadata and immutable winners`, async () => {
      const transport = container()
      const store = createStore(transport)
      const bytes = evidenceOriginal(format)
      const contentType = api.UPLOAD_CONTENT_TYPES[format]
      const name = `${prefix}/${filename(bytes, format)}`
      const first = await store.putImmutable(name, bytes, contentType)
      assert.equal(first.created, true)
      assert.equal(first.blob.sha256, sha(bytes))
      assert.equal(transport.uploads[0].options.blobHTTPHeaders.blobContentType, contentType)
      assert.deepEqual(Buffer.from((await store.read(name)).bytes), bytes)
      assert.equal((await store.read(name)).contentType, contentType)
      const repeated = await store.putImmutable(name, Buffer.from('A different original'), contentType)
      assert.equal(repeated.created, false)
      assert.deepEqual(Buffer.from(repeated.blob.bytes), bytes)
      assert.equal(repeated.blob.sha256, first.blob.sha256)
      for (const invalidType of [undefined, null, 42, 'text/html', 'application/pdf', 'application/octet-stream', 'application/json',
        api.UPLOAD_CONTENT_TYPES[format === 'doc' ? 'docx' : 'doc']]) {
        await assert.rejects(store.putImmutable(name, bytes, invalidType))
        transport.metadata.contentType = invalidType
        await assert.rejects(store.read(name), /content metadata/)
      }
      delete transport.metadata.contentType
      for (const unsafe of ['../original.docx', `${prefix}/original.docm`, `${prefix}/original.rtf`,
        `${prefix}/original.zip`, `${prefix}/original.docx.html`, `${prefix}/../original.docx`]) {
        await assert.rejects(store.read(unsafe))
        await assert.rejects(store.putImmutable(unsafe, bytes, contentType))
      }
      const maximum = api.WORD_DOCUMENT_LIMITS.maxFileBytes
      await assert.rejects(store.putImmutable(name, new Uint8Array(maximum + 1), contentType))
      transport.metadata.contentLength = maximum + 1
      await assert.rejects(store.read(name), /size/)
      transport.metadata.contentLength = bytes.byteLength + 1
      await assert.rejects(store.read(name), /truncated/)
      transport.values.set(name, { bytes: Buffer.alloc(maximum + 1), contentType, etag: '"oversize"' })
      transport.metadata.contentLength = undefined
      await assert.rejects(store.read(name), /size/)
      transport.values.set(name, { bytes: Buffer.alloc(0), contentType, etag: '"empty"' })
      await assert.rejects(store.read(name), /empty/)
    })
  }
}
