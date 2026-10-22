import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, test } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { frontendWorkspaceContext } from './frontend.test-support.mjs'

const output = resolve(`.rubric-approval-tests-${randomUUID()}`)
const originals = new Map()
const h = React.createElement
let dom, root, createRoot, ui
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
const HASH = 'a'.repeat(64)

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent',
    'DocumentFragment', 'DOMException', 'KeyboardEvent', 'MouseEvent', 'localStorage']) {
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
  originals.set('crypto', Object.getOwnPropertyDescriptor(globalThis, 'crypto'))
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: { randomUUID } })
  originals.set('CSS', Object.getOwnPropertyDescriptor(globalThis, 'CSS'))
  Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: { escape: (value) => String(value).replace(/["\\\]]/g, '\\$&') } })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { RubricPanel } from './src/features/rubrics/RubricPanel'
    export { WorkspaceContext } from './src/app/workspace-context'
    export { EVIDENCE_SCALE_VERSION } from './src/domain/evidence-scale'
    export { RubricsPage } from './src/features/rubrics/RubricsPage'
    export { JobsPage } from './src/features/jobs/JobsPage'
    export { BulkRubricApproval } from './src/features/rubrics/BulkRubricApproval'
    export { RealAnalysisSetup } from './src/features/analyses/RealAnalysisSetup'
    export { RealAnalysesContext } from './src/app/real-analyses-context'
    export { RealResumesContext } from './src/app/real-resumes-context'
    export { LibraryViewStateContext, createLibraryViewStore } from './src/app/library-view-state'
    export { rubricApprovalPresentation, summarizeRubricQa, buildRubricFixInstruction } from './src/domain/rubric-approval'
    export { BrowserRouter, Routes, Route } from 'react-router-dom'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

afterEach(async () => {
  if (root) { await act(async () => { root.unmount(); await pause() }); root = null }
  document.body.innerHTML = '<div id="root"></div>'
})

after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

const citation = (quote) => ({ documentId: 'doc-1', documentVersion: 1, paragraphId: 'p1', page: 1, heading: 'Duties', quote })
const levels = [1, 2, 3, 4, 5].map((level) => ({ level, examples: `Documents analysis work at level ${level}.` }))
const unexpected = async () => { throw new Error('Unexpected rubric approval call.') }

function fixture({ legacy = false } = {}) {
  const document = {
    id: 'doc-1', title: 'Program analyst', kind: 'job', version: 1, sample: false,
    paragraphs: [{ id: 'p1', page: 1, heading: 'Duties', text: 'Lead data analysis and communicate findings to stakeholders.' }],
  }
  const criterion = (id, label, weight, quote) => ({
    id, key: 'custom', label, description: `${label} for the role.`, guidance: 'Rendered from the evidence scale.', weight,
    requirementType: 'required', sourceParagraphId: 'p1', sourceCitations: [citation(quote)], ...(legacy ? {} : { levels }),
  })
  const rubric = {
    id: 'rubric-1', groupId: 'rubric-group-1', kind: 'job', jobId: 'job-1', name: 'Program analyst rubric',
    description: 'Assess job requirements.', version: 2, createdAt: '2026-01-02T00:00:00.000Z', dataKind: 'real',
    provenance: { kind: 'edited', model: 'fixture', promptVersion: 'fixture' },
    ...(legacy ? {} : { scaleVersion: ui.EVIDENCE_SCALE_VERSION }),
    criteria: [criterion('criterion-1', 'Analysis', 60, 'Lead data analysis'), criterion('criterion-2', 'Communication', 40, 'communicate findings to stakeholders')],
  }
  const firstVersion = { ...rubric, version: 1, createdAt: '2026-01-01T00:00:00.000Z' }
  const job = { id: 'job-1', title: 'Program analyst', organization: 'Fixture org', location: '', arrangement: '', employmentType: '', grade: '', series: '', source: 'pdf', sourceLabel: 'job.pdf', documentId: document.id, rubricId: rubric.id, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', dataKind: 'real' }
  return { workspace: { jobs: [job], documents: [document], rubrics: [rubric] }, job, document, rubric, firstVersion }
}

const pointer = (version) => ({ approvalId: `rubric-approval-${version}`, rubricId: 'rubric-1', version, rubricHash: HASH, approvedBy: 'owner', approvedAt: '2026-01-04T00:00:00.000Z' })
const checkState = ({ blockers = [], checks = null } = {}) => ({ rubricId: 'rubric-1', version: 2, rubricHash: HASH, status: 'draft', blockers, checks })
const qaRecord = (checks = [], findings = []) => ({
  id: 'rubric-qa:rubric-1:2:score-rubric-qa-v1', workspaceId: 'workspace-one', recordType: 'rubric-qa', jobId: 'job-1', rubricId: 'rubric-1', version: 2,
  rubricHash: HASH, qaVersion: 'score-rubric-qa-v1', checks,
  review: { promptVersion: 'score-job-rubric-review-v1', model: 'fixture-model', summary: 'The criteria cover separate work.', findings },
  createdBy: 'owner', createdAt: '2026-01-03T00:00:00.000Z',
})
const overlap = { code: 'same-capability', severity: 'warning', criterionIds: ['criterion-1', 'criterion-2'], message: 'Both criteria may credit the same analysis work.' }
const structure = { code: 'scale-structure', severity: 'blocker', criterionIds: ['criterion-1'], message: 'Level 3 repeats level 2.' }

async function render({ role = 'owner', approval, legacy = false, required = true, checksAvailable = true, ...api } = {}, panelProps = {}) {
  const data = fixture({ legacy })
  const ctx = frontendWorkspaceContext({
    workspace: data.workspace,
    cloud: {
      currentWorkspaceId: 'workspace-one',
      workspaces: [{ id: 'workspace-one', name: 'Fixture workspace', role, etag: '"workspace"' }],
      realJobs: {
        features: {
          realJobImports: true, markdownJobImports: true, wordDocumentImports: false, rubricAssistant: false, rubricExports: false,
          rubricApprovalRequired: required, rubricChecks: checksAvailable,
          limits: { maxCriteria: 20, maxBatchFiles: 10, maxFileBytes: 1, maxPdfBytes: 1, maxPdfPages: 1, maxSourceCharacters: 1000, maxUrlLength: 1000, maxMarkdownBytes: 1 },
        },
        detail: () => ({ state: 'ready', value: {
          job: data.job, document: data.document, rubric: data.rubric, rubricVersions: [data.firstVersion, data.rubric],
          ...(approval ? { rubricApproval: approval } : {}),
          source: { kind: 'pdf', displayName: 'job.pdf' }, etag: '"job"', updatedAt: data.job.createdAt, attempts: 1, warnings: [],
        } }),
        source: () => ({ kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf' }),
        rubricChecks: unexpected, runRubricChecks: unexpected, approveRubric: unexpected, ...api,
      },
    },
  })
  root ??= createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(h(ui.BrowserRouter, null, h(ui.WorkspaceContext.Provider, { value: ctx },
      h(ui.RubricPanel, { rubric: panelProps.version === 1 ? data.firstVersion : data.rubric, readOnly: panelProps.readOnly ?? false }))))
    await pause()
  })
}

const text = () => document.body.textContent.replace(/\s+/g, ' ')
const dialog = () => document.querySelector('[role="dialog"]')
const findButton = (label, within = document) => [...within.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent.trim()) === label)
function button(label, within = document) {
  const found = findButton(label, within)
  assert.ok(found, `Button "${label}" exists`)
  return found
}
async function click(node) { await act(async () => { node.click(); await pause() }) }

test('an owner runs the checks on the latest scaled draft, reviews the findings and approves that exact version', async () => {
  const calls = []
  const checked = checkState({ checks: qaRecord([], [overlap]) })
  await render({
    rubricChecks: async (jobId, rubricId, version) => { calls.push(['read', jobId, rubricId, version]); return checkState() },
    runRubricChecks: async (jobId, rubricId, version) => { calls.push(['run', jobId, rubricId, version]); return checked },
    approveRubric: async (jobId, state) => { calls.push(['approve', jobId, state]) },
  })
  assert.match(text(), /Approval Draft/)
  assert.match(text(), /Not approved yet\. New analyses and grade ladders can use this rubric only after a workspace owner approves it\./)
  await click(button('Check and approve'))
  assert.ok(dialog(), 'The approval dialog opens')
  assert.equal(button('Approve version 2', dialog()).disabled, true, 'Approval waits for the checks')
  await click(button('Run rubric checks', dialog()))
  assert.match(dialog().textContent, /The criteria cover separate work\./)
  assert.match(dialog().textContent, /Review before approving/)
  assert.match(dialog().textContent, /Both criteria may credit the same analysis work\./)
  assert.match(dialog().textContent, /01 Analysis · 02 Communication/)
  assert.equal(button('Approve version 2', dialog()).disabled, false, 'Warnings inform the owner but don’t block approval')
  await click(button('Approve version 2', dialog()))
  assert.deepEqual(calls, [['read', 'job-1', 'rubric-1', 2], ['run', 'job-1', 'rubric-1', 2], ['approve', 'job-1', checked]])
  assert.equal(dialog(), null, 'The dialog closes after approval')
})

test('blocking findings keep Approve disabled and say what to fix', async () => {
  await render({ rubricChecks: async () => checkState({ blockers: ['Fix the level examples before approving.'], checks: qaRecord([structure]) }) })
  await click(button('Check and approve'))
  assert.match(dialog().textContent, /This version can’t be approved yet\..*Fix the level examples before approving\./)
  assert.match(dialog().textContent, /Must fix before approval.*Level 3 repeats level 2\./)
  assert.equal(button('Approve version 2', dialog()).disabled, true)
})

test('editors can run the checks but only workspace owners approve', async () => {
  await render({ role: 'editor', rubricChecks: async () => checkState({ checks: qaRecord() }) })
  assert.equal(findButton('Check and approve'), undefined)
  await click(button('Run rubric checks'))
  assert.equal(findButton('Approve version 2', dialog()), undefined)
  assert.match(dialog().textContent, /The checks found nothing to review\./)
  assert.match(dialog().textContent, /Only a workspace owner can approve rubrics\./)
})

test('checks stay unavailable while the deployment can’t run them', async () => {
  await render({ checksAvailable: false, rubricChecks: async () => checkState() })
  await click(button('Check and approve'))
  assert.equal(findButton('Run rubric checks', dialog()), undefined)
  assert.match(dialog().textContent, /Rubric checks aren’t available right now/)
  assert.equal(button('Approve version 2', dialog()).disabled, true)
})

test('approved, superseded, legacy and optional-approval rubrics explain their state without offering approval', async () => {
  await render({ approval: pointer(2) })
  assert.match(text(), /Approval Approved/)
  assert.match(text(), /New analyses and grade ladders use this version\./)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ approval: pointer(2) }, { version: 1, readOnly: true })
  assert.match(text(), /Approval Superseded/)
  assert.match(text(), /Version 2 was approved after this one and is the version new work uses\./)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ legacy: true })
  assert.match(text(), /made before the evidence scale, so it can’t be approved/)
  assert.equal(findButton('Check and approve'), undefined)
  await act(async () => { root.unmount(); await pause() }); root = null

  await render({ required: false })
  assert.match(text(), /Admin settings let new analyses use rubrics without approval\./)
  assert.ok(findButton('Check and approve'), 'Owners can still approve while approval is optional')
})

