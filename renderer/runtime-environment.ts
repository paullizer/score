import { assertCredentialFreeEnvironment, credentialEnvironmentNames } from './app'

const BROKER_VARIABLES = new Set(['IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET'])
type Probe = typeof fetch

export async function prepareCredentialFreeRuntime(env: NodeJS.ProcessEnv, probe: Probe = fetch): Promise<void> {
  const names = credentialEnvironmentNames(env)
  if (!names.length) return
  if (names.some((name) => !BROKER_VARIABLES.has(name))) assertCredentialFreeEnvironment(env)
  const clientId = env.RENDERER_PULL_CLIENT_ID
  if (!clientId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(clientId)) {
    throw new Error('The runtime-disabled registry identity must be identified for the isolation check.')
  }
  if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER) throw new Error('The managed-identity broker contract is incomplete.')
  const endpoint = new URL(env.IDENTITY_ENDPOINT)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username || endpoint.password) throw new Error('The identity isolation probe must stay on loopback.')
  if (env.MSI_ENDPOINT && new URL(env.MSI_ENDPOINT).origin !== endpoint.origin) {
    throw new Error('The legacy identity broker does not match the isolated loopback broker.')
  }
  endpoint.searchParams.set('api-version', '2019-08-01')
  endpoint.searchParams.set('resource', 'https://management.azure.com/')
  endpoint.searchParams.set('client_id', clientId)
  const response = await probe(endpoint, {
    headers: { 'X-IDENTITY-HEADER': env.IDENTITY_HEADER },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  const body = await response.text()
  if (response.ok || /"access_token"\s*:/.test(body)) {
    throw new Error('Renderer isolation failed: a managed-identity token is available to application code.')
  }
  if (![400, 403, 404].includes(response.status) ||
    !/(not (?:available|assigned|found|allowed)|unavailable|identity_not|identitynot|lifecycle|no .*identity)/i.test(body)) {
    throw new Error(`The identity broker did not confirm runtime isolation (HTTP ${response.status}).`)
  }
  // ACA can inject broker variables even for lifecycle=None. Only discard them after proving that
  // the sole attached, AcrPull-only identity cannot issue a token to this container.
  for (const name of BROKER_VARIABLES) delete env[name]
  assertCredentialFreeEnvironment(env)
}
