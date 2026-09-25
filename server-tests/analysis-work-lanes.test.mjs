import assert from 'node:assert/strict'
import test from 'node:test'
import { api, NOW } from './real-analyses.test-support.mjs'

function tracked(values) {
  const state = { pulls: 0, closed: false }
  async function* source() {
    try {
      for (const value of values) {
        state.pulls++
        yield value
      }
    } finally {
      state.closed = true
    }
  }
  return { state, source: source() }
}

test('work lanes take turns, backfill from the other lane and read nothing past the limit', async () => {
  const scoring = tracked(['s1', 's2', 's3'])
  const summaries = tracked(['n1'])
  assert.deepEqual(await api.mergeAnalysisWorkLanes({ scoring: scoring.source, summaries: summaries.source }, 'summaries', 3),
    ['n1', 's1', 's2'])
  assert.equal(scoring.state.pulls, 2, 'The third score is never read.')
  assert.ok(scoring.state.closed && summaries.state.closed, 'Unfinished lanes are closed so their queries stop.')
  assert.deepEqual(await api.mergeAnalysisWorkLanes({ scoring: ['s1', 's2'], summaries: ['n1', 'n2', 'n3'] }, 'scoring', 10),
    ['s1', 'n1', 's2', 'n2', 'n3'])
  assert.deepEqual(await api.mergeAnalysisWorkLanes({ scoring: [], summaries: [] }, 'summaries', 5), [])
  const untouched = tracked(['s1'])
  assert.deepEqual(await api.mergeAnalysisWorkLanes({ scoring: untouched.source, summaries: [] }, 'scoring', 0), [])
  assert.equal(untouched.state.pulls, 0)
})

test('workers start with scoring on even clock minutes and with summaries on odd ones', () => {
  const at = offset => api.firstAnalysisWorkLane(new Date(Date.parse(NOW) + offset))
  assert.deepEqual([at(0), at(59_999), at(60_000), at(119_999), at(120_000)],
    ['scoring', 'scoring', 'summaries', 'summaries', 'scoring'])
  assert.deepEqual(api.ANALYSIS_WORK_LANES, {
    scoring: ['analysis-comparison', 'analysis-correction'],
    summaries: ['analysis-narrative-request', 'analysis-candidate-narrative', 'analysis-target-narrative'],
  })
})
