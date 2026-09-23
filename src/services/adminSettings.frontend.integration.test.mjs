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
import { analysisSummaryFixture, summaryHistoryFixture, summaryRunId } from './analysisSummaries.test-support.mjs'

const output = resolve(`.admin-frontend-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const pause = (milliseconds = 10) => new Promise(resolve => setTimeout(resolve, milliseconds))
const user = { id: 'reviewer', tenantId: 'tenant', name: 'Reviewer', email: 'reviewer@example.test' }
const metadata = { id: 'workspace-one', name: 'Workspace one', role: 'owner', etag: '"workspace-one"' }
let ui, dom, root, createRoot, requests, settings, revision, override, admin, workspaces, workspace, observedPolicy, observedAnalyses
const json = (body, status = 200) => Response.json(body, { status })
function testWorkspace() {
  return {
    documents: [{ id: 'document-one', title: 'Captured source', kind: 'job', version: 1, sample: false, paragraphs: [
      { id: 'paragraph-one', page: 1, heading: 'Duties', text: 'Captured source evidence supports this review.' },
    ] }],
    jobs: [{ id: 'job-one', title: 'Program analyst', organization: 'Agency', location: 'Remote', arrangement: 'Remote',
      employmentType: 'Full-time', grade: 'GS-13', series: '0343', source: 'pdf', sourceLabel: 'Captured job.pdf',
      documentId: 'document-one', rubricId: 'rubric-one', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' }],
    rubrics: [{ id: 'rubric-one', groupId: 'rubric-group-one', kind: 'job', jobId: 'job-one', name: 'Job rubric',
      description: 'Measures the role.', version: 1, createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real',
      criteria: [{ id: 'criterion-one', key: 'technical', label: 'Evidence', description: 'Uses evidence.',
        guidance: 'Check exact source evidence.', weight: 100, requirementType: 'required',
        sourceCitations: [{ documentId: 'document-one', documentVersion: 1, paragraphId: 'paragraph-one',
          page: 1, heading: 'Duties', quote: 'source evidence' }] }] }],
    lifecycle: { entities: {} },
  }
}
const testResume = () => ({ id: 'resume-one', name: 'Captured resume', displayName: 'Captured resume.pdf', status: 'ready',
  source: 'pdf', sourceLabel: 'Captured resume.pdf', documentId: 'document-one', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' })
function projection(value = settings, id = revision) {
  return ui.projectPublicSettings(ui.captureProcessingSettings(value, id, '2026-01-01T00:00:00.000Z'))
}
function response(value = settings, id = revision) {
  return {
    settings: structuredClone(value), revision: id, etag: `"${id}"`, createdAt: '2026-01-01T00:00:00.000Z',
    defaults: ui.createDefaultAdminSettings(), fields: ui.ADMIN_SETTINGS_FIELDS,
    environment: {
      runtimeEnabled: true, runtimeSettingsVersion: 'score-runtime-settings-v1', workerVerification: null,
      runtimeReadiness: { configured: true, newProcessingAllowed: true, reason: null, message: null },
      storeConfigured: true, tenantId: user.tenantId, administratorUserIds: [user.id],
      model: { endpoint: null, resourceId: null, authentication: 'managed-identity', inventoryAvailable: true,
        probeIdentity: 'api-managed-identity', workerIdentityVerified: false },
    },
  }
}

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/admin/settings', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent',
    'PopStateEvent', 'DocumentFragment', 'localStorage']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  for (const [name, value] of Object.entries({
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  originals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  dom.window.matchMedia = globalThis.matchMedia
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      export { CloudApplication } from './src/app/CloudApplication';
      export { App } from './src/app/App';
      export { ThemeControl } from './src/app/ThemeControl';
      export { resolveTheme } from './src/app/theme';
      export { PublicSettingsProvider } from './src/app/PublicSettingsProvider';
      export { PublicSettingsContext, usePublicSettings, clientAdmissionReason, originalDownloadReason } from './src/app/public-settings-context';
      export { WorkspaceContext } from './src/app/workspace-context';
      export { AdminSettingsPage } from './src/features/admin/AdminSettingsPage';
      export { GradeNavigationProtectionProvider } from './src/app/GradeNavigationProtection';
      export { useGradeLeaveGuard } from './src/app/grade-navigation-context';
      export { RealAnalysesBridge } from './src/app/RealAnalysesBridge';
      export { useRealAnalyses } from './src/app/real-analyses-context';
      export { RealResumesContext } from './src/app/real-resumes-context';
      export { GradeLaddersContext } from './src/app/grade-ladders-context';
      export { JobDetail } from './src/features/jobs/JobsPage';
      export { RealResumesPage } from './src/features/resumes/RealResumesPage';
      export { GradeSourceInspector } from './src/features/grade-ladders/GradeSourceInspector';
      export { createDefaultAdminSettings } from './src/domain/admin-settings-defaults';
      export { ADMIN_SETTINGS_STORAGE_LIMITS, settingsJsonBytes } from './src/domain/admin-settings';
      export { projectPublicSettings, captureProcessingSettings, diffAdminSettings } from './src/domain/admin-settings-resolver';
      export { ADMIN_SETTINGS_FIELDS } from './src/domain/admin-settings-fields';
      export { effectiveFeatures } from './server/settings/features';
      export { initialGradeContext, initialGradeLevels } from './src/features/grade-ladders/gradeDefaults';
      export { requireGradeLevels, gradeSourceOriginalUrl } from './src/services/gradeLadders';
      export { createRealAnalysis } from './src/services/realAnalyses';
      export { importRealJobFile } from './src/services/realJobs';
      export * as publicPolicy from './src/services/publicSettings';
      export * as adminClient from './src/services/adminSettings';
      export { MemoryRouter, Route, Routes } from 'react-router-dom';
    ` },
    outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node',
    jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
  })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

beforeEach(() => {
  requests = []; override = null; admin = true; workspaces = []; observedPolicy = null; observedAnalyses = null
  settings = ui.createDefaultAdminSettings(); revision = 'revision-1'; workspace = testWorkspace()
  dom.window.localStorage.clear()
  dom.window.history.replaceState(null, '', '/admin/settings')
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'https://score.test').pathname
    const method = init.method ?? 'GET'
    requests.push({ path, url, method, init })
    const custom = await override?.(path, init, url)
    if (custom !== undefined) return custom
    if (path === '/api/features') return json({
      realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
      markdownJobImports: true, markdownResumeImports: true, wordDocumentImports: true,
      analysisSummaryGeneration: true, publicSettings: projection(),
    })
    if (path === '/api/session/identity') return json({ mode: 'cloud', user, capabilities: { applicationAdmin: admin } })
    if (path === '/api/session') return json({ mode: 'cloud', user, capabilities: { applicationAdmin: admin }, workspaces })
    if (path === '/api/workspaces') return json({ workspaces })
    const workspaceCounts = /^\/api\/workspaces\/([^/]+)\/summary$/.exec(path)
    if (workspaceCounts) return json({ workspaceId: workspaceCounts[1], jobs: { status: 'ready', count: 0 }, resumes: { status: 'ready', count: 0 }, analyses: { status: 'ready', count: 0 } })
    if (path.endsWith('/state')) throw new Error(`Workspace state API must not be used: ${method} ${path}`)
    if (path.endsWith('/jobs')) return json({ jobs: [] })
    if (path.endsWith('/resumes')) return json({ resumes: [] })
    if (path.endsWith('/grade-ladders')) return json({ ladders: [] })
    if (path.endsWith('/analyses/targets')) return json({ targets: [] })
    if (path.endsWith('/analyses')) return json({ runs: [] })
    if (path === '/api/admin/settings' && method === 'GET') return json(response())
    if (path === '/api/admin/settings' && method === 'PATCH') {
      settings = JSON.parse(init.body); revision = `revision-${Number(revision.split('-')[1]) + 1}`
      return json(response())
    }
    if (path === '/api/admin/settings/history') return json({ revisions: [] })
    throw new Error(`Unexpected fixture request: ${method} ${url}`)
  }
})
afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
})
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

