import { execFileSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { AzureCliCredential } from '@azure/identity'

function selectedEnvironment() {
  return process.env.AZURE_ENV_NAME ? ['--environment', process.env.AZURE_ENV_NAME] : []
}

export function environment() {
  const values = parseEnv(execFileSync('azd', ['env', 'get-values', ...selectedEnvironment()], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  process.env.AZURE_ENV_NAME ??= values.AZURE_ENV_NAME
  return { ...process.env, ...values }
}

export function required(env, name) {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}. Run scripts\\deploy.ps1 to initialize this azd environment.`)
  return value
}

export function setEnvironment(name, value) {
  execFileSync('azd', ['env', 'set', name, value, ...selectedEnvironment()], { stdio: ['ignore', 'pipe', 'pipe'] })
}

export function identifier(value, name) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new Error(`${name} must be a directory or subscription GUID.`)
  }
  return value
}

export function client(env) {
  identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  // Data-plane challenges also supply a tenant; Azure CLI rejects combining it with --subscription.
  return new AzureCliCredential({
    tenantId: identifier(required(env, 'AZURE_TENANT_ID'), 'Tenant'),
    processTimeoutInMs: 60000,
  })
}

export async function request(credential, audience, url, method = 'GET', body) {
  const token = await credential.getToken(`${audience}/.default`)
  if (!token) throw new Error(`No Azure credential is available for ${audience}.`)
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    let detail = ''
    try {
      const parsed = JSON.parse(text)
      detail = `${parsed.error?.code ?? ''}: ${parsed.error?.message ?? response.statusText}`
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      detail = response.statusText
    }
    const error = new Error(`${method} ${new URL(url).pathname} failed (${response.status}): ${detail}`)
    error.statusCode = response.status
    throw error
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

export function graph(credential, path, method = 'GET', body) {
  return request(credential, 'https://graph.microsoft.com', `https://graph.microsoft.com/v1.0${path}`, method, body)
}
