import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { AzureCliCredential } from '@azure/identity'
import {
  DECISION_CONTRACT, DECISION_PRICE, DecisionError, validateDecisionManifest, decisionRequest,
  invokeDecisionChoice, evaluationHash, summarizeDecisionPanel,
  verifyDecisionDeployment,
} from '../dist-worker/scoring-evaluation.mjs'

export async function runDecisionEvaluation(manifestPath, outputPath, admission) {
  if (!manifestPath || !outputPath || !['--dry-run', '--confirm-paid-inference'].includes(admission)) {
    throw new Error('Usage: decision-evaluation-run.mjs <manifest.json> <new-private-output-directory> --dry-run|--confirm-paid-inference')
  }
  const bytes = await readFile(resolve(manifestPath))
  const plan = validateDecisionManifest(JSON.parse(bytes.toString('utf8')))
  if (!plan.withinBudget) throw new Error('Worst-case attempt reservations exceed the frozen spend limit.')
  const output = resolve(outputPath)
  // A fresh directory prevents overwriting, mixed-code resume, concurrent runs, and unaccounted replay.
  await mkdir(output, { mode: 0o700 })
  const capture = async (name, value) => writeFile(resolve(output, name),
    `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const runner = await readFile(new URL(import.meta.url))
  const bundle = await readFile(new URL('../dist-worker/scoring-evaluation.mjs', import.meta.url))
  const lock = await readFile(new URL('../package-lock.json', import.meta.url))
  const { createHash } = await import('node:crypto')
  const hashBytes = value => createHash('sha256').update(value).digest('hex')
  await writeFile(resolve(output, 'manifest.original.json'), bytes, { flag: 'wx', mode: 0o600 })
  await capture('manifest.json', plan.manifest)
  await capture('execution.json', {
    schemaVersion: 1, mode: admission, manifestSha256: plan.manifestSha256,
    manifestBytesSha256: hashBytes(bytes), runnerSha256: hashBytes(runner), bundleSha256: hashBytes(bundle),
    dependencyLockSha256: hashBytes(lock), nodeVersion: process.version,
    contract: DECISION_CONTRACT, price: DECISION_PRICE,
  })
  for (const [name, value] of [['runner.mjs', runner], ['bundle.mjs', bundle], ['package-lock.json', lock]]) {
    await writeFile(resolve(output, name), value, { flag: 'wx', mode: 0o600 })
  }
  await capture('preflight.json', {
    manifestSha256: plan.manifestSha256, cases: plan.manifest.cases.length, requests: plan.requests,
    maxAttempts: plan.manifest.maxAttempts, maximumAttempts: plan.requests * plan.manifest.maxAttempts,
    reservationPerAttemptUsdMicros: plan.reservationPerAttemptUsdMicros,
    maximumReservationUsdMicros: plan.maximumReservationUsdMicros,
    spendLimitUsdMicros: plan.manifest.maxSpendUsdMicros, withinBudget: plan.withinBudget,
    contextLimitStatus: 'Model-specific context maximum unverified; local request-byte bound is not a provider limit.',
    costLimitStatus: 'Conservative local token reservations, not an Azure billing quote or provider-side quota. Unknown costs retain full reservation.',
    inferenceAdmitted: admission === '--confirm-paid-inference',
  })
  if (admission === '--dry-run') return { mode: 'dry-run', requests: plan.requests, inferenceRequests: 0 }
  const credential = new AzureCliCredential({ tenantId: plan.manifest.identity.tenantId })
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Offline evaluation interrupted.'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const deadline = setTimeout(stop, Math.min(3_600_000, plan.requests * (plan.manifest.maxAttempts * plan.manifest.timeoutMilliseconds + 7000)))
  const observations = []
  let reservedUsdMicros = 0, knownUsdMicros = 0, unknownAttempts = 0, attempts = 0
  const cachedTokens = new Map()
  const getToken = async scope => {
    let cachedToken = cachedTokens.get(scope)
    if (!cachedToken || cachedToken.expiresOnTimestamp <= Date.now() + 60_000) {
      cachedToken = await credential.getToken(scope)
      if (cachedToken) cachedTokens.set(scope, cachedToken)
    }
    if (!cachedToken) throw new DecisionError('authentication')
    return cachedToken.token
  }
  const journal = async event => appendFile(resolve(output, 'attempts.jsonl'),
    `${JSON.stringify(event)}\n`, { mode: 0o600 })
  let infrastructureFailure = null
  try {
    const deployment = await verifyDecisionDeployment(getToken)
    await capture('deployment.json', deployment)
    await capture('admission.json', { manifestSha256: plan.manifestSha256, deploymentSha256: evaluationHash(deployment) })
    for (const item of plan.manifest.cases) for (const variant of plan.manifest.variants) {
      controller.signal.throwIfAborted()
      const request = decisionRequest(item, variant, plan.manifest.promptVersion), started = Date.now()
      const identity = { caseId: item.id, variant, manifestSha256: plan.manifestSha256 }
      let result
      try {
        const response = await invokeDecisionChoice(request.state, request.instructions, request.criteria, {
          ...plan.manifest, getToken,
          onStart: async attempt => {
            if (reservedUsdMicros + plan.reservationPerAttemptUsdMicros > plan.manifest.maxSpendUsdMicros) {
              throw new DecisionError('spend-limit')
            }
            reservedUsdMicros += plan.reservationPerAttemptUsdMicros
            attempts++
            await journal({ ...identity, event: 'reserved', ...attempt,
              reservedUsdMicros: plan.reservationPerAttemptUsdMicros, priceVersion: DECISION_PRICE.version })
          },
          onFinish: async attempt => {
            if (attempt.amountUsdMicros === null) unknownAttempts++
            else knownUsdMicros += attempt.amountUsdMicros
            await journal({ ...identity, event: 'finished', ...attempt, priceVersion: DECISION_PRICE.version })
            if (knownUsdMicros > plan.manifest.maxSpendUsdMicros || attempt.code === 'metering-bound-exceeded') {
              throw new DecisionError('spend-or-metering-limit')
            }
          },
        }, controller.signal)
        result = { status: 'complete', response, responseSha256: evaluationHash(response) }
      } catch (error) {
        if (!(error instanceof DecisionError)) throw error
        result = { status: 'failed', code: error.code, httpStatus: error.httpStatus }
      }
      const row = { ...identity, provenance: request.provenance, durationMilliseconds: Date.now() - started, result }
      await appendFile(resolve(output, 'observations.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 })
      observations.push(row)
      if (result.status === 'failed' && ['authentication', 'spend-limit', 'spend-or-metering-limit',
        'metering-bound-exceeded', 'unexpected-model'].includes(result.code)) {
        throw new DecisionError(result.code, result.httpStatus)
      }
      // Sequential calls paced below the observed deployment's 50 RPM; capacity is not a suitability gate.
      await delay(1500, undefined, { signal: controller.signal })
    }
  } catch (error) {
    infrastructureFailure = error instanceof DecisionError ? error.code : controller.signal.aborted ? 'cancelled' : 'runner-failure'
    throw error
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await capture('observations.json', observations)
    await capture('report.json', summarizeDecisionPanel(plan.manifest, observations))
    await capture('cost-summary.json', {
      attempts, knownUsdMicros, unknownAttempts, reservedUsdMicros,
      maximumReservationUsdMicros: plan.maximumReservationUsdMicros,
      spendLimitUsdMicros: plan.manifest.maxSpendUsdMicros, infrastructureFailure,
      initialContractSmokeExcluded: true, billingReconciled: false,
    })
  }
  return { mode: 'inference', requests: observations.length, failed: observations.filter(row => row.result.status === 'failed').length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, output, admission, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Unexpected decision runner arguments.')
  runDecisionEvaluation(manifest, output, admission).then(result => {
    console.log(JSON.stringify(result))
    if (result.failed) process.exitCode = 1
  }).catch(error => {
    console.error(error instanceof DecisionError ? error.message : 'Offline decision runner failed; inspect local inputs and private captures.')
    process.exitCode = 1
  })
}
