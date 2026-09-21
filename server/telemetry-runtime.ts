import { diag, DiagLogLevel, metrics, SpanStatusCode } from '@opentelemetry/api'
import type { HttpClient } from '@azure/core-rest-pipeline'
import type { HttpInstrumentationConfig } from '@opentelemetry/instrumentation-http'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import { createPrivacyTransport, sanitizeMetricAttributes, telemetryMetricAttributeKeys } from './telemetry-export'
import { registerTelemetryLifecycle, type TelemetryLifecycle, type TelemetryShutdownResult } from './telemetry-lifecycle'
import { PrivacySpanProcessor } from './telemetry-spans'
import { TELEMETRY_ROLE, TELEMETRY_SCOPE } from './telemetry-schema'
import { createTelemetryWarnings, type TelemetryWarning } from './telemetry-warnings'

const DEFAULT_SAMPLING_RATIO = 0.25
const SHUTDOWN_TIMEOUT_MS = 3_000
const DEFAULT_INGESTION_ENDPOINT = 'https://dc.services.visualstudio.com'

interface TelemetryConfiguration {
  readonly connectionString: string
  readonly instrumentationKey: string
}

export class TelemetryConfigurationError extends Error {
  constructor() {
    super('Score telemetry configuration is invalid. Check APPLICATIONINSIGHTS_CONNECTION_STRING.')
    this.name = 'TelemetryConfigurationError'
  }
}

export function readTelemetryConfiguration(value: string | undefined): TelemetryConfiguration | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const values = new Map<string, string>()
  for (const part of value.trim().split(';').filter(Boolean)) {
    const separator = part.indexOf('=')
    if (separator <= 0) throw new TelemetryConfigurationError()
    const key = part.slice(0, separator).trim().toLowerCase()
    if (values.has(key) || !['instrumentationkey', 'ingestionendpoint', 'liveendpoint', 'applicationid'].includes(key)) {
      throw new TelemetryConfigurationError()
    }
    values.set(key, part.slice(separator + 1).trim())
  }
  const instrumentationKey = values.get('instrumentationkey')
  if (!instrumentationKey || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(instrumentationKey)) {
    throw new TelemetryConfigurationError()
  }
  let endpoint: URL
  try {
    endpoint = new URL(values.get('ingestionendpoint') ?? DEFAULT_INGESTION_ENDPOINT)
  } catch {
    throw new TelemetryConfigurationError()
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '') || endpoint.port ||
    !(endpoint.hostname === 'dc.services.visualstudio.com' || endpoint.hostname.endsWith('.in.applicationinsights.azure.com'))) {
    throw new TelemetryConfigurationError()
  }
  return {
    instrumentationKey: instrumentationKey.toLowerCase(),
    connectionString: `InstrumentationKey=${instrumentationKey.toLowerCase()};IngestionEndpoint=${endpoint.origin}`,
  }
}

function restrictSdkEnvironment(samplingRatio: number, warn: (code: TelemetryWarning) => void): void {
  if (process.env.APPLICATIONINSIGHTS_CONFIGURATION_CONTENT || process.env.APPLICATIONINSIGHTS_CONFIGURATION_FILE) {
    warn('configuration_override_ignored')
  }
  // The distro otherwise lets JSON/environment settings re-enable collectors after programmatic options.
  Object.assign(process.env, {
    APPLICATIONINSIGHTS_CONFIGURATION_CONTENT: '{}',
    APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
    APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
    APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL: 'NONE',
    APPLICATIONINSIGHTS_LOG_DESTINATION: 'console',
    OTEL_LOG_LEVEL: 'NONE',
    OTEL_SDK_DISABLED: 'false',
    OTEL_NODE_RESOURCE_DETECTORS: 'none',
    OTEL_PROPAGATORS: 'tracecontext',
    OTEL_TRACES_SAMPLER: 'microsoft.fixed_percentage',
    OTEL_TRACES_SAMPLER_ARG: String(samplingRatio),
    OTEL_BSP_MAX_QUEUE_SIZE: '1024',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '128',
    OTEL_BSP_SCHEDULE_DELAY: '5000',
    OTEL_BSP_EXPORT_TIMEOUT: '2500',
    OTEL_BLRP_MAX_QUEUE_SIZE: '128',
    OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: '64',
    OTEL_BLRP_SCHEDULE_DELAY: '5000',
    OTEL_BLRP_EXPORT_TIMEOUT: '2500',
    OTEL_METRIC_EXPORT_INTERVAL: '60000',
    OTEL_METRIC_EXPORT_TIMEOUT: '2500',
    OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '32',
    OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '256',
    OTEL_SPAN_EVENT_COUNT_LIMIT: '2',
    OTEL_SPAN_LINK_COUNT_LIMIT: '0',
    OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT: '4',
  })
}

export interface TelemetryRuntimeOptions {
  readonly connectionString?: string
  /** Programmatic seam for a local test exporter; production always uses the Azure HTTP client. */
  readonly transport?: HttpClient
  readonly samplingRatio?: number
  readonly shutdownTimeoutMs?: number
  readonly warningSink?: (code: TelemetryWarning) => void
}

