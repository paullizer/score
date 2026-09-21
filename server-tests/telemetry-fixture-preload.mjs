import { createHttpHeaders } from '@azure/core-rest-pipeline'
import { initializeTelemetry as initialize } from '../server/telemetry-runtime.ts'

export function initializeTelemetry() {
  return initialize({
    samplingRatio: process.env.SCORE_TELEMETRY_FIXTURE_SAMPLING === 'partial' ? 0.25 : 1,
    shutdownTimeoutMs: process.env.SCORE_TELEMETRY_FIXTURE_MODE === 'hang' ? 100 : undefined,
    transport: {
      async sendRequest(request) {
        const envelopes = JSON.parse(request.body)
        process.send?.({ type: 'export', envelopes })
        if (process.env.SCORE_TELEMETRY_FIXTURE_MODE === 'fail') throw new Error('PRIVATE-SENTINEL-export-error-token')
        if (process.env.SCORE_TELEMETRY_FIXTURE_MODE === 'hang') return new Promise(() => {})
        return {
          request, status: 200, headers: createHttpHeaders(),
          bodyAsText: JSON.stringify({ itemsReceived: envelopes.length, itemsAccepted: envelopes.length, errors: [] }),
        }
      },
    },
  })
}
