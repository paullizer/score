import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after, before } from 'node:test'
import { pathToFileURL } from 'node:url'
import { RestError } from '@azure/storage-blob'
import { build } from 'esbuild'
import { createJobBlobStoreFromContainer } from '../dist-server/app.mjs'

const BLOB_NAME = 'workspace-one/job-123e4567-e89b-42d3-a456-426614174000/original.pdf'
const MARKDOWN_BLOB_NAME = BLOB_NAME.replace(/\.pdf$/, '.md')
const MAX_MARKDOWN = 10 * 1024 * 1024
const validationOutput = join(process.cwd(), 'dist-server', `real-jobs-validation-tests-${process.pid}.mjs`)
let validation

before(async () => {
  await build({
    entryPoints: [join(process.cwd(), 'server', 'jobs', 'validation.ts')], outfile: validationOutput,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
  })
  validation = await import(pathToFileURL(validationOutput).href)
})
after(async () => { await rm(validationOutput, { force: true }) })

for (const statusCode of [409, 412]) {
  test(`immutable job Blob create handles Azure HTTP ${statusCode} by preserving and returning existing bytes`, async () => {
    const existing = Buffer.from('%PDF-1.7\nexisting bytes', 'ascii')
    let downloaded = false
    const store = createJobBlobStoreFromContainer({
      getBlockBlobClient(name) {
        assert.equal(name, BLOB_NAME)
        return {
          async upload(_body, _length, options) {
            assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
            assert.equal(options.blobHTTPHeaders.blobContentType, 'application/pdf')
            throw new RestError('Conditional create failed', { statusCode })
          },
          async download() {
            downloaded = true
            return {
              etag: '"existing-etag"',
              contentType: 'application/pdf',
              contentLength: existing.byteLength,
              readableStreamBody: Readable.from([existing]),
            }
          },
        }
      },
    })

    const result = await store.putImmutable(BLOB_NAME, Buffer.from('%PDF-1.7\nreplacement'), 'application/pdf')
    assert.equal(result.created, false)
    assert.equal(downloaded, true)
    assert.deepEqual(Buffer.from(result.blob.bytes), existing)
    assert.equal(result.blob.sha256, createHash('sha256').update(existing).digest('hex'))
    assert.equal(result.blob.contentType, 'application/pdf')
    assert.equal(result.blob.etag, '"existing-etag"')
  })
}

test('job Blob adapter rejects caller-controlled paths and bounds reads', async () => {
  const store = createJobBlobStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() { assert.fail('unsafe path must not reach Blob Storage') },
        async download() { assert.fail('unsafe or oversized blob must not be consumed') },
      }
    },
  })
  await assert.rejects(store.read('../workspace-state/secret.json'), /Invalid job blob name/)
  await assert.rejects(store.putImmutable('../workspace-state/secret.json', new Uint8Array(), 'application/json'), /Invalid job blob name/)

  const oversized = createJobBlobStoreFromContainer({
    getBlockBlobClient() {
      return {
        async upload() {},
        async download() {
          return {
            etag: '"large"',
            contentType: 'application/pdf',
            contentLength: 10 * 1024 * 1024 + 1,
            readableStreamBody: Readable.from([]),
          }
        },
      }
    },
  })
  await assert.rejects(oversized.read(BLOB_NAME), /exceeds the supported size/)
})