async function render(tree) {
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(tree); await pause() })
}
async function until(predicate, message) {
  for (let index = 0; index < 150; index++) {
    if (predicate()) return
    await act(async () => { await pause() })
  }
  assert.fail(`${message}\n${document.body.textContent.slice(0, 2000)}`)
}
function button(label, within = document) {
  const result = [...within.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
  assert.ok(result, `Button "${label}" exists`)
  return result
}
const click = async item => { await act(async () => { item.click(); await pause() }) }
function dialog(title) { return [...document.querySelectorAll('[role="dialog"]')].find(item => item.querySelector('h2')?.textContent === title) }
async function edit(input, value) {
  assert.ok(input, 'Editable control exists')
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function field(path) {
  await edit(document.querySelector('input[aria-label="Search application settings"]'), path)
  const wrapper = [...document.querySelectorAll('.settings-field')].find(item => item.querySelector('code')?.textContent === path)
  assert.ok(wrapper, `Setting ${path} exists`)
  return wrapper.querySelector('input,textarea,select')
}
function unloadBlocked() {
  const event = new dom.window.Event('beforeunload', { cancelable: true })
  dom.window.dispatchEvent(event)
  return event.defaultPrevented
}
async function renderAdmin(onLeave = () => {}) {
  await render(element(ui.GradeNavigationProtectionProvider, { workspaceId: 'application-settings', routePrefix: '/admin/settings', apiRef: { current: null } },
    element(ui.AdminSettingsPage, { onLeave })))
  await until(() => document.querySelector('.settings-savebar'), 'Admin settings load')
}
async function reviewTitle(title) {
  await edit(await field('appearance.applicationTitle'), title)
  await click(button('Review and save'))
  assert.ok(dialog('Review application changes'))
}
const patches = () => requests.filter(item => item.method === 'PATCH' && item.path === '/api/admin/settings')

test('direct application-admin settings is independent of workspace bootstrap and stays available when features fail', async () => {
  override = path => path === '/api/features' ? json({ error: { message: 'Public policy unavailable' } }, 503) : undefined
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.settings-savebar'), 'Direct settings route loads')
  assert.ok(requests.some(item => item.path === '/api/session/identity'))
  assert.ok(!requests.some(item => item.path === '/api/session' || item.path.startsWith('/api/workspaces')))
  assert.match(document.body.textContent, /APPLICATION-WIDE/)
})

test('a workspace owner without explicit application capability cannot read the admin route', async () => {
  admin = false; workspaces = [metadata]
  await render(element(ui.CloudApplication))
  await until(() => document.body.textContent.includes('Application administrator access required'), 'Non-admin denial is visible')
  assert.match(document.body.textContent, /Owning a workspace does not grant access/)
  assert.ok(!requests.some(item => item.path.startsWith('/api/admin')))
})

test('returning from direct administration loads a directory instead of presenting a failed read as an empty account', async () => {
  workspaces = [metadata]
  override = path => path === '/api/session' ? json({ error: { code: 'unavailable', message: 'Directory temporarily unavailable.' } }, 503) : undefined
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.settings-savebar'), 'Direct settings route loads')
  await click(button('Back to workspaces'))
  await until(() => document.body.textContent.includes('The workspace list is unavailable.'), 'Unread directory is explicit')
  assert.equal(document.querySelector('.workspace-directory'), null)
  assert.doesNotMatch(document.body.textContent, /Your first workspace starts here/)
  assert.equal(button('New workspace').disabled, true)
  assert.equal(button('Application settings').disabled, false)
  override = null
  await click(button('Retry workspace list'))
  await until(() => document.querySelector('.workspace-directory'), 'Retry loads actual workspaces')
  assert.ok(button(metadata.name))
  assert.ok(!requests.some(item => item.path.endsWith('/state')))
})

for (const archived of [false, true]) test(`admin navigation remains reachable with ${archived ? 'only an archived workspace' : 'no workspaces'}`, async () => {
  dom.window.history.replaceState(null, '', '/')
  workspaces = archived ? [{ ...metadata, archivedAt: '2026-01-01T00:00:00.000Z' }] : []
  settings.workspaces.allowCreation = false
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.workspace-directory'), 'Empty workspace gate loads')
  assert.equal(button('New workspace').disabled, true)
  await click(button('Application settings'))
  await until(() => document.querySelector('.settings-savebar'), 'Settings open independently')
  assert.equal(location.pathname, '/admin/settings')
  assert.ok(!requests.some(item => item.path.endsWith('/state')))
})

test('entering admin honors dirty workspace drafts, with cancel and explicit discard', async () => {
  dom.window.history.replaceState(null, '', '/workspaces/workspace-one/grade-ladders/new')
  workspaces = [metadata]
  await render(element(ui.CloudApplication))
  const familyName = () => document.querySelector('input[placeholder="A recognizable role or specialty"]')
  await until(familyName, 'Grade creation form loads')
  await edit(familyName(), 'Unsaved family name')
  await click(button('Application settings'))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(familyName().value, 'Unsaved family name')
  assert.ok(!requests.some(item => item.path === '/api/admin/settings'))
  await click(button('Application settings'))
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  await until(() => document.querySelector('.settings-savebar'), 'Explicit discard allows admin navigation')
})

test('dirty settings protect beforeunload and leaving, without saving on discard', async () => {
  let left = 0
  await renderAdmin(() => { left++ })
  assert.equal(unloadBlocked(), false)
  await edit(await field('appearance.applicationTitle'), 'Unpublished title')
  assert.equal(unloadBlocked(), true)
  await click(button('Back to workspaces'))
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(left, 0)
  assert.equal((await field('appearance.applicationTitle')).value, 'Unpublished title')
  await click(button('Back to workspaces'))
  await click(button('Discard unsaved changes and leave', dialog('Unsaved changes')))
  assert.equal(left, 1)
  assert.equal(patches().length, 0)
})

test('dirty admin browser-back cancellation restores the admin route and draft', async () => {
  await render(element(ui.CloudApplication))
  await until(() => document.querySelector('.settings-savebar'), 'Settings load')
  await edit(await field('appearance.applicationTitle'), 'Retained on back')
  await act(async () => {
    dom.window.history.pushState(null, '', '/')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
    await pause()
  })
  await click(button('Stay here', dialog('Unsaved changes')))
  await until(() => location.pathname === '/admin/settings', 'Admin route is restored')
  assert.equal((await field('appearance.applicationTitle')).value, 'Retained on back')
})

test('local validation, server validation, and failed saves retain drafts and show no invented success', async () => {
  await renderAdmin()
  await edit(await field('imports.jobs.maxBatchItems'), '11')
  await click(button('Review and save'))
  assert.match(document.body.textContent, /Validation errors/)
  assert.equal(patches().length, 0)
  assert.equal((await field('imports.jobs.maxBatchItems')).value, '11')
  await edit(await field('imports.jobs.maxBatchItems'), '5')
  await reviewTitle('Saved only when acknowledged')
  override = (path, init) => path === '/api/admin/settings' && init.method === 'PATCH'
    ? json({ error: { message: 'Deployment review failed', fields: [{ path: 'appearance.applicationTitle', message: 'Server rejected this title' }] } }, 400) : undefined
  await click(button('Publish new revision', dialog('Review application changes')))
  assert.match(document.body.textContent, /Server rejected this title/)
  assert.equal(dialog('Review application changes') !== undefined, true)
  override = (path, init) => path === '/api/admin/settings' && init.method === 'PATCH'
    ? json({ error: { message: 'Settings store unavailable' } }, 503) : undefined
  await click(button('Publish new revision', dialog('Review application changes')))
  assert.match(dialog('Review application changes').textContent, /Settings store unavailable/)
  await click(button('Keep editing', dialog('Review application changes')))
  assert.equal((await field('appearance.applicationTitle')).value, 'Saved only when acknowledged')
  assert.ok(!document.body.textContent.includes('Saved application settings revision'))
})

test('oversized UTF-8 drafts display a root validation error without truncating text or making a request', async () => {
  await renderAdmin()
  const text = '界'.repeat(1000)
  const candidate = structuredClone(settings)
  for (const path of ['maintenance.explanation', 'grades.defaults.specialty', 'reports.additionalFooter', 'appearance.announcement.text']) {
    const keys = path.split('.')
    let parent = candidate
    for (const key of keys.slice(0, -1)) parent = parent[key]
    parent[keys.at(-1)] = text
    await edit(await field(path), text)
  }
  assert.ok(JSON.stringify(candidate).length < ui.ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes, 'The character count alone would incorrectly fit')
  assert.ok(ui.settingsJsonBytes(candidate) > ui.ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes, 'Canonical UTF-8 exceeds the real storage budget')
  await click(button('Review and save'))
  const errors = document.querySelector('[aria-label="Settings validation errors"]')
  assert.ok(errors)
  assert.equal(errors.querySelector('button').textContent, 'settings')
  assert.match(errors.textContent, /byte/i)
  assert.equal(dialog('Review application changes'), undefined)
  assert.equal((await field('appearance.announcement.text')).value, text)
  assert.equal(patches().length, 0)
})

test('server resolved-snapshot byte errors keep the reviewed draft and show the global field message', async () => {
  const message = `Resolved settings snapshot exceeds ${ui.ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes} serialized UTF-8 bytes. Reduce the configuration before publishing.`
  override = (path, init) => path === '/api/admin/settings' && init.method === 'PATCH'
    ? json({ error: { code: 'invalid_request', message, fields: [{ path: '', message }] } }, 400) : undefined
  await renderAdmin()
  const title = 'Draft retained after snapshot size rejection'
  await reviewTitle(title)
  await click(button('Publish new revision', dialog('Review application changes')))
  const errors = document.querySelector('[aria-label="Settings validation errors"]')
  assert.equal(errors.querySelector('button').textContent, 'settings')
  assert.ok(errors.textContent.includes(message))
  assert.ok(dialog('Review application changes').textContent.includes(message))
  assert.equal(patches().length, 1)
  assert.equal(JSON.parse(patches()[0].init.body).appearance.applicationTitle, title)
  assert.equal(document.querySelector('.settings-savebar code').textContent, 'revision-1')
  await click(button('Keep editing', dialog('Review application changes')))
  assert.equal((await field('appearance.applicationTitle')).value, title)
  assert.notEqual(settings.appearance.applicationTitle, title, 'The rejected candidate never replaces acknowledged settings')
})

test('ETag conflict shows server diff and requires explicit rebase, review, and a fresh conditional save', async () => {
  await renderAdmin()
  await reviewTitle('My reviewed title')
  let first = true
  override = (path, init) => {
    if (path !== '/api/admin/settings' || init.method !== 'PATCH' || !first) return undefined
    first = false
    settings.appearance.applicationTitle = 'Another administrator title'
    settings.navigation.defaultPage = 'resumes'
    revision = 'revision-2'
    return json({ error: { message: 'Revision conflict' } }, 412)
  }
  await click(button('Publish new revision', dialog('Review application changes')))
  await until(() => document.querySelector('[aria-label="Settings conflict"]'), 'Conflict panel loads')
  assert.match(document.body.textContent, /Another administrator title/)
  assert.equal(patches().length, 1)
  await click(button('Rebase my changes for review'))
  assert.equal(patches().length, 1)
  await click(button('Review and save'))
  await click(button('Publish new revision', dialog('Review application changes')))
  await until(() => document.body.textContent.includes('Saved application settings revision revision-3'), 'Conditional rebase is acknowledged')
  assert.equal(patches()[1].init.headers.get('If-Match'), '"revision-2"')
  assert.equal(settings.appearance.applicationTitle, 'My reviewed title')
  assert.equal(settings.navigation.defaultPage, 'resumes')
  assert.equal(unloadBlocked(), false)
})

test('history pagination and restore publish a new revision without deleting old history', async () => {
  const old = ui.createDefaultAdminSettings()
  old.appearance.applicationTitle = 'Historical title'
  const entry = { revision: 'older-1', createdAt: '2025-12-01T00:00:00.000Z', reason: 'save', actor: { oid: 'other', tenantId: 'tenant' },
    changes: ui.diffAdminSettings(settings, old), settings: old }
  override = (path, init, url) => {
    if (path === '/api/admin/settings/history') return json(url.includes('before=') ? { revisions: [] } : { revisions: [entry], nextBefore: 'older-1' })
    if (path === '/api/admin/settings/revisions/older-1') return json(entry)
    if (path === '/api/admin/settings/restore') {
      assert.deepEqual(JSON.parse(init.body), { revision: 'older-1' })
      assert.equal(init.headers.get('If-Match'), '"revision-1"')
      settings = old; revision = 'revision-2'
      return json(response())
    }
  }
  await renderAdmin()
  await click(button('History & restore'))
  await click(button('Load older revisions'))
  assert.ok(requests.some(item => item.url.includes('before=older-1')))
  await click(button('Inspect revision older-1'))
  await click(button('Review restore as new revision'))
  assert.ok(!requests.some(item => item.path.endsWith('/restore')))
  await click(button('Publish new revision', dialog('Review settings restore')))
  assert.ok(requests.some(item => item.path.endsWith('/restore') && item.method === 'POST'))
  assert.equal(patches().length, 0)
})

test('imports require server preview and explicit apply; synthetic tests require a separate cost confirmation', async () => {
  const imported = structuredClone(settings)
  imported.appearance.applicationTitle = 'Imported title'
  const documentValue = { format: 'score-admin-settings', schemaVersion: 1, sourceRevision: 'portable-1', settings: {} }
  override = (path, init) => {
    if (path.endsWith('/import-preview')) return json({ baseRevision: revision, etag: `"${revision}"`, settings: imported, changes: ui.diffAdminSettings(settings, imported) })
    if (path.endsWith('/import-apply')) {
      assert.deepEqual(JSON.parse(init.body), { document: documentValue, confirm: true })
      assert.equal(init.headers.get('If-Match'), '"revision-1"')
      settings = imported; revision = 'revision-2'
      return json(response())
    }
    if (path === '/api/admin/deployments/refresh') {
      assert.equal(init.body, '{}')
      return json({ checkedAt: '2026-01-01T00:00:00.000Z', deployments: [] })
    }
    if (path === '/api/admin/deployments/test') {
      const input = JSON.parse(init.body)
      assert.equal(input.confirmPaidProbe, true)
      assert.equal(input.taskId, 'jobRubric')
      assert.equal(input.draft.appearance.applicationTitle, 'Imported title')
      assert.ok(!Object.hasOwn(input, 'workspace'))
      return json({ kind: 'task', status: 'passed', deploymentId: 'default', identity: 'api-managed-identity',
        checkedAt: '2026-01-01T00:00:00.000Z', checks: [{ name: 'Synthetic adapter', passed: true, message: 'Synthetic only' }] })
    }
  }
  await renderAdmin()
  await click(button('Import settings'))
  await edit(dialog('Preview nonsecret settings import').querySelector('textarea'), JSON.stringify(documentValue))
  await click(button('Validate and preview import'))
  assert.ok(dialog('Review settings import'))
  assert.ok(!requests.some(item => item.path.endsWith('/import-apply')))
  await click(button('Publish new revision', dialog('Review settings import')))
  await click(button('Refresh deployment inventory'))
  assert.ok(!requests.some(item => item.path === '/api/admin/deployments/test'))
  await click(button('Configure synthetic test'))
  const probe = dialog('Explicit synthetic model test')
  assert.equal(button('Run explicit test', probe).disabled, true)
  await click(probe.querySelector('input[type="checkbox"]'))
  await click(button('Run explicit test', probe))
  assert.match(document.body.textContent, /passing probe is not proof of worker readiness/i)
})

test('connection checks are free management reads and HTTP 200 failed probes are not presented as successes', async () => {
  let wire, requestOptions
  override = (path, init) => {
    if (path !== '/api/admin/deployments/test') return undefined
    wire = JSON.parse(init.body); requestOptions = init
    return json({
      kind: 'connection', status: 'failed', checkedAt: '2026-01-01T00:00:00.000Z',
      deploymentId: wire.deploymentId, identity: 'api-managed-identity', workerIdentityVerified: false,
      checks: [{ name: 'Scoped management read', passed: false, message: 'The explicitly selected deployment could not be reached.' }],
    })
  }
  await renderAdmin()
  await click(button('Configure synthetic test'))
  const probe = dialog('Explicit synthetic model test')
  await edit(probe.querySelector('select'), 'connection')
  assert.equal(probe.querySelector('input[type="checkbox"]'), null)
  assert.match(probe.textContent, /free scoped management read.*do not run model inference/)
  assert.equal(button('Run explicit test', probe).disabled, false)
  await click(button('Run explicit test', probe))
  assert.equal(wire.kind, 'connection')
  assert.equal(wire.deploymentId, settings.ai.defaultDeploymentId)
  assert.equal(wire.confirmPaidProbe, false)
  assert.deepEqual(wire.draft, settings)
  assert.equal(Object.hasOwn(wire, 'settings'), false)
  assert.equal(Object.hasOwn(wire, 'acknowledgeCost'), false)
  assert.equal(requestOptions.credentials, 'same-origin')
  assert.equal(requestOptions.mode, 'same-origin')
  assert.equal(requestOptions.headers.get('X-Score-Request'), 'workspace')
  assert.match(document.body.textContent, /connection: failed/)
  assert.doesNotMatch(document.body.textContent, /connection: passed/)
  assert.equal(patches().length, 0)
})

test('paid probes reject missing acknowledgement before HTTP and a changed task requires fresh confirmation', async () => {
  for (const kind of ['structured-output', 'task']) {
    assert.throws(() => ui.adminClient.testModelConfiguration({
      kind, deploymentId: settings.ai.defaultDeploymentId, ...(kind === 'task' ? { taskId: 'jobRubric' } : {}),
      settings, acknowledgeCost: false,
    }), /Explicitly acknowledge possible inference charges/)
  }
  assert.equal(requests.length, 0)
  await renderAdmin()
  await click(button('Configure synthetic test'))
  const probe = dialog('Explicit synthetic model test')
  await click(probe.querySelector('input[type="checkbox"]'))
  assert.equal(button('Run explicit test', probe).disabled, false)
  await edit(probe.querySelectorAll('select')[1], 'resumeProfile')
  assert.equal(probe.querySelector('input[type="checkbox"]').checked, false)
  assert.equal(button('Run explicit test', probe).disabled, true)
  assert.ok(!requests.some(request => request.path === '/api/admin/deployments/test'))
})

test('QC planning has an editable dedicated binding and only explicit paid confirmation runs its synthetic probe', async () => {
  let wire
  override = (path, init) => {
    if (path !== '/api/admin/deployments/test') return undefined
    wire = JSON.parse(init.body)
    return json({ kind: 'task', status: 'passed', deploymentId: wire.deploymentId, identity: 'api-managed-identity',
      checkedAt: '2026-01-01T00:00:00.000Z', checks: [{ name: 'QC planner adapter', passed: true, message: 'Synthetic content only.' }] })
  }
  await renderAdmin()
  const task = [...document.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.startsWith('QC improvement planning'))
  assert.ok(task)
  await edit(task.querySelector('select'), settings.ai.defaultDeploymentId)
  await click(button('Configure synthetic test'))
  const probe = dialog('Explicit synthetic model test')
  await edit(probe.querySelectorAll('select')[1], 'qcPlan')
  assert.equal(button('Run explicit test', probe).disabled, true)
  assert.equal(wire, undefined)
  await click(probe.querySelector('input[type="checkbox"]'))
  await click(button('Run explicit test', probe))
  assert.equal(wire.taskId, 'qcPlan')
  assert.equal(wire.deploymentId, settings.ai.defaultDeploymentId)
  assert.equal(wire.confirmPaidProbe, true)
  assert.equal(wire.draft.ai.tasks.qcPlan.deploymentId, settings.ai.defaultDeploymentId)
  assert.equal(settings.ai.tasks.qcPlan.deploymentId, null, 'A synthetic probe never publishes the edited binding')
  assert.equal(patches().length, 0)
})

test('legacy QC settings upgrade is explicit, discardable, and never mutates the saved v1 configuration', async () => {
  settings.schemaVersion = 1
  delete settings.ai.tasks.qcPlan
  delete settings.processing.qc
  delete settings.workers.qc
  const saved = JSON.stringify(settings)
  await renderAdmin()
  assert.doesNotMatch(document.body.textContent, /QC improvement planning/)
  assert.equal(unloadBlocked(), false)
  await edit(document.querySelector('input[aria-label="Search application settings"]'), 'processing.qc')
  assert.equal(document.querySelectorAll('.settings-field').length, 0, 'Missing legacy QC policy cannot be edited piecemeal')
  await edit(document.querySelector('input[aria-label="Search application settings"]'), '')
  await click(button('Configure synthetic test'))
  assert.equal([...dialog('Explicit synthetic model test').querySelectorAll('option')].some(item => item.value === 'qcPlan'), false)
  await click(button('Cancel', dialog('Explicit synthetic model test')))
  await click(button('Add QC settings to draft'))
  assert.match(document.body.textContent, /QC improvement planning/)
  assert.equal(unloadBlocked(), true)
  assert.equal(JSON.stringify(settings), saved)
  assert.equal(patches().length, 0)
  await click(button('Configure synthetic test'))
  await edit(dialog('Explicit synthetic model test').querySelectorAll('select')[1], 'qcPlan')
  await click(button('Cancel', dialog('Explicit synthetic model test')))
  await click(button('Discard'))
  await click(button('Discard settings draft', dialog('Discard settings draft?')))
  assert.equal(unloadBlocked(), false)
  assert.equal(JSON.stringify(settings), saved)
  assert.doesNotMatch(document.body.textContent, /QC improvement planning/)
  await click(button('Configure synthetic test'))
  const probe = dialog('Explicit synthetic model test')
  assert.match(probe.textContent, /selected task is not configured/)
  await click(probe.querySelector('input[type="checkbox"]'))
  assert.equal(button('Run explicit test', probe).disabled, true, 'A stale QC selection cannot run after discarding its binding')
  assert.equal(requests.some(item => item.path === '/api/admin/deployments/test'), false)
})

test('publishing a QC configuration upgrade retains unrelated v1 values and creates a reviewed new revision', async () => {
  settings.schemaVersion = 1
  delete settings.ai.tasks.qcPlan
  delete settings.processing.qc
  delete settings.workers.qc
  settings.appearance.applicationTitle = 'Existing application title'
  const before = structuredClone(settings)
  await renderAdmin()
  await click(button('Add QC settings to draft'))
  await click(button('Review and save'))
  const review = dialog('Review application changes')
  assert.ok(review)
  assert.match(review.textContent, /ai\.tasks\.qcPlan/)
  assert.match(review.textContent, /schemaVersion/)
  assert.equal(patches().length, 0)
  assert.deepEqual(settings, before)
  await click(button('Publish new revision', review))
  assert.equal(patches().length, 1)
  assert.equal(patches()[0].init.headers.get('If-Match'), '"revision-1"')
  assert.equal(settings.schemaVersion, 2)
  assert.ok(settings.ai.tasks.qcPlan && settings.processing.qc && settings.workers.qc)
  const withoutQc = structuredClone(settings)
  withoutQc.schemaVersion = 1
  delete withoutQc.ai.tasks.qcPlan
  delete withoutQc.processing.qc
  delete withoutQc.workers.qc
  assert.deepEqual(withoutQc, before)
  assert.equal(requests.some(item => item.path === '/api/admin/deployments/test'), false)
  assert.equal(revision, 'revision-2')
})

function PolicyProbe() { observedPolicy = ui.usePublicSettings(); return element(ui.ThemeControl) }
test('public provider consumes the actual server feature envelope without a settings wire alias', async () => {
  settings.appearance.applicationTitle = 'Authoritative feature policy'
  settings.documents.formattedDocxPreviewEnabled = false
  settings.documents.originalDownloadRoles = ['owner']
  settings.imports.jobs.allowedFormats = ['pdf', 'docx']
  const capabilities = {
    realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
    analysisSummaryGeneration: true, wordDocumentImports: false,
  }
  const body = ui.effectiveFeatures(capabilities, ui.captureProcessingSettings(settings, revision, '2026-01-01T00:00:00.000Z'), true)
  assert.equal(Object.hasOwn(body, 'settings'), false)
  assert.equal(body.settingsRevision, revision)
  assert.equal(body.runtimeSettingsEnabled, true)
  assert.deepEqual(body.deploymentCapabilities, capabilities)
  override = path => path === '/api/features' ? json(body) : undefined
  await render(element(ui.PublicSettingsProvider, null, element(PolicyProbe)))
  await until(() => observedPolicy?.phase === 'ready', 'The actual server feature response is recognized')
  assert.deepEqual(observedPolicy.settings, body.publicSettings)
  assert.equal(observedPolicy.settings.revision, revision)
  assert.equal(observedPolicy.settings.documents.formattedDocxPreviewEnabled, false)
  assert.deepEqual(observedPolicy.settings.documents.originalDownloadRoles, ['owner'])
  assert.deepEqual(observedPolicy.settings.imports.jobs.allowedFormats, ['pdf'], 'Effective server deployment gates are retained')
  assert.equal(document.title, 'Authoritative feature policy')
})

test('missing cloud projection fails closed; only an explicitly unconfigured deployment retains legacy defaults', async () => {
  override = path => path === '/api/features' ? json({ realJobImports: true, realResumeImports: true, realAnalyses: true }) : undefined
  await render(element(ui.PublicSettingsProvider, null, element(PolicyProbe)))
  await until(() => observedPolicy?.phase === 'error', 'Missing cloud policy is not treated as a demo or acknowledged legacy response')
  assert.equal(observedPolicy.settings, null)
  assert.match(ui.clientAdmissionReason(observedPolicy, 'jobImports'), /did not provide effective application policy/)
  const legacy = ui.effectiveFeatures({
    realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
    analysisSummaryGeneration: true, wordDocumentImports: true,
  }, ui.captureProcessingSettings(ui.createDefaultAdminSettings(), 'legacy-v1', '2026-01-01T00:00:00.000Z'), false, false)
  override = path => path === '/api/features' ? json(legacy) : undefined
  await act(async () => { await observedPolicy.refresh() })
  assert.equal(observedPolicy.phase, 'ready')
  assert.equal(observedPolicy.settings.runtimeEnabled, false)
  assert.equal(observedPolicy.settings.runtimeReadiness.configured, false)
  assert.equal(observedPolicy.settings.imports.jobs.maxBatchItems, 10)
  assert.equal(ui.clientAdmissionReason(observedPolicy, 'jobImports'), null)
})

test('configured inactive rollout retains saved access and appearance policy while denying only new processing', async () => {
  settings.appearance.applicationTitle = 'Saved policy while processing is paused'
  settings.documents.originalDownloadRoles = ['owner']
  settings.documents.formattedDocxPreviewEnabled = false
  settings.reports.enabledFormats = ['csv']; settings.reports.defaultFormat = 'csv'; settings.reports.allowedRoles = ['owner']
  settings.summaries.historyRoles = 'owner'; settings.summaries.historyPageSize = 3
  settings.summaries.allowManualPublication = false; settings.summaries.manualPublicationRoles = 'owner'
  settings.imports.jobs.maxFileBytes = 1024; settings.imports.jobs.maxBatchItems = 2
  const body = ui.effectiveFeatures({
    realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
    analysisSummaryGeneration: true, wordDocumentImports: true,
  }, ui.captureProcessingSettings(settings, revision, '2026-01-01T00:00:00.000Z'), false, true)
  override = path => path === '/api/features' ? json(body) : undefined
  await render(element(ui.PublicSettingsProvider, null, element(PolicyProbe)))
  await until(() => observedPolicy?.phase === 'ready', 'Configured inactive policy remains available')
  const retained = observedPolicy.settings
  assert.equal(retained.runtimeEnabled, false)
  assert.equal(retained.runtimeReadiness.configured, true)
  assert.equal(retained.runtimeReadiness.newProcessingAllowed, false)
  assert.equal(document.title, settings.appearance.applicationTitle)
  assert.deepEqual(retained.documents, settings.documents)
  assert.deepEqual(retained.reports, settings.reports)
  assert.deepEqual(retained.summaries, {
    generationMode: settings.summaries.generationMode, allowManualPublication: false,
    manualPublicationRoles: 'owner', historyRoles: 'owner', historyPageSize: 3,
  })
  assert.equal(retained.imports.jobs.maxFileBytes, 1024)
  assert.equal(retained.imports.jobs.maxBatchItems, 2)
  assert.deepEqual(retained.imports.jobs.allowedFormats, [])
  for (const kind of ['jobImports', 'resumeImports', 'gradeLadders', 'newAnalyses', 'summaryGeneration']) {
    assert.equal(ui.clientAdmissionReason(observedPolicy, kind), retained.runtimeReadiness.message)
  }
  assert.equal(ui.originalDownloadReason(observedPolicy, 'owner'), null, 'Authorized original reads are not processing admissions')
  assert.match(ui.originalDownloadReason(observedPolicy, 'viewer'), /current workspace role cannot download/)
  override = path => path === '/api/features' ? json({ error: { code: 'unavailable', message: 'Configured policy store is unavailable.' } }, 503) : undefined
  await act(async () => { await observedPolicy.refresh() })
  assert.equal(observedPolicy.phase, 'error')
  assert.equal(observedPolicy.settings, retained, 'A failed refresh does not substitute permissive defaults')
  assert.match(ui.originalDownloadReason(observedPolicy, 'owner'), /until current application policy can be checked/)
})

test('admin readiness explains that the rollout flag pauses new processing without disabling saved policy', async () => {
  override = (path, init) => {
    if (path !== '/api/admin/settings' || (init.method && init.method !== 'GET')) return undefined
    const current = response()
    current.environment.runtimeEnabled = false
    current.environment.runtimeReadiness = {
      configured: true, newProcessingAllowed: false, reason: 'worker-verification-required',
      message: 'Verify the deployed worker readers before enabling new processing.',
    }
    return json(current)
  }
  await renderAdmin()
  await click(button('Environment & readiness'))
  const panel = document.querySelector('[aria-label="Read-only environment and administrator roster"]')
  assert.match(panel.textContent, /New-processing rollout flagDisabled/)
  assert.match(panel.textContent, /New-processing admissionPaused/)
  assert.match(panel.textContent, /Saved policy remains enforced for access, exports, limits, and appearance/)
  assert.match(panel.textContent, /Verify the deployed worker readers/)
  assert.doesNotMatch(panel.textContent, /Legacy defaults/)
})

test('public settings refresh changes the projection and title, but preserves saved system and host precedence', async () => {
  settings.appearance.defaultTheme = 'dark'; settings.appearance.applicationTitle = 'Agency evidence'
  dom.window.localStorage.setItem('score-theme', 'system')
  await render(element(ui.PublicSettingsProvider, null, element(PolicyProbe)))
  await until(() => observedPolicy?.phase === 'ready', 'Public policy loads')
  assert.equal(document.title, 'Agency evidence')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light')
  assert.equal(ui.resolveTheme('system', 'dark'), 'system')
  assert.equal(ui.resolveTheme('dark', 'light', 'light'), 'light')
  assert.equal(ui.resolveTheme(null, 'dark'), 'dark')
  const captured = observedPolicy.settings
  settings.imports.jobs.maxBatchItems = 2; revision = 'revision-2'
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); await pause() })
  assert.equal(observedPolicy.settings.imports.jobs.maxBatchItems, 2)
  assert.equal(captured.imports.jobs.maxBatchItems, 10, 'An active operation snapshot is not mutated')
  override = path => path === '/api/features' ? json({ error: { message: 'Policy refresh unavailable' } }, 503) : undefined
  await act(async () => { await observedPolicy.refresh() })
  assert.equal(observedPolicy.phase, 'error')
  assert.match(ui.clientAdmissionReason(observedPolicy, 'jobImports'), /503|unavailable/i)
})

