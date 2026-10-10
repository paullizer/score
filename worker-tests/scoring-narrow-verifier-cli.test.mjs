import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { narrowFixture } from './narrow-verifier-support.mjs'

const exec = promisify(execFile)
const runner = fileURLToPath(new URL('../scripts/scoring-evaluation-run.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/scoring-evaluation.mjs', import.meta.url))
const mock = new URL('./narrow-verifier-runner-mock.mjs', import.meta.url).href
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('offline fixed-proposal CLI smoke freezes, mocks both reviewers, reports and rejects historical/mixed identity resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'score-narrow-mocked-'))
  try {
    const data = narrowFixture('B2')
    const choices = join(directory, 'choices.json'), proposalsPath = join(directory, 'proposals.json')
    const schemaPath = join(directory, 'schema.json'), manifestPath = join(directory, 'manifest.json')
    const output = join(directory, 'output'), reportPath = join(directory, 'report.json')
    await writeFile(choices, JSON.stringify([{ id: 'case', input: data.input, candidate: 'B2', choice: data.choice }]))
    assert.match((await exec(process.execPath, [cli, 'freeze-scale-proposals', choices, proposalsPath])).stdout, /frozen/)
    assert.deepEqual(await readJson(proposalsPath), [data.proposal])
    await assert.rejects(exec(process.execPath, [cli, 'freeze-scale-proposals', choices, proposalsPath]), /EEXIST/)
    assert.match((await exec(process.execPath, [cli, 'verifier-schema', schemaPath])).stdout, /schema saved/)
    const schema = await readJson(schemaPath)
    assert.equal(schema.algorithmVersion, 'score-narrow-verifier-v1')
    assert.equal(schema.schema.additionalProperties, false)
    const manifest = {
      kind: 'fixed-scale-review', suite: data.suite, inputs: data.inputs, proposals: [data.proposal], policy: data.policy,
      settings: data.suite.configurations.map(row => ({ id: row.id, snapshot: data.snapshot })),
      prices: { reviewer: data.prices.reviewer }, concurrency: 1, endpoint: 'https://test-account.openai.azure.com/',
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    const run = () => exec(process.execPath, ['--import', mock, runner, manifestPath, output, '--confirm-paid-inference'])
    assert.match((await run()).stdout, /evaluation-complete/)
    const observationsPath = join(output, 'observations.json')
    const rows = await readJson(observationsPath), identity = await readJson(join(output, 'execution.json'))
    assert.equal(rows.length, 4)
    assert.equal(rows.every(row => row.result.status === 'complete'), true, JSON.stringify(rows.map(row => row.result)))
    assert.equal(rows.filter(row => row.result.reviewer === 'narrow').length, 2)
    assert.equal(rows.filter(row => row.result.reviewer === 'current').length, 2)
    assert.equal(rows.every(row => row.proposalSha256 === data.proposal.proposalSha256), true)
    assert.equal(identity.kind, 'fixed-scale-review')
    assert.equal(identity.policySha256.length, 64)
    const attempts = await readFile(join(output, 'model-attempts.jsonl'), 'utf8')
    assert.equal(attempts.trim().split('\n').length, 4)
    assert.match((await run()).stdout, /evaluation-complete/)
    assert.equal(await readFile(join(output, 'model-attempts.jsonl'), 'utf8'), attempts)
    assert.match((await exec(process.execPath, [cli, 'verifier-report', manifestPath, observationsPath, reportPath])).stdout, /provisional/)
    const report = await readJson(reportPath)
    assert.equal(report.eligibleForRelease, false)
    assert.equal(report.panels[0].paired, 2)
    assert.equal(report.panels[0].disagreementRate, 0)
    assert.equal(report.inspection.length, 2)
    assert.equal(report.scopes[0].scope.qualificationPolicy, 'separate-unscored-not-verified')
    await writeFile(join(output, 'execution.json'), JSON.stringify({ ...identity, bundleSha256: 'f'.repeat(64) }))
    await assert.rejects(run(), /Execution identity changed/)
    await unlink(join(output, 'execution.json'))
    await assert.rejects(run(), /historical unbound/)
    await writeFile(join(output, 'execution.json'), JSON.stringify(identity))
    manifest.policy.boundaryLevels = []
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(run(), /frozen suite, proposal, policy/)
    manifest.policy = data.prepared.scope.policy
    manifest.suite.configurations[0].algorithmVersion = 'score-production-v1'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(run(), /impersonate/)
    await assert.rejects(exec(process.execPath, [cli, 'verifier-report', manifestPath, observationsPath, manifestPath]), /overwrite/)
    assert.equal(await readFile(join(output, 'model-attempts.jsonl'), 'utf8'), attempts)
    await assert.rejects(readFile(join(output, 'evaluation.lock')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