function flowRecord(index, overrides = {}) {
  const data = fixture()
  const rubric = { ...data.rubric, id: `rubric-${index}`, groupId: `group-${index}`, jobId: `job-${index}`, name: `Role ${index} rubric`, ...overrides.rubric }
  const job = { ...data.job, id: rubric.jobId, rubricId: rubric.id, title: `Role ${index}`, ...overrides.job }
  return { job, rubric, source: { kind: 'pdf', displayName: `job-${index}.pdf` }, etag: `"job-${index}-1"`,
    updatedAt: job.createdAt, attempts: 1, warnings: [], ...overrides, job, rubric }
}
function flowReview(rubric, { missing = false, blockers = [], warnings = [] } = {}) {
  const qa = qaRecord([], warnings)
  return { rubricId: rubric.id, version: rubric.version, rubricHash: HASH, status: 'draft', blockers,
    checks: missing ? null : { ...qa, rubricId: rubric.id, version: rubric.version, jobId: rubric.jobId } }
}
let flow
async function renderFlow({ records = [flowRecord(1), flowRecord(2)], role = 'owner', required = true, checks = true,
  path = '/rubrics', page = 'rubrics', read, run, approve, search = '', targetError, strict = false, targetsInitiallyReady = false } = {}) {
  window.history.replaceState(null, '', path)
  const calls = [], store = ui.createLibraryViewStore()
  store.set('rubrics:query', search)
  function Harness() {
    const [rows, setRows] = React.useState(records)
    const [access, setAccess] = React.useState({ role, workspaceId: 'workspace-one' })
    const [targetReady, setTargetReady] = React.useState(targetsInitiallyReady)
    const rowsRef = React.useRef(rows)
    rowsRef.current = rows
    const subscribeTargets = React.useCallback(() => { calls.push(['subscribe']); return () => calls.push(['unsubscribe']) }, [])
    flow = { calls, setRows, setAccess }
    const ctx = frontendWorkspaceContext({
      workspace: { jobs: rows.map(item => item.job), rubrics: rows.map(item => item.rubric), documents: [fixture().document],
        lifecycle: { entities: Object.fromEntries(rows.flatMap(item => [[`job:${item.job.id}`, item.lifecycle ?? {}], [`rubric:${item.rubric.groupId}`, item.rubricLifecycle ?? {}]])) } },
      notify: message => calls.push(['notice', message]),
      cloud: {
        currentWorkspaceId: access.workspaceId,
        workspaces: [{ id: access.workspaceId, role: access.role, name: 'Fixture', etag: '"workspace"' }],
        realJobs: {
          summaries: rows, features: { rubricApprovalRequired: required, rubricChecks: checks, realJobImports: true, rubricAssistant: true },
          detail: id => {
            const item = rows.find(item => item.job.id === id)
            return item ? { state: 'ready', value: { ...item, rubricVersions: item.rubricVersions ?? [item.rubric], document: fixture().document } } : { state: 'idle' }
          },
          source: () => ({ kind: 'pdf', displayName: 'job.pdf', originalContentType: 'application/pdf' }),
          refresh: async () => { calls.push(['refresh-jobs']) },
          assistRubric: async (jobId, request) => {
            calls.push(['assist', jobId, request.instruction, request.focusCriterionId])
            return {
              outcome: 'changed',
              reply: 'Separated the overlapping criteria.',
              operations: [{ type: 'updateCriterion', criterionId: 'criterion-1', changes: { label: 'Quantitative analysis' } }],
              warnings: [],
              assistant: { promptVersion: 'score-rubric-assist-v2', model: 'fixture-model' },
            }
          },
          rubricChecks: async (jobId, rubricId, version, signal) => {
            calls.push(['read', jobId, rubricId, version])
            const rubric = rowsRef.current.find(item => item.job.id === jobId).rubric
            return read ? read(rubric, signal) : flowReview(rubric)
          },
          runRubricChecks: async (jobId, rubricId, version) => {
            calls.push(['run', jobId, rubricId, version])
            const rubric = rowsRef.current.find(item => item.job.id === jobId).rubric
            return run ? run(rubric) : flowReview(rubric)
          },
          approveRubric: async (jobId, review, options) => {
            calls.push(['approve', jobId, review, options])
            if (approve) await approve(jobId, review)
            setRows(items => items.map(item => item.job.id === jobId ? { ...item, rubricApproval: { ...pointer(review.version), rubricId: review.rubricId } } : item))
          },
        },
      },
    })
    const targets = targetReady ? rows.filter(item => item.rubricApproval || !required).map(item => ({
      kind: 'job', id: `target-${item.job.id}`, label: item.job.title, sublabel: '', rubricId: item.rubric.id, rubricVersion: item.rubric.version,
      criterionCount: item.rubric.criteria.length, selection: { kind: 'job', jobId: item.job.id, rubricId: item.rubric.id, rubricVersion: item.rubric.version, rubricHash: HASH },
    })) : []
    const analyses = { workspaceId: access.workspaceId, canWrite: access.role !== 'reader', phase: 'ready', features: { realAnalyses: true, analysisLimits: { maxComparisons: 500 } },
      targets: { state: 'ready', value: targets, ...(targetError ? { error: targetError } : {}) }, subscribeTargets,
      refreshTargets: async () => { calls.push(['refresh-targets']); setTargetReady(true) },
    }
    const content = page === 'jobs' ? h(ui.JobsPage) : page === 'analysis' ? h(ui.RealAnalysisSetup)
      : page === 'batch' ? h(ui.BulkRubricApproval, { rubrics: records.map(item => item.rubric), onClose: () => calls.push(['close']) })
        : h(ui.Routes, null, h(ui.Route, { path: '/rubrics', element: h(ui.RubricsPage) }), h(ui.Route, { path: '/rubrics/:id', element: h(ui.RubricsPage) }))
    return h(ui.LibraryViewStateContext.Provider, { value: store }, h(ui.WorkspaceContext.Provider, { value: ctx },
      h(ui.RealAnalysesContext.Provider, { value: analyses },
        h(ui.RealResumesContext.Provider, { value: { phase: 'ready', summaries: [], refresh: async () => {} } }, content))))
  }
  root ??= createRoot(document.getElementById('root'))
  await act(async () => { root.render(h(ui.BrowserRouter, null, strict ? h(React.StrictMode, null, h(Harness)) : h(Harness))); await pause(30) })
  return calls
}

