import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = resolve(`.session-recovery-tests-${randomUUID()}`)
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let client, channels, timers, opened, popup, host
const id = '109d591a-bdb3-46c6-9ce8-d30cbfe2fe47'

before(async () => {
  await mkdir(output)
  await build({
    entryPoints: [join('src', 'services', 'sessionRecovery.ts')], outfile: join(output, 'client.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
  })
  client = await import(pathToFileURL(join(output, 'client.mjs')).href)
})
beforeEach(() => {
  channels = []; timers = new Map(); opened = []; popup = { opener: {} }
  host = {
    crypto: { randomUUID: () => id },
    BroadcastChannel: class {
      constructor(name) { this.name = name; this.closed = false; channels.push(this) }
      close() { this.closed = true }
      postMessage(message) { this.message = message }
    },
    setTimeout(fn, delay) { const key = randomUUID(); timers.set(key, { fn, delay }); return key },
    clearTimeout(key) { timers.delete(key) },
    open(...args) { opened.push(args); return popup },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
})
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete globalThis.window
})
after(async () => { await rm(output, { recursive: true, force: true }) })

test('recovery URLs accept only a fixed same-origin completion path and UUID attempt', () => {
  const login = new URL(client.sessionRecoveryLoginUrl(id), 'https://score.test')
  assert.equal(login.origin, 'https://score.test')
  assert.equal(login.pathname, '/.auth/login/aad')
  assert.equal(login.searchParams.get('post_login_redirect_uri'), `/auth/recovery?attempt=${id}`)
  assert.equal(client.sessionRecoveryAttemptId(new URL(`https://score.test/auth/recovery?attempt=${id}`)), id)
  for (const input of ['', '//attacker.test', '/\\attacker.test', 'javascript:alert(1)', `${id}&redirect=//attacker.test`]) {
    assert.throws(() => client.sessionRecoveryLoginUrl(input), /Invalid/)
    assert.equal(client.sessionRecoveryAttemptId(new URL(`https://score.test/auth/recovery?attempt=${encodeURIComponent(input)}`)), null)
  }
  assert.equal(client.sessionRecoveryAttemptId(new URL(`https://score.test/workspaces?attempt=${id}`)), null)
})

test('only the explicit open action starts sign-in and severs the login window opener', () => {
  const attempt = client.createSessionRecoveryAttempt(() => assert.fail('No completion'), () => assert.fail('No timeout'))
  assert.equal(opened.length, 0)
  assert.equal(attempt.open(), true)
  assert.equal(opened.length, 1)
  assert.equal(opened[0][0], attempt.loginUrl)
  assert.equal(opened[0][1], '_blank')
  assert.equal(popup.opener, null)
  attempt.dispose()
  assert.equal(channels[0].closed, true)
  assert.equal(timers.size, 0)
})

test('completion is attempt-scoped, validated and single-use, and never grants access itself', () => {
  let complete = 0
  const attempt = client.createSessionRecoveryAttempt(() => complete++, () => assert.fail('No timeout'))
  const receive = channels[0].onmessage
  for (const data of [null, 'complete', {}, { type: 'other', attempt: id }, { type: 'score-session-recovery-complete', attempt: randomUUID() }]) receive({ data })
  assert.equal(complete, 0)
  receive({ data: { type: 'score-session-recovery-complete', attempt: id } })
  receive({ data: { type: 'score-session-recovery-complete', attempt: id } })
  assert.equal(complete, 1)
  assert.equal(timers.size, 0)
  assert.equal(channels[0].closed, true)
  attempt.dispose()
})

test('timeouts and disposal stop notifications and remove timers', () => {
  let expired = 0, complete = 0
  const attempt = client.createSessionRecoveryAttempt(() => complete++, () => expired++)
  const timer = [...timers.values()][0]
  assert.equal(timer.delay, client.SESSION_RECOVERY_TIMEOUT_MS)
  timer.fn()
  channels[0].onmessage({ data: { type: 'score-session-recovery-complete', attempt: id } })
  assert.equal(expired, 1)
  assert.equal(complete, 0)
  assert.equal(timers.size, 0)
  attempt.dispose()
  timer.fn()
  assert.equal(expired, 1)
})

test('missing or denied BroadcastChannel still allows explicit sign-in and manual verification', () => {
  for (const denied of [false, true]) {
    host.BroadcastChannel = denied ? class { constructor() { throw new DOMException('Channel denied', 'SecurityError') } } : undefined
    const attempt = client.createSessionRecoveryAttempt(() => assert.fail('No notification'), () => {})
    assert.equal(attempt.open(), true)
    assert.equal(attempt.notificationError, denied ? 'Channel denied' : '')
    attempt.dispose()
  }
})

test('blocked windows retain a safe login URL for the explicit fallback link', () => {
  popup = null
  const attempt = client.createSessionRecoveryAttempt(() => {}, () => {})
  assert.equal(attempt.open(), false)
  assert.equal(attempt.loginUrl, client.sessionRecoveryLoginUrl(id))
  attempt.dispose()
})

test('completion view notifications carry no identity, credentials or draft data and close the channel', () => {
  client.notifySessionRecoveryComplete(id)
  assert.equal(channels[0].name, `score-session-recovery:${id}`)
  assert.deepEqual(channels[0].message, { type: 'score-session-recovery-complete', attempt: id })
  assert.equal(channels[0].closed, true)
  assert.throws(() => client.notifySessionRecoveryComplete('//attacker.test'), /Invalid/)
  assert.equal(channels.length, 1)
})
