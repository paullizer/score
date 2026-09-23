import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorker } from './shared-model-loader.mjs'

const legacyFixture = JSON.parse(await readFile(path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'processing-settings-v1.json',
), 'utf8'))
export const legacyV1Capture = Object.freeze({
  sourceCommit: legacyFixture.sourceCommit,
  sourceRuntimeSettingsVersion: legacyFixture.sourceRuntimeSettingsVersion,
  snapshotBytes: legacyFixture.snapshotBytes,
  snapshotSha256: legacyFixture.snapshotSha256,
  policySha256: legacyFixture.policySha256,
  snapshotJson: JSON.stringify(legacyFixture.snapshot),
})

export const settingsDomain = await loadWorker('../src/domain/admin-settings.ts')
export function settingsSnapshot(change = () => {}, revision = 'runtime-test-v1') {
  const settings = settingsDomain.createDefaultAdminSettings()
  for (const task of settingsDomain.MODEL_TASK_IDS) {
    settings.ai.deployments.push({
      ...structuredClone(settings.ai.deployments[0]), id: task, deploymentName: `deployment-${task}`, label: task,
    })
    settings.ai.tasks[task].deploymentId = task
  }
  change(settings)
  return settingsDomain.captureProcessingSettings(settings, revision, '2026-09-21T12:00:00.000Z')
}

export function legacyV1Snapshot() {
  return JSON.parse(legacyV1Capture.snapshotJson)
}
