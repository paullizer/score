import { readFile, writeFile, appendFile, rename, mkdir, open, unlink } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity'
import {
  scoringSuiteSchema, evaluationHash, executeScoringSuite, executeProductionEvaluation,
  advanceCostMilestones,
  validateProductionEvaluation,
  costMilestoneStateSchema,
  validateObservations,
  executeFixedJudgeEvaluation, executeFixedJudgeSuite, validateFixedJudgeEvaluation,
  validateFixedJudgeProposals, validateFixedJudgeObservations,
} from '../dist-worker/scoring-evaluation.mjs'

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function loadOr(path, fallback) {
  try { return await json(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return fallback
  }
}

async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Private checkpoint cleanup failed:', cleanupError.code)
    }
    throw error
  }
}

async function main() {
  const [manifestPath, outputPath, admission, ...extra] = process.argv.slice(2)
  if (!manifestPath || !outputPath || admission !== '--confirm-paid-inference' || extra.length) {
    throw new Error('Usage: scoring-evaluation-run.mjs <private-manifest.json> <private-output-directory> --confirm-paid-inference')
  }
  const manifest = await json(resolve(manifestPath))
  const suite = scoringSuiteSchema.parse(manifest.suite)
  const kind = manifest.kind ?? 'scoring'
  if (!['scoring', 'fixed-judge'].includes(kind)) throw new Error('Unknown evaluation manifest kind.')
  const proposals = kind === 'fixed-judge' ? validateFixedJudgeProposals(suite, manifest.proposals) : null
  const endpoint = new URL(manifest.endpoint)
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.openai.azure.com') ||
    endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Evaluation requires a fixed Azure OpenAI HTTPS account endpoint.')
  }
  if (!Array.isArray(manifest.inputs) || !Array.isArray(manifest.settings)) throw new Error('Private input/settings arrays are required.')
  const inputs = new Map(manifest.inputs.map(row => [row.id, row.input]))
  const settings = new Map(manifest.settings.map(row => [row.id, row.snapshot]))
  if (inputs.size !== manifest.inputs.length || settings.size !== manifest.settings.length) throw new Error('Duplicate private input/settings IDs.')
  if (!Number.isInteger(manifest.concurrency) || manifest.concurrency < 1 || manifest.concurrency > 8) {
    throw new Error('Explicit evaluation concurrency must be one through eight.')
  }
  const identity = manifest.identity ?? { kind: 'azure-cli' }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
    !['azure-cli', 'managed-identity'].includes(identity.kind) ||
    Object.keys(identity).some(key => !(identity.kind === 'azure-cli' ? ['kind', 'tenantId'] : ['kind', 'clientId']).includes(key)) ||
    identity.kind === 'azure-cli' && identity.tenantId !== undefined && !uuid.test(identity.tenantId) ||
    identity.kind === 'managed-identity' && (typeof identity.clientId !== 'string' || !uuid.test(identity.clientId))) {
    throw new Error('Evaluation identity must be azure-cli with an optional tenant UUID or managed-identity with an explicit client UUID.')
  }
  const maxDurationMilliseconds = manifest.maxDurationMilliseconds ?? 14_400_000
  const maxComparisonMilliseconds = manifest.maxComparisonMilliseconds ?? 900_000
  if (![maxDurationMilliseconds, maxComparisonMilliseconds].every(value =>
    Number.isSafeInteger(value) && value >= 1000 && value <= 86_400_000)) {
    throw new Error('Evaluation and comparison deadlines must be 1000-86400000 milliseconds.')
  }
  for (const item of suite.cases) for (const configuration of suite.configurations) {
    const job = {
      suiteSha256: evaluationHash(suite), case: item, configuration, repetition: 1,
    }
    const options = { input: inputs.get(item.id), processingSettings: settings.get(configuration.id), prices: manifest.prices }
    if (kind === 'fixed-judge') validateFixedJudgeEvaluation(job, { ...options, ...proposals.get(item.id) })
    else validateProductionEvaluation(job, options)
  }
  const initialMilestones = costMilestoneStateSchema.parse({
    schemaVersion: 1, programId: manifest.programId ?? suite.id, reportedThroughUsdMicros: 0, pending: [],
  })
  const output = resolve(outputPath)
  await mkdir(output, { recursive: true })
  const costRoot = resolve(manifest.costDirectory ?? resolve(dirname(output), 'costs'))
  await mkdir(costRoot, { recursive: true })
  const programId = initialMilestones.programId
  const programKey = evaluationHash(programId)
  const programLockPath = resolve(costRoot, `${programKey}.state.json.lock`)
  const lockPath = resolve(output, 'evaluation.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Evaluation cancelled; saved prefixes remain resumable.'))
  const deadline = setTimeout(() => controller.abort(new Error('Evaluation deadline reached; saved prefixes remain resumable.')), maxDurationMilliseconds)
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const credential = identity.kind === 'managed-identity'
    ? new ManagedIdentityCredential({ clientId: identity.clientId })
    : new AzureCliCredential(identity.tenantId ? { tenantId: identity.tenantId } : {})
  const tokens = new Map()
  const pendingTokens = new Map()
  const getToken = async scope => {
    const cached = tokens.get(scope)
    if (cached && cached.expiresOnTimestamp > Date.now() + 60_000) return cached.token
    let request = pendingTokens.get(scope)
    if (!request) {
      request = credential.getToken(scope).then(token => {
        if (!token) throw new Error('Azure identity did not return a model token.')
        tokens.set(scope, token)
        return token
      }).finally(() => pendingTokens.delete(scope))
      pendingTokens.set(scope, request)
    }
    return (await request).token
  }
  let programLock
  try {
    programLock = await open(programLockPath, 'wx', 0o600)
    const suitePath = resolve(output, 'suite.json')
    const previousSuite = await loadOr(suitePath, null)
    if (previousSuite && evaluationHash(previousSuite) !== evaluationHash(suite)) {
      throw new Error('Output directory already belongs to a different frozen suite.')
    }
    await atomic(suitePath, suite)
    const observationsPath = resolve(output, 'observations.json')
    const ledgerPath = resolve(costRoot, `${programKey}.ledger.json`)
    const milestonePath = resolve(costRoot, `${programKey}.state.json`)
    const prior = await loadOr(observationsPath, [])
    const observations = kind === 'fixed-judge'
      ? validateFixedJudgeObservations(suite, proposals, prior) : validateObservations(suite, prior)
    const executionPath = resolve(output, 'execution.json')
    const previousExecution = await loadOr(executionPath, null)
    const executionFiles = await Promise.all([
      ['runner.mjs', new URL(import.meta.url)],
      ['bundle.mjs', new URL('../dist-worker/scoring-evaluation.mjs', import.meta.url)],
      ['package-lock.json', new URL('../package-lock.json', import.meta.url)],
    ].map(async ([name, url]) => {
      const bytes = await readFile(url)
      return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    }))
    const execution = {
      schemaVersion: 1, status: 'bound',
      runnerSha256: executionFiles[0].sha256,
      bundleSha256: executionFiles[1].sha256,
      dependencyLockSha256: executionFiles[2].sha256,
      nodeVersion: process.version, suiteSha256: evaluationHash(suite),
      endpoint: endpoint.href, pricesSha256: evaluationHash(manifest.prices),
      ...(kind === 'fixed-judge' ? { kind, proposalsSha256: evaluationHash(manifest.proposals) } : {}),
    }
    const legacy = previousExecution?.status === 'legacy-unverified' || !previousExecution && observations.length > 0
    if (legacy) {
      if (observations.length !== suite.cases.length * suite.configurations.length * suite.repetitions) {
        throw new Error('Legacy partial runs have no execution binding; use a separately versioned audited follow-up, not silent mixed-code resume.')
      }
      if (!previousExecution) await atomic(executionPath, { schemaVersion: 1, status: 'legacy-unverified' })
      console.log(JSON.stringify({ event: 'legacy-execution-unverified', note: 'No new inference admitted; original executable identity cannot be reconstructed.' }))
    } else {
      if (previousExecution && evaluationHash(previousExecution) !== evaluationHash(execution)) {
        throw new Error('Execution identity changed; do not mix executable, runtime, endpoint or price versions in a frozen run.')
      }
      if (!previousExecution) await atomic(executionPath, execution)
      const executionDirectory = resolve(output, 'execution-files')
      await mkdir(executionDirectory, { recursive: true })
      for (const file of executionFiles) {
        const path = resolve(executionDirectory, file.name)
        try {
          await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          if (createHash('sha256').update(await readFile(path)).digest('hex') !== file.sha256) {
            throw new Error('Archived execution files differ from the exact bound implementation.')
          }
        }
      }
    }
    const ledger = await loadOr(ledgerPath, [])
    let milestones = await loadOr(milestonePath, initialMilestones)
    if (milestones.programId !== programId) throw new Error('Cost state belongs to another evaluation program.')
    milestones = advanceCostMilestones(milestones, ledger).state
    await atomic(milestonePath, milestones)
    const emittedReceipts = new Set()
    const emitPendingMilestones = advanced => {
      for (const pending of advanced.state.pending) {
        if (emittedReceipts.has(pending.id)) continue
        console.log(JSON.stringify({
          event: 'cost-milestone-pending', ...pending, ...advanced.costs,
          note: 'Estimated inference only; receipt requires delivery acknowledgment. Ancillary costs may be unbilled.',
        }))
        emittedReceipts.add(pending.id)
      }
    }
    emitPendingMilestones(advanceCostMilestones(milestones, ledger))
    let writes = Promise.resolve()
    const serialize = operation => {
      writes = writes.then(operation)
      return writes
    }
    const executeSuite = kind === 'fixed-judge' ? executeFixedJudgeSuite : executeScoringSuite
    await executeSuite(suite, {
      ...(kind === 'fixed-judge' ? { proposals: manifest.proposals } : {}),
      concurrency: manifest.concurrency, signal: controller.signal, priorObservations: observations,
      execute: async (job, signal) => {
        const comparisonController = new AbortController()
        const comparisonDeadline = setTimeout(() => comparisonController.abort(
          new Error('Comparison deadline reached; paid attempts remain in the program ledger.'),
        ), maxComparisonMilliseconds)
        const comparisonSignal = signal ? AbortSignal.any([signal, comparisonController.signal]) : comparisonController.signal
        const snapshot = settings.get(job.configuration.id)
        const input = inputs.get(job.case.id)
        try {
          if (snapshot === undefined || input === undefined) throw new Error('Missing private frozen evaluation artifacts.')
          const options = {
          input, processingSettings: snapshot, prices: manifest.prices,
          model: {
            endpoint: endpoint.href, deployment: 'captured-task-only', modelName: 'captured-task-only',
            getToken,
          },
          admitPaidWork: async () => { signal?.throwIfAborted() },
          recordAttempt: (attempt, amountUsdMicros, priceVersion) => serialize(async () => {
            await appendFile(resolve(output, 'model-attempts.jsonl'), `${JSON.stringify({
              ...attempt, evaluation: {
                suiteSha256: job.suiteSha256, caseId: job.case.id,
                configurationId: job.configuration.id, repetition: job.repetition,
              },
            })}\n`, { mode: 0o600 })
            ledger.push({
              schemaVersion: 1, id: attempt.id, costItemId: attempt.id, suiteId: suite.id,
              category: 'inference', mode: 'estimate', amountUsdMicros, priceVersion,
              usage: attempt.usage && attempt.usage.cachedInputTokens !== null
                ? attempt.usage : null,
            })
            await atomic(ledgerPath, ledger)
            const advanced = advanceCostMilestones(milestones, ledger)
            milestones = advanced.state
            await atomic(milestonePath, milestones)
            emitPendingMilestones(advanced)
          }),
          recordPrivateResult: async result => {
            const filename = evaluationHash([job.case.id, job.configuration.id, job.repetition])
            await atomic(resolve(output, `${filename}.result.json`), result)
          },
          recordPrivateDiagnostics: async diagnostics => {
            const filename = evaluationHash([job.case.id, job.configuration.id, job.repetition])
            await atomic(resolve(output, `${filename}.diagnostics.json`), diagnostics)
          },
          recordPrivateFailure: async failure => {
            const filename = evaluationHash([job.case.id, job.configuration.id, job.repetition])
            await atomic(resolve(output, `${filename}.failure.json`), failure)
          },
          }
          const result = kind === 'fixed-judge' ? await executeFixedJudgeEvaluation(job, {
            ...options, ...proposals.get(job.case.id),
            recordPrivateReview: async review => {
              const filename = evaluationHash([job.case.id, job.configuration.id, job.repetition])
              await atomic(resolve(output, `${filename}.review.json`), review)
            },
          }, comparisonSignal) : await executeProductionEvaluation(job, options, comparisonSignal)
          comparisonSignal.throwIfAborted()
          return result
        } finally {
          clearTimeout(comparisonDeadline)
        }
      },
      checkpoint: observation => serialize(async () => {
        observations.push(observation)
        await atomic(observationsPath, observations)
      }),
    })
    console.log(JSON.stringify({ event: 'evaluation-complete', observations: observations.length }))
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    await lock.close()
    await unlink(lockPath)
    if (programLock) {
      await programLock.close()
      await unlink(programLockPath)
    }
  }
}

try { await main() } catch (error) {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.')
  process.exitCode = 1
}
