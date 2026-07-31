export interface PiOtelConfig {
  enabled: boolean
  captureContent: boolean
  endpoint: string
  tracesEndpoint: string
  metricsEndpoint: string
  logsEndpoint: string
  headers: Record<string, string>
  resourceAttributes: Record<string, string>
  serviceName: string
  serviceVersion: string
  exportIntervalMillis: number
  contentLimit: number
}

function signalEndpoint(signal: "TRACES" | "METRICS" | "LOGS", base: string, env: NodeJS.ProcessEnv) {
  return env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] ?? `${base.replace(/\/$/, "")}/v1/${signal.toLowerCase()}`
}

function keyValues(value: string | undefined, decode = false) {
  if (!value) return {}
  return Object.fromEntries(
    value.split(",").flatMap((entry) => {
      const index = entry.indexOf("=")
      if (index < 1) return []
      const key = entry.slice(0, index).trim()
      const raw = entry.slice(index + 1).trim()
      try {
        return [[decode ? decodeURIComponent(key) : key, decode ? decodeURIComponent(raw) : raw]]
      } catch {
        return []
      }
    }),
  )
}

function truthy(value: string | undefined) {
  return value?.toLowerCase() === "true" || value === "1"
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): PiOtelConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318"
  const enabled = truthy(env.PI_OTEL_ENABLED) || Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT)
  return {
    enabled,
    captureContent: truthy(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) || truthy(env.PI_OTEL_CAPTURE_CONTENT),
    endpoint,
    tracesEndpoint: signalEndpoint("TRACES", endpoint, env),
    metricsEndpoint: signalEndpoint("METRICS", endpoint, env),
    logsEndpoint: signalEndpoint("LOGS", endpoint, env),
    headers: keyValues(env.OTEL_EXPORTER_OTLP_HEADERS),
    resourceAttributes: keyValues(env.OTEL_RESOURCE_ATTRIBUTES, true),
    serviceName: env.OTEL_SERVICE_NAME || "pi",
    serviceVersion: env.PI_OTEL_SERVICE_VERSION || "unknown",
    exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 1000),
    contentLimit: Number(env.PI_OTEL_CONTENT_MAX_LENGTH ?? 61_440),
  }
}