test('host scoutTheme remains authoritative when an ordinary link removes its query', async () => {
  dom.window.history.replaceState(null, '', '/admin/settings?scoutTheme=dark')
  settings.appearance.defaultTheme = 'light'
  dom.window.localStorage.setItem('score-theme', 'light')
  await render(element(ui.PublicSettingsProvider, null, element(PolicyProbe)))
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  dom.window.history.replaceState(null, '', '/admin/settings')
  await act(async () => { await observedPolicy.refresh() })
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  assert.equal(button('Use light theme').disabled, true)
})

test('new-operation preflight honors safe projection, hard ceilings, and retained GS levels without reading files', async () => {
  settings.imports.jobs.allowedFormats = ['markdown']; settings.imports.jobs.maxFileBytes = 1024
  settings.imports.jobs.maxBatchItems = 2; settings.imports.urls.requireHttps = true
  settings.analyses.maxComparisons = 1
  settings.grades.allowedLevels = [12, 13]; settings.grades.defaults.levels = [12]
  settings.grades.defaults.agency = 'Agency default'; settings.grades.defaults.functions = ['research']
  let publicValue = projection()
  assert.deepEqual(ui.publicPolicy.effectiveFormats(['pdf', 'markdown', 'docx'], publicValue, 'jobs'), ['markdown'])
  assert.throws(() => ui.publicPolicy.requireImportBatch(3, 'jobs', publicValue), /1 and 2/)
  assert.throws(() => ui.publicPolicy.requireImportUrl('http://agency.example/jobs', 'jobs', publicValue), /HTTPS/)
  let reads = 0
  const file = { name: 'job.pdf', type: 'application/pdf', size: 500, arrayBuffer: () => { reads++; return new ArrayBuffer(1) } }
  await assert.rejects(ui.importRealJobFile('workspace-one', file, randomUUID(), undefined, undefined, publicValue), /not enabled|not allowed|Choose|supported/i)
  assert.equal(reads, 0); assert.equal(requests.length, 0)
  const resumes = [{ resumeId: 'r1' }, { resumeId: 'r2' }]
  await assert.rejects(ui.createRealAnalysis('workspace-one', { name: 'No truncation', resumes, targets: [{}] }, randomUUID(), publicValue), /at most 1 comparisons/)
  assert.doesNotThrow(() => ui.requireGradeLevels([11, 12], publicValue, [11]))
  assert.throws(() => ui.requireGradeLevels([11, 12], publicValue), /New GS levels/)
  assert.deepEqual(ui.initialGradeLevels(publicValue), [12])
  const context = ui.initialGradeContext(publicValue, { organization: 'Source agency', series: '2210' })
  assert.equal(context.agency, 'Source agency'); assert.equal(context.confirmed, false)
  assert.equal(ui.initialGradeContext(publicValue).agency, 'Agency default')
  assert.equal(ui.publicPolicy.clampClientLimits({ retries: 2 }, { retries: 0 }).retries, 0)
  assert.equal(ui.publicPolicy.clampClientLimits({ comparisons: 500 }, { comparisons: 1000 }).comparisons, 500)
  settings.features.jobImports = false; publicValue = projection()
  assert.match(ui.publicPolicy.admissionReason(publicValue, 'jobImports'), /history remain available/)
})