test('approval presentation distinguishes missing approval, newer drafts, superseded versions and optional policy', () => {
  const rubric = fixture().rubric
  assert.equal(ui.rubricApprovalPresentation(rubric, undefined, true).label, 'Needs approval')
  assert.match(ui.rubricApprovalPresentation(rubric, pointer(1), true).message, /Approved version 1 stays in use/)
  assert.equal(ui.rubricApprovalPresentation(rubric, pointer(2), true).label, 'Approved')
  assert.equal(ui.rubricApprovalPresentation({ ...rubric, version: 1 }, pointer(2), true).label, 'Superseded')
  assert.equal(ui.rubricApprovalPresentation(rubric, undefined, false).label, 'Draft · approval optional')
})

test('pending library rubrics are selectable for checked bulk approval, then server targets make analysis usable', async () => {
  const calls = await renderFlow({ read: rubric => flowReview(rubric, { warnings: [overlap] }) })
  assert.match(text(), /2 job rubrics need approval/)
  assert.equal(document.querySelector('input[aria-label="Select Role 1 rubric"]').disabled, true)
  assert.equal(button('Analyze selected').disabled, true)
  assert.ok(calls.some(item => item[0] === 'subscribe'), 'The library subscribes before offering analysis')
  await click(button('For approval'))
  await click(button('Select visible'))
  assert.equal(document.querySelector('input[aria-label="Select Role 1 rubric"]').checked, true)
  await click(button('Approve selected (2)'))
  assert.match(dialog().textContent, /Both criteria may credit the same analysis work/)
  assert.equal(calls.filter(item => item[0] === 'run').length, 0, 'Stored checks are reused without paid calls')
  await click(button('Approve 2 checked rubrics', dialog()))
  assert.deepEqual(calls.filter(item => item[0] === 'approve').map(item => [item[1], item[2].version, item[3]]),
    [['job-1', 2, { notify: false }], ['job-2', 2, { notify: false }]])
  assert.ok(calls.some(item => item[0] === 'refresh-targets'))
  assert.equal(calls.filter(item => item[0] === 'notice').length, 1)
  await click(button('Close', dialog()))
  assert.doesNotMatch(text(), /job rubrics need approval/)
  await click(button('For analysis'))
  assert.equal(document.querySelector('input[aria-label="Select Role 1 rubric"]').disabled, false)
  assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === 'Use rubric').disabled, false)
})

