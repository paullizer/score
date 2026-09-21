import { loadWorker } from './shared-model-loader.mjs'

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