test('policy appearance, hidden cloud sample affordances, default navigation, and explicit deep links are applied', async () => {
  settings.navigation.defaultPage = 'rubrics'
  settings.appearance.applicationTitle = 'Agency evidence'
  settings.appearance.announcement = { enabled: true, text: 'Review carefully', tone: 'warning' }
  settings.help.supportUrl = 'https://agency.example/support'; settings.help.documentationUrl = 'https://agency.example/help'
  const context = frontendWorkspaceContext({ workspace, cloud: { currentWorkspaceId: metadata.id } })
  const sampleAffordancesAreAbsent = () => {
    assert.equal(document.querySelector('.library-kind-switcher'), null)
    // No Samples switcher, sample reset, sample save status, or any other sample wording remains.
    assert.doesNotMatch(document.body.textContent, /\bsamples?\b|saved on this device/i)
    assert.equal(document.querySelector('.about-chip'), null)
    assert.ok([...document.querySelectorAll('.sidebar-links button.nav-item')].some(item => item.textContent.trim() === 'About Agency evidence'))
  }
  const tree = path => element(ui.PublicSettingsContext.Provider, { value: { settings: projection(), phase: 'ready', error: null, cloud: true, refresh: async () => {} } },
    element(ui.WorkspaceContext.Provider, { value: context }, element(ui.MemoryRouter, { key: path, initialEntries: [path],
      future: { v7_startTransition: true, v7_relativeSplatPath: true } }, element(ui.App))))
  for (const visible of [false, true]) {
    settings.features.samplesVisible = visible
    await render(tree('/'))
    await until(() => document.querySelector('h1')?.textContent === 'Rubrics', 'Configured default page is selected')
    sampleAffordancesAreAbsent()
  }
  await render(tree('/'))
  await until(() => document.querySelector('h1')?.textContent === 'Rubrics', 'Configured default page is selected')
  assert.ok(document.querySelector('a[aria-label="Agency evidence home"]'))
  assert.match(document.body.textContent, /Review carefully/)
  assert.ok(document.querySelector('a[href="https://agency.example/support"]'))
  sampleAffordancesAreAbsent()
  await render(tree('/jobs'))
  assert.equal(document.querySelector('h1').textContent, 'Your jobs')
  sampleAffordancesAreAbsent()
})

