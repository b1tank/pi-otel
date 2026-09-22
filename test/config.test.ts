import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapSettings, resolveConfig } from "../src/config.js";

describe("settings bootstrap", () => {
  it("creates defaults, preserves unrelated settings, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-otel-config-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "dark" }));
    expect(bootstrapSettings(path)).toBe(true);
    const first = readFileSync(path, "utf8");
    const parsed = JSON.parse(first);
    expect(parsed.theme).toBe("dark");
    expect(parsed["pi-otel"].enabled).toBe(false);
    expect(bootstrapSettings(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("continues with environment configuration when global JSON is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-otel-config-"));
    writeFileSync(join(dir, "settings.json"), "{broken");
    const config = resolveConfig({ PI_CODING_AGENT_DIR: dir, PI_OTEL_ENABLED: "true" });
    expect(config.enabled).toBe(true);
    expect(config.bootstrapWarning).toContain("Could not bootstrap settings");
  });

  it("merges only missing known defaults into an existing block", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-otel-config-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", "pi-otel": { enabled: true, endpoint: "custom", capture: { userPrompts: true } } }));
    chmodSync(path, 0o640);
    expect(bootstrapSettings(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed["pi-otel"].enabled).toBe(true);
    expect(parsed["pi-otel"].endpoint).toBe("custom");
    expect(parsed["pi-otel"].capture.userPrompts).toBe(true);
    expect(parsed["pi-otel"].capture.assistantResponses).toBe(false);
  });

  it("preserves complete existing pi-otel configuration byte-for-byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-otel-config-"));
    const path = join(dir, "settings.json");
    const value = { enabled: true, metricsExporter: "otlp", logsExporter: "otlp", tracesExporter: "otlp", protocol: "http/protobuf", endpoint: "custom", capture: { userPrompts: true, assistantResponses: false, toolDetails: false, toolContent: false, systemInstructions: false, providerPayload: false, providerHeaders: false, observabilityToolContent: false }, contentMaxLength: 16384, metricExportInterval: 1000, logsExportInterval: 5000, exportTimeout: 1000 };
    writeFileSync(path, JSON.stringify({ "pi-otel": value }));
    chmodSync(path, 0o640);
    const before = readFileSync(path, "utf8");
    expect(bootstrapSettings(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

function resolveForTest(env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), "pi-otel-env-"));
  return resolveConfig({ PI_CODING_AGENT_DIR: dir, ...env });
}

describe("resolveConfig", () => {
  it("derives all signal endpoints and enables content capture", () => {
    const config = resolveForTest({
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
    const config = resolveForTest({});
    expect(config.enabled).toBe(false);
    expect(config.captureProviderPayload).toBe(false);
    expect(config.captureProviderHeaders).toBe(false);
    expect(config.exportTimeoutMillis).toBe(1000);
    expect(config.contentLimit).toBe(16_384);
  });

  it("uses global, then project, then environment settings precedence", () => {
    const global = mkdtempSync(join(tmpdir(), "pi-otel-global-"));
    const project = mkdtempSync(join(tmpdir(), "pi-otel-project-"));
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(global, "settings.json"), JSON.stringify({ "pi-otel": { enabled: false, endpoint: "http://global", contentMaxLength: 100 } }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ "pi-otel": { enabled: true, endpoint: "http://project", contentMaxLength: 200 } }));
    const previous = process.cwd();
    try {
      process.chdir(project);
      const config = resolveConfig({ PI_CODING_AGENT_DIR: global, PI_OTEL_ENABLED: "false", PI_OTEL_CONTENT_MAX_LENGTH: "300" });
      expect(config.enabled).toBe(false);
      expect(config.endpoint).toBe("http://project");
      expect(config.contentLimit).toBe(300);
    } finally { process.chdir(previous); }
  });

  it("keeps capture gates independently overridable and aggregate capture excludes provider data", () => {
    const config = resolveForTest({
      PI_OTEL_CAPTURE_CONTENT: "true",
      OTEL_LOG_USER_PROMPTS: "false",
      PI_OTEL_CAPTURE_PROVIDER_PAYLOAD: "false",
    });
    expect(config.capture?.userPrompts).toBe(false);
    expect(config.capture?.assistantResponses).toBe(true);
    expect(config.capture?.toolDetails).toBe(true);
    expect(config.capture?.toolContent).toBe(true);
    expect(config.capture?.systemInstructions).toBe(true);
    expect(config.capture?.providerPayload).toBe(false);
    expect(config.capture?.providerHeaders).toBe(false);
    expect(config.capture?.observabilityToolContent).toBe(false);
  });

  it("applies signal-specific endpoints and merges signal headers over generic values", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-otel-signals-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ "pi-otel": {
      enabled: true,
      endpoint: "http://settings:4318",
      tracesEndpoint: "http://trace-settings/v1/traces",
      headers: { shared: "settings", only_settings: "yes" },
      tracesHeaders: { shared: "trace-settings" },
    } }));
    const config = resolveForTest({
      PI_CODING_AGENT_DIR: dir,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318/",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://trace-env/v1/custom",
      OTEL_EXPORTER_OTLP_HEADERS: "shared=generic%20env,generic=yes",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "shared=signal%20env",
    });
    expect(config.tracesEndpoint).toBe("http://trace-env/v1/custom");
    expect(config.metricsEndpoint).toBe("http://env:4318/v1/metrics");
    expect(config.tracesHeaders).toEqual({ shared: "signal env", only_settings: "yes", generic: "yes" });
    expect(config.logsHeaders?.shared).toBe("generic env");
  });

  it("disables only invalid or unsupported signals", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const config = resolveForTest({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "file:///tmp/metrics",
        OTEL_TRACES_EXPORTER: "unsupported",
      });
      expect(config.metricsExporter).toBe("none");
      expect(config.tracesExporter).toBe("none");
      expect(config.logsExporter).toBe("otlp");
    } finally { console.warn = warn; }
  });

});
