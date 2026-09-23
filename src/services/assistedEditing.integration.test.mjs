import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import React, { StrictMode, act } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.assisted-editing-tests-${randomUUID()}`)
const originals = new Map()
const element = React.createElement
const apiRef = { current: null }
let dom, root, createRoot, ui

const pause = (milliseconds = 10) => new Promise(resolve => setTimeout(resolve, milliseconds))

before(async () => {
  await mkdir(output)
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  originals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'))
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
  ;({ createRoot } = await import('react-dom/client'))
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    export { diffDrafts, highlightFor, summarizeChanges } from './src/features/assist/changeTracking'
    export { useEditSession, createEditSessionState, editSessionReducer } from './src/features/assist/useEditSession'
    export { rubricEditAdapter, describeRubricAssistOperations, summarizeRubricAssistOperations, rubricVersionChangeNote, rubricAssistOperationFieldKeys } from './src/features/rubrics/rubricAssist'
    export { applyRubricAssistOperations, criterionFieldKey, criterionPresenceKey, RUBRIC_NAME_KEY } from './src/domain/rubric-assist'
  ` }, outfile: join(output, 'ui.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent' })
  ui = await import(pathToFileURL(join(output, 'ui.mjs')).href)
})

after(async () => {
  if (root) {
    await act(async () => { root.unmount(); await pause() })
    root = null
  }
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

function citation(id = 'p1', quote = 'Builds reliable data products') {
  return { documentId: 'doc', documentVersion: 1, paragraphId: id, page: 1, heading: 'Responsibilities', quote }
}

function criterion(id, label, weight, extra = {}) {
  return {
    id,
    key: extra.key ?? 'technical',
    label,
    description: `${label} description`,
    guidance: `${label} guidance`,
    weight,
    requirementType: extra.requirementType ?? 'required',
    sourceParagraphId: extra.sourceParagraphId ?? 'p1',
    sourceCitations: extra.sourceCitations ?? [citation()],
  }
}

function rubric(overrides = {}) {
  return {
    id: 'rubric-one',
    groupId: 'group-one',
    kind: 'job',
    jobId: 'job-one',
    name: 'Original rubric',
    description: 'Original description',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    dataKind: 'real',
    provenance: { kind: 'generated', model: 'model', promptVersion: 'prompt' },
    criteria: [
      criterion('c1', 'Data analysis', 50),
      criterion('c2', 'Communication', 50, { sourceParagraphId: 'p2', sourceCitations: [citation('p2', 'Explains work clearly')] }),
    ],
    ...overrides,
  }
}

function clone(value) {
  return structuredClone(value)
}

function Harness({ baseline, maxEntries = 100 }) {
  const counter = React.useRef(0)
  apiRef.current = ui.useEditSession({
    baseline,
    adapter: ui.rubricEditAdapter,
    maxEntries,
    now: () => 1000 + counter.current,
    newId: () => `entry-${counter.current += 1}`,
  })
  return null
}

async function renderSession(baseline = rubric(), maxEntries) {
  if (root) {
    await act(async () => { root.unmount(); await pause() })
  }
  root = createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(element(StrictMode, null, element(Harness, { baseline, maxEntries })))
    await pause()
  })
  return () => apiRef.current
}

async function sessionAct(recipe) {
  let value
  await act(async () => {
    value = recipe(apiRef.current)
    await pause()
  })
  return value
}

test('AI and user attribution drive highlights, previous values and revert clearing', async () => {
  const base = rubric()
  const session = await renderSession(base)
  const guidanceKey = ui.criterionFieldKey('c1', 'guidance')
  const next = clone(base)
  next.criteria[0].guidance = 'AI-written guidance'
  await sessionAct(api => api.applyAssist(next, { keys: [guidanceKey], note: 'Guidance · Criterion 01', turnId: 'turn-one' }))
  assert.equal(session().highlight(guidanceKey), 'ai')
  assert.equal(session().previous(guidanceKey), 'Data analysis guidance')
  assert.equal(session().aiChangeCount, 1)
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'Reviewer rubric' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'Renamed rubric', groupKey: 'name' }))
  assert.equal(session().highlight(ui.RUBRIC_NAME_KEY), 'user')
  assert.equal(session().changes.length, 2)
  await sessionAct(api => api.revert(guidanceKey))
  assert.equal(session().highlight(guidanceKey), null)
  assert.equal(session().draft.criteria[0].guidance, 'Data analysis guidance')
})