test('all twelve task bindings offer inheritance, deployment-specific reasoning, and bounded advanced controls', async () => {
  await renderAdmin()
  assert.equal(document.querySelectorAll('details.settings-section').length, 12)
  for (const item of document.querySelectorAll('details.settings-section')) {
    const selection = item.querySelector('select')
    assert.equal(selection.options[0].value, '')
    assert.match(selection.options[0].textContent, /Use application default/)
    assert.match(selection.closest('label').textContent, /Default source: compiled-default/)
    assert.match(selection.closest('label').textContent, /Source: application-revision/)
  }
  const reasoning = await field('ai.tasks.jobRubric.reasoningEffort')
  assert.deepEqual([...reasoning.options].map(option => option.value), ['', 'minimal', 'low', 'medium', 'high'])
  const temperature = await field('ai.tasks.jobRubric.temperature')
  assert.equal(temperature.disabled, true, 'The default GPT-5 deployment rejects sampling parameters')
  const completion = await field('ai.tasks.jobRubric.completionTokenLimit')
  assert.equal(Number(completion.max), 8192)
  assert.equal(Number((await field('ai.tasks.qcPlan.completionTokenLimit')).max), 16384)
  await edit(document.querySelector('input[aria-label="Search application settings"]'), 'ai.defaultDeploymentId')
  assert.ok(document.querySelector('[aria-label="Azure deployment catalog"]'), 'Custom deployment controls are searchable by metadata path')
})

