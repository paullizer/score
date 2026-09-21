import type { TokenCredential } from '@azure/identity'
import { z } from 'zod'
import { modelCapabilitiesFor } from '../../src/domain/admin-settings-defaults'
import type { AdminSettings, DeploymentInventory, ModelDeployment, ModelTaskId, ModelTestResult, ResolvedTaskModel } from '../../src/domain/admin-settings'
import { invalidRequest, unavailable } from '../errors'
import type { SettingsModelResource } from './store'

export interface ModelTestRequest {
  kind: 'connection' | 'structured-output' | 'task'
  deployment: ModelDeployment
  task?: ResolvedTaskModel
  settings: AdminSettings
  confirmPaidProbe: boolean
}
export interface SettingsModelAdapter {
  inventory(): Promise<DeploymentInventory>
  test(request: ModelTestRequest): Promise<ModelTestResult>
}
interface AzureSettingsModelOptions {
  resource: SettingsModelResource
  /** Explicit API managed-identity credential, not a chained credential or an API key. */
  credential: TokenCredential
  fetch?: typeof fetch
  now?: () => Date
}

const MANAGEMENT_ORIGIN = 'https://management.azure.com'
const MANAGEMENT_VERSION = '2024-10-01'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const inventoryPageSchema = z.object({
  value: z.array(z.object({
    id: z.string(), name: z.string().min(1).max(128),
    properties: z.object({
      provisioningState: z.string().optional(),
      model: z.object({ format: z.string(), name: z.string(), version: z.string().optional() }),
    }),
  })).max(100),
  nextLink: z.string().optional(),
})
const completionEnvelope = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/),
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
      tool_calls: z.null().optional(), function_call: z.null().optional(),
    }),
  })).length(1),
})
const simpleProbe = z.strictObject({ value: z.literal('score-structured-output') })
const SYNTHETIC_EVIDENCE = 'The synthetic source states that one example project was completed.'
const taskProbe = (task: ModelTaskId) => z.strictObject({
  task: z.literal(task),
  supported: z.literal(true),
  evidence: z.array(z.strictObject({ paragraphId: z.literal('synthetic-p1'), quote: z.literal(SYNTHETIC_EVIDENCE) })).length(1),
  missing: z.null(),
})
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert)
    if (typeof value !== 'object' || value === null) return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '$schema') continue
      if (key === 'const') result.enum = [item]
      else result[key] = convert(item)
    }
    return result
  }
  return convert(z.toJSONSchema(schema)) as Record<string, unknown>
}

async function jsonResponse(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel()
    throw unavailable('Azure returned an oversized validation response.')
  }
  if (!response.body) throw unavailable('Azure returned no validation response body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw unavailable('Azure returned an oversized validation response.')
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const body = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(body) } catch { throw unavailable('Azure returned invalid JSON during validation.') }
}

