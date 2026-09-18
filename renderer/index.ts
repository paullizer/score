import process from 'node:process'
import { createRendererApp, assertCredentialFreeEnvironment, credentialEnvironmentNames } from './app'
import { safePublicFetch } from '../worker/public-http'
import { prepareCredentialFreeRuntime } from './runtime-environment'

const DEFAULT_PORT = 8080

function readPort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort === '') return DEFAULT_PORT
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }
  return port
}

async function main(): Promise<void> {
  try {
    await prepareCredentialFreeRuntime(process.env)
    assertCredentialFreeEnvironment(process.env)
    const port = readPort(process.env.PORT)
    const app = createRendererApp({ fetcher: safePublicFetch })
    app.listen(port, '0.0.0.0', () => {
      console.log(JSON.stringify({ event: 'renderer_listening', port }))
    })
  } catch (error) {
    console.error(JSON.stringify({
      event: 'renderer_startup_failed',
      code: 'invalid_configuration',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      credentialVariableNames: credentialEnvironmentNames(process.env),
    }))
    process.exitCode = 1
  }
}

void main()