test('deployment-seeded defaults display their provenance and a default reset remains an unsaved draft', async () => {
  settings.workers.jobs.maxItemsPerExecution = 6
  const configuredDefaults = ui.createDefaultAdminSettings()
  configuredDefaults.workers.jobs.maxItemsPerExecution = 5
  override = (path, init) => path === '/api/admin/settings' && (!init.method || init.method === 'GET') ? json({
    ...response(), defaults: configuredDefaults,
    fields: ui.ADMIN_SETTINGS_FIELDS.map(item => item.path === 'workers.jobs.maxItemsPerExecution'
      ? { ...item, defaultValue: 5, defaultSource: 'WORKER_MAX_JOBS' }
      : ['ai.deployments', 'ai.defaultDeploymentId'].includes(item.path)
        ? { ...item, defaultSource: 'AZURE_OPENAI_DEPLOYMENT_NAME' } : item),
  }) : undefined
  await renderAdmin()
  const control = await field('workers.jobs.maxItemsPerExecution')
  const wrapper = control.closest('.settings-field')
  assert.equal(control.value, '6')
  assert.match(wrapper.textContent, /Default: 5/)
  assert.match(wrapper.textContent, /Default source: WORKER_MAX_JOBS/)
  assert.match(wrapper.textContent, /Source: application-revision/)
  assert.doesNotMatch(wrapper.textContent, /Default: 4/)
  await click(button('Use default', wrapper))
  assert.equal(control.value, '5')
  assert.match(wrapper.textContent, /Source: Unsaved draft/)
  assert.equal(patches().length, 0, 'A configured-default reset still requires review and save')
  await edit(document.querySelector('input[aria-label="Search application settings"]'), 'ai.defaultDeploymentId')
  const catalog = document.querySelector('[aria-label="Azure deployment catalog"]')
  assert.match(catalog.textContent, /Default source: AZURE_OPENAI_DEPLOYMENT_NAME/)
  assert.match(catalog.querySelector('label.field.mt-4').textContent, /Default source: AZURE_OPENAI_DEPLOYMENT_NAME/)
})