test('approve all pending includes hidden active drafts but excludes approved and archived rubrics', async () => {
  const calls = await renderFlow({ search: 'Role 1', records: [flowRecord(1), flowRecord(2), flowRecord(3, {
    rubricApproval: { ...pointer(2), rubricId: 'rubric-3' },
  }), flowRecord(4, { rubricLifecycle: { archivedAt: '2026-01-01' } })] })
  assert.equal(document.querySelectorAll('.rubric-card').length, 1)
  await click(button('Approve all pending (2)'))
  assert.match(dialog().textContent, /Role 1 rubric/)
  assert.match(dialog().textContent, /Role 2 rubric/)
  assert.doesNotMatch(dialog().textContent, /Role [34] rubric/)
  assert.equal(calls.filter(item => item[0] === 'read').length, 2)
})

test('missing checks require an explicit action, and blockers are separated from the confirmed set', async () => {
  let checked = false
  const calls = await renderFlow({ page: 'batch', read: rubric => flowReview(rubric, rubric.jobId === 'job-1'
    ? { missing: !checked } : { blockers: ['Fix the level examples before approving.'] }),
    run: rubric => { checked = true; return flowReview(rubric) } })
  assert.equal(button('Approve 0 checked rubrics', dialog()).disabled, true)
  assert.equal(calls.filter(item => item[0] === 'run').length, 0)
  await click(button('Run missing checks (1)', dialog()))
  assert.match(dialog().textContent, /Fix the level examples before approving/)
  assert.match(dialog().textContent, /Only the checked versions labeled/)
  await click(button('Approve 1 checked rubric', dialog()))
  assert.deepEqual(calls.filter(item => item[0] === 'approve').map(item => item[1]), ['job-1'])
})

