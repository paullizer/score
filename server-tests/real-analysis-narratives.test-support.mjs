import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { api, clone } from './real-analyses.test-support.mjs'
import { narrativeModelTestResponseFor as narrativeModelResponse } from '../worker-tests/narrative-model-response-test-support.mjs'

export { narrativeModelResponse }

let runtimePromise
export function narrativeRuntime() {
  runtimePromise ??= (async () => {
    const bundle = path.resolve('dist-worker', `narrative-runtime-${process.pid}-${randomUUID()}.mjs`)
    await mkdir(path.dirname(bundle), { recursive: true })
    await build({
      stdin: {
        resolveDir: path.resolve('.'),
        contents: "export * from './worker/analyses/runtime.ts'; export * from './worker/analyses/narrative-runtime.ts';",
      },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    })
    after(async () => { await unlink(bundle) })
    return import(pathToFileURL(bundle).href)
  })()
  return runtimePromise
}

export function narrativeWorker(f, handler) {
  const calls = [], events = []
  const clock = {
    now: () => new Date(f.now),
    async sleep(milliseconds, signal) {
      signal?.throwIfAborted()
      f.now = new Date(Date.parse(f.now) + milliseconds).toISOString()
    },
  }
  const model = {
    endpoint: 'https://narrative-test.example', deployment: 'saved-narrative-deployment', modelName: 'configured-model',
    getToken: async () => 'fake-private-token',
    async fetch(url, init) {
      const request = JSON.parse(init.body), kind = request.response_format.json_schema.name
      const body = JSON.parse(request.messages[1].content)
      calls.push({ kind, body, request, signal: init.signal })
      const override = await handler?.({ kind, body, request, signal: init.signal, call: calls.length })
      if (override instanceof Response) return override
      const output = override ?? narrativeModelResponse(kind, body)
      assert.ok(output, `Unexpected scoring or other model call: ${kind}`)
      return Response.json({ model: 'actual-test-narrative-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })
    },
  }
  return { calls, events, deps: { ...f.analysis, clock, model, owner: 'narrative-test-worker', onNarrativeEvent: event => events.push(event) } }
}

export function runComparisons(f, runId) {
  return [...f.analysis.store.values.values()].filter(value =>
    value.record.recordType === 'analysis-comparison' && value.record.runId === runId).sort((left, right) => left.record.index - right.record.index).map(clone)
}
export async function settleNarratives(f, runId, mock = narrativeWorker(f), maximum = 30) {
  const { runAnalysisWorker } = await narrativeRuntime()
  for (let turn = 0; turn < maximum; turn++) {
    const before = await api.readAnalysisSummaries(f.analysis, f.workspaceId, runId)
    if (before.ready || before.counts.candidates.failed + before.counts.targets.failed > 0 &&
      before.counts.candidates.queued + before.counts.candidates.running + before.counts.targets.queued + before.counts.targets.running === 0) return before
    await runAnalysisWorker(mock.deps, { maxItems: 100 })
    f.now = new Date(Date.parse(f.now) + 30_000).toISOString()
  }
  assert.fail('Narrative work did not settle within its bounded test window')
}
export async function drainNarrativeRequest(f, runId, requestId) {
  for (let chunk = 0; chunk < 50; chunk++) {
    if (!await api.advanceAnalysisNarrativeRequest(f.analysis, f.workspaceId, runId, requestId, () => new Date(f.now))) return
  }
  assert.fail('Narrative request did not finish its bounded scheduling cursor')
}
