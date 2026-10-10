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
  rubricRepeatabilitySuiteSchema, validateRubricGeneration, validateRubricGenerationObservations,
  executeRubricRepeatabilitySuite, executeRubricGeneration,
  gradeGenerationSuiteSchema, validateGradeGeneration, validateGradeGenerationObservations,
  executeGradeGenerationSuite, executeGradeGeneration,
} from '../dist-worker/scoring-evaluation.mjs'

const GENERATION_KINDS = ['rubric-generation', 'grade-generation']

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
  const kind = manifest.kind ?? 'scoring'
  if (!['scoring', 'fixed-judge', ...GENERATION_KINDS].includes(kind)) throw new Error('Unknown evaluation manifest kind.')
  const generation = GENERATION_KINDS.includes(kind)
  const suite = kind === 'rubric-generation' ? rubricRepeatabilitySuiteSchema.parse(manifest.suite)
    : kind === 'grade-generation' ? gradeGenerationSuiteSchema.parse(manifest.suite) : scoringSuiteSchema.parse(manifest.suite)
  const proposals = kind === 'fixed-judge' ? validateFixedJudgeProposals(suite, manifest.proposals) : null
  const endpoint = new URL(manifest.endpoint)
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.openai.azure.com') ||
    endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Evaluation requires a fixed Azure OpenAI HTTPS account endpoint.')
  }
  // Scoring reads resume inputs, rubric generation reads job documents and grade generation reads frozen ladder fixtures.
  const sourceKey = { 'rubric-generation': 'documents', 'grade-generation': 'fixtures' }[kind] ?? 'inputs'
  if (!Array.isArray(manifest[sourceKey]) || !Array.isArray(manifest.settings)) throw new Error(`Private ${sourceKey}/settings arrays are required.`)
  const inputs = new Map(manifest[sourceKey].map(row => generation
    ? [row.sourceId, kind === 'rubric-generation' ? row.document : row.fixture] : [row.id, row.input]))
  const settings = new Map(manifest.settings.map(row => [row.id, row.snapshot]))
  if (inputs.size !== manifest[sourceKey].length || settings.size !== manifest.settings.length) throw new Error(`Duplicate private ${sourceKey}/settings IDs.`)
  if (generation && !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Generation manifests require an explicit createdAt timestamp.')
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
  for (const item of generation ? suite.sources : suite.cases) for (const configuration of suite.configurations) {
    const job = generation
      ? { suiteSha256: evaluationHash(suite), source: item, configuration, repetition: 1 }
      : { suiteSha256: evaluationHash(suite), case: item, configuration, repetition: 1 }
    const options = { processingSettings: settings.get(configuration.id), prices: manifest.prices }
    if (kind === 'rubric-generation') validateRubricGeneration(job, { ...options, document: inputs.get(item.id) })
    else if (kind === 'grade-generation') validateGradeGeneration(job, { ...options, fixture: inputs.get(item.id) })
    else if (kind === 'fixed-judge') validateFixedJudgeEvaluation(job, { ...options, input: inputs.get(item.id), ...proposals.get(item.id) })
    else validateProductionEvaluation(job, { ...options, input: inputs.get(item.id) })
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
    const observations = kind === 'fixed-judge' ? validateFixedJudgeObservations(suite, proposals, prior)
      : kind === 'rubric-generation' ? validateRubricGenerationObservations(suite, prior)
        : kind === 'grade-generation' ? validateGradeGenerationObservations(suite, prior) : validateObservations(suite, prior)
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
      ...(generation ? { kind, sourcesSha256: evaluationHash(manifest[sourceKey]), createdAt: manifest.createdAt } : {}),
    }
    const legacy = previousExecution?.status === 'legacy-unverified' || !previousExecution && observations.length > 0
    if (legacy) {
      const expected = (generation ? suite.sources : suite.cases).length * suite.configurations.length * suite.repetitions
      if (observations.length !== expected) {
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
    const executeSuite = {
      'fixed-judge': executeFixedJudgeSuite, 'rubric-generation': executeRubricRepeatabilitySuite,
      'grade-generation': executeGradeGenerationSuite,
    }[kind] ?? executeScoringSuite
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
        // Generation jobs are keyed by their frozen source; scoring jobs by their case.
        const itemId = generation ? job.source.id : job.case.id
        const input = inputs.get(itemId)
        const filename = evaluationHash([itemId, job.configuration.id, job.repetition])
        const record = (suffix, value) => atomic(resolve(output, `${filename}.${suffix}.json`), value)
        try {
          if (snapshot === undefined || input === undefined) throw new Error('Missing private frozen evaluation artifacts.')
          const options = {
            processingSettings: snapshot, prices: manifest.prices,
            model: {
              endpoint: endpoint.href, deployment: 'captured-task-only', modelName: 'captured-task-only',
              getToken,
            },
            admitPaidWork: async () => { signal?.throwIfAborted() },
            recordAttempt: (attempt, amountUsdMicros, priceVersion) => serialize(async () => {
              await appendFile(resolve(output, 'model-attempts.jsonl'), `${JSON.stringify({
                ...attempt, evaluation: {
                  suiteSha256: job.suiteSha256, caseId: itemId,
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
            recordPrivateFailure: failure => record('failure', failure),
          }
          const binding = { sourceId: itemId, configurationId: job.configuration.id, repetition: job.repetition }
          let result
          if (kind === 'rubric-generation') {
            result = await executeRubricGeneration(job, {
              ...options, document: input, createdAt: manifest.createdAt,
              recordPrivateRubric: generated => record('rubric', { ...binding, ...generated }),
            }, comparisonSignal)
          } else if (kind === 'grade-generation') {
            result = await executeGradeGeneration(job, {
              ...options, fixture: input, createdAt: manifest.createdAt,
              recordPrivateGeneration: generated => record('grades', { ...binding, ...generated }),
            }, comparisonSignal)
          } else if (kind === 'fixed-judge') {
            result = await executeFixedJudgeEvaluation(job, {
              ...options, input, ...proposals.get(job.case.id),
              recordPrivateReview: review => record('review', review),
            }, comparisonSignal)
          } else {
            result = await executeProductionEvaluation(job, {
              ...options, input,
              recordPrivateResult: result => record('result', result),
              recordPrivateDiagnostics: diagnostics => record('diagnostics', diagnostics),
              recordPrivateScaleArtifact: artifact => record(`scale-choice-${artifact.correctionCount}`, {
                suiteSha256: job.suiteSha256, caseId: itemId,
                configurationId: job.configuration.id, repetition: job.repetition, ...artifact,
              }),
            }, comparisonSignal)
          }
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
