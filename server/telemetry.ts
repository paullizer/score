import { isMainThread } from 'node:worker_threads'
import { initializeTelemetry } from './telemetry-runtime'

if (isMainThread) {
  const telemetry = await initializeTelemetry()
  process.once('beforeExit', () => { void telemetry.shutdown() })
}