test('rubric AI assistant switch is on for revisions saved before it existed and publishes only explicit changes', async () => {
  assert.equal('rubricAssistant' in settings.features, false, 'The fixture revision predates the switch')
  await renderAdmin()
  const control = await field('features.rubricAssistant')
  const wrapper = control.closest('.settings-field')
  assert.equal(control.type, 'checkbox')
  assert.equal(control.checked, true, 'Absent means on')
  assert.match(wrapper.textContent, /Rubric AI assistant/)
  assert.match(wrapper.textContent, /Default: On/)
  assert.doesNotMatch(wrapper.textContent, /changed/)
  assert.equal(unloadBlocked(), false)
  await click(control)
  assert.equal(control.checked, false)
  assert.match(wrapper.textContent, /changed/)
  assert.equal(unloadBlocked(), true)
  await click(control)
  assert.equal(control.checked, true)
  assert.doesNotMatch(wrapper.textContent, /changed/)
  assert.equal(unloadBlocked(), false, 'Turning it back on restores the unsaved default instead of pinning a redundant value')
  assert.match(document.querySelector('.settings-savebar').textContent, /0 unsaved changes/)

  await click(control)
  await click(button('Review and save'))
  const review = dialog('Review application changes')
  assert.match(review.textContent, /features\.rubricAssistant/)
  assert.match(review.textContent, /Not saved \(default: On\)/)
  assert.doesNotMatch(review.textContent, /undefined/)
  await click(button('Publish new revision', review))
  assert.equal(patches().length, 1)
  assert.equal(JSON.parse(patches()[0].init.body).features.rubricAssistant, false)
  assert.equal((await field('features.rubricAssistant')).checked, false)

  await click(button('Review reset to defaults'))
  const reset = dialog('Review reset to defaults')
  assert.match(reset.textContent, /features\.rubricAssistant/)
  await click(button('Publish new revision', reset))
  assert.equal(patches().length, 2)
  assert.equal(JSON.parse(patches()[1].init.body).features.rubricAssistant, true, 'A merging PATCH must name the switch to reset it')
})

for (const recorded of [false, true]) {
  test(`read-only worker rollout evidence is ${recorded ? 'verification-time only, never live health' : 'explicitly absent when not configured or cleared'}`, async () => {
    const receipt = recorded ? {
      workerVersion: 'score-runtime-settings-v1', image: 'score.azurecr.io/score:verified-fixture',
      verifiedAt: '2026-09-21T12:00:00.000Z', verificationTimeOnly: true, liveHealth: false,
    } : null
    override = (path, init) => {
      if (path !== '/api/admin/settings' || (init.method && init.method !== 'GET')) return undefined
      const current = response()
      current.environment.workerVerification = receipt
      return json(current)
    }
    await renderAdmin()
    await click(button('Environment & readiness'))
    const panel = document.querySelector('[aria-label="Read-only environment and administrator roster"]')
    assert.match(panel.textContent, /API reader contractscore-runtime-settings-v1/)
    assert.equal(panel.querySelector('input,select,textarea'), null, 'Deployment evidence is not an editable settings field')
    assert.match(panel.textContent, /Not verified by API-side synthetic tests/)
    assert.match(panel.textContent, /does not monitor current worker identity, inference health, or deployment drift/)
    if (receipt) {
      assert.match(panel.textContent, /Recorded verification-time evidence only — not live worker health/)
      assert.ok(panel.textContent.includes(receipt.image))
      assert.equal(panel.querySelector('time').dateTime, receipt.verifiedAt)
    } else {
      assert.match(panel.textContent, /No verification-time worker rollout evidence recorded/)
      assert.equal(panel.querySelector('time'), null)
    }
    assert.ok(requests.every(request => (request.init.method ?? 'GET') === 'GET'), 'Viewing rollout evidence does not save, discover deployments, or run inference')
  })
}

for (const kind of ['job', 'resume', 'reference']) {
  test(`${kind} original links recheck current workspace role and policy while retaining extracted evidence`, async () => {
    const timestamp = '2026-01-01T00:00:00.000Z'
    const original = { blobName: 'captured/source.pdf', contentType: 'application/pdf', bytes: 100, sha256: 'a'.repeat(64) }
    const local = kind === 'resume' ? testResume() : workspace.jobs[0]
    const documentValue = structuredClone(workspace.documents.find(item => item.id === local.documentId))
    documentValue.sample = false
    workspace.documents = workspace.documents.map(item => item.id === documentValue.id ? documentValue : item)
    const evidence = documentValue.paragraphs[0].text.slice(0, 40)
    let view, resumes = null, resumeSummary = null, grades = null
    let cloud = {}, route = '/'
    if (kind === 'job') {
      const job = { ...local, dataKind: 'real' }
      workspace.jobs = workspace.jobs.map(item => item.id === job.id ? job : item)
      const source = { kind: 'pdf', displayName: 'Captured job.pdf', originalContentType: original.contentType, bytes: original.bytes, sha256: original.sha256 }
      cloud = { realJobs: {
        source: () => source, detail: () => ({ state: 'ready', value: {} }),
        summaries: [{ job, source, etag: '"job-original"', warnings: [], attempts: 1 }],
        originalUrl: id => `/api/workspaces/${metadata.id}/jobs/${id}/original`,
      } }
      route = `/jobs/${job.id}`
      view = element(ui.Routes, null, element(ui.Route, { path: '/jobs/:id', element: element(ui.JobDetail) }))
    } else if (kind === 'resume') {
      const value = {
        resume: { ...local, dataKind: 'real', status: 'ready' }, workspaceId: metadata.id, etag: '"resume-original"',
        source: { kind: 'pdf', displayName: 'Captured resume.pdf' }, capture: { original, capturedAt: timestamp },
        document: documentValue, documentRef: null, profile: null, warnings: [], duplicates: [], attempts: 1, retryCount: 0,
      }
      resumeSummary = value
      resumes = {
        workspaceId: metadata.id, phase: 'ready', error: null, features: null, canWrite: false, summaries: [value],
        detail: () => ({ state: 'ready', value }), ensureDetail: async () => {}, refresh: async () => {}, pending: () => false,
        originalUrl: id => `/api/workspaces/${metadata.id}/resumes/${id}/original`,
      }
      view = element(ui.RealResumesPage, { id: value.resume.id })
    } else {
      documentValue.kind = 'reference'
      documentValue.selectedPages = []
      documentValue.completeness = 'complete'
      documentValue.pageCount = Math.max(...documentValue.paragraphs.map(item => item.page))
      const source = {
        sourceId: 'reference-policy', documentId: documentValue.id, documentVersion: documentValue.version,
        title: 'Captured reference policy', origin: 'opm', purpose: 'grading', publisher: 'OPM', authorityStatus: 'current',
        documentBlobName: 'captured/reference.json', originalBlobName: original.blobName, sha256: original.sha256,
        pageCount: documentValue.pageCount, selectedPages: [], completeness: 'complete',
        coverage: { series: ['0801'], grades: [9], functions: [], state: 'confirmed', explanation: 'Captured reference coverage.' }, issues: [],
      }
      grades = {
        sourceSet: async () => ({ sources: [source], createdAt: timestamp }), document: async () => documentValue,
        originalUrl: (ladderId, sourceId, sourceSetId) => ui.gradeSourceOriginalUrl(metadata.id, ladderId, sourceId, sourceSetId),
      }
      view = element(ui.GradeSourceInspector, { ladderId: 'ladder-policy', selection: { sourceId: source.sourceId, sourceSetId: 'source-set-policy' }, onClose: () => {} })
    }
    async function show(role, phase = 'ready', roles = ['owner'], missingProjection = false) {
      settings.documents.originalDownloadRoles = roles
      const policy = { settings: missingProjection ? null : projection(), cloud: true, phase, error: phase === 'error' ? 'Policy unavailable' : null, refresh: async () => {} }
      const context = frontendWorkspaceContext({ workspace, cloud: {
        ...cloud, currentWorkspaceId: metadata.id, workspaces: [
          { ...metadata, id: 'another-workspace', role: 'owner' }, ...(role ? [{ ...metadata, role }] : []),
        ],
      } }, resumeSummary ? { resumes: [resumeSummary] } : {})
      await render(element(ui.PublicSettingsContext.Provider, { value: policy },
        element(ui.WorkspaceContext.Provider, { value: context },
          element(ui.RealResumesContext.Provider, { value: resumes },
            element(ui.GradeLaddersContext.Provider, { value: grades },
              element(ui.MemoryRouter, { initialEntries: [route], future: { v7_startTransition: true, v7_relativeSplatPath: true } }, view))))))
      if (kind === 'resume' && !role) {
        await until(() => !document.body.textContent.includes(evidence), 'A removed workspace membership hides cached resume evidence')
      } else await until(() => document.body.textContent.includes(evidence), `${kind} extracted evidence stays readable for current members`)
    }
    await show('viewer')
    assert.equal(document.querySelector('a[download]'), null, 'An owner role in another workspace cannot authorize this source')
    assert.match(document.body.textContent, /current workspace role cannot download original/)
    await show('owner')
    assert.ok(document.querySelector('a[download]'), 'An explicitly allowed current role can download')
    assert.equal(new URL(document.querySelector('a[download]').href).searchParams.has('preview'), false)
    for (const phase of ['loading', 'error']) {
      await show('owner', phase)
      assert.equal(document.querySelector('a[download]'), null, `Cloud ${phase} denies raw bytes without hiding evidence`)
    }
    await show('owner', 'ready', [])
    assert.equal(document.querySelector('a[download]'), null, 'An empty role allowlist revokes original access')
    await show(undefined)
    assert.equal(document.querySelector('a[download]'), null, 'Missing current membership never borrows another workspace role')
    await show('owner', 'ready', ['owner'], true)
    assert.equal(document.querySelector('a[download]'), null, 'A missing cloud projection is not an unrestricted default')
    await show('viewer', 'ready', ['viewer'])
    assert.ok(document.querySelector('a[download]'), 'Original-read roles are independent of edit permission')
    assert.ok(requests.every(item => !item.path.endsWith('/original')), 'Permission checks do not prefetch raw bytes')
  })
}

