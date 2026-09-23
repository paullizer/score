import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'
import { createQcFixture, qcFeedback, qcPlanDetail, qcProposal, qcScope, qcSubmission } from './qualityControl.test-support.mjs'

const output = resolve(`.qc-frontend-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const protectionRef = { current: null }
let ui, dom, root, createRoot, fixture, navigate, renderOptions

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent',
    'PopStateEvent', 'DocumentFragment', 'localStorage', 'sessionStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  for (const [name, value] of Object.entries({
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  originals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { App } from './src/app/App'
    export { QualityControlPage } from './src/features/qc/QualityControlPage'
    export { RealComparisonReview } from './src/features/analyses/RealComparisonReview'
    export { WorkspaceContext } from './src/app/workspace-context'
    export { ApplicationNavigationContext } from './src/app/application-navigation-context'
    export { GradeNavigationProtectionProvider, GradeRouterProtection } from './src/app/GradeNavigationProtection'
    export { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
    export * as client from './src/services/qualityControl'
    export * as domain from './src/domain/quality-control'
    export * as improvement from './src/domain/quality-improvement'
    export { PROMPT_REGISTRY_LIMITS } from './src/domain/prompt-versions'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
  jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})
beforeEach(() => {
  fixture = createQcFixture()
  globalThis.fetch = fixture.fetch
  navigate = null; renderOptions = {}
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
})
afterEach(async () => { if (root) { await act(async () => { root.unmount(); await pause() }); root = null } })
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  await rm(output, { recursive: true, force: true })
})
function Probe() { navigate = ui.useNavigate(); return null }
function Harness({ role = fixture.role, admin = fixture.admin, cloud = true, app = false, normalReview = false, workspaceId = 'workspace-one',
  routerWorkspaceId = workspaceId, tenantId = 'tenant', deletedAt, missingMembership = false, accessSource = 'membership', membershipRole,
  refreshWorkspaces = async () => { fixture.refreshes = (fixture.refreshes ?? 0) + 1 } }) {
  const context = frontendWorkspaceContext({ ...(cloud ? { cloud: { currentWorkspaceId: workspaceId,
    refreshWorkspaces, workspaces: missingMembership ? [] : [{ id: workspaceId, role, accessSource, membershipRole,
      name: 'QC fixture workspace', etag: '"workspace"', deletedAt }] } } : {}) })
  if (context.cloud) context.cloud.user.tenantId = tenantId
  return h(ui.GradeNavigationProtectionProvider, { workspaceId, routePrefix: cloud ? `/workspaces/${routerWorkspaceId}` : '/', apiRef: protectionRef },
    h(ui.BrowserRouter, { basename: cloud ? `/workspaces/${routerWorkspaceId}` : '/', future: { v7_startTransition: true, v7_relativeSplatPath: true } },
      h(ui.GradeRouterProtection, null, h(ui.WorkspaceContext.Provider, { value: context },
        h(ui.ApplicationNavigationContext.Provider, { value: { applicationAdmin: admin, openAdminSettings: async () => {} } },
          h(Probe), app ? h(ui.App) : normalReview ? h(ui.RealComparisonReview, { detail: fixture.analysis.details[0] }) : h(ui.Routes, null,
            h(ui.Route, { path: '/qc/*', element: h(ui.QualityControlPage) }),
            h(ui.Route, { path: '/analyses', element: h('h1', null, 'Normal analysis mode') })))))))
}
async function render(path = '/qc/reviews/run-one/comparison-1', options = {}) {
  renderOptions = options
  dom.window.history.replaceState({ idx: 0 }, '', `${options.cloud === false ? '' : '/workspaces/workspace-one'}${path}`)
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(h(options.strict ? React.StrictMode : React.Fragment, null, h(Harness, options))); await pause() })
}
async function rerender(options) {
  renderOptions = { ...renderOptions, ...options }
  await act(async () => { root.render(h(renderOptions.strict ? React.StrictMode : React.Fragment, null, h(Harness, renderOptions))); await pause() })
}
function button(text, within = document) {
  const found = [...within.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent.trim()) === text)
  assert.ok(found, `Button "${text}" exists`)
  return found
}
function field(text, within = document) {
  const label = [...within.querySelectorAll('label')].find(item => item.querySelector(':scope > span')?.textContent === text)
  assert.ok(label, `Field "${text}" exists`)
  return label.querySelector('input,textarea,select')
}
async function click(node) { await act(async () => { node.click(); await pause() }) }
async function fill(node, value) {
  const prototype = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await pause()
  })
}
async function until(predicate, message, attempts = 120) {
  for (let index = 0; index < attempts; index++) { if (predicate()) return; await act(async () => { await pause() }) }
  assert.fail(message)
}
function holdNextResponse(matches) {
  const held = { signal: null, release: null }
  let claimed = false
  fixture.override = async (url, init) => {
    if (claimed || !matches(String(url), init)) return
    claimed = true
    const response = await fixture.respond(url, init)
    return new Promise(resolve => {
      held.signal = init.signal
      held.release = () => resolve(response)
    })
  }
  return held
}
const writes = () => fixture.requests.filter(item => ['POST', 'PUT'].includes(item.method))
function unloadingBlocked() {
  const event = new dom.window.Event('beforeunload', { cancelable: true })
  dom.window.dispatchEvent(event)
  return event.defaultPrevented
}
function dialog() { const value = document.querySelector('[role="dialog"]'); assert.ok(value); return value }
async function completeDisagreement(score = '0') {
  await fill(field('Decision for Engineering methods'), 'disagree')
  await fill(field('Required explanation for Engineering methods'), 'The frozen passage supports a narrower interpretation.')
  await fill(field('Recommended rating or unscored disposition for Engineering methods'), score)
}

test('review opening is read-only, blinded, and displays only recorded diagnostics with unchanged evidence', async () => {
  await render()
  assert.match(document.body.textContent, /ambiguous breadth|model call recorded/)
  assert.match(document.body.textContent, /alternative defensible ratings: 2, 3/)
  assert.match(document.body.textContent, /Frozen passage|frozen passage/)
  assert.equal(button('Submit complete comparison').disabled, true)
  assert.equal(button('Load authorized peer feedback').disabled, true)
  assert.equal(fixture.requests.some(item => /\/peers|\/summaries|\/corrections/.test(item.url)), false)
  assert.equal(writes().length, 0)
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)
})

test('historical diagnostic absence never derives confidence from evidence coverage or scores', async () => {
  fixture.override = url => String(url).includes('/qc/context') ? Response.json({ ...fixture.context(),
    diagnostics: { status: 'historical', message: 'This correction did not rerun the assessor.', criteria: [] } }) : undefined
  await render()
  assert.match(document.body.textContent, /Confidence: Not recorded/)
  assert.doesNotMatch(document.body.textContent, /alternative defensible ratings|ambiguous breadth/)
  assert.equal(writes().length, 0)
})

test('normal frozen-evidence review does not render or fetch private QC confidence or feedback', async () => {
  await render('/analyses/run-one', { normalReview: true })
  assert.match(document.body.textContent, /The evidence, criterion by criterion/)
  assert.match(document.body.textContent, /The frozen passage documents independent engineering work/)
  assert.equal(document.querySelector('.qc-criterion'), null)
  assert.equal(fixture.requests.some(item => item.url.includes('/qc/')), false)
  assert.doesNotMatch(document.body.textContent, /Model-reported confidence|Your explicit response|ambiguous breadth/)
})

test('explicit decisions require reasons/recommendations; zero and unscored remain distinct', async () => {
  await render()
  await fill(field('Decision for Engineering methods'), 'disagree')
  assert.equal(button('Submit complete comparison').disabled, true)
  await fill(field('Required explanation for Engineering methods'), 'Evidence disagreement, not a candidate judgment.')
  assert.equal(button('Submit complete comparison').disabled, true)
  await fill(field('Recommended rating or unscored disposition for Engineering methods'), '0')
  assert.equal(button('Submit complete comparison').disabled, false)
  await click(button('Submit complete comparison'))
  assert.equal(fixture.calls.submitted, 1)
  assert.deepEqual(writes()[0].body.feedback[0].recommendation, { kind: 'score', score: 0 })
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  await click(button('Revise my feedback'))
  await fill(field('Recommended rating or unscored disposition for Engineering methods'), 'not-assessed')
  await click(button('Submit complete comparison'))
  assert.deepEqual(writes().at(-1).body.feedback[0].recommendation, { kind: 'not-assessed' })
  assert.equal(fixture.calls.submitted, 2)
})

test('incomplete server drafts survive reopening and unchecked rows are never auto-agreed', async () => {
  await render()
  await fill(field('Decision for Engineering methods'), 'disagree')
  assert.equal(unloadingBlocked(), true)
  await click(button('Save incomplete draft'))
  assert.equal(writes().length, 1)
  assert.equal(writes()[0].body.feedback[0].reason, '')
  assert.equal(writes()[0].body.feedback[0].recommendation, null)
  assert.equal(fixture.calls.submitted, 0)
  assert.equal(unloadingBlocked(), false)
  await act(async () => { root.unmount(); await pause() }); root = null
  await render()
  assert.equal(field('Decision for Engineering methods').value, 'disagree')
  assert.equal(button('Submit complete comparison').disabled, true)
})

test('same-score rationale disagreement and unable-to-judge are explicit valid choices', async () => {
  await render()
  await completeDisagreement('3')
  assert.equal(button('Submit complete comparison').disabled, false)
  await fill(field('Decision for Engineering methods'), 'unable-to-judge')
  assert.equal(button('Submit complete comparison').disabled, false)
  await fill(field('Required explanation for Engineering methods'), '')
  assert.equal(button('Submit complete comparison').disabled, true)
  await fill(field('Required explanation for Engineering methods'), 'The rubric anchors do not distinguish this case.')
  await click(button('Submit complete comparison'))
  assert.equal(writes().at(-1).body.feedback[0].decision, 'unable-to-judge')
  assert.equal(writes().at(-1).body.feedback[0].recommendation, null)
})

test('ambiguous submission acknowledgement retains exact UUID, ETag, payload, fields and leave protection', async () => {
  await render()
  await completeDisagreement()
  let first = true
  fixture.override = async (url, init) => {
    if (String(url).endsWith('/reviews/submit') && first) { first = false; await fixture.respond(url, init); throw new TypeError('Network acknowledgement lost') }
  }
  await click(button('Submit complete comparison'))
  assert.equal(fixture.calls.submitted, 1)
  assert.equal(unloadingBlocked(), true)
  assert.equal(field('Required explanation for Engineering methods').value, 'The frozen passage supports a narrower interpretation.')
  await click(button('Retry unacknowledged request'))
  const attempts = writes().filter(item => item.url.endsWith('/reviews/submit'))
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].headers.get('Idempotency-Key'), attempts[1].headers.get('Idempotency-Key'))
  assert.equal(attempts[0].headers.get('If-None-Match'), '*')
  assert.deepEqual(attempts[0].body, attempts[1].body)
  assert.equal(fixture.calls.submitted, 1)
  assert.equal(unloadingBlocked(), false)
})

test('ETag conflict preserves a draft and supports explicit inspection before replacing the working copy', async () => {
  fixture.seedSubmission()
  await render()
  await click(button('Revise my feedback'))
  await fill(field('Required explanation for Engineering methods'), 'My locally retained reason.')
  fixture.heads.get('comparison-1').etag = '"changed-elsewhere"'
  fixture.heads.get('comparison-1').record.feedback = [qcFeedback({ reason: 'The server has a different reason.' })]
  await click(button('Save incomplete draft'))
  assert.match(document.body.textContent, /newer saved draft exists/)
  assert.equal(field('Required explanation for Engineering methods').value, 'My locally retained reason.')
  assert.equal(unloadingBlocked(), true)
  await click(button('Check current result and draft version'))
  assert.match(document.body.textContent, /The server has a different reason/)
  await click(button('Keep my fields against this reviewed version'))
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).headers.get('If-Match'), '"changed-elsewhere"')
  assert.equal(writes().at(-1).body.feedback[0].reason, 'My locally retained reason.')
})

test('a replay cannot silently replace local feedback with a later working copy from another request', async () => {
  await render()
  await completeDisagreement()
  fixture.override = async (url, init) => {
    if (!String(url).endsWith('/reviews')) return
    const response = await fixture.respond(url, init)
    const saved = await response.json()
    saved.record.lastRequestId = randomUUID()
    saved.record.feedback[0].reason = 'A newer competing saved working copy.'
    return Response.json(saved)
  }
  await click(button('Save incomplete draft'))
  assert.match(document.body.textContent, /saved working copy was changed by another request/)
  assert.equal(field('Required explanation for Engineering methods').value, 'The frozen passage supports a narrower interpretation.')
  assert.equal(unloadingBlocked(), true)
})

test('a newly published result is explicitly historical and never retargets the existing draft', async () => {
  await render(`/qc/reviews/run-one/comparison-1?resultRevision=original&resultSha256=${'a'.repeat(64)}`)
  await completeDisagreement()
  fixture.override = url => {
    if (!String(url).includes('/qc/context')) return
    const parsed = new URL(url, 'https://score.test')
    if (parsed.searchParams.has('resultRevision')) return
    const value = fixture.context()
    value.scope.resultRevision = 'corrected-two'
    value.scope.resultSha256 = 'b'.repeat(64)
    value.analysis.comparison.result.sha256 = value.scope.resultSha256
    value.analysis.result.criteria[0].score = 4
    value.analysis.result.overall.score = 80
    value.myReview = null; value.canSeePeers = false
    value.diagnostics = { status: 'not-recorded', message: 'A correction did not rerun the full assessor.', criteria: [] }
    return Response.json(value)
  }
  await click(button('Check current result and draft version'))
  assert.match(document.body.textContent, /You are reviewing a historical result/)
  assert.equal(field('Required explanation for Engineering methods').value, 'The frozen passage supports a narrower interpretation.')
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).body.scope.resultRevision, 'original')
  assert.equal(writes().at(-1).body.scope.resultSha256, 'a'.repeat(64))
  const link = [...document.querySelectorAll('a')].find(item => item.textContent === 'Explicitly open the current result instead')
  assert.match(link.href, /resultRevision=corrected-two/)
})

test('peer feedback fetch is deliberate after submission and later revisions are labeled exposed', async () => {
  fixture.seedSubmission()
  await render()
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /Independent peer/)
  const exposed = fixture.heads.get('comparison-1')
  assert.notEqual(exposed.etag, '"head-1"')
  await click(button('Revise my feedback'))
  assert.match(document.body.textContent, /Coordinator or peer-exposed revision/)
  await fill(field('Required explanation for Engineering methods'), 'An explicitly peer-exposed revision.')
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).headers.get('If-Match'), exposed.etag)
  assert.equal(fixture.heads.get('comparison-1').record.feedback[0].reason, 'An explicitly peer-exposed revision.')
  assert.equal(fixture.requests.filter(item => item.url.endsWith('/peers')).length, 1)
})

test('coordinator peer exposure adopts an initially absent head without replacing unsaved local feedback', async () => {
  fixture.role = 'owner'
  await render()
  await completeDisagreement()
  assert.equal(fixture.heads.size, 0)
  await click(button('Load authorized peer feedback'))
  const exposed = fixture.heads.get('comparison-1')
  assert.deepEqual(exposed.record.feedback, [])
  assert.equal(field('Required explanation for Engineering methods').value, 'The frozen passage supports a narrower interpretation.')
  assert.equal(unloadingBlocked(), true)
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).headers.get('If-Match'), exposed.etag)
  assert.equal(writes().at(-1).headers.has('If-None-Match'), false)
  assert.equal(fixture.heads.get('comparison-1').record.feedback[0].recommendation.score, 0)
})

test('peer metadata refresh never silently adopts a competing feedback revision', async () => {
  fixture.seedSubmission()
  await render()
  await click(button('Revise my feedback'))
  await fill(field('Required explanation for Engineering methods'), 'My unsaved local reasoning.')
  fixture.override = async (url, init) => {
    if (!String(url).endsWith('/qc/peers')) return
    const response = await fixture.respond(url, init)
    const head = fixture.heads.get('comparison-1')
    head.record.feedback = [qcFeedback({ reason: 'A competing saved revision.' })]
    head.record.lastRequestId = randomUUID()
    head.record.lastRequestHash = 'c'.repeat(64)
    head.etag = '"competing-save"'
    return response
  }
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /A newer saved draft exists/)
  assert.match(document.body.textContent, /A competing saved revision/)
  assert.equal(field('Required explanation for Engineering methods').value, 'My unsaved local reasoning.')
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).headers.get('If-Match'), '"head-1"')
  assert.equal(fixture.heads.get('comparison-1').record.feedback[0].reason, 'A competing saved revision.')
  await click(button('Keep my fields against this reviewed version'))
  await click(button('Save incomplete draft'))
  assert.equal(writes().at(-1).headers.get('If-Match'), '"competing-save"')
  assert.equal(fixture.heads.get('comparison-1').record.feedback[0].reason, 'My unsaved local reasoning.')
})

test('failed post-peer metadata refresh preserves local edits and retries only the context read', async () => {
  fixture.seedSubmission()
  await render()
  await click(button('Revise my feedback'))
  await fill(field('Required explanation for Engineering methods'), 'Keep this draft through the metadata outage.')
  fixture.override = url => String(url).includes('/qc/context') && fixture.heads.get('comparison-1').record.peerExposedAt
    ? Response.json({ error: { code: 'unavailable', message: 'Saved draft metadata is temporarily unavailable.' } }, { status: 503 }) : undefined
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /Saved draft metadata is temporarily unavailable/)
  assert.equal(button('Save incomplete draft').disabled, true)
  assert.equal(field('Required explanation for Engineering methods').value, 'Keep this draft through the metadata outage.')
  assert.equal(unloadingBlocked(), true)
  fixture.override = null
  await click([...document.querySelectorAll('button')].find(item => item.textContent.includes('Retry')))
  assert.equal(button('Save incomplete draft').disabled, false)
  assert.equal(field('Required explanation for Engineering methods').value, 'Keep this draft through the metadata outage.')
  assert.equal(fixture.requests.filter(item => item.url.endsWith('/peers')).length, 1)
})

test('failed private access clears all rendered evidence and aborts scoped reads', async () => {
  fixture.seedSubmission()
  await render()
  fixture.override = url => String(url).endsWith('/qc/peers') ? Response.json({ error: { code: 'forbidden', message: 'Membership revoked.' } }, { status: 403 }) : undefined
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /Private evidence, feedback, and unsaved fields have been cleared/)
  assert.doesNotMatch(document.body.textContent, /Jordan Example|Engineering methods|frozen passage|Independent peer/)
  assert.equal(fixture.requests.filter(item => item.url.includes('/qc/context')).every(item => item.signal.aborted), true)
  assert.equal(fixture.refreshes, 1)
})

test('a failed workspace refresh after denied QC access never restores private evidence or drafts', async () => {
  fixture.seedSubmission()
  await render('/qc/reviews/run-one/comparison-1', { refreshWorkspaces: async () => { throw new Error('Workspace list unavailable.') } })
  fixture.override = url => String(url).endsWith('/qc/peers') ? Response.json({ error: { code: 'forbidden', message: 'Membership revoked.' } }, { status: 403 }) : undefined
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /Workspace access could not be refreshed/)
  assert.match(document.body.textContent, /Private QC data remains cleared/)
  assert.doesNotMatch(document.body.textContent, /Jordan Example|Engineering methods|frozen passage|Independent peer/)
})

test('deleted membership metadata clears QC even when the workspace provider and reviewer role remain mounted', async () => {
  await render()
  await completeDisagreement()
  await rerender({ deletedAt: '2026-09-22T16:00:00.000Z' })
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /narrower interpretation|Jordan Example|Engineering methods/)
  assert.equal(fixture.requests.filter(item => item.url.includes('/qc/context')).every(item => item.signal.aborted), true)
  assert.equal(unloadingBlocked(), false)
})

test('QC mode entry is hidden for retained deleted metadata and admin status cannot replace membership', async () => {
  await render('/analyses', { app: true, deletedAt: '2026-09-22T16:00:00.000Z' })
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'QC mode'), false)
  assert.equal([...document.querySelectorAll('a')].some(item => item.textContent.trim() === 'Enter QC mode'), false)
  await act(async () => { root.unmount(); await pause() }); root = null
  await render('/qc', { admin: true, missingMembership: true })
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.equal(fixture.requests.some(item => item.url.includes('/qc/')), false)
})

test('membership downgrade and workspace departure unmount private QC data instead of reusing cached state', async () => {
  await render()
  await completeDisagreement()
  await rerender({ role: 'viewer' })
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /narrower interpretation|Jordan Example/)
  await rerender({ role: 'reviewer' })
  assert.equal(field('Decision for Engineering methods').value, '')
})

test('tenant changes clear private drafts and abort the old principal scope even when the user ID is unchanged', async () => {
  await render()
  await completeDisagreement()
  const previous = fixture.requests.find(item => item.url.includes('/qc/context'))
  await rerender({ tenantId: 'another-tenant' })
  assert.equal(previous.signal.aborted, true)
  assert.equal(fixture.requests.filter(item => item.url.includes('/qc/context')).length, 2)
  assert.equal(field('Decision for Engineering methods').value, '')
  assert.doesNotMatch(document.body.textContent, /narrower interpretation/)
  assert.equal(unloadingBlocked(), false)
})

test('late context replies cannot repopulate a view after membership removal', async () => {
  const held = holdNextResponse(url => url.includes('/qc/context'))
  await render()
  await until(() => held.release, 'The initial context response was held.')
  await rerender({ missingMembership: true })
  assert.equal(held.signal.aborted, true)
  await act(async () => { held.release(); await pause() })
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /Jordan Example|Engineering methods|frozen passage/)
  assert.equal(unloadingBlocked(), false)
})

test('late peer replies cannot restore peers or unsaved fields after a capability-losing downgrade and re-entry', async () => {
  fixture.seedSubmission()
  await render()
  await click(button('Revise my feedback'))
  await fill(field('Required explanation for Engineering methods'), 'Private fields from the previous access scope.')
  const held = holdNextResponse(url => url.endsWith('/qc/peers'))
  await click(button('Load authorized peer feedback'))
  await until(() => held.release, 'The private peer response was held.')
  await rerender({ role: 'viewer' })
  assert.equal(held.signal.aborted, true)
  assert.doesNotMatch(document.body.textContent, /Private fields from|Jordan Example|Independent peer/)
  await rerender({ role: 'reviewer' })
  const readsBeforeRelease = fixture.requests.filter(item => item.url.includes('/qc/context')).length
  await act(async () => { held.release(); await pause() })
  assert.doesNotMatch(document.body.textContent, /Private fields from|Independent peer/)
  assert.equal(fixture.requests.filter(item => item.url.includes('/qc/context')).length, readsBeforeRelease)
  assert.equal(button('Load authorized peer feedback').disabled, false)
  assert.equal(unloadingBlocked(), false)
})

test('workspace changes fence late plan and evaluation replies while the router and provider remain mounted', async () => {
  const previous = qcPlanDetail({ status: 'ready', proposal: qcProposal() })
  previous.plan.name = 'Private old workspace plan'
  previous.evaluation.cases[0].candidate.findings = ['Private old workspace evaluation']
  fixture.plans.set('plan-one', previous)
  const held = holdNextResponse(url => url.endsWith('/workspaces/workspace-one/qc/plans/plan-one'))
  const delay = fixture.override
  const next = qcPlanDetail()
  next.plan.workspaceId = 'workspace-two'
  next.plan.name = 'New workspace saved plan'
  fixture.override = (url, init) => String(url).endsWith('/workspaces/workspace-two/qc/plans/plan-one')
    ? Response.json(next) : delay(url, init)
  await render('/qc/improvements/plan-one')
  await until(() => held.release, 'The old workspace plan response was held.')
  await rerender({ workspaceId: 'workspace-two', routerWorkspaceId: 'workspace-one' })
  assert.equal(held.signal.aborted, true)
  assert.match(document.body.textContent, /New workspace saved plan/)
  await act(async () => { held.release(); await pause() })
  assert.match(document.body.textContent, /New workspace saved plan/)
  assert.doesNotMatch(document.body.textContent, /Private old workspace plan|Private old workspace evaluation/)
})

test('late evaluation polling replies cannot restore private results after membership loss', async () => {
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'evaluating', proposal: qcProposal() }))
  await render('/qc/improvements/plan-one')
  const completed = qcPlanDetail({ status: 'ready', proposal: qcProposal() })
  completed.evaluation.cases[0].candidate.findings = ['Private late evaluation findings']
  fixture.plans.set('plan-one', completed)
  const held = holdNextResponse(url => url.endsWith('/qc/plans/plan-one'))
  await until(() => held.release, 'The saved-status poll response was held.', 700)
  await rerender({ missingMembership: true })
  assert.equal(held.signal.aborted, true)
  await act(async () => { held.release(); await pause() })
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /Private late evaluation findings|Fixture improvement|evaluated candidate/)
  assert.equal(fixture.calls.paid, 0)
})

test('current member appadmins can use QC as viewers but losing admin capability clears the private view', async () => {
  fixture.role = 'viewer'
  fixture.admin = true
  await render()
  assert.match(document.body.textContent, /Engineering methods/)
  const previous = fixture.requests.find(item => item.url.includes('/qc/context'))
  await rerender({ admin: false })
  assert.equal(previous.signal.aborted, true)
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /Jordan Example|Engineering methods/)
})

test('an Admin losing explicit membership clears private QC drafts without losing ordinary Owner access', async () => {
  await render('/qc/reviews/run-one/comparison-1', {
    admin: true, role: 'owner', accessSource: 'application-admin', membershipRole: 'viewer',
  })
  await completeDisagreement()
  const previous = fixture.requests.find(item => item.url.includes('/qc/context'))
  const reads = fixture.requests.length
  await rerender({ membershipRole: undefined })
  assert.equal(previous.signal.aborted, true)
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.doesNotMatch(document.body.textContent, /narrower interpretation|Jordan Example|Engineering methods/)
  assert.equal(unloadingBlocked(), false)
  assert.equal(fixture.requests.length, reads)
  await rerender({ membershipRole: 'viewer' })
  assert.equal(field('Decision for Engineering methods').value, '', 'Restored membership cannot revive private unsaved feedback')
})

test('implicit Admin Owner access alone exposes neither QC navigation nor private requests', async () => {
  const implicitAdmin = { admin: true, role: 'owner', accessSource: 'application-admin' }
  await render('/analyses', { ...implicitAdmin, app: true })
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'QC mode'), false)
  await act(async () => { root.unmount(); await pause() }); root = null
  await render('/qc', implicitAdmin)
  assert.match(document.body.textContent, /authorized cloud workspace/)
  assert.equal(fixture.requests.some(item => item.url.includes('/qc/')), false)
})

test('invalid or absent membership roles deny QC even with application-admin capability', async () => {
  for (const role of [undefined, 'unknown-role']) {
    fixture.role = role
    await render('/qc', { admin: true })
    assert.match(document.body.textContent, /authorized cloud workspace/)
    assert.equal(fixture.requests.some(item => item.url.includes('/qc/')), false)
  }
})

test('context rejects foreign results and mismatched historical hashes instead of silently selecting current scores', async () => {
  await assert.rejects(ui.client.getQcContext('workspace-one', 'run-one', 'comparison-1', 'original', undefined, 'b'.repeat(64)), /bound to the requested saved comparison/)
  fixture.override = url => String(url).includes('/qc/context') ? Response.json({ ...fixture.context(), workspaceId: 'another-workspace' }) : undefined
  await assert.rejects(ui.client.getQcContext('workspace-one', 'run-one', 'comparison-1'), /bound to the requested saved comparison/)
})

test('leave guards retain unsaved review fields and never place reasons or evidence in navigation URLs', async () => {
  await render()
  await completeDisagreement()
  await act(async () => { navigate('/analyses'); await pause() })
  assert.match(dialog().textContent, /Unsaved changes/)
  await click(button('Stay here', dialog()))
  assert.equal(field('Required explanation for Engineering methods').value, 'The frozen passage supports a narrower interpretation.')
  assert.doesNotMatch(dom.window.location.href, /passage|interpretation|Engineering/)
  await act(async () => { navigate('/analyses'); await pause() })
  await click(button('Discard unsaved changes and leave', dialog()))
  assert.match(document.body.textContent, /Normal analysis mode/)
  assert.equal(fixture.calls.submitted, 0)
})

test('peer scope equality is semantic and requests retain private no-store CSRF headers', async () => {
  fixture.seedSubmission()
  const scope = qcScope()
  const reordered = { comparisonId: scope.comparisonId, resultSha256: scope.resultSha256, runId: scope.runId, resultRevision: scope.resultRevision }
  const peers = await ui.client.getQcPeers('workspace-one', reordered, randomUUID())
  assert.equal(peers.submissions.length, 2)
  assert.equal(fixture.requests.at(-1).headers.get('X-Score-Request'), 'workspace')
  assert.ok(fixture.requests.at(-1).signal)
})

test('curation loads only explicit authorized feedback and saving a draft never invokes AI', async () => {
  fixture.role = 'owner'
  await render('/qc/improvements/new')
  await fill(field('Plan name'), 'Curated evidence plan')
  await fill(field('Improvement objective'), 'Test one clearly bounded evidence hypothesis.')
  await fill(field('Saved real analysis'), 'run-one')
  await until(() => document.body.textContent.includes('Select exact result'), 'Completed comparison is selectable despite partial run')
  await click([...document.querySelectorAll('label')].find(label => label.textContent.includes('Select exact result')).querySelector('input'))
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  await click(button('Load authorized feedback for this case'))
  assert.match(document.body.textContent, /Independent peer/)
  await fill(field('Disposition of Independent peer revision 1'), 'include')
  assert.equal(button('Save draft plan — no AI work').disabled, false)
  await click(button('Save draft plan — no AI work'))
  await until(() => document.body.textContent.includes('Draft improvement plan'), 'Saved draft plan opens')
  assert.equal(fixture.calls.createdPlans, 1)
  assert.equal(fixture.calls.paid, 0)
  assert.equal(writes().find(item => item.url.endsWith('/plans')).body.cases[0].reviewIds[0], 'submission-peer-1')
  await click(button('Draft improvement plan'))
  assert.equal(fixture.calls.paid, 0)
  assert.match(dialog().textContent, /One durable AI planning job/)
  assert.equal(button('Confirm paid QC work', dialog()).disabled, true)
  await click(dialog().querySelector('input[type="checkbox"]'))
  await click(button('Confirm paid QC work', dialog()))
  assert.equal(fixture.calls.paid, 1)
  assert.match(document.body.textContent, /Durable work work-one/)
})

test('blinded reviewers cannot select a case for planning before their own submission', async () => {
  await render('/qc/improvements/new')
  await fill(field('Saved real analysis'), 'run-one')
  await until(() => document.body.textContent.includes('Select exact result'), 'Saved context loads')
  const input = [...document.querySelectorAll('label')].find(label => label.textContent.includes('Select exact result')).querySelector('input')
  assert.equal(input.disabled, true)
  assert.match(document.body.textContent, /Submit your own review first/)
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
})

test('curation records exclusions with reasons and never silently selects all available reviewer opinions', async () => {
  fixture.role = 'owner'
  fixture.submissions.push(qcSubmission({ id: 'submission-peer-2', author: { principalId: 'peer-2', name: 'Second peer' } }))
  await render('/qc/improvements/new')
  await fill(field('Plan name'), 'Explicit curation')
  await fill(field('Improvement objective'), 'Retain individual opinions and record exclusions.')
  await fill(field('Saved real analysis'), 'run-one')
  await until(() => document.body.textContent.includes('Select exact result'), 'Case selector ready')
  await click([...document.querySelectorAll('label')].find(label => label.textContent.includes('Select exact result')).querySelector('input'))
  await click(button('Load authorized feedback for this case'))
  assert.equal(button('Save draft plan — no AI work').disabled, true)
  await fill(field('Disposition of Independent peer revision 1'), 'include')
  await fill(field('Disposition of Second peer revision 1'), 'exclude')
  assert.equal(button('Save draft plan — no AI work').disabled, true)
  await fill(field('Exclusion reason for Second peer'), 'Reserve this distinct rationale for a separately scoped investigation.')
  await click(button('Save draft plan — no AI work'))
  const saved = writes().find(item => item.url.endsWith('/plans')).body
  assert.deepEqual(saved.cases[0].reviewIds, ['submission-peer-1'])
  assert.deepEqual(saved.excludedFeedback, [{ reviewId: 'submission-peer-2', reason: 'Reserve this distinct rationale for a separately scoped investigation.' }])
  assert.deepEqual(saved.cases[0].referenceDecisions, [])
  assert.equal(fixture.calls.paid, 0)
})

test('saved plans paginate explicitly without starting work or reusing a previous page', async () => {
  const first = qcPlanDetail({ id: 'plan-first' }), second = qcPlanDetail({ id: 'plan-second' })
  fixture.override = url => {
    const parsed = new URL(url, 'https://score.test')
    if (!parsed.pathname.endsWith('/qc/plans')) return
    const more = parsed.searchParams.has('continuationToken')
    const selected = more ? second : first
    return Response.json({ items: [{ record: { ...selected.plan, name: more ? 'Second saved plan' : 'First saved plan' }, etag: selected.etag }],
      ...(more ? {} : { continuationToken: 'cursor-next' }) })
  }
  await render('/qc/improvements')
  assert.match(document.body.textContent, /First saved plan/)
  await click(button('More plans'))
  assert.match(document.body.textContent, /Second saved plan/)
  assert.doesNotMatch(document.body.textContent, /First saved plan/)
  assert.equal(writes().length, 0)
})

test('curation can select an exact historical batch pin without substituting the current result or loading peers', async () => {
  fixture.role = 'owner'
  const scope = { ...qcScope(), resultRevision: randomUUID() }
  fixture.batchRecords.push({ record: { id: 'batch-history', workspaceId: 'workspace-one', recordType: 'qc-batch',
    name: 'Historical campaign', comparisons: [scope], createdBy: { principalId: 'coordinator', name: 'Coordinator' },
    createdAt: '2026-09-22T10:00:00Z', updatedAt: '2026-09-22T10:00:00Z' }, etag: '"batch-history"' })
  await render('/qc/improvements/new')
  await click([...document.querySelectorAll('summary')].find(item => item.textContent === 'Select exact historical results from an optional batch'))
  await fill(field('Saved pinned review batch'), 'batch-history')
  await until(() => document.body.textContent.includes('Select exact result'), 'Pinned context loads')
  assert.ok(fixture.requests.some(item => item.url.includes(`resultRevision=${scope.resultRevision}`)))
  await click([...document.querySelectorAll('label')].find(label => label.textContent.includes('Select exact result')).querySelector('input'))
  assert.equal(fixture.requests.some(item => item.url.endsWith('/peers')), false)
  assert.ok([...document.querySelectorAll('a')].some(item => item.href.includes(`resultRevision=${scope.resultRevision}`) && item.href.includes(`resultSha256=${scope.resultSha256}`)))
  assert.match(document.body.textContent, /Curated cases · 1 \/ 25/)
})

test('active-work cancellation uses server permission or exact coordinator/creator ownership, not canEdit', async () => {
  const detail = qcPlanDetail({ status: 'planning' })
  detail.canEdit = false
  delete detail.canCancel
  detail.plan.createdBy.principalId = 'tenant:reviewer'
  detail.work = { id: 'active-work', workspaceId: 'workspace-one', planId: 'plan-one', planRevision: 1,
    kind: 'plan', status: 'queued', attempts: 0, nextAttemptAt: null, lease: null, checkpoint: null, error: null }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  assert.equal(button('Cancel QC work').disabled, false)
  await click(button('Cancel QC work'))
  assert.equal(fixture.plans.get('plan-one').plan.status, 'cancelled')
  assert.equal(fixture.calls.paid, 0)
  assert.ok(button('Resume / retry saved work'))
})

test('admission-off preserves saved reviews and batches without permitting new feedback or ordinary-mode restrictions', async () => {
  fixture.role = 'owner'
  fixture.admissionEnabled = false
  fixture.seedSubmission()
  fixture.batchRecords.push({ record: { id: 'batch-saved', workspaceId: 'workspace-one', recordType: 'qc-batch',
    name: 'Previously accepted batch', comparisons: [qcScope()], createdBy: { principalId: 'coordinator', name: 'Coordinator' },
    createdAt: '2026-09-22T10:00:00Z', updatedAt: '2026-09-22T10:00:00Z' }, etag: '"batch-saved"' })
  await render('/qc/reviews/run-one/comparison-1', { app: true })
  assert.match(document.body.textContent, /New QC reviews and improvement changes are disabled/)
  assert.match(document.body.textContent, /does not change normal workspace permissions/)
  assert.doesNotMatch(document.body.textContent, /This workspace is read-only|QC changes are read-only/)
  assert.equal(field('Decision for Engineering methods').matches(':disabled'), true)
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === 'Revise my feedback'), false)
  assert.ok(fixture.requests.some(item => item.url.includes('/qc/reviews/history')))
  await click(button('Load authorized peer feedback'))
  assert.match(document.body.textContent, /Independent peer/)
  await click([...document.querySelectorAll('a')].find(item => item.textContent === 'All reviews'))
  assert.match(document.body.textContent, /Previously accepted batch/)
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === 'Save named batch'), false)
  await click(button('Normal mode'))
  assert.ok(document.querySelector('[aria-label="Main navigation"]'))
  assert.equal(document.querySelector('.library-kind-switcher'), null)
  assert.deepEqual(writes().map(item => item.url.split('/').at(-1)), ['peers'])
})

test('admission-off keeps unsubmitted drafts visible but disables both review save and submission controls', async () => {
  fixture.admissionEnabled = false
  fixture.seedSubmission()
  const head = fixture.heads.get('comparison-1')
  head.record.submittedId = null; head.record.submissionNumber = 0
  fixture.submissions = []
  await render()
  assert.equal(field('Required explanation for Engineering methods').value, head.record.feedback[0].reason)
  assert.equal(button('Save incomplete draft').disabled, true)
  assert.equal(button('Submit complete comparison').disabled, true)
  assert.equal(button('Save review draft').disabled, true)
  assert.equal(button('Submit reviewed comparison').disabled, true)
  assert.equal(writes().length, 0)
})

test('admission-off allows cancellation and saved plan/prompt inspection while every new plan action stays unavailable', async () => {
  fixture.role = 'owner'; fixture.admin = true; fixture.admissionEnabled = false; fixture.workerEnabled = false
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'planning' }))
  fixture.plans.set('plan-ready', qcPlanDetail({ id: 'plan-ready', status: 'ready', proposal: qcProposal(), admin: true }))
  await render('/qc/improvements/plan-one')
  assert.equal(button('Cancel QC work').disabled, false)
  assert.equal(button('Draft improvement plan').disabled, true)
  await click(button('Cancel QC work'))
  assert.equal(fixture.plans.get('plan-one').work.status, 'cancelled')
  assert.equal(button('Draft improvement plan').disabled, true)
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === 'Resume / retry saved work'), false)
  await act(async () => { navigate('/qc/improvements'); await pause() })
  assert.equal([...document.querySelectorAll('a')].some(item => item.textContent === 'Collect feedback'), false)
  await act(async () => { navigate('/qc/improvements/new'); await pause() })
  assert.equal(field('Plan name').matches(':disabled'), true)
  assert.equal(button('Save draft plan — no AI work').disabled, true)
  await act(async () => { navigate('/qc/improvements/plan-ready'); await pause() })
  assert.match(document.body.textContent, /Pinned baseline \/ candidate evaluation/)
  assert.equal(field('Proposed Analysis assessment guidance').matches(':disabled'), true)
  assert.equal(button('Save new plan revision').disabled, true)
  assert.equal(button('Run baseline / candidate trial').disabled, true)
  assert.equal(button('Review activation of evaluated revision 1').disabled, true)
  assert.ok(fixture.requests.some(item => item.url.includes('/qc/plans/plan-ready/history')))
  await click([...document.querySelectorAll('a')].find(item => item.textContent === 'Prompt versions'))
  await click(button('Compare release release-old'))
  assert.match(document.body.textContent, /Previous compatible assessment guidance/)
  assert.equal(button('Review restore of release-old').disabled, true)
  assert.deepEqual(writes().map(item => item.url.split('/').at(-1)), ['cancel'])
  assert.equal(fixture.calls.paid, 0)
})

test('a disabled improvement worker leaves human QC admission and all saved-history tabs available', async () => {
  fixture.workerEnabled = false
  await render()
  assert.match(document.body.textContent, /dedicated improvement worker is not enabled/)
  assert.equal(button('Save incomplete draft').disabled, false)
  assert.ok([...document.querySelectorAll('a')].some(item => item.textContent === 'Quality improvement'))
  assert.ok([...document.querySelectorAll('a')].some(item => item.textContent === 'Prompt versions'))
  assert.doesNotMatch(document.body.textContent, /New QC reviews and improvement changes are disabled/)
})

test('plan edits invalidate exact evaluation readiness and paid trial confirmation states bounded work', async () => {
  fixture.admin = true
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'ready', proposal: qcProposal(), admin: true }))
  await render('/qc/improvements/plan-one')
  assert.equal(fixture.calls.paid, 0)
  assert.equal(button('Review activation of evaluated revision 1').disabled, false)
  await fill(field('Proposed Analysis assessment guidance'), 'Revised generalized assessment guidance.')
  assert.equal(button('Review activation of evaluated revision 1').disabled, true)
  assert.match(document.body.textContent, /Historical \/ invalidated/)
  await click(button('Save new plan revision'))
  assert.match(document.body.textContent, /Prior evaluation readiness is invalidated/)
  assert.equal(fixture.plans.get('plan-one').evaluation, null)
  assert.equal(button('Review activation of evaluated revision 2').disabled, true)
  await click(button('Run baseline / candidate trial'))
  assert.match(dialog().textContent, /Up to 2 baseline\/candidate family-case trials/)
  assert.equal(fixture.calls.paid, 0)
  await click(dialog().querySelector('input[type="checkbox"]'))
  await click(button('Confirm paid QC work', dialog()))
  assert.equal(fixture.calls.paid, 1)
  assert.equal(writes().at(-1).body.confirmPaidWork, true)
})

test('paid evaluation uses server-projected compatible pairs including holdouts, not a model-call estimate', async () => {
  const proposal = qcProposal()
  proposal.changes.push({ familyId: 'jobRubric', guidance: 'Use the exact job source scope.', reason: 'Clarify job evidence.' })
  const detail = qcPlanDetail({ proposal })
  detail.plan.cases.push({ ...structuredClone(detail.plan.cases[0]), scope: qcScope('comparison-grade'), purpose: 'holdout' })
  detail.trialScope = { pairs: [
    { scope: detail.plan.cases[0].scope, purpose: 'drafting', familyId: 'assessment' },
    { scope: detail.plan.cases[0].scope, purpose: 'drafting', familyId: 'jobRubric' },
    { scope: detail.plan.cases[1].scope, purpose: 'holdout', familyId: 'assessment' },
  ], baselineTrials: 3, candidateTrials: 3, unsupportedFamilies: [] }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  await click(button('Run baseline / candidate trial'))
  assert.match(dialog().textContent, /3 paired case\/family comparisons/)
  assert.match(dialog().textContent, /3 baseline trial executions and 3 candidate trial executions/)
  assert.match(dialog().textContent, /2 drafting pairs; 1 holdout pairs/)
  assert.match(dialog().textContent, /Trial executions are not model-call counts/)
  assert.match(dialog().textContent, /not a remaining-work count/)
  assert.doesNotMatch(dialog().textContent, /Up to 8/)
  assert.ok([...dialog().querySelectorAll('a')].some(item => item.href.includes('comparison-grade') && item.href.includes('resultSha256=')))
  assert.equal(fixture.calls.paid, 0)
  await click(dialog().querySelector('input[type="checkbox"]'))
  await click(button('Confirm paid QC work', dialog()))
  assert.equal(fixture.calls.paid, 1)
})

test('unsupported saved prompt families disable evaluation without hiding the editable proposal', async () => {
  const proposal = qcProposal()
  proposal.changes.push({ familyId: 'gradeDraft', guidance: 'Use exact grade source evidence.', reason: 'Clarify grade evidence.' })
  const detail = qcPlanDetail({ proposal })
  detail.trialScope = { pairs: [{ scope: qcScope(), purpose: 'drafting', familyId: 'assessment' }],
    baselineTrials: 1, candidateTrials: 1, unsupportedFamilies: ['gradeDraft'] }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  assert.match(document.body.textContent, /No compatible frozen case for: Grade rubric drafting/)
  assert.equal(button('Run baseline / candidate trial').disabled, true)
  assert.equal(field('Proposed Grade rubric drafting guidance').matches(':disabled'), false)
  assert.equal(fixture.calls.paid, 0)
})

test('evaluation resume previews the full pinned scope without inventing remaining calls or checkpoint progress', async () => {
  const detail = qcPlanDetail({ status: 'evaluating', proposal: qcProposal() })
  detail.plan.status = 'failed'
  detail.work.status = 'failed'
  detail.work.checkpoint = { name: 'private/saved-checkpoint', sha256: 'a'.repeat(64), bytes: 120 }
  detail.canEdit = true
  detail.canCancel = false
  detail.trialScope = { pairs: [{ scope: qcScope(), purpose: 'drafting', familyId: 'assessment' }],
    baselineTrials: 1, candidateTrials: 1, unsupportedFamilies: [] }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  await click(button('Resume / retry saved work'))
  assert.match(dialog().textContent, /1 paired case\/family comparisons/)
  assert.match(dialog().textContent, /complete saved evaluation scope, not a remaining-work count/)
  assert.match(dialog().textContent, /reuse completed checkpoints and rerun failed or model-drifted pairs/)
  assert.match(dialog().textContent, /Remaining model calls and completion percentages are not reported/)
  assert.equal(fixture.calls.paid, 0)
  await click(dialog().querySelector('input[type="checkbox"]'))
  await click(button('Confirm paid QC work', dialog()))
  assert.equal(writes().at(-1).url.endsWith('/retry'), true)
  assert.deepEqual(writes().at(-1).body, {})
  assert.equal(fixture.calls.paid, 1)
})

test('trial scope rejects mismatched counts, foreign pins, duplicate pairs and false compatibility claims', async () => {
  for (const mutate of [
    value => { value.baselineTrials = 0 },
    value => { value.candidateTrials = 0 },
    value => { value.pairs[0].scope.resultRevision = 'foreign-revision' },
    value => { value.pairs[0].purpose = 'holdout' },
    value => { value.pairs[0].familyId = 'gradeDraft' },
    value => { value.pairs.push(structuredClone(value.pairs[0])); value.baselineTrials = 2; value.candidateTrials = 2 },
    value => { value.unsupportedFamilies = ['assessment'] },
    value => { value.pairs = []; value.baselineTrials = 0; value.candidateTrials = 0 },
  ]) {
    const detail = qcPlanDetail({ proposal: qcProposal() })
    detail.trialScope = { pairs: [{ scope: qcScope(), purpose: 'drafting', familyId: 'assessment' }],
      baselineTrials: 1, candidateTrials: 1, unsupportedFamilies: [] }
    mutate(detail.trialScope)
    fixture.plans.set('plan-one', detail)
    await assert.rejects(ui.client.getQcPlan('workspace-one', 'plan-one'), /trial-scope projection does not match/)
  }
  assert.equal(writes().length, 0)
})

test('prompt bounds match the immutable registry while review explanations keep their separate limit', async () => {
  assert.equal(ui.domain.QC_LIMITS.guidanceCharacters, ui.PROMPT_REGISTRY_LIMITS.guidanceCharacters)
  assert.equal(ui.domain.QC_LIMITS.guidanceCharacters, 4000)
  assert.equal(ui.domain.QC_LIMITS.activationReasonCharacters, ui.PROMPT_REGISTRY_LIMITS.reasonCharacters)
  assert.equal(ui.domain.QC_LIMITS.activationReasonCharacters, 1000)
  const proposal = qcProposal()
  proposal.changes[0].guidance = 'x'.repeat(4000)
  assert.equal(ui.improvement.qcPlanProposalSchema.safeParse(proposal).success, true)
  proposal.changes[0].guidance += 'x'
  assert.equal(ui.improvement.qcPlanProposalSchema.safeParse(proposal).success, false)
  proposal.changes[0].guidance = 'Use {unresolved_template} rather than complete guidance.'
  assert.equal(ui.improvement.qcPlanProposalSchema.safeParse(proposal).success, false)
  const input = { scope: qcScope(), feedback: [qcFeedback({ reason: 'r'.repeat(2000) })] }
  assert.equal(ui.domain.qcReviewInputSchema.safeParse(input).success, true)
  input.feedback[0].reason += 'r'
  assert.equal(ui.domain.qcReviewInputSchema.safeParse(input).success, false)
  const detail = qcPlanDetail({ status: 'ready', proposal: qcProposal(), admin: true })
  for (const reason of ['', '   ', 'r'.repeat(1001)]) {
    await assert.rejects(ui.client.actOnQcPlan('workspace-one', detail, 'activate', randomUUID(), reason))
    await assert.rejects(ui.client.restoreQcPrompts('workspace-one', 'release-old', '"release-baseline"', reason, randomUUID()))
  }
  assert.equal(writes().length, 0, 'Invalid input never reaches a mutation endpoint')
})

test('guidance accepts exactly 4000 characters and retains over-limit local edits without a save', async () => {
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'ready', proposal: qcProposal() }))
  await render('/qc/improvements/plan-one')
  const guidance = field('Proposed Analysis assessment guidance')
  assert.equal(guidance.maxLength, 4000)
  await fill(guidance, 'x'.repeat(4001))
  assert.equal(guidance.value.length, 4001, 'The editor does not silently truncate an invalid draft')
  assert.equal(button('Save new plan revision').disabled, true)
  assert.equal(writes().length, 0)
  await fill(guidance, 'x'.repeat(4000))
  assert.equal(button('Save new plan revision').disabled, false)
  await click(button('Save new plan revision'))
  assert.equal(writes().at(-1).body.proposal.changes[0].guidance.length, 4000)
})

test('only an administrator can explicitly activate the unchanged evaluated revision with rationale', async () => {
  fixture.admin = true
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'ready', proposal: qcProposal(), admin: true }))
  await render('/qc/improvements/plan-one')
  await click(button('Review activation of evaluated revision 1'))
  assert.match(dialog().textContent, /FUTURE newly accepted work in every workspace/)
  assert.equal(button('Activate evaluated revision for FUTURE work', dialog()).disabled, true)
  const rationale = field('Required administrator rationale', dialog())
  assert.equal(rationale.maxLength, 1000)
  await fill(rationale, 'r'.repeat(1001))
  await click(dialog().querySelector('input[type="checkbox"]'))
  assert.equal(button('Activate evaluated revision for FUTURE work', dialog()).disabled, true)
  assert.match(dialog().textContent, /Use at most 1000 characters/)
  assert.equal(fixture.calls.activated, 0)
  await fill(rationale, 'r'.repeat(1000))
  await click(button('Activate evaluated revision for FUTURE work', dialog()))
  const activation = writes().find(item => item.url.endsWith('/activate'))
  assert.equal(activation.headers.get('If-Match'), '"plan-1"')
  assert.equal(activation.body.confirm, true)
  assert.equal(activation.body.reason.length, 1000)
  assert.equal(fixture.calls.activated, 1)
  assert.equal(fixture.calls.paid, 0)
})

test('ordinary reviewers can inspect ready evaluations but never get activation controls', async () => {
  fixture.plans.set('plan-one', qcPlanDetail({ status: 'ready', proposal: qcProposal() }))
  await render('/qc/improvements/plan-one')
  assert.match(document.body.textContent, /1 \/ 1 exact numeric agreements/)
  assert.match(document.body.textContent, /Only one drafting case/)
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent.includes('Review activation')), false)
  assert.equal(writes().length, 0)
})

test('saved worker findings render unchanged as plain text rather than attributed model quotations', async () => {
  const detail = qcPlanDetail({ status: 'ready', proposal: qcProposal() })
  for (const variant of ['baseline', 'candidate']) {
    Object.assign(detail.evaluation.cases[0][variant], {
      reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0,
      findings: [
        `${variant} saved worker aggregate: low=1, medium=0, high=1. Uncalibrated model-reported strata, not an accuracy estimate.`,
        `${variant} saved worker warning: <img src=x> is literal retained text.`,
      ],
    })
  }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  for (const variant of ['baseline', 'candidate']) {
    const title = `${variant[0].toUpperCase()}${variant.slice(1)}`
    const trial = document.querySelector(`[aria-label="${title} trial"]`)
    const findings = detail.evaluation.cases[0][variant].findings
    assert.deepEqual([...trial.querySelectorAll(':scope > p')].map(item => item.textContent).filter(text => findings.includes(text)), findings)
    assert.equal(trial.querySelector('q,blockquote,img'), null)
    assert.doesNotMatch([...trial.querySelectorAll('h3,h4,h5,h6')].map(item => item.textContent).join(' '), /model.*(?:quote|quotation|said|findings)/i)
    assert.match(trial.textContent, /No numeric human-reference denominator/)
  }
  assert.equal(writes().length, 0)
})

test('generated baseline and candidate rubrics retain independent citations, qualifications and grounding findings', async () => {
  const proposal = qcProposal()
  proposal.changes = [{ familyId: 'gradeDraft', guidance: 'Describe exact source support for each generated criterion.', reason: 'Make grounding inspectable.' }]
  const detail = qcPlanDetail({ status: 'ready', proposal })
  const outcome = detail.evaluation.cases[0]
  outcome.familyId = 'gradeDraft'
  for (const variant of ['baseline', 'candidate']) {
    const citation = { documentId: `${variant}-source`, documentVersion: 3, paragraphId: `${variant}-paragraph`,
      page: 7, heading: `${variant} frozen source heading`, quote: `${variant} exact frozen citation <img src="https://invalid.test/private">` }
    Object.assign(outcome[variant], { reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0,
      rubric: { description: `${variant} generated rubric description`, criteria: [{
        id: 'criterion-one', label: `${variant} independent meaning`, description: `${variant} bounded scope`, weight: 100,
        guidance: `${variant} scoring anchors`, sourceCitations: [citation], competencyId: `${variant}-competency`,
        support: 'derived', interpretation: `${variant} source interpretation`, gradeBasis: [{ ...citation, quote: `${variant} exact grade basis` }],
      }], qualifications: [{ id: 'qualification-one', text: `${variant} unscored credential requirement`, support: 'direct',
        interpretation: `${variant} qualification interpretation`, citations: [{ ...citation, quote: `${variant} qualification source` }] }],
      issues: [{ id: 'finding-one', code: 'source-boundary', scope: 'criterion', severity: 'warning', grade: 12,
        sourceId: citation.documentId, criterionId: 'criterion-one', message: `${variant} limited source scope`,
        citations: [{ ...citation, quote: `${variant} grounding finding source` }] }],
      warnings: [`${variant} retained trial warning`] } })
  }
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  assert.match(document.body.textContent, /not assumed equivalent to historical criteria with matching numeric IDs/)
  for (const variant of ['baseline', 'candidate']) {
    const title = `${variant[0].toUpperCase()}${variant.slice(1)}`
    const trial = document.querySelector(`[aria-label="${title} trial"]`)
    await click([...trial.querySelectorAll('summary')].find(item => item.textContent.startsWith(`${title} generated rubric`)))
    assert.match(trial.textContent, new RegExp(`${variant} independent meaning`))
    assert.match(trial.textContent, new RegExp(`${variant}-source v3 · ${variant}-paragraph · p. 7 · ${variant} frozen source heading`))
    assert.match(trial.textContent, new RegExp(`${variant} exact frozen citation <img`))
    assert.match(trial.textContent, new RegExp(`${variant} exact grade basis`))
    assert.match(trial.textContent, /Source support: derived. This is not a confidence rating./)
    assert.match(trial.querySelector('[aria-label="Unscored qualifications"]').textContent, new RegExp(`${variant} qualification source`))
    assert.match(trial.querySelector('[aria-label="Saved grounding findings"]').textContent, new RegExp(`${variant} grounding finding source`))
    assert.match(trial.textContent, /Grade: 12 · Variant-local criterion: criterion-one/)
    assert.match(trial.textContent, new RegExp(`${variant} retained trial warning`))
    assert.doesNotMatch(trial.textContent, /exact numeric agreements|total absolute difference/)
    assert.equal(trial.querySelector('img'), null)
  }
  assert.equal(writes().length, 0)
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)
  await rerender({ role: 'viewer' })
  assert.doesNotMatch(document.body.textContent, /exact frozen citation|qualification source|grounding finding source|independent meaning/)
})

test('older saved trial rubrics remain readable without fabricating absent grounding artifacts', async () => {
  const detail = qcPlanDetail({ status: 'ready', proposal: qcProposal() })
  detail.plan.proposal.changes[0].familyId = 'jobRubric'
  const outcome = detail.evaluation.cases[0]
  outcome.familyId = 'jobRubric'
  for (const variant of ['baseline', 'candidate']) Object.assign(outcome[variant], {
    reviewedCriteria: 0, exactAgreements: 0, absoluteDifference: 0, rubric: { description: `${variant} legacy saved rubric`,
      criteria: [{ id: 'legacy-one', label: 'Legacy criterion meaning', description: 'Historical scope', weight: 100, guidance: 'Saved anchors' }] },
  })
  fixture.plans.set('plan-one', detail)
  await render('/qc/improvements/plan-one')
  assert.match(document.body.textContent, /Legacy criterion meaning/)
  assert.match(document.body.textContent, /Not recorded in this saved trial/)
  assert.match(document.body.textContent, /Qualifications were not recorded in this saved trial/)
  assert.match(document.body.textContent, /Grounding findings were not recorded in this saved trial/)
  assert.doesNotMatch(document.body.textContent, /No grounding findings recorded/)
  assert.equal(writes().length, 0)
})

test('prompt history comparison is read-only; restore requires rationale, current ETag and app-wide confirmation', async () => {
  fixture.admin = true
  await render('/qc/prompts')
  await click(button('Compare release release-old'))
  assert.match(document.body.textContent, /Previous compatible assessment guidance/)
  assert.equal(writes().length, 0)
  await click(button('Review restore of release-old'))
  const rationale = field('Required restore rationale', dialog())
  assert.equal(rationale.maxLength, 1000)
  await fill(rationale, 'r'.repeat(1001))
  await click(dialog().querySelector('input[type="checkbox"]'))
  assert.equal(button('Confirm app-wide restore', dialog()).disabled, true)
  assert.equal(fixture.calls.restored, 0)
  await fill(rationale, 'r'.repeat(1000))
  await click(button('Confirm app-wide restore', dialog()))
  assert.equal(fixture.calls.restored, 1)
  assert.equal(writes().at(-1).headers.get('If-Match'), '"release-baseline"')
  assert.equal(writes().at(-1).body.revision, 'release-old')
  assert.equal(writes().at(-1).body.reason.length, 1000)
})

test('QC app routing honors basename, focuses navigation, and normal mode keeps its existing navigation', async () => {
  await render('/qc', { app: true })
  assert.ok(document.querySelector('[aria-label="QC navigation"]'))
  assert.deepEqual([...document.querySelectorAll('[aria-label="QC navigation"] a')].map(item => item.textContent), ['Reviews', 'Quality improvement', 'Prompt versions'],
    'The QC sidebar leaves the return to normal mode to the top bar')
  assert.equal(document.querySelector('.sidebar').textContent.includes('Return to normal mode'), false)
  assert.equal(document.querySelector('[aria-label="Main navigation"]'), null)
  assert.equal([...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'New analysis'), false)
  assert.ok([...document.querySelectorAll('a')].some(item => item.href.endsWith('/workspaces/workspace-one/qc/improvements')))
  await click(button('Normal mode'))
  assert.ok(document.querySelector('[aria-label="Main navigation"]'))
  assert.ok(button('New analysis'))
})

test('StrictMode effect replay does not permanently abort the QC privacy scope', async () => {
  await render('/qc/reviews/run-one/comparison-1', { strict: true })
  await until(() => document.body.textContent.includes('Engineering methods'), 'StrictMode QC data finishes loading')
  assert.equal(button('Submit complete comparison').disabled, true)
  assert.equal(writes().length, 0)
})
