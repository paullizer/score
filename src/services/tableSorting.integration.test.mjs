import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

const output = resolve(`.table-sorting-tests-${randomUUID()}`)
const originals = new Map()
let sorting, ui, dom, root, createRoot

before(async () => {
  await mkdir(output)
  await Promise.all([
    build({ entryPoints: [join('src', 'domain', 'tableSorting.ts')], outfile: join(output, 'sorting.mjs'),
      bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent' }),
    build({ entryPoints: [join('src', 'components', 'ui', 'TableSorting.tsx')], outfile: join(output, 'ui.mjs'),
      bundle: true, packages: 'external', format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent' }),
  ])
  ;[sorting, ui] = await Promise.all(['sorting', 'ui'].map((name) => import(pathToFileURL(join(output, `${name}.mjs`)).href)))
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://score.test/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
})

afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null } })
after(async () => {
  dom?.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  await rm(output, { recursive: true, force: true })
})

function sortedValues(values, direction) {
  return sorting.sortTableRows(values, { key: 'value', direction }, (value) => value)
}

test('text sorting is natural and case-insensitive in both directions', () => {
  const values = ['Resume 10', 'beta', 'résumé 2', 'Alpha', 'RESUME 2', 'resume 1']
  assert.deepEqual(sortedValues(values, 'asc'), ['Alpha', 'beta', 'resume 1', 'résumé 2', 'RESUME 2', 'Resume 10'])
  assert.deepEqual(sortedValues(values, 'desc'), ['Resume 10', 'résumé 2', 'RESUME 2', 'resume 1', 'beta', 'Alpha'])
})

test('null, undefined, empty text, and nonfinite numbers stay last, but zero is numeric', () => {
  const missing = [null, undefined, '', ' \t ', NaN, Infinity, -Infinity]
  const values = [null, 10, undefined, 0, '', -2, ' \t ', NaN, 2, Infinity, -Infinity]
  assert.deepEqual(sortedValues(values, 'asc'), [-2, 0, 2, 10, ...missing])
  assert.deepEqual(sortedValues(values, 'desc'), [10, 2, 0, -2, ...missing])
  assert.deepEqual(sortedValues(['beta', null, '', 'Alpha', undefined], 'asc'), ['Alpha', 'beta', null, '', undefined])
  assert.deepEqual(sortedValues(['beta', null, '', 'Alpha', undefined], 'desc'), ['beta', 'Alpha', null, '', undefined])
})

test('numbers and caller-supplied date timestamps sort numerically', () => {
  assert.deepEqual(sortedValues([100, 2, -10, 0, 2.5, 10], 'asc'), [-10, 0, 2, 2.5, 10, 100])
  assert.deepEqual(sortedValues([100, 2, -10, 0, 2.5, 10], 'desc'), [100, 10, 2.5, 2, 0, -10])
  const dates = ['2026-10-01T01:00:00Z', '2026-09-18T20:00:00-04:00', '2026-09-19T01:00:00Z', 'invalid', null]
  const getDate = (value) => value === null ? null : Date.parse(value)
  assert.deepEqual(sorting.sortTableRows(dates, { key: 'date', direction: 'asc' }, getDate), [dates[1], dates[2], dates[0], 'invalid', null])
  assert.deepEqual(sorting.sortTableRows(dates, { key: 'date', direction: 'desc' }, getDate), [dates[0], dates[2], dates[1], 'invalid', null])
})

test('stable ties preserve source order and frozen provider rows are never mutated', () => {
  const rows = Object.freeze([
    Object.freeze({ id: 'first-tie', score: 5 }), Object.freeze({ id: 'low', score: 0 }),
    Object.freeze({ id: 'second-tie', score: 5 }), Object.freeze({ id: 'missing-first', score: null }),
    Object.freeze({ id: 'third-tie', score: 5 }), Object.freeze({ id: 'missing-second', score: undefined }),
  ])
  let calls = 0
  const getValue = (row, key) => { calls++; assert.equal(key, 'score'); return row[key] }
  const ascending = sorting.sortTableRows(rows, { key: 'score', direction: 'asc' }, getValue)
  assert.equal(calls, rows.length)
  assert.deepEqual(ascending.map(({ id }) => id), ['low', 'first-tie', 'second-tie', 'third-tie', 'missing-first', 'missing-second'])
  const descending = sorting.sortTableRows(rows, { key: 'score', direction: 'desc' }, getValue)
  assert.deepEqual(descending.map(({ id }) => id), ['first-tie', 'second-tie', 'third-tie', 'low', 'missing-first', 'missing-second'])
  assert.notEqual(ascending, rows)
  assert.equal(ascending[0], rows[1])
  assert.deepEqual(rows.map(({ id }) => id), ['first-tie', 'low', 'second-tie', 'missing-first', 'third-tie', 'missing-second'])
})

test('null sort returns a fresh copy in incoming order without reading sort values', () => {
  const rows = Object.freeze([{ id: 'saved-second' }, { id: 'saved-first' }])
  const copy = sorting.sortTableRows(rows, null, () => assert.fail('Default order must not extract sort values'))
  assert.notEqual(copy, rows)
  assert.deepEqual(copy, rows)
  assert.equal(copy[0], rows[0])
  assert.deepEqual(sorting.sortTableRows([], { key: 'name', direction: 'asc' }, () => null), [])
})

test('toggle uses configurable initial directions and switches without mutating state', () => {
  assert.deepEqual(sorting.toggleTableSort(null, 'name'), { key: 'name', direction: 'asc' })
  assert.deepEqual(sorting.toggleTableSort(null, 'score', 'desc'), { key: 'score', direction: 'desc' })
  const current = Object.freeze({ key: 'score', direction: 'desc' })
  assert.deepEqual(sorting.toggleTableSort(current, 'score', 'desc'), { key: 'score', direction: 'asc' })
  assert.deepEqual(sorting.toggleTableSort({ key: 'score', direction: 'asc' }, 'score', 'desc'), current)
  assert.deepEqual(sorting.toggleTableSort(current, 'name'), { key: 'name', direction: 'asc' })
  assert.deepEqual(sorting.toggleTableSort(current, 'date', 'desc'), { key: 'date', direction: 'desc' })
  assert.deepEqual(current, { key: 'score', direction: 'desc' })
})

test('metadata search trims and case-folds the query without joining unrelated fields', () => {
  const fields = ['Ada Lovelace', 'Software Engineer', 'Resume 2.pdf', 'Platform', null, undefined]
  for (const query of ['', '  ', '  ADA  ', 'engineer', '2.PDF', 'PLATform']) assert.equal(sorting.matchesTableSearch(query, fields), true)
  assert.equal(sorting.matchesTableSearch('Grace', fields), false)
  assert.equal(sorting.matchesTableSearch('Lovelace Software', fields), false)
  assert.equal(sorting.matchesTableSearch('candidate', [null, undefined, '']), false)
  assert.equal(sorting.matchesTableSearch('', []), true)
})

const options = [
  { key: 'name', label: 'Candidate', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' },
  { key: 'score', label: 'Score', ascendingLabel: 'Lowest first', descendingLabel: 'Highest first', initialDirection: 'desc' },
  { key: 'added:date', label: 'Added date', ascendingLabel: 'Oldest first', descendingLabel: 'Newest first', initialDirection: 'desc' },
]

async function mount(element) {
  root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => root.render(element))
}

test('headers and selector share controlled state, semantic direction labels, and a default-order reset', async () => {
  function Harness() {
    const [sort, setSort] = React.useState(null)
    return React.createElement(React.Fragment, null,
      React.createElement(ui.TableSortSelect, { options, sort, onChange: setSort, label: 'Sort comparisons', defaultLabel: 'Saved order' }),
      React.createElement('table', null, React.createElement('thead', null, React.createElement('tr', null,
        ...options.slice(0, 2).map((option) => React.createElement(ui.SortableHeader, { key: option.key, option, sort, onChange: setSort }))))),
      React.createElement('output', null, JSON.stringify(sort)),
    )
  }
  await mount(React.createElement(Harness))
  const document = dom.window.document
  const select = document.querySelector('select')
  const headers = [...document.querySelectorAll('th')]
  const buttons = headers.map((header) => header.querySelector('button'))
  assert.equal(select.getAttribute('aria-label'), 'Sort comparisons')
  assert.equal(select.labels.length, 1)
  assert.equal(select.labels[0].querySelector('span').textContent, 'Sort comparisons')
  assert.equal(select.value, '')
  assert.deepEqual([...select.options].map((option) => option.textContent), [
    'Saved order', 'Candidate: A–Z', 'Candidate: Z–A', 'Score: Lowest first', 'Score: Highest first',
    'Added date: Oldest first', 'Added date: Newest first',
  ])
  for (const header of headers) {
    assert.equal(header.getAttribute('scope'), 'col')
    assert.equal(header.hasAttribute('aria-sort'), false)
    const button = header.querySelector('button')
    assert.equal(button.type, 'button')
    assert.equal(button.tabIndex, 0)
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true')
    assert.equal(button.querySelector('svg').getAttribute('focusable'), 'false')
  }
  assert.equal(buttons[0].getAttribute('aria-label'), 'Sort Candidate: A–Z')
  assert.equal(buttons[1].getAttribute('aria-label'), 'Sort Score: Highest first')
  buttons[0].focus()
  assert.equal(document.activeElement, buttons[0])
  await act(async () => buttons[0].click())
  assert.equal(headers[0].getAttribute('aria-sort'), 'ascending')
  assert.equal(headers[1].hasAttribute('aria-sort'), false)
  assert.equal(select.selectedOptions[0].textContent, 'Candidate: A–Z')
  assert.equal(buttons[0].getAttribute('aria-label'), 'Sort Candidate: Z–A')
  assert.equal(buttons[0].querySelector('svg').classList.contains('lucide-arrow-up'), true)
  await act(async () => buttons[0].click())
  assert.equal(headers[0].getAttribute('aria-sort'), 'descending')
  assert.equal(select.selectedOptions[0].textContent, 'Candidate: Z–A')
  assert.equal(buttons[0].querySelector('svg').classList.contains('lucide-arrow-down'), true)
  await act(async () => buttons[1].click())
  assert.equal(headers[0].hasAttribute('aria-sort'), false)
  assert.equal(headers[1].getAttribute('aria-sort'), 'descending')
  assert.equal(select.selectedOptions[0].textContent, 'Score: Highest first')

  async function choose(label) {
    await act(async () => {
      select.value = [...select.options].find((option) => option.textContent === label).value
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
  }
  await choose('Score: Lowest first')
  assert.equal(headers[1].getAttribute('aria-sort'), 'ascending')
  await choose('Added date: Newest first')
  assert.equal(document.querySelector('output').textContent, '{"key":"added:date","direction":"desc"}')
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0)
  await choose('Saved order')
  assert.equal(document.querySelector('output').textContent, 'null')
  assert.equal(document.querySelectorAll('th[aria-sort]').length, 0)
})

test('disabled options apply to both controls, preserve explanations, and do not change state', async () => {
  const blocked = { ...options[1], disabled: true, title: 'Select an exact target before sorting scores.' }
  const changes = []
  const onChange = (value) => changes.push(value)
  await mount(React.createElement(React.Fragment, null,
    React.createElement(ui.TableSortSelect, { options: [options[0], blocked], sort: null, onChange }),
    React.createElement('table', null, React.createElement('thead', null, React.createElement('tr', null,
      React.createElement(ui.SortableHeader, { option: blocked, sort: null, onChange, className: 'mobile-hide' }, 'Assessment'),
      React.createElement(ui.SortableHeader, { option: options[0], sort: null, onChange, disabled: true, title: 'Unavailable' }))),
    ),
  ))
  const document = dom.window.document
  const buttons = [...document.querySelectorAll('th button')]
  assert.equal(document.querySelector('th').className, 'mobile-hide')
  assert.equal(buttons[0].textContent, 'Assessment')
  assert.equal(buttons[0].title, blocked.title)
  assert.equal(buttons[1].title, 'Unavailable')
  for (const button of buttons) {
    assert.equal(button.disabled, true)
    await act(async () => button.click())
  }
  const select = document.querySelector('select')
  for (const option of [...select.options].filter((option) => option.textContent.startsWith('Score:'))) {
    assert.equal(option.disabled, true)
    assert.equal(option.title, blocked.title)
    await act(async () => {
      select.value = option.value
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
  }
  assert.deepEqual(changes, [])
})

test('selector supports disabled and title props and has no internal sort state', async () => {
  const changes = []
  const props = { options, sort: { key: 'score', direction: 'desc' }, onChange: (value) => changes.push(value),
    disabled: true, title: 'Loading comparisons', className: 'mobile-sort' }
  await mount(React.createElement(ui.TableSortSelect, props))
  const select = dom.window.document.querySelector('select')
  assert.equal(select.disabled, true)
  assert.equal(select.title, 'Loading comparisons')
  assert.equal(select.closest('label').classList.contains('mobile-sort'), true)
  assert.equal(select.selectedOptions[0].textContent, 'Score: Highest first')
  await act(async () => root.render(React.createElement(ui.TableSortSelect, { ...props, disabled: false, sort: null })))
  assert.equal(select.value, '')
  assert.deepEqual(changes, [])
})
