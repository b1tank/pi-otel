import { describe, expect, it } from "vitest"
import { resolveConfig } from "../src/config.js"

describe("resolveConfig", () => {
  it("derives all signal endpoints and enables content capture", () => {
    const config = resolveConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4319/",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
      OTEL_RESOURCE_ATTRIBUTES: "team=agents,encoded=hello%20world",
    })
    expect(config.enabled).toBe(true)
    expect(config.captureContent).toBe(true)
    expect(config.tracesEndpoint).toBe("http://localhost:4319/v1/traces")
    expect(config.metricsEndpoint).toBe("http://localhost:4319/v1/metrics")
    expect(config.logsEndpoint).toBe("http://localhost:4319/v1/logs")
    expect(config.resourceAttributes).toEqual({ team: "agents", encoded: "hello world" })
  })

  it("stays disabled without explicit enablement or an endpoint", () => {
    expect(resolveConfig({}).enabled).toBe(false)
  })
})