test('a partial failure preserves successful approvals and retry targets only the failed exact version', async () => {
  let failures = 0
  const calls = await renderFlow({ page: 'batch', approve: jobId => {
    if (jobId === 'job-2' && failures++ === 0) throw new Error('This job changed in another session. Review its checks again.')
  } })
  await click(button('Approve 2 checked rubrics', dialog()))
  assert.match(dialog().textContent, /This job changed in another session/)
  assert.match(dialog().textContent, /1 approved/)
  await click(button('Reload failed items (1)', dialog()))
  await click(button('Approve 1 checked rubric', dialog()))
  assert.deepEqual(calls.filter(item => item[0] === 'approve').map(item => item[1]), ['job-1', 'job-2', 'job-2'])
  assert.match(dialog().textContent, /2 approved/)
})

test('checks unavailable, legacy versions and readers never gain approval rights', async () => {
  const calls = await renderFlow({ page: 'batch', checks: false, read: rubric => flowReview(rubric, { missing: true }),
    records: [flowRecord(1), flowRecord(2, { rubric: { scaleVersion: undefined } })] })
  assert.equal(button('Run missing checks (1)', dialog()).disabled, true)
  assert.match(dialog().textContent, /predates the evidence scale/)
  assert.equal(button('Approve 0 checked rubrics', dialog()).disabled, true)
  assert.equal(calls.filter(item => item[0] === 'read').length, 1)
  await act(async () => { flow.setAccess({ role: 'reader', workspaceId: 'workspace-one' }); await pause() })
  assert.match(dialog().textContent, /approval access changed/)
})

