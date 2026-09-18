import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareCredentialFreeRuntime } from '../dist-renderer/runtime-environment.mjs'

function broker() {
  return {
    IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
    IDENTITY_HEADER: 'test-only-broker-header',
    MSI_ENDPOINT: 'http://localhost:42356/msi/token',
    MSI_SECRET: 'test-only-broker-header',
    RENDERER_PULL_CLIENT_ID: '11111111-2222-4333-8444-555555555555',
  }
}

test('runtime-disabled platform broker is checked and removed before browser code starts', async () => {
  const env = broker()
  await prepareCredentialFreeRuntime(env, async (url, options) => {
    assert.equal(url.hostname, 'localhost')
    assert.equal(url.searchParams.get('client_id'), env.RENDERER_PULL_CLIENT_ID)
    assert.equal(options.redirect, 'error')
    return new Response('{"error":"identity_not_available"}', { status: 403 })
  })
  assert.equal(env.IDENTITY_HEADER, undefined)
  assert.equal(env.MSI_SECRET, undefined)
})

test('an available runtime token fails closed and is never accepted as isolation', async () => {
  const env = broker()
  await assert.rejects(prepareCredentialFreeRuntime(env, async () =>
    new Response('{"access_token":"not-a-real-token"}', { status: 200 })), /token is available/)
})

test('network failures and unrelated credential variables cannot masquerade as disabled identity', async () => {
  await assert.rejects(prepareCredentialFreeRuntime(broker(), async () =>
    new Response('temporary failure', { status: 500 })), /did not confirm/)
  await assert.rejects(prepareCredentialFreeRuntime({ ...broker(), AZURE_CLIENT_SECRET: 'test-only' }), /refuses Azure/)
  await assert.rejects(prepareCredentialFreeRuntime({ ...broker(), IDENTITY_ENDPOINT: 'https://example.com/token' }), /loopback/)
})
