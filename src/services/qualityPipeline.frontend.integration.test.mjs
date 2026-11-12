import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, test } from 'node:test'
import { mkdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { pipelineFixture, pipelineUser, pipelineWorkspace } from './qualityPipeline.test-support.mjs'

const output = resolve('node_modules', '.cache', `quality-pipeline-${randomUUID()}.mjs`)
await mkdir(resolve('node_modules', '.cache'), { recursive: true })
await build({
  stdin: { resolveDir: process.cwd(), contents: `
    export * from './src/services/qualityPipeline.ts'
    export * from './src/features/admin/quality-pipeline/pipeline-map.ts'
    export { setCloudSessionAccess } from './src/services/cloudWorkspace.ts'
  ` }, outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
})
const client = await import(pathToFileURL(output).href)
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; client.setCloudSessionAccess(null) })
after(() => unlink(output))
const session = workspace => ({ mode: 'cloud', user: pipelineUser, capabilities: { applicationAdmin: true }, workspaces: workspace ? [workspace] : [] })

test('pipeline client rejects foreign scopes and malformed projections without substituting defaults', async () => {
  const fixture = pipelineFixture()
  globalThis.fetch = fixture.fetch
  assert.equal((await client.readPipelinePlan('workspace-one', 'plan-one')).plan.revision, 4)
  fixture.detail.plan.workspaceId = 'other-workspace'
  await assert.rejects(client.readPipelinePlan('workspace-one', 'plan-one'), /different saved plan/)
  fixture.detail.plan.workspaceId = 'workspace-one'
  fixture.detail.tasks[1] = fixture.detail.tasks[0]
  await assert.rejects(client.readPipelinePlan('workspace-one', 'plan-one'), /duplicate or excessive/)
})

test('pipeline metadata requests are fenced by both administrator and explicit workspace membership', async () => {
  const fixture = pipelineFixture()
  client.setCloudSessionAccess(session(pipelineWorkspace))
  let release
  globalThis.fetch = () => new Promise(resolve => { release = resolve })
  const pending = client.readPipelinePlan('workspace-one', 'plan-one')
  client.setCloudSessionAccess(session({ ...pipelineWorkspace, membershipRole: undefined }))
  release(Response.json(fixture.detail))
  await assert.rejects(pending, /access changed/i)
  await assert.rejects(client.listPipelinePlans('workspace-one'), /explicit workspace membership/i)
  client.setCloudSessionAccess({ ...session(pipelineWorkspace), capabilities: { applicationAdmin: false } })
  await assert.rejects(client.readPipelinePlan('workspace-one', 'plan-one'), /administrator access/i)
})

test('saved map relationships do not turn completed trials or possible future use into activation', () => {
  const { detail } = pipelineFixture()
  const candidateEdges = client.savedPipelineEdges(detail, 'bundle-baseline')
  assert.equal(candidateEdges.has('candidate:evaluation'), true)
  assert.equal(candidateEdges.has('holdout:evaluation'), true)
  assert.equal(candidateEdges.has('activate:active'), false)
  assert.equal(candidateEdges.has('active:future'), false)
  assert.match(client.pipelineNextStep(detail), /Member application admin/)
  detail.activatedBundleId = 'bundle-candidate'
  assert.equal(client.savedPipelineEdges(detail, 'bundle-baseline').has('activate:active'), false)
  assert.equal(client.savedPipelineEdges(detail, 'bundle-candidate').has('activate:active'), true)
  detail.evaluation.holdoutTrials = 0
  assert.equal(client.savedPipelineEdges(detail).has('holdout:evaluation'), false, 'Selected holdouts are not proof of executed holdout trials')
})
