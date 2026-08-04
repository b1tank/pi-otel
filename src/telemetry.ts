import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { PiOtelConfig } from "./config.js"

const SCOPE = "pi.otel"
const SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0"

export type LogSeverity = "INFO" | "WARN" | "ERROR"

const LOG_SEVERITY = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
} satisfies Record<LogSeverity, SeverityNumber>

export type Operation = {
  span: Span
  context: Context
  startedAt: number
}

export class Telemetry {
  readonly config: PiOtelConfig
  private readonly tracerProvider: BasicTracerProvider
  private readonly meterProvider: MeterProvider
  private readonly loggerProvider: LoggerProvider
  private readonly tracer
  private readonly meter
  private readonly logger
  private readonly counters = new Map<string, ReturnType<typeof this.meter.createCounter>>()
  private readonly histograms = new Map<string, ReturnType<typeof this.meter.createHistogram>>()
  private closed = false

  constructor(config: PiOtelConfig, instrumentationVersion = config.serviceVersion) {
    this.config = config
    const resource = resourceFromAttributes({
      ...config.resourceAttributes,
      "service.name": config.serviceName,
      "service.version": config.serviceVersion,
      "telemetry.sdk.language": "nodejs",
      "pi.otel.version": instrumentationVersion,
      "pi.otel.capture_content": config.captureContent,
    })
    const exporterOptions = (url: string) => ({ url, headers: config.headers })

    this.tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(exporterOptions(config.tracesEndpoint)), {
        scheduledDelayMillis: 500,
      })],
    })
    this.tracer = this.tracerProvider.getTracer(SCOPE, instrumentationVersion, { schemaUrl: SCHEMA_URL })

    this.meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(exporterOptions(config.metricsEndpoint)),
        exportIntervalMillis: config.exportIntervalMillis,
      })],
    })
    this.meter = this.meterProvider.getMeter(SCOPE, instrumentationVersion, { schemaUrl: SCHEMA_URL })

    this.loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(exporterOptions(config.logsEndpoint)),
        scheduledDelayMillis: 500,
      })],
    })
    this.logger = this.loggerProvider.getLogger(SCOPE, instrumentationVersion, { schemaUrl: SCHEMA_URL })
  }

  start(name: string, kind: SpanKind, attributes: Attributes, parent?: Operation): Operation {
    const parentContext = parent?.context ?? context.active()
    const span = this.tracer.startSpan(name, { kind, attributes }, parentContext)
    return { span, context: trace.setSpan(parentContext, span), startedAt: performance.now() }
  }

  end(operation: Operation | undefined, attributes: Attributes = {}, error?: unknown) {
    if (!operation) return
    operation.span.setAttributes(attributes)
    if (error) {
      operation.span.recordException(error instanceof Error ? error : new Error(String(error)))
      operation.span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
    }
    operation.span.end()
  }

  event(
    name: string,
    attributes: Attributes = {},
    operation?: Operation,
    severity: LogSeverity = "INFO",
  ) {
    operation?.span.addEvent(name, attributes)
    this.logger.emit({
      eventName: name,
      severityNumber: LOG_SEVERITY[severity],
      severityText: severity,
      body: name,
      attributes: { "event.name": name, ...attributes },
      context: operation?.context,
      timestamp: new Date(),
    })
  }

  error(name: string, error: unknown, attributes: Attributes = {}, operation?: Operation) {
    const value = error instanceof Error ? error : new Error(String(error))
    operation?.span.recordException(value)
    this.logger.emit({
      eventName: name,
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: value.message,
      attributes: {
        "event.name": name,
        "error.type": value.name,
        "exception.message": value.message,
        ...(value.stack ? { "exception.stacktrace": value.stack } : {}),
        ...attributes,
      },
      context: operation?.context,
      timestamp: new Date(),
    })
  }

  count(name: string, value = 1, attributes: Attributes = {}) {
    let instrument = this.counters.get(name)
    if (!instrument) {
      instrument = this.meter.createCounter(name)
      this.counters.set(name, instrument)
    }
    instrument.add(value, attributes)
  }

  histogram(name: string, value: number, unit: string, attributes: Attributes = {}) {
    if (!Number.isFinite(value)) return
    const key = `${name}\0${unit}`
    let instrument = this.histograms.get(key)
    if (!instrument) {
      instrument = this.meter.createHistogram(name, { unit })
      this.histograms.set(key, instrument)
    }
    instrument.record(value, attributes)
  }

  content(value: unknown) {
    if (!this.config.captureContent) return "[REDACTED]"
    let text: string
    try {
      const serialized = typeof value === "string" ? value : JSON.stringify(value)
      text = serialized ?? String(value)
    } catch {
      text = String(value)
    }
    if (text.length <= this.config.contentLimit) return text
    return `${text.slice(0, Math.max(0, this.config.contentLimit - 24))}[TRUNCATED BY PI-OTEL]`
  }

  async flush() {
    await Promise.allSettled([
      this.tracerProvider.forceFlush(),
      this.meterProvider.forceFlush(),
      this.loggerProvider.forceFlush(),
    ])
  }

  async shutdown() {
    if (this.closed) return
    this.closed = true
    await this.flush()
    await Promise.allSettled([
      this.tracerProvider.shutdown(),
      this.meterProvider.shutdown(),
      this.loggerProvider.shutdown(),
    ])
  }
}

export { SpanKind }