function WorkspaceDraftGuard() {
  ui.useGradeLeaveGuard(true, false, 'Staged resume sources', 'workspace')
  return null
}
test('workspace-scoped staged inputs survive local navigation but guard admin/switch/unload boundaries', async () => {
  const protection = { current: null }
  await render(element(ui.GradeNavigationProtectionProvider, { workspaceId: metadata.id, apiRef: protection }, element(WorkspaceDraftGuard)))
  assert.equal(unloadBlocked(), true)
  assert.equal(await protection.current.confirmLeave(), true, 'In-workspace navigation keeps bridge-owned staged inputs')
  let leaving
  await act(async () => { leaving = protection.current.confirmLeave(undefined, true); await pause() })
  assert.ok(dialog('Unsaved changes'))
  await click(button('Stay here', dialog('Unsaved changes')))
  assert.equal(await leaving, false)
})

for (const scenario of ['disabled features', 'inactive rollout', 'unavailable policy']) {
  test(`new-action restrictions preserve historical library reads and disable both resume entry points: ${scenario}`, async () => {
    if (scenario === 'disabled features') settings.features = { ...settings.features, jobImports: false, resumeImports: false, gradeLadders: false, newAnalyses: false, summaryGeneration: false }
    const body = ui.effectiveFeatures({
      realJobImports: true, realGradeLadders: true, realResumeImports: true, realAnalyses: true,
      analysisSummaryGeneration: true, wordDocumentImports: true,
    }, ui.captureProcessingSettings(settings, revision, '2026-01-01T00:00:00.000Z'), scenario !== 'inactive rollout', true)
    override = path => path === '/api/features'
      ? scenario === 'unavailable policy' ? json({ error: { code: 'unavailable', message: 'Policy store unavailable.' } }, 503) : json(body)
      : undefined
    workspaces = [metadata]
    dom.window.history.replaceState(null, '', '/workspaces/workspace-one/jobs')
    await render(element(ui.CloudApplication))
    await until(() => ['/jobs', '/resumes', '/grade-ladders', '/analyses'].every(suffix =>
      requests.some(item => item.path === `/api/workspaces/workspace-one${suffix}` && item.method === 'GET')), 'Every saved library is fetched without admitting new work')
    assert.equal(button('Add jobs').disabled, true)
    const resumesLink = [...document.querySelectorAll('a')].find(link => new URL(link.href).pathname === '/workspaces/workspace-one/resumes')
    assert.ok(resumesLink, 'Historical resume navigation remains available')
    await click(resumesLink)
    await until(() => document.querySelector('[aria-label="Real resume library"]')?.textContent.includes('No saved real resumes'), 'A healthy historical service is not marked unavailable when new imports are denied')
    assert.equal(button('Add resumes').disabled, true)
    assert.equal(button('Add real resumes').disabled, true)
    assert.doesNotMatch(document.body.textContent, /Resume service unavailable|Every candidate is fictional/)
    assert.ok(!requests.some(item => item.method === 'POST'))
  })
}

function AnalysisPolicyProbe() { observedAnalyses = ui.useRealAnalyses(); return null }
test('private history and manual publication recheck current role policy without hiding saved analyses', async () => {
  const fixture = analysisSummaryFixture()
  const privateHistory = summaryHistoryFixture(fixture, { rounds: 1 })
  settings.summaries.manualPublicationRoles = 'owner'
  settings.summaries.historyPageSize = 2
  override = path => path.endsWith('/summaries/candidate/comparison-1/history') ? json(privateHistory) : undefined
  const tree = role => element(ui.PublicSettingsContext.Provider, {
    value: { settings: projection(), phase: 'ready', cloud: true, error: null, refresh: async () => {} },
  }, element(ui.WorkspaceContext.Provider, { value: frontendWorkspaceContext({ workspace, cloud: {
    currentWorkspaceId: fixture.workspaceId, workspaces: [{ ...metadata, id: fixture.workspaceId, role }],
  } }) }, element(ui.MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    element(ui.RealAnalysesBridge, { workspaceId: fixture.workspaceId }, element(AnalysisPolicyProbe)))))
  await render(tree('editor'))
  await until(() => observedAnalyses?.phase === 'ready', 'Saved analysis service loads')
  assert.equal(observedAnalyses.canReviewSummaries, true)
  const subject = { kind: 'candidate', subjectId: 'comparison-1' }
  await assert.rejects(observedAnalyses.publishSummaryDraft(summaryRunId, subject, {}, '"old"'), /Manual summary publication is not permitted/)
  settings.summaries.historyRoles = 'owner'; revision = 'revision-2'
  await render(tree('editor'))
  assert.equal(observedAnalyses.canReviewSummaries, false)
  await assert.rejects(observedAnalyses.summaryHistory(summaryRunId, subject), /Only workspace owners/)
  await render(tree('owner'))
  assert.equal(observedAnalyses.canReviewSummaries, true)
  const page = await observedAnalyses.summaryHistory(summaryRunId, subject)
  assert.equal(page.entries.length, 2)
  const request = requests.findLast(item => item.path.endsWith('/history'))
  assert.ok(!request.url.includes('limit='), 'Server applies the effective page size; the strict route does not accept a limit query')
  assert.ok(!requests.some(item => item.method === 'POST'))
})
