import { readFile, writeFile, rename, mkdir, open, unlink, link } from 'node:fs/promises'
import { dirname, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  advanceCostMilestones, scoringSuiteSchema, summarizeScoringSuite, validateReferenceSet,
  prepareScoringCorpus,
  prepareBlindSpotChecks,
  exportScorerDerivedReferences,
  measureExtractionPreservation, diagnoseLayoutFactPreservation, importBlindHumanLabels, evaluateScoringEngineeringGates,
  exportSourceOnlyReferences,
  fixedJudgeStatistics,
  summarizePairedInvariance,
  summarizeFixedJudgeSuite,
  acknowledgeCostMilestones, costDeliveryReceiptSchema, evaluationHash,
  prepareScoringShards, mergeScoringShardObservations, validateProductionEvaluation,
  QC_LIMITS,
  summarizeEvidenceMonotonicity,
  summarizeEvidenceSelections,
} from '../dist-worker/scoring-evaluation.mjs'

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}

async function atomicWrite(path, value, immutable = false) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = resolve(dirname(destination), `.${basename(destination)}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    if (immutable) {
      await link(temporary, destination)
      await unlink(temporary)
    } else await rename(temporary, destination)
  } catch (error) {
    try { await unlink(temporary) } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Evaluation temporary-file cleanup failed:', cleanupError.code)
    }
    throw error
  }
}

async function main(args) {
  const [command, ...paths] = args
  if (command === 'layout-integrity' && paths.length === 3) {
    const [responsePath, factsPath, outputPath] = paths
    if ([responsePath, factsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Layout integrity diagnostics cannot overwrite their source artifacts.')
    }
    const [response, facts] = await Promise.all([readJson(responsePath), readJson(factsPath)])
    await atomicWrite(outputPath, diagnoseLayoutFactPreservation(response, facts))
    console.log('Source-bound layout diagnostics saved; evidence was not rewritten and word preservation is not semantic recall.')
    return
  }
  if (command === 'evidence-selection' && paths.length === 6) {
    const [suitePath, observationsPath, inputsPath, annotationsPath, assessmentsPath, outputPath] = paths
    if (paths.slice(0, -1).some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Evidence selection report cannot overwrite its input artifacts.')
    }
    const [suite, observations, inputs, annotations, assessments] = await Promise.all(
      [suitePath, observationsPath, inputsPath, annotationsPath, assessmentsPath].map(readJson))
    await atomicWrite(outputPath, summarizeEvidenceSelections(suite, observations, inputs, annotations, assessments))
    console.log('Source-bound final-citation fact coverage saved; literal coverage is not semantic accuracy or release approval.')
    return
  }
  if (command === 'monotonicity' && paths.length === 5) {
    const [suitePath, observationsPath, pairsPath, inputsPath, outputPath] = paths
    if ([suitePath, observationsPath, pairsPath, inputsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Monotonicity report cannot overwrite its input artifacts.')
    }
    const [suite, observations, pairs, inputs] = await Promise.all([
      readJson(suitePath), readJson(observationsPath), readJson(pairsPath), readJson(inputsPath),
    ])
    await atomicWrite(outputPath, summarizeEvidenceMonotonicity(suite, observations, pairs, inputs))
    console.log('Source-bound evidence insertion/removal diagnostics saved; directional changes are not inferred errors or release approval.')
    return
  }
  if (command === 'prepare-shards' && paths.length === 2) {
    const [manifestPath, outputPath] = paths
    const manifest = await readJson(manifestPath)
    if (manifest.kind !== undefined && manifest.kind !== 'scoring') {
      throw new Error('Scoring sharding does not accept fixed-judge manifests.')
    }
    const partition = prepareScoringShards(manifest.suite, manifest.inputs)
    if (!Array.isArray(manifest.settings)) throw new Error('Sharding requires the frozen configuration settings.')
    const settings = new Map(manifest.settings.map(row => [row.id, row.snapshot]))
    if (settings.size !== manifest.settings.length) throw new Error('Duplicate frozen configuration settings.')
    const directory = resolve(outputPath)
    const artifacts = partition.shards.map(shard => {
      for (const item of shard.suite.cases) for (const configuration of shard.suite.configurations) {
        validateProductionEvaluation({
          suiteSha256: evaluationHash(shard.suite), case: item, configuration, repetition: 1,
        }, {
          input: shard.inputs.find(row => row.id === item.id).input,
          processingSettings: settings.get(configuration.id), prices: manifest.prices,
        })
      }
      const value = {
        ...manifest, kind: 'scoring', suite: shard.suite, inputs: shard.inputs,
        programId: manifest.programId ?? partition.index.parentSuite.id,
        costDirectory: resolve(manifest.costDirectory ?? resolve(directory, 'costs')),
      }
      if (Buffer.byteLength(JSON.stringify(value)) > QC_LIMITS.artifactBytes) {
        throw new Error('Complete shard manifest exceeds the QC artifact byte ceiling; narrow the suite explicitly. No evidence was truncated.')
      }
      return { path: resolve(directory, `${shard.suite.id}.manifest.json`), value }
    })
    artifacts.push({ path: resolve(directory, 'index.json'), value: partition.index })
    if (artifacts.some(row => row.path === resolve(manifestPath))) throw new Error('Shard artifacts cannot overwrite the parent manifest.')
    for (const artifact of artifacts) {
      try { await atomicWrite(artifact.path, artifact.value, true) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (evaluationHash(await readJson(artifact.path)) !== evaluationHash(artifact.value)) {
          throw new Error('Existing shard artifact differs from this immutable partition.')
        }
      }
    }
    console.log(JSON.stringify({
      parentSuiteSha256: partition.index.parentSuiteSha256,
      shards: partition.index.shards.length, cases: partition.index.parentSuite.cases.length,
      index: resolve(directory, 'index.json'),
      note: 'Private manifests prepared without inference; run shards sequentially under their shared program lock.',
    }))
    return
  }
  if (command === 'merge-shards' && paths.length === 3) {
    const [indexPath, resultsPath, outputPath] = paths
    if ([indexPath, resultsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Merged shard report cannot overwrite its input artifacts.')
    }
    const [index, results] = await Promise.all([readJson(indexPath), readJson(resultsPath)])
    await atomicWrite(outputPath, mergeScoringShardObservations(index, results))
    console.log('Exact shard checkpoints merged; missing work and failed observations remain explicit.')
    return
  }
  if (command === 'costs-ack' && paths.length === 3) {
    const [statePath, deliveryPath, archivePath] = paths
    if (resolve(statePath) === resolve(deliveryPath)) throw new Error('Cost delivery input must be separate from milestone state.')
    const lockPath = `${resolve(statePath)}.lock`
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      const [state, rawReceipt] = await Promise.all([readJson(statePath), readJson(deliveryPath)])
      const receipt = costDeliveryReceiptSchema.parse(rawReceipt)
      if (Date.parse(receipt.deliveredAt) > Date.now()) throw new Error('A cost notice cannot be acknowledged before its recorded delivery time.')
      const destination = resolve(archivePath, `${evaluationHash(receipt)}.delivery.json`)
      if ([statePath, deliveryPath].some(path => resolve(path) === destination)) {
        throw new Error('Cost delivery archive cannot overwrite its input artifacts.')
      }
      let archived
      try { archived = await readJson(destination) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const acknowledged = acknowledgeCostMilestones(state, receipt, archived)
      if (archived === undefined) await atomicWrite(destination, acknowledged.receipt, true)
      await atomicWrite(statePath, acknowledged.state)
      console.log(JSON.stringify({
        acknowledgedMilestones: receipt.milestones, archivedReceipt: destination,
        pendingNotifications: acknowledged.state.pending,
        note: 'Operator-supplied delivery record retained; this command does not send a notice or prove human receipt.',
      }, null, 2))
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
    return
  }
  if (command === 'judge-report' && paths.length === 5) {
    const [suitePath, proposalsPath, observationsPath, labelsPath, outputPath] = paths
    if ([suitePath, proposalsPath, observationsPath, labelsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Judge report cannot overwrite its input artifacts.')
    }
    const [suite, proposals, observations, labels] = await Promise.all([
      readJson(suitePath), readJson(proposalsPath), readJson(observationsPath), readJson(labelsPath),
    ])
    await atomicWrite(outputPath, summarizeFixedJudgeSuite(suite, proposals, observations, labels))
    console.log('Source/proposal-bound judge report saved; independent labels and repetitions remain separate.')
    return
  }
  if (command === 'invariance' && paths.length === 5) {
    const [suitePath, observationsPath, pairsPath, inputsPath, outputPath] = paths
    if ([suitePath, observationsPath, pairsPath, inputsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Invariance report cannot overwrite its input artifacts.')
    }
    const [suite, observations, pairs, inputs] = await Promise.all([
      readJson(suitePath), readJson(observationsPath), readJson(pairsPath), readJson(inputsPath),
    ])
    await atomicWrite(outputPath, summarizePairedInvariance(suite, observations, pairs, inputs))
    console.log('Paired input changes and unchanged-input noise saved; no fairness or release claim inferred.')
    return
  }
  if (command === 'judge' && paths.length === 2) {
    if (resolve(paths[0]) === resolve(paths[1])) throw new Error('Judge report cannot overwrite its input.')
    await atomicWrite(paths[1], fixedJudgeStatistics(await readJson(paths[0])))
    console.log('Fixed-assessment judge diagnostics saved; failed reviews remain indeterminate.')
    return
  }
  if (command === 'source-references' && paths.length === 5) {
    const [manifestPath, targetsPath, resultsPath, outputPath, configurationId] = paths
    if ([manifestPath, targetsPath, resultsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Source-only references cannot overwrite input artifacts.')
    }
    const [manifest, targets, results] = await Promise.all([
      readJson(manifestPath), readJson(targetsPath), readJson(resultsPath),
    ])
    await atomicWrite(outputPath, exportSourceOnlyReferences(manifest.suite, targets.map(row => ({
      id: row.id, caseId: row.caseId, criterionId: row.criterionId, inputSha256: row.inputSha256,
      inclusionProbability: row.inclusionProbability,
    })), configurationId, results), true)
    console.log('Source-only AI references saved; independent exposure does not imply human truth.')
    return
  }
  if (command === 'extraction' && paths.length === 2) {
    if (resolve(paths[0]) === resolve(paths[1])) throw new Error('Extraction report cannot overwrite its input.')
    await atomicWrite(paths[1], measureExtractionPreservation(await readJson(paths[0])))
    console.log('Planted extraction preservation measured; no semantic or PDF/OCR accuracy inferred.')
    return
  }
  if (command === 'human-labels' && paths.length === 4) {
    const [manifestPath, targetsPath, submissionPath, outputPath] = paths
    if ([manifestPath, targetsPath, submissionPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Human revision must not overwrite its input artifacts.')
    }
    const [manifest, targets, submission] = await Promise.all([
      readJson(manifestPath), readJson(targetsPath), readJson(submissionPath),
    ])
    await atomicWrite(outputPath, importBlindHumanLabels({
      ...submission, suite: manifest.suite, targets, inputs: manifest.inputs,
    }), true)
    console.log('Source-bound human label revision saved separately; holdout labels must stay sealed.')
    return
  }
  if (command === 'gates' && paths.length === 6) {
    const [suitePath, observationsPath, referencesPath, outputPath, baselineId, candidateId] = paths
    if ([suitePath, observationsPath, referencesPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Engineering gate output cannot overwrite its input artifacts.')
    }
    const [suite, observations, references] = await Promise.all([
      readJson(suitePath), readJson(observationsPath), readJson(referencesPath),
    ])
    await atomicWrite(outputPath, evaluateScoringEngineeringGates(suite, observations, references, baselineId, candidateId))
    console.log('Engineering gates saved; external release requirements and explicit promotion still apply.')
    return
  }
  if (command === 'silver-references' && paths.length === 6) {
    const [manifestPath, targetsPath, observationsPath, outputPath, configurationId, repetition] = paths
    if ([manifestPath, targetsPath, observationsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Reference output must not overwrite an input artifact.')
    }
    const [manifest, targets, observations] = await Promise.all([
      readJson(manifestPath), readJson(targetsPath), readJson(observationsPath),
    ])
    const selectedTargets = targets.map(row => ({
      id: row.id, caseId: row.caseId, criterionId: row.criterionId,
      inputSha256: row.inputSha256, inclusionProbability: row.inclusionProbability,
    }))
    const snapshot = manifest.settings.find(row => row.id === configurationId)?.snapshot
    await atomicWrite(outputPath, exportScorerDerivedReferences(
      manifest.suite, selectedTargets, observations, configurationId, Number(repetition), snapshot,
    ), true)
    console.log('Provisional scorer-derived references saved with explicit non-independent provenance.')
    return
  }
  if (command === 'spot-checks' && paths.length === 4) {
    const [manifestPath, targetsPath, outputPath, seed] = paths
    if ([manifestPath, targetsPath].some(path => resolve(path) === resolve(outputPath))) {
      throw new Error('Blind pack output must not overwrite an input artifact.')
    }
    const [manifest, targets] = await Promise.all([readJson(manifestPath), readJson(targetsPath)])
    await atomicWrite(outputPath, prepareBlindSpotChecks(manifest.suite, targets, manifest.inputs, seed), true)
    console.log('Thirty blind cards saved; no model scores or opinions are included.')
    return
  }
  if (command === 'prepare-corpus' && paths.length === 2) {
    if (resolve(paths[0]) === resolve(paths[1])) throw new Error('Corpus output must not overwrite its source manifest.')
    await atomicWrite(paths[1], prepareScoringCorpus(await readJson(paths[0])), true)
    console.log('Private 50-family corpus prepared without inference; reference scores are not yet labeled.')
    return
  }
  if (command === 'report' && (paths.length === 3 || paths.length === 4)) {
    const [suitePath, observationsPath, outputPath, referencesPath] = paths
    if (paths.some((path, index) => index !== 2 && resolve(path) === resolve(outputPath))) {
      throw new Error('Report output must not overwrite an input artifact.')
    }
    const [suite, observations, references] = await Promise.all([
      readJson(suitePath), readJson(observationsPath), referencesPath ? readJson(referencesPath) : [],
    ])
    await atomicWrite(outputPath, summarizeScoringSuite(suite, observations, references))
    console.log('Descriptive evaluation report saved. This does not authorize a release.')
    return
  }
  if (command === 'validate' && (paths.length === 1 || paths.length === 2)) {
    const suite = scoringSuiteSchema.parse(await readJson(paths[0]))
    if (paths[1]) validateReferenceSet(suite, await readJson(paths[1]))
    console.log('Frozen evaluation contracts validated.')
    return
  }
  if (command === 'costs' && paths.length === 2) {
    const [ledgerPath, statePath] = paths
    if (resolve(ledgerPath) === resolve(statePath)) throw new Error('Cost state cannot overwrite its ledger.')
    const lockPath = `${resolve(statePath)}.lock`
    await mkdir(dirname(lockPath), { recursive: true })
    const lock = await open(lockPath, 'wx', 0o600)
    try {
      const [entries, state] = await Promise.all([readJson(ledgerPath), readJson(statePath)])
      const next = advanceCostMilestones(state, entries)
      await atomicWrite(statePath, next.state)
      console.log(JSON.stringify({ costs: next.costs, pendingNotifications: next.state.pending }, null, 2))
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
    return
  }
  throw new Error('Usage: scoring-evaluation.mjs <prepare-corpus|prepare-shards|merge-shards|spot-checks|silver-references|source-references|human-labels|extraction|layout-integrity|evidence-selection|judge|judge-report|invariance|monotonicity|gates|validate|report|costs|costs-ack> <paths...>. See docs\\scoring-quality-program.md for each command contract.')
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Scoring evaluation failed.')
  process.exitCode = 1
}