export function createAzureSettingsModelAdapter(options: AzureSettingsModelOptions): SettingsModelAdapter {
  const { resource, credential } = options
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const accountPath = resource.resourceId
  const deploymentPath = accountPath ? `${accountPath}/deployments` : undefined
  const endpoint = new URL(resource.endpoint)
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.openai.azure.com') || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash || (endpoint.port && endpoint.port !== '443')) {
    throw new Error('Model validation requires the fixed Azure OpenAI service-root endpoint.')
  }
  function managementUrl(): string {
    if (!deploymentPath) throw unavailable('Scoped deployment discovery is not configured. Set SCORE_MODEL_RESOURCE_ID through deployment.')
    return `${MANAGEMENT_ORIGIN}${deploymentPath}?api-version=${MANAGEMENT_VERSION}`
  }
  function validateManagementUrl(value: string): URL {
    const url = new URL(value)
    if (!deploymentPath || url.origin !== MANAGEMENT_ORIGIN || url.pathname.toLowerCase() !== deploymentPath.toLowerCase() ||
      url.username || url.password || url.hash) throw unavailable('Azure inventory returned a continuation outside the configured resource.')
    return url
  }
  async function request(url: string, scope: string, init: RequestInit, timeoutMilliseconds: number): Promise<Response> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(unavailable('Azure model validation exceeded its bounded deadline.'))
      }, timeoutMilliseconds)
    })
    try {
      return await Promise.race([
        (async () => {
          const token = await credential.getToken(scope, { abortSignal: controller.signal })
          controller.signal.throwIfAborted()
          if (!token?.token) throw unavailable('The API managed identity could not acquire the required Azure token.')
          const response = await fetcher(url, {
            ...init, redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token.token}` },
          })
          controller.signal.throwIfAborted()
          // Buffer under the same timeout and size ceiling, not after dropping the deadline.
          const body = await jsonResponse(response)
          controller.signal.throwIfAborted()
          return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } })
        })(),
        deadline,
      ])
    } catch (error) {
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw unavailable('Azure model validation exceeded its bounded deadline.')
      throw error
    } finally { clearTimeout(timer) }
  }
  async function inventory(): Promise<DeploymentInventory> {
    let next: string | undefined = managementUrl()
    const visited = new Set<string>()
    const deployments: ModelDeployment[] = []
    const checkedAt = now().toISOString()
    while (next) {
      const url = validateManagementUrl(next).toString()
      if (visited.has(url) || visited.size >= 10) throw unavailable('Azure deployment inventory pagination exceeded the supported bound.')
      visited.add(url)
      const response = await request(url, 'https://management.azure.com/.default', { method: 'GET' }, 30_000)
      if (!response.ok) throw unavailable(`Scoped Azure deployment inventory failed (HTTP ${response.status}). Check the API identity's resource-scoped deployment-read role.`)
      const parsed = inventoryPageSchema.safeParse(await response.json())
      if (!parsed.success) throw unavailable('Azure returned an unrecognized deployment inventory response.')
      for (const item of parsed.data.value) {
        if (!deploymentPath || item.id.toLowerCase() !== `${deploymentPath}/${item.name}`.toLowerCase()) {
          throw unavailable('Azure returned a deployment outside the configured account.')
        }
        const capabilities = item.properties.model.format === 'OpenAI'
          ? modelCapabilitiesFor(item.properties.model.name, item.properties.model.version ?? null)
          : modelCapabilitiesFor('unsupported')
        deployments.push({
          id: item.name, deploymentName: item.name, label: item.name, description: '',
          enabled: capabilities.structuredOutputs && item.properties.provisioningState === 'Succeeded',
          modelName: item.properties.model.name, modelVersion: item.properties.model.version ?? null, capabilities,
          verification: 'discovered', verifiedAt: null,
        })
      }
      if (deployments.length > 100) throw unavailable('The configured Azure resource contains more than 100 deployments.')
      next = parsed.data.nextLink
    }
    if (new Set(deployments.map(item => item.deploymentName.toLowerCase())).size !== deployments.length) {
      throw unavailable('Azure returned duplicate deployment identifiers.')
    }
    return { checkedAt, deployments }
  }
  return {
    inventory,
    async test(input) {
      const checkedAt = now().toISOString()
      const result: ModelTestResult = {
        kind: input.kind, status: 'failed', checkedAt, deploymentId: input.deployment.id,
        ...(input.task ? { taskId: input.task.taskId } : {}),
        identity: 'api-managed-identity', workerIdentityVerified: false, checks: [],
      }
      if (input.kind === 'connection') {
        const found = (await inventory()).deployments.find(item => item.deploymentName === input.deployment.deploymentName)
        result.checks.push({
          name: 'resource-scoped-management-read', passed: Boolean(found),
          message: found ? 'The API identity can read this deployment in the fixed Azure resource. No inference or worker identity was tested.' : 'The selected deployment was not found in the configured Azure resource.',
        })
        result.status = found ? 'passed' : 'failed'
        return result
      }
      if (!input.confirmPaidProbe) throw invalidRequest('This explicit synthetic inference probe may incur Azure charges. Confirm the paid probe before continuing.')
      if (!input.deployment.enabled || !input.deployment.capabilities.structuredOutputs) throw invalidRequest('This deployment does not support the required structured-output adapter.')
      if (input.kind === 'task' && !input.task) throw invalidRequest('A task binding is required for a task compatibility probe.')
      if (input.task && (
        (input.task.reasoningEffort !== null && !input.deployment.capabilities.reasoningEfforts.includes(input.task.reasoningEffort)) ||
        (input.task.temperature !== null && !input.deployment.capabilities.temperature) ||
        (input.task.topP !== null && !input.deployment.capabilities.topP) ||
        (input.task.temperature !== null && input.task.topP !== null) ||
        input.task.completionTokenLimit > input.deployment.capabilities.maxOutputTokens
      )) throw invalidRequest('The selected task parameters are unsupported by this Azure deployment.')
      const schema = input.task ? taskProbe(input.task.taskId) : simpleProbe
      const completionTokens = input.task?.completionTokenLimit ?? Math.min(2048, input.deployment.capabilities.maxOutputTokens)
      const requestBody = {
        model: input.deployment.deploymentName,
        messages: [
          { role: 'system', content: 'You are validating a synthetic Score structured-output request, not reviewing private evidence. Return exactly the required schema. Do not invent source text.' },
          { role: 'user', content: input.task
            ? `Test task ${input.task.taskId}. In synthetic-p1, the complete source is: ${SYNTHETIC_EVIDENCE} Return task, supported=true, that exact evidence, and missing=null.`
            : 'Return value="score-structured-output".' },
        ],
        response_format: { type: 'json_schema', json_schema: { name: input.task ? `score_test_${input.task.taskId}` : 'score_connection_test', strict: true, schema: jsonSchema(schema) } },
        max_completion_tokens: completionTokens,
        ...(input.task?.reasoningEffort != null ? { reasoning_effort: input.task.reasoningEffort } : {}),
        ...(input.task?.temperature != null ? { temperature: input.task.temperature } : {}),
        ...(input.task?.topP != null ? { top_p: input.task.topP } : {}),
      }
      const serialized = JSON.stringify(requestBody)
      if (input.task) {
        const size = input.task.inputBudget.unit === 'characters' ? serialized.length : Buffer.byteLength(serialized, 'utf8')
        const sourceSize = input.task.inputBudget.unit === 'characters' ? SYNTHETIC_EVIDENCE.length : Buffer.byteLength(SYNTHETIC_EVIDENCE, 'utf8')
        if (sourceSize > input.task.inputBudget.maxInput || size > input.task.inputBudget.maxRequest ||
          Buffer.byteLength(serialized, 'utf8') + completionTokens + input.task.inputBudget.reservedTokens > input.task.capabilities.contextTokens) {
          throw invalidRequest('The complete synthetic request and completion reserve exceed the selected task budget.')
        }
      }
      const response = await request(`${endpoint.origin}/openai/v1/chat/completions`, 'https://cognitiveservices.azure.com/.default', {
        method: 'POST', body: serialized,
      }, input.settings.ai.requestTimeoutMilliseconds)
      if (!response.ok) {
        result.checks.push({ name: 'inference-request', passed: false, message: `The API identity's synthetic request returned HTTP ${response.status}. No settings were saved and no worker identity was tested.` })
        return result
      }
      const envelope = completionEnvelope.safeParse(await response.json())
      if (!envelope.success) {
        result.checks.push({ name: 'response-envelope', passed: false, message: 'Azure did not return a complete model identity and completion envelope.' })
        return result
      }
      const choice = envelope.data.choices[0]
      result.actualModel = envelope.data.model
      if (choice.finish_reason !== 'stop' || choice.message.refusal || !choice.message.content) {
        result.checks.push({ name: 'complete-structured-output', passed: false, message: 'The model refused, truncated, or omitted the synthetic response.' })
        return result
      }
      let output: unknown
      try { output = JSON.parse(choice.message.content) } catch {
        result.checks.push({ name: 'strict-json', passed: false, message: 'The model response was not valid JSON.' })
        return result
      }
      const valid = schema.safeParse(output).success
      result.status = valid ? 'passed' : 'failed'
      result.checks.push({
        name: input.task ? 'synthetic-task-schema-and-evidence' : 'strict-structured-output', passed: valid,
        message: valid
          ? 'The API identity completed the synthetic schema check with the selected parameters. This is not a production-accuracy test or worker identity certification.'
          : 'The synthetic result failed exact schema/evidence validation. No success was inferred from HTTP status alone.',
      })
      return result
    },
  }
}
