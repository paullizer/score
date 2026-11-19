import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyGithubRelease, verifyImage } from '../verify-artifacts.mjs'

const now = new Date('2026-11-19T12:00:00Z')
const digest = `sha256:${'a'.repeat(64)}`
const image = { name: 'node', reference: `node:24.22.1-bookworm-slim@${digest}`, metadata: 'https://hub.docker.com/v2/repositories/library/node/tags/24.22.1-bookworm-slim' }
const respond = data => async () => new Response(JSON.stringify(data))

test('image admission binds publication age to the exact digest, never the build date', async () => {
  await verifyImage(image, { now, fetchImpl: respond({ digest, tag_last_pushed: '2026-11-05T12:00:00Z' }) })
  await assert.rejects(verifyImage(image, { now, fetchImpl: respond({ digest: `sha256:${'b'.repeat(64)}`, tag_last_pushed: '2026-01-01T00:00:00Z' }) }), /pinned image digest/)
  await assert.rejects(verifyImage(image, { now, fetchImpl: respond({ digest, created: '2026-01-01T00:00:00Z' }) }), /unverified/)
  await assert.rejects(verifyImage(image, { now, fetchImpl: respond({ digest, tag_last_pushed: '2026-11-06T00:00:00Z' }) }), /fresh/)
  await assert.rejects(verifyImage(image, { now, fetchImpl: async () => new Response('<html>not metadata</html>') }), /JSON/)
})

test('action admission verifies the release timestamp and resolves annotated tags to the pinned commit', async () => {
  const sha = 'a'.repeat(40)
  const artifact = { repository: 'actions/checkout', tag: 'v7.0.1', sha }
  const fetchImpl = async url => new Response(JSON.stringify(
    url.includes('/releases/') ? { tag_name: 'v7.0.1', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false }
      : url.includes('/git/ref/') ? { object: { type: 'tag', sha: 'b'.repeat(40) } }
        : { object: { type: 'commit', sha } },
  ))
  await verifyGithubRelease(artifact, { now, fetchImpl })
  await assert.rejects(verifyGithubRelease({ ...artifact, sha: 'c'.repeat(40) }, { now, fetchImpl }), /pinned action commit/)
  await assert.rejects(verifyGithubRelease(artifact, { now, fetchImpl: respond({ tag_name: 'v7.0.1', published_at: '2026-11-18T00:00:00Z' }) }), /fresh/)
})

test('Microsoft image admission selects the exact tag and checks its digest-bound publication time', async () => {
  const microsoftImage = { ...image, name: 'playwright', tag: 'v1.63.0-noble' }
  const record = { name: microsoftImage.tag, digest, lastModifiedDate: '2026-09-04T23:48:51.0000000+00:00' }
  await verifyImage(microsoftImage, { now, fetchImpl: respond([{ name: 'latest', digest }, record]) })
  await assert.rejects(verifyImage(microsoftImage, { now, fetchImpl: respond([{ ...record, name: 'another-tag' }]) }), /pinned image digest/)
  await assert.rejects(verifyImage(microsoftImage, { now, fetchImpl: respond([{ ...record, lastModifiedDate: '2026-11-18T00:00:00Z' }]) }), /fresh/)
})

test('GitHub metadata authentication stays in the first-party request header, never the URL', async () => {
  const artifact = { repository: 'nodejs/node', tag: 'v24.22.1' }
  await verifyGithubRelease(artifact, {
    now, token: 'metadata-test-token',
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.github.com')
      assert.equal(options.headers.Authorization, 'Bearer metadata-test-token')
      assert.equal(url.includes('metadata-test-token'), false)
      assert.equal(options.redirect, 'error')
      return new Response(JSON.stringify({ tag_name: artifact.tag, published_at: '2026-10-21T00:00:00Z' }))
    },
  })
})