test('workspace change or unmount stops admitting further approvals, and duplicate clicks do not resubmit', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const calls = await renderFlow({ page: 'batch', approve: () => pending })
  const confirm = button('Approve 2 checked rubrics', dialog())
  await act(async () => { confirm.click(); confirm.click(); await pause() })
  assert.equal(button('Close', dialog()).disabled, true)
  assert.equal(calls.filter(item => item[0] === 'approve').length, 1)
  await act(async () => {
    flow.setAccess({ role: 'owner', workspaceId: 'workspace-two' })
    await pause()
  })
  await act(async () => {
    release()
    await pause()
  })
  assert.equal(calls.filter(item => item[0] === 'approve').length, 1, 'No approval is sent to the new workspace')
  assert.match(dialog().textContent, /Workspace or approval access changed/)
})

test('closing the component stops a batch after its in-flight approval, without submitting the next item', async () => {
  let release
  const calls = await renderFlow({ page: 'batch', approve: () => new Promise(resolve => { release = resolve }) })
  await click(button('Approve 2 checked rubrics', dialog()))
  await act(async () => { root.unmount(); root = null; await pause(); release(); await pause() })
  assert.equal(calls.filter(item => item[0] === 'approve').length, 1)
})

test('a new version saved during batch preparation is never substituted into approval', async () => {
  const calls = await renderFlow({ page: 'batch' })
  await act(async () => { flow.setRows(items => items.map(item => ({ ...item, rubric: { ...item.rubric, version: 3 } }))); await pause() })
  assert.equal(button('Approve 0 checked rubrics', dialog()).disabled, true)
  assert.equal(calls.filter(item => item[0] === 'approve').length, 0)
  assert.ok([...dialog().querySelectorAll('a')].every(link => new URL(link.href).searchParams.get('version') === '2'), 'Inspection links retain captured versions after newer drafts arrive')
})