test('job Markdown blobs round-trip privately under canonical original.md with exact MIME, hash, immutable writes, and byte limits', async () => {
  const values = new Map()
  const store = createJobBlobStoreFromContainer({
    getBlockBlobClient(name) {
      return {
        async upload(body, length, options) {
          assert.equal(name, MARKDOWN_BLOB_NAME)
          assert.equal(body.byteLength, length)
          assert.deepEqual(options.conditions, { ifNoneMatch: '*' })
          assert.deepEqual(options.blobHTTPHeaders, { blobContentType: 'text/markdown', blobCacheControl: 'private, no-store' })
          if (values.has(name)) throw new RestError('Immutable collision', { statusCode: 412 })
          values.set(name, Buffer.from(body))
          return { etag: '"markdown-original"' }
        },
        async download() {
          const bytes = values.get(name)
          return { contentType: 'text/markdown', contentLength: bytes.length, etag: '"markdown-original"', readableStreamBody: Readable.from([bytes]) }
        },
      }
    },
  })
  const bytes = Buffer.alloc(MAX_MARKDOWN, 'x')
  bytes.set(Buffer.from('\uFEFF# Résumé\r\n\t😀\r\n'))
  const original = await store.putImmutable(MARKDOWN_BLOB_NAME, bytes, 'text/markdown')
  assert.equal(original.created, true)
  assert.equal(original.blob.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(Buffer.from((await store.read(MARKDOWN_BLOB_NAME)).bytes), bytes)
  const repeated = await store.putImmutable(MARKDOWN_BLOB_NAME, Buffer.from('# different original'), 'text/markdown')
  assert.equal(repeated.created, false)
  assert.deepEqual(Buffer.from(repeated.blob.bytes), bytes)
  assert.equal(repeated.blob.sha256, original.blob.sha256)
  await assert.rejects(store.putImmutable(MARKDOWN_BLOB_NAME, Buffer.alloc(MAX_MARKDOWN + 1, 'x'), 'text/markdown'), /size/)
  await assert.rejects(store.putImmutable(MARKDOWN_BLOB_NAME, Buffer.alloc(0), 'text/markdown'), /empty/)
  for (const contentType of ['text/html', 'application/pdf', 'application/json', 'text/plain', 'application/octet-stream']) {
    await assert.rejects(store.putImmutable(MARKDOWN_BLOB_NAME, Buffer.from('# role'), contentType), /content type/)
  }
  for (const name of [
    MARKDOWN_BLOB_NAME.replace('original.md', 'original.markdown'), MARKDOWN_BLOB_NAME.replace('original.md', 'original.MD'),
    MARKDOWN_BLOB_NAME.replace('original.md', 'original.txt'), MARKDOWN_BLOB_NAME.replace('original.md', '../original.md'),
  ]) {
    await assert.rejects(store.read(name), /Invalid job blob name/)
    await assert.rejects(store.putImmutable(name, Buffer.from('# role'), 'text/markdown'), /Invalid job blob name/)
  }
})

test('job Markdown blob reads reject wrong MIME, unsupported metadata, empty bodies, and actual or declared over-limit streams', async () => {
  const bytes = Buffer.from('# Captured job\n')
  for (const change of [
    { contentType: 'application/pdf' }, { contentType: 'text/html' }, { contentType: 'application/json' },
    { contentType: undefined }, { etag: undefined }, { etag: '' }, { contentLength: MAX_MARKDOWN + 1 },
    { contentLength: 0 }, { contentLength: -1 }, { contentLength: bytes.length - 1 },
    { contentLength: undefined, readableStreamBody: Readable.from([]) },
    { contentLength: undefined, readableStreamBody: Readable.from([Buffer.alloc(MAX_MARKDOWN), Buffer.from('x')]) },
  ]) {
    const store = createJobBlobStoreFromContainer({
      getBlockBlobClient() {
        return {
          async upload() { assert.fail('read must not write') },
          async download() {
            return { contentType: 'text/markdown', contentLength: bytes.length, etag: '"md"', readableStreamBody: Readable.from([bytes]), ...change }
          },
        }
      },
    })
    await assert.rejects(store.read(MARKDOWN_BLOB_NAME))
  }
})

test('job validators bind uploaded Markdown filenames, MIME, canonical originals and extraction, without imposing PDF pagination on sections', () => {
  const jobId = 'job-123e4567-e89b-42d3-a456-426614174000'
  const documentId = 'document-123e4567-e89b-42d3-a456-426614174000'
  const record = {
    id: jobId, workspaceId: 'workspace-one', recordType: 'job',
    job: {
      id: jobId, title: 'Role', organization: '', location: '', arrangement: '', employmentType: '', grade: '', series: '',
      source: 'markdown', sourceLabel: 'Role.MARKDOWN', documentId, rubricId: null, status: 'queued',
      createdAt: '2026-09-18T02:30:00.000Z', dataKind: 'real',
    },
    source: {
      kind: 'markdown', displayName: 'Role.MARKDOWN', originalBlobName: MARKDOWN_BLOB_NAME, originalContentType: 'text/markdown',
      sha256: 'a'.repeat(64), bytes: MAX_MARKDOWN, extractionMethod: 'markdown',
    },
    inputFingerprint: 'b'.repeat(64), createdBy: 'test-actor', updatedAt: '2026-09-18T02:30:00.000Z', attempts: 0, warnings: [],
  }
  assert.equal(validation.validateRealJobRecord(record), true)
  for (const filename of ['Role: engineer.pdf', 'CON.pdf', ' role.pdf', 'Role? draft*.PDF', 'Role "engineer".pdf']) {
    assert.equal(validation.validateRealJobRecord({
      ...record,
      job: { ...record.job, source: 'pdf', sourceLabel: filename },
      source: {
        ...record.source, kind: 'pdf', displayName: filename, originalBlobName: BLOB_NAME,
        originalContentType: 'application/pdf', extractionMethod: 'document-intelligence',
      },
    }), true, `Legacy PDF metadata must remain readable: ${filename}`)
  }
  assert.equal(validation.originalBlobName('workspace-one', jobId, 'markdown'), MARKDOWN_BLOB_NAME)
  assert.equal(validation.originalBlobName('workspace-one', jobId, 'text/markdown'), MARKDOWN_BLOB_NAME)
  assert.equal(validation.jobBlobContentType(MARKDOWN_BLOB_NAME), 'text/markdown')
  assert.throws(() => validation.originalBlobName('workspace-one', jobId, 'text/plain'))
  assert.throws(() => validation.jobBlobContentType(MARKDOWN_BLOB_NAME.replace('original.md', 'original.txt')))
  for (const change of [
    { originalContentType: 'application/pdf' }, { originalContentType: 'text/html' },
    { originalBlobName: BLOB_NAME }, { originalBlobName: MARKDOWN_BLOB_NAME.replace('workspace-one', 'workspace-two') },
    { displayName: 'Role.pdf' }, { displayName: '../Role.md' }, { bytes: MAX_MARKDOWN + 1 }, { bytes: 0 },
    { sha256: undefined }, { extractionMethod: 'html' }, { extractionMethod: 'document-intelligence' },
    { finalUrl: 'https://example.com/role.md' }, { url: 'https://example.com/role.md' },
  ]) assert.equal(validation.validateRealJobRecord({ ...record, source: { ...record.source, ...change } }), false, JSON.stringify(change))
  const urlSource = { ...record.source, kind: 'url', displayName: 'https://example.com/role.md', url: 'https://example.com/role.md' }
  assert.equal(validation.validateRealJobRecord({
    ...record, source: urlSource, job: { ...record.job, source: 'url', sourceLabel: urlSource.displayName },
  }), false, 'URL captures must remain limited to PDF and HTML')
  const document = {
    id: documentId, kind: 'job', title: 'Role', version: 1, sample: false,
    paragraphs: [{ id: 'p-75', page: 75, heading: 'Requirements', text: 'Lead engineering.' }],
  }
  assert.deepEqual(validation.validateRealSourceDocument(document, 'text/markdown'), [])
  assert.deepEqual(validation.validateRealSourceDocument(document), [])
  assert.ok(validation.validateRealSourceDocument(document, 'application/pdf').length)
  const paragraph = document.paragraphs[0]
  const rubric = {
    id: 'rubric-test', groupId: 'rubric-test', kind: 'job', jobId, name: 'Role rubric', description: 'Source-grounded rubric',
    version: 1, createdAt: record.job.createdAt, dataKind: 'real', provenance: { kind: 'generated', model: 'test', promptVersion: 'test' },
    criteria: [{
      id: 'criterion', key: 'custom', label: 'Leadership', description: 'Lead engineering.', weight: 100,
      guidance: 'Use captured evidence.', requirementType: 'required',
      sourceCitations: [{
        documentId, documentVersion: 1, paragraphId: paragraph.id, page: paragraph.page, heading: paragraph.heading, quote: paragraph.text,
      }],
    }],
  }
  assert.deepEqual(validation.validateRealRubric(rubric, document, 'text/markdown'), [])
  assert.ok(validation.validateRealRubric(rubric, document, 'application/pdf').length)
})