export async function initializeTelemetry(options: TelemetryRuntimeOptions = {}): Promise<TelemetryLifecycle> {
  const warn = createTelemetryWarnings(options.warningSink)
  let configuration: TelemetryConfiguration | undefined
  try {
    configuration = readTelemetryConfiguration(options.connectionString ?? process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
  } catch {
    warn('configuration_invalid')
    throw new TelemetryConfigurationError()
  }
  if (!configuration) {
    const disabled: TelemetryLifecycle = { enabled: false, shutdown: () => Promise.resolve('disabled') }
    registerTelemetryLifecycle(disabled)
    console.info('[score.telemetry] disabled: no connection string configured')
    return disabled
  }
  const samplingRatio = options.samplingRatio ?? DEFAULT_SAMPLING_RATIO
  if (!Number.isFinite(samplingRatio) || samplingRatio <= 0 || samplingRatio > 1) {
    warn('configuration_invalid')
    throw new TelemetryConfigurationError()
  }
  restrictSdkEnvironment(samplingRatio, warn)

  try {
    const [{ useAzureMonitor: initializeAzureMonitor, shutdownAzureMonitor }, { resourceFromAttributes }, metricSdk, pipeline, azureLogger] = await Promise.all([
      import('@azure/monitor-opentelemetry'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-metrics'),
      import('@azure/core-rest-pipeline'),
      import('@azure/logger'),
    ])
    const transport = createPrivacyTransport(options.transport ?? pipeline.createDefaultHttpClient(), configuration.instrumentationKey, warn)
    const httpOptions: HttpInstrumentationConfig = {
      enabled: true,
      requireParentforOutgoingSpans: true,
      headersToSpanAttributes: { client: { requestHeaders: [], responseHeaders: [] }, server: { requestHeaders: [], responseHeaders: [] } },
      applyCustomAttributesOnSpan: (span, _request, response) => {
        if (response && 'writableFinished' in response && response.writableFinished === false) {
          span.setAttributes({ 'http.status_code': 499, 'http.response.status_code': 499, 'score.error.category': 'cancelled' })
          span.setStatus({ code: SpanStatusCode.ERROR })
        }
      },
    }
    initializeAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: configuration.connectionString,
        disableOfflineStorage: true,
        httpClient: transport.client,
        retryOptions: { maxRetries: 0 },
      },
      samplingRatio,
      tracesPerSecond: 0,
      enableLiveMetrics: false,
      enableStandardMetrics: false,
      enablePerformanceCounters: false,
      enableTraceBasedSamplingForLogs: true,
      browserSdkLoaderOptions: { enabled: false, connectionString: '' },
      instrumentationOptions: {
        http: httpOptions,
        azureSdk: { enabled: true },
        mongoDb: { enabled: false }, mySql: { enabled: false }, postgreSql: { enabled: false },
        redis: { enabled: false }, redis4: { enabled: false }, bunyan: { enabled: false },
        winston: { enabled: false }, console: { enabled: false },
      },
      resource: resourceFromAttributes({ 'service.name': TELEMETRY_ROLE, 'service.instance.id': TELEMETRY_ROLE }),
      spanProcessors: [new PrivacySpanProcessor()],
      views: [
        { instrumentName: '*', aggregation: { type: metricSdk.AggregationType.DROP } },
        // Distinct output names avoid merging the allowlisted streams with the catch-all DROP stream.
        ...['http.request.count', 'http.request.duration', 'operation.count', 'operation.duration'].map((name) => ({
          meterName: TELEMETRY_SCOPE, instrumentName: `score.api.${name}`, name: `score.${name}`, aggregationCardinalityLimit: 256,
          attributesProcessors: [
            metricSdk.createAllowListAttributesProcessor(telemetryMetricAttributeKeys),
            { process: sanitizeMetricAttributes },
          ],
        })),
      ],
    })

    // SDK diagnostics can include connection strings and raw exporter errors. Emit bounded categories only.
    azureLogger.setLogLevel(undefined)
    azureLogger.AzureLogger.log = () => warn('sdk_warning')
    diag.setLogger({
      error: () => warn('sdk_error'), warn: () => warn('sdk_warning'),
      info: () => {}, debug: () => {}, verbose: () => {},
    }, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true })

    let shutdownPromise: Promise<TelemetryShutdownResult> | undefined
    const meterProvider = metrics.getMeterProvider() as MeterProvider
    const lifecycle: TelemetryLifecycle = {
      enabled: true,
      shutdown: () => {
        shutdownPromise ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const timeout = new Promise<TelemetryShutdownResult>((resolve) => {
              timer = setTimeout(() => {
                warn('shutdown_timeout')
                resolve('timed_out')
              }, Math.max(1, Math.min(options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS)))
            })
            const shutdown = (async (): Promise<TelemetryShutdownResult> => {
              let failed = false
              try {
                await meterProvider.forceFlush()
              } catch {
                failed = true
                warn('shutdown_failed')
              }
              try {
                await shutdownAzureMonitor()
              } catch {
                failed = true
                warn('shutdown_failed')
              }
              return failed || transport.failed() ? 'failed' : 'flushed'
            })()
            return await Promise.race([shutdown, timeout])
          } finally {
            if (timer) clearTimeout(timer)
            transport.close()
          }
        })()
        return shutdownPromise
      },
    }
    registerTelemetryLifecycle(lifecycle)
    return lifecycle
  } catch {
    warn('startup_failed')
    throw new Error('Score telemetry startup failed.')
  }
}