test('grouped typing is one history entry until endGroup, then undo and redo behave predictably', async () => {
  const base = rubric()
  const session = await renderSession(base)
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'A' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'Rubric name', groupKey: 'name' }))
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'AB' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'Rubric name', groupKey: 'name' }))
  assert.equal(session().entries.length, 1)
  assert.equal(session().draft.name, 'AB')
  await sessionAct(api => api.endGroup())
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'ABC' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'Rubric name', groupKey: 'name' }))
  assert.equal(session().entries.length, 2)
  await sessionAct(api => api.undo())
  assert.equal(session().draft.name, 'AB')
  assert.equal(session().canRedo, true)
  await sessionAct(api => api.redo())
  assert.equal(session().draft.name, 'ABC')
  await sessionAct(api => api.undo())
  await sessionAct(api => api.edit(draft => ({ ...draft, description: 'New description' }), { keys: ['rubric.description'], note: 'Description' }))
  assert.equal(session().canRedo, false)
  assert.equal(session().entries.length, 2)
})

test('restoreTo creates a non-destructive restore entry and supports the opened baseline', async () => {
  const base = rubric()
  const session = await renderSession(base)
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'First' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'First name' }))
  const firstId = session().entries[0].id
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'Second' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'Second name' }))
  await sessionAct(api => api.restoreTo(firstId))
  assert.equal(session().draft.name, 'First')
  assert.equal(session().entries.at(-1).origin, 'restore')
  assert.equal(session().entries.length, 3)
  await sessionAct(api => api.restoreTo('baseline'))
  assert.equal(session().draft.name, base.name)
  assert.equal(session().dirty, false)
})

test('undoTurn restores only untouched AI fields and reports skipped reviewer-edited fields', async () => {
  const base = rubric()
  const session = await renderSession(base)
  const labelKey = ui.criterionFieldKey('c1', 'label')
  const guidanceKey = ui.criterionFieldKey('c1', 'guidance')
  const aiDraft = clone(base)
  aiDraft.criteria[0].label = 'AI label'
  aiDraft.criteria[0].guidance = 'AI guidance'
  await sessionAct(api => api.applyAssist(aiDraft, { keys: [labelKey, guidanceKey], note: 'Label and guidance', turnId: 'turn-ai' }))
  await sessionAct(api => api.edit(draft => ({
    ...draft,
    criteria: draft.criteria.map(item => item.id === 'c1' ? { ...item, guidance: 'Reviewer guidance' } : item),
  }), { keys: [guidanceKey], note: 'Reviewer guidance' }))
  const result = await sessionAct(api => api.undoTurn('turn-ai'))
  assert.deepEqual(result, { reverted: 1, skipped: 1 })
  assert.equal(session().draft.criteria[0].label, 'Data analysis')
  assert.equal(session().draft.criteria[0].guidance, 'Reviewer guidance')
  assert.equal(session().highlight(labelKey), null)
  assert.equal(session().highlight(guidanceKey), 'user')
})

test('added and removed criteria diff, revert, and undoTurn preserve original positions', async () => {
  const base = rubric()
  const session = await renderSession(base)
  const added = criterion('c3', 'Stakeholder engagement', 10, { key: 'custom', sourceParagraphId: 'p3', sourceCitations: [citation('p3', 'Partners with stakeholders')] })
  const addOperation = { type: 'addCriterion', afterCriterionId: 'c1', criterion: added }
  const removeOperation = { type: 'removeCriterion', criterionId: 'c1' }
  const next = ui.applyRubricAssistOperations(base, [addOperation, removeOperation])
  const keys = [ui.criterionPresenceKey('c3'), ui.criterionPresenceKey('c1')]
  await sessionAct(api => api.applyAssist(next, { keys, note: 'Added and removed criteria', turnId: 'turn-criteria' }))
  assert.deepEqual(session().changes.map(change => change.kind).sort(), ['added', 'removed'])
  await sessionAct(api => api.revert(ui.criterionPresenceKey('c1')))
  assert.equal(session().draft.criteria[0].id, 'c1')
  await sessionAct(api => api.undoTurn('turn-criteria'))
  assert.deepEqual(session().draft.criteria.map(item => item.id), ['c1', 'c2'])
})

test('loadVersion attributes baseline differences to the reviewer; reset and eviction clear session state', async () => {
  const base = rubric()
  const session = await renderSession(base, 2)
  const version = rubric({ name: 'Saved alternative', criteria: [criterion('c1', 'Data analysis', 100)] })
  await sessionAct(api => api.loadVersion(version, 'Used saved version'))
  assert.equal(session().highlight(ui.RUBRIC_NAME_KEY), 'user')
  assert.equal(session().entries[0].origin, 'restore')
  await sessionAct(api => api.edit(draft => ({ ...draft, name: 'One' }), { keys: [ui.RUBRIC_NAME_KEY], note: 'One' }))
  await sessionAct(api => api.edit(draft => ({ ...draft, description: 'Two' }), { keys: ['rubric.description'], note: 'Two' }))
  assert.equal(session().entries.length, 2)
  assert.equal(session().evictedEntries, 1)
  await sessionAct(api => api.reset(session().draft))
  assert.equal(session().entries.length, 0)
  assert.equal(session().dirty, false)
  assert.equal(session().cursor, -1)
})