test('optional approval does not claim drafts block analysis, while an older approval is explicitly linked', async () => {
  await renderFlow({ required: false, targetsInitiallyReady: true })
  assert.doesNotMatch(text(), /job rubrics need approval/)
  assert.match(text(), /Draft · approval optional/)
  assert.equal(button('Use rubric').disabled, false, 'Optional approval preserves the single-rubric analysis action')
  await act(async () => { root.unmount(); await pause() }); root = null
  await renderFlow({ records: [flowRecord(1, { rubricApproval: pointer(1) })] })
  assert.match(text(), /Changes need approval/)
  assert.match(text(), /Approved version 1 stays in use/)
  assert.match(document.querySelector('a[href*="version=1"]').href, /rubric-1.*version=1/)
})

test('Jobs attention and analysis empty states explain missing approval with a direct recovery link', async () => {
  await renderFlow({ page: 'jobs' })
  assert.match(text(), /Processed2/)
  assert.match(text(), /Needs approval/)
  await click(button('Needs attention2'))
  assert.equal(document.querySelectorAll('tbody tr').length, 2)
  assert.ok(document.querySelector('a[href="/rubrics/rubric-1?job=job-1"]'))
  await act(async () => { root.unmount(); await pause() }); root = null
  await renderFlow({ page: 'analysis' })
  assert.match(text(), /Job rubrics are waiting for approval/)
  assert.ok([...document.querySelectorAll('a')].some(item => item.getAttribute('href') === '/rubrics?kind=job&approval=pending'))
})

test('target refresh errors keep analysis disabled and expose retry; strict mode still loads batch checks', async () => {
  await renderFlow({ targetError: 'Targets are unavailable' })
  assert.ok(button('Retry available targets'))
  assert.equal(button('Analyze selected').disabled, true)
  await act(async () => { root.unmount(); await pause() }); root = null
  await renderFlow({ page: 'batch', strict: true })
  assert.equal(button('Approve 2 checked rubrics', dialog()).disabled, false)
})

