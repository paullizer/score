import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { BLOCKER, REVIEW } from './lib/findings.mjs'
import { loadTypeScript } from './lib/ast.mjs'
import { createRepo, runSpec } from './lib/testing.mjs'
import { analyzeFile, spec } from './check-outbound-requests.mjs'

const repos = []
after(() => repos.forEach(repo => repo.cleanup()))
function repo(options) {
  const created = createRepo(options)
  repos.push(created)
  return created
}

const ts = loadTypeScript()

function findings(file, text, options = {}) {
  return analyzeFile(file, text, { ts, addedLines: text.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line })), ...options })
}

function rules(items, verdict) {
  return items.filter(item => !verdict || item.verdict === verdict).map(item => item.rule)
}

describe('outbound request pure analysis', () => {
  test('flags global fetch but not injected or locally declared fetch', () => {
    assert.deepEqual(rules(findings('server/a.ts', "export async function run() { return fetch('https://example.invalid') }\n"), BLOCKER), ['outbound/global-fetch'])
    assert.deepEqual(rules(findings('server/a.ts', "export async function run(fetch: typeof globalThis.fetch) { return fetch('https://example.invalid') }\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "export async function run(options: { fetch: typeof globalThis.fetch }) { return options.fetch('https://example.invalid') }\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "const fetch = options.fetch\nexport async function run() { return fetch('https://example.invalid') }\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "export async function run() { return globalThis.fetch('https://example.invalid') }\n"), BLOCKER), ['outbound/global-fetch'])
  })

  test('flags outbound network imports and ignores type-only imports', () => {
    assert.deepEqual(rules(findings('server/a.ts', "import https from 'node:https'\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "import type { Agent } from 'node:https'\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "const https = require('node:https')\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "await import('node:https')\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "import('undici')\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "import('playwright')\n"), BLOCKER), ['outbound/playwright-import'])
    assert.deepEqual(rules(findings('server/a.ts', "export { request } from 'node:https'\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "export type { Agent } from 'node:https'\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "import https = require('node:https')\n"), BLOCKER), ['outbound/network-module'])
    assert.deepEqual(rules(findings('server/a.ts', "import(name)\n"), REVIEW), ['outbound/dynamic-module-load'])
    assert.deepEqual(rules(findings('server/a.ts', "require('node:' + name)\n"), REVIEW), ['outbound/dynamic-module-load'])
    assert.deepEqual(rules(findings('server/a.ts', "import { createRequire } from 'node:module'\n"), REVIEW), ['outbound/dynamic-module-load'])
    assert.deepEqual(rules(findings('server/a.ts', "import type { Module } from 'node:module'\n"), REVIEW), [])
  })

  test('flags Playwright navigation outside sanctioned renderer and worker runtime', () => {
    assert.deepEqual(rules(findings('server/a.ts', "export async function run(page) { await page.goto('https://example.invalid') }\n"), BLOCKER), ['outbound/playwright-navigation'])
    assert.deepEqual(rules(findings('renderer/browser.ts', "export async function run(page) { await page.goto('https://example.invalid') }\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('worker/runtime.ts', "export async function run(page) { await page.goto(validatePublicUrl(url).href) }\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "export async function run(route) { await route.continue({ url: 'https://example.invalid' }) }\n"), BLOCKER), ['outbound/playwright-navigation'])
  })

  test('flags disabled TLS verification', () => {
    assert.deepEqual(rules(findings('server/a.ts', "client.request(url, { rejectUnauthorized: false })\n"), BLOCKER), ['outbound/tls-verification-disabled'])
    assert.deepEqual(rules(findings('server/a.ts', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'\n"), BLOCKER), ['outbound/node-tls-disabled'])
    assert.deepEqual(rules(findings('server/a.ts', "const value = process.env.NODE_TLS_REJECT_UNAUTHORIZED\n"), BLOCKER), [])
    assert.deepEqual(rules(findings('server/a.ts', "chromium.launch({ ignoreHTTPSErrors: true, args: ['--ignore-certificate-errors'] })\n"), BLOCKER), [
      'outbound/tls-verification-disabled',
      'outbound/tls-verification-disabled',
    ])
  })

  test('reviews automatic redirects and model transport changes', () => {
    assert.deepEqual(rules(findings('server/a.ts', "fetch(url, { redirect: 'follow' })\n"), REVIEW), ['outbound/redirect-follow'])
    assert.deepEqual(rules(findings('server/a.ts', "const options = { redirect: 'manual', maxRedirects: 3 }\n"), REVIEW), ['outbound/redirect-follow'])
    assert.deepEqual(rules(findings('server/new-model.ts', "const endpoint = `${base}/openai/v1/chat/completions`\n"), REVIEW), ['outbound/model-transport-change'])
    assert.deepEqual(rules(findings('worker/model-transport.ts', "const endpoint = `${base}/openai/v1/chat/completions`\n"), REVIEW), [])
  })
})

describe('outbound request runner integration', () => {
  test('scopes review findings to added lines while blockers are whole-file invariants', async () => {
    const fixture = repo({
      base: { 'server/a.ts': "export async function old(fetch: typeof globalThis.fetch) { return fetch(url, { redirect: 'follow' }) }\n" },
      head: { 'server/a.ts': "export async function old(fetch: typeof globalThis.fetch) { return fetch(url, { redirect: 'follow' }) }\nexport const touched = true\n" },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(rules(result.findings), [])

    fixture.write('server/a.ts', "export async function old(fetch: typeof globalThis.fetch) { return fetch(url, { redirect: 'follow' }) }\nexport async function next() { return fetch('https://example.invalid') }\n")
    const changed = await runSpec(spec, fixture, ['--worktree'])
    assert.equal(changed.exitCode, 1)
    assert.deepEqual(rules(changed.findings, BLOCKER), ['outbound/global-fetch'])
  })

  test('reports SSRF policy changes', async () => {
    const fixture = repo({
      base: { 'worker/runtime.ts': "export const policy = { maxRedirects: 5 }\n" },
      head: { 'worker/runtime.ts': "export const policy = { maxRedirects: 5 }\nexport const tighterPolicy = { maxRedirects: 3 }\n" },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 0)
    assert.ok(result.findings.some(item => item.rule === 'outbound/ssrf-policy-change' && item.file === 'worker/runtime.ts'))
    assert.ok(result.findings.some(item => item.rule === 'outbound/redirect-follow' && item.file === 'worker/runtime.ts'))
  })

  test('honours suppressions for reviewed global fetch exceptions', async () => {
    const fixture = repo({
      head: {
        'server/a.ts': [
          '// security-reviewed: outbound/global-fetch -- fixed endpoint test fixture only',
          "export async function run() { return fetch('https://example.invalid') }",
          '',
        ].join('\n'),
      },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 0)
    assert.equal(result.suppressed.length, 1)
  })

  test('full scan analyzes every in-scope file', async () => {
    const fixture = repo({ base: { 'server/a.ts': "export async function run() { return fetch('https://example.invalid') }\n" } })
    const result = await runSpec(spec, fixture, ['--full-scan', '--head', fixture.baseSha])
    assert.equal(result.ctx.mode, 'full')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(rules(result.findings, BLOCKER), ['outbound/global-fetch'])
  })
})