test('summaries and rubric operation descriptions are compact and keyed to editable fields', () => {
  const base = rubric()
  const operations = [
    { type: 'updateCriterion', criterionId: 'c1', changes: { guidance: 'Use anchored 0 to 5 guidance', weight: 40 } },
    { type: 'updateCriterion', criterionId: 'c2', changes: { weight: 60 } },
    { type: 'updateRubric', name: 'Rebalanced rubric' },
  ]
  const descriptions = ui.describeRubricAssistOperations(operations, base)
  assert.equal(descriptions[0].key, ui.criterionFieldKey('c1', 'guidance'))
  assert.match(descriptions[0].label, /Updated score guidance · Criterion 01/)
  assert.match(descriptions[1].detail, /50% → 40%/)
  assert.match(ui.summarizeRubricAssistOperations(operations, base), /Guidance · Criterion 01/)
  assert.match(ui.summarizeRubricAssistOperations(operations, base), /Weights · Criterion 01–02/)
  const added = { id: 'c3', key: 'custom', label: 'Added', description: 'Added criterion', guidance: 'Anchored 0 to 5', weight: 10, requirementType: 'required', sourceParagraphId: 'p1', sourceCitations: [base.criteria[0].sourceCitations[0]] }
  const structural = ui.summarizeRubricAssistOperations([{ type: 'removeCriterion', criterionId: 'c2' }, { type: 'addCriterion', afterCriterionId: null, criterion: added }], base)
  assert.match(structural, /Added Criterion 02/, 'Additions are numbered by their position in the resulting draft')
  assert.match(structural, /Removed Criterion 02/, 'Removals are numbered by their position before removal')
  const changes = ui.diffDrafts(base, ui.applyRubricAssistOperations(base, operations), ui.rubricEditAdapter, new Map([[ui.criterionFieldKey('c1', 'guidance'), 'ai']]))
  assert.match(ui.summarizeChanges(changes), /Score guidance · Criterion 01/)
})

test('rubricVersionChangeNote distinguishes generated, edited, structural, and unchanged versions', () => {
  const generated = rubric()
  assert.equal(ui.rubricVersionChangeNote(undefined, generated), 'Generated')
  assert.equal(ui.rubricVersionChangeNote(undefined, { ...generated, version: 1 }), 'Generated')
  const renamed = { ...generated, version: 2, name: 'New name', description: 'New description' }
  assert.equal(ui.rubricVersionChangeNote(generated, renamed), 'Name and description edited')
  const changed = clone(generated)
  changed.version = 2
  changed.criteria = [
    { ...changed.criteria[0], weight: 40 },
    criterion('c3', 'Stakeholder engagement', 60),
  ]
  assert.match(ui.rubricVersionChangeNote(generated, changed), /1 criterion edited · 1 added · 1 removed · weights changed/)
  assert.equal(ui.rubricVersionChangeNote(generated, { ...generated, version: 2, provenance: { kind: 'edited', model: 'm', promptVersion: 'p' } }), 'No criterion changes')
})

test('end-to-end server-shaped operations apply as one AI entry and undo by turn', async () => {
  const base = rubric()
  const session = await renderSession(base)
  const operations = [
    { type: 'updateRubric', description: 'Updated from the posting' },
    { type: 'updateCriterion', criterionId: 'c1', changes: { citation: citation('p9', 'Analyzes workforce data'), requirementType: 'preferred' } },
  ]
  const next = ui.applyRubricAssistOperations(base, operations)
  const keys = operations.flatMap(operation => ui.rubricAssistOperationFieldKeys(operation))
  await sessionAct(api => api.applyAssist(next, { keys, note: ui.summarizeRubricAssistOperations(operations, base), turnId: 'server-turn' }))
  assert.equal(session().entries.length, 1)
  assert.equal(session().highlight('rubric.description'), 'ai')
  assert.equal(session().highlight(ui.criterionFieldKey('c1', 'citation')), 'ai')
  assert.equal(session().draft.criteria[0].sourceParagraphId, 'p9')
  const result = await sessionAct(api => api.undoTurn('server-turn'))
  assert.deepEqual(result, { reverted: 3, skipped: 0 })
  assert.equal(session().draft.description, base.description)
  assert.equal(session().draft.criteria[0].sourceParagraphId, 'p1')
  assert.equal(session().dirty, false)
})