test('pending deep links select approval mode; readers and editors see reminders without owner actions', async () => {
  await renderFlow({ path: '/rubrics?kind=job&approval=pending' })
  assert.equal(button('For approval').getAttribute('aria-pressed'), 'true')
  assert.equal(document.querySelector('input[aria-label="Select Role 1 rubric"]').disabled, false)
  for (const role of ['editor', 'reader']) {
    await act(async () => { root.unmount(); await pause() }); root = null
    await renderFlow({ role, path: '/rubrics?kind=job&approval=pending' })
    assert.equal(findButton('For approval'), undefined)
    assert.equal(findButton('Approve all pending (2)'), undefined)
    assert.equal(findButton('Check and approve'), undefined)
    assert.match(text(), /job rubrics need approval/)
  }
})

test('an explicit older-approved-version link opens that preserved version, not the newer draft', async () => {
  const record = flowRecord(1, { rubricApproval: pointer(1) })
  record.rubricVersions = [{ ...record.rubric, name: 'Preserved approved rubric', version: 1 }, record.rubric]
  await renderFlow({ records: [record], path: '/rubrics/rubric-1?job=job-1&version=1' })
  assert.equal(document.querySelector('h1').textContent, 'Preserved approved rubric')
  assert.match(text(), /Version 1/)
  assert.equal(findButton('Check and approve'), undefined)
})

test('rubric library cards distinguish clean Ready to approve drafts from flagged Review for approval drafts', async () => {
  const cleanRow = flowRecord(1)
  cleanRow.rubricQaSummary = ui.summarizeRubricQa({ ...qaRecord([], []), rubricId: cleanRow.rubric.id, version: cleanRow.rubric.version })
  const flaggedRow = flowRecord(2)
  flaggedRow.rubricQaSummary = ui.summarizeRubricQa({ ...qaRecord([], [overlap]), rubricId: flaggedRow.rubric.id, version: flaggedRow.rubric.version })
  await renderFlow({ records: [cleanRow, flaggedRow] })
  const readyButton = button('Ready to approve')
  assert.ok(readyButton.classList.contains('button-success'), 'Clean rubric has a green Ready to approve button')
  assert.ok(button('Review for approval (1)'), 'Flagged rubric shows issue count on its review button')
  assert.doesNotMatch(text(), /Approve this rubric before using it in a new analysis/, 'Fresh pending cards omit redundant boilerplate text')
})

test('rubric detail places approval at the top, highlights overlapping criteria, and Fix with AI launches the assisted editor', async () => {
  const flaggedRow = flowRecord(1)
  flaggedRow.rubricQaSummary = ui.summarizeRubricQa({ ...qaRecord([], [overlap]), rubricId: flaggedRow.rubric.id, version: flaggedRow.rubric.version })
  const calls = await renderFlow({ records: [flaggedRow], path: '/rubrics/rubric-1?job=job-1' })
  assert.doesNotMatch(text(), /This exact version is not available for real analysis/, 'Robotic duplicate callout is removed')
  assert.match(text(), /1 item to review/)
  assert.equal(document.querySelectorAll('.criterion-card.is-flagged').length, 2, 'Overlapping criteria are highlighted inline')
  await click(button('Fix with AI'))
  await pause(30)
  const assistCalls = calls.filter(item => item[0] === 'assist')
  assert.equal(assistCalls.length, 1, 'Fix with AI automatically invokes the rubric assistant with the QA findings')
  assert.match(assistCalls[0][2], /Both criteria may credit the same analysis work/)
  assert.match(dialog().textContent, /Edit rubric/)
})

test('guided bulk approval steps through rubrics one by one with Approve & next', async () => {
  const calls = await renderFlow({ page: 'batch' })
  assert.match(dialog().textContent, /Step 1 of 2 · Role 1 rubric/)
  await click(button('Approve & next', dialog()))
  assert.deepEqual(calls.filter(item => item[0] === 'approve').map(item => item[1]), ['job-1'])
  assert.match(dialog().textContent, /Step 2 of 2 · Role 2 rubric/)
  await click(button('Approve version 2', dialog()))
  assert.deepEqual(calls.filter(item => item[0] === 'approve').map(item => item[1]), ['job-1', 'job-2'])
})

