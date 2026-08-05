import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("derives all signal endpoints and enables content capture", () => {
    const config = resolveConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4319/",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
      PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT: "true",
      PI_OTEL_CAPTURE_PROVIDER_PAYLOAD: "true",
      PI_OTEL_CAPTURE_PROVIDER_HEADERS: "true",
      OTEL_RESOURCE_ATTRIBUTES: "team=agents,encoded=hello%20world",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
    });
    expect(config.enabled).toBe(true);
    expect(config.captureContent).toBe(true);
    expect(config.captureObservabilityToolContent).toBe(true);
    expect(config.captureProviderPayload).toBe(true);
    expect(config.captureProviderHeaders).toBe(true);
    expect(config.tracesEndpoint).toBe("http://localhost:4319/v1/traces");
    expect(config.metricsEndpoint).toBe("http://localhost:4319/v1/metrics");
    expect(config.logsEndpoint).toBe("http://localhost:4319/v1/logs");
    expect(config.exportTimeoutMillis).toBe(2500);
    expect(config.resourceAttributes).toEqual({
      team: "agents",
      encoded: "hello world",
    });
  });

  it("stays disabled without explicit enablement or an endpoint", () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(false);
    expect(config.captureProviderPayload).toBe(false);
    expect(config.captureProviderHeaders).toBe(false);
    expect(config.exportTimeoutMillis).toBe(1000);
    expect(config.contentLimit).toBe(16_384);
  });

  it("falls back from invalid numeric settings", () => {
    const config = resolveConfig({
      PI_OTEL_ENABLED: "true",
      OTEL_METRIC_EXPORT_INTERVAL: "NaN",
      OTEL_EXPORTER_OTLP_TIMEOUT: "0",
      PI_OTEL_CONTENT_MAX_LENGTH: "-1",
    });
    expect(config.exportIntervalMillis).toBe(1000);
    expect(config.exportTimeoutMillis).toBe(1000);
    expect(config.contentLimit).toBe(16_384);
  });
});
