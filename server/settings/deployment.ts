import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { PROMPT_RUNTIME_VERSION, PROMPT_TEMPLATE_GENERATION, promptHashSchema, type PromptDeploymentRelease } from '../../src/domain/prompt-versions'
import type { SettingsConfig } from './store'
import { compiledPromptContractHash } from './prompts'

const manifestSchema = z.strictObject({
  releaseId: promptHashSchema, contractSha256: promptHashSchema,
  generation: z.literal(PROMPT_TEMPLATE_GENERATION), promptRuntimeVersion: z.literal(PROMPT_RUNTIME_VERSION),
})
export async function readDeploymentBuild(): Promise<z.infer<typeof manifestSchema>> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('./deployment.json', import.meta.url), 'utf8')))
  if (manifest.contractSha256 !== compiledPromptContractHash()) throw new Error('The packaged release does not match the API prompt contract.')
  return manifest
}
export function deploymentProof(settings: SettingsConfig | undefined): PromptDeploymentRelease | undefined {
  const proof = settings?.workerVerification
  if (!settings?.runtimeEnabled || !proof?.releaseId || !proof.contractSha256) return undefined
  return { releaseId: proof.releaseId, contractSha256: proof.contractSha256, workerImage: proof.image, verifiedAt: proof.verifiedAt }
}
