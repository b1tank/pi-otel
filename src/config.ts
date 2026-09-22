import { readFileSync, renameSync, mkdirSync, writeFileSync, statSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CaptureConfig {
  userPrompts: boolean;
  assistantResponses: boolean;
  toolDetails: boolean;
  toolContent: boolean;
  systemInstructions: boolean;
  providerPayload: boolean;
  providerHeaders: boolean;
  observabilityToolContent: boolean;
}

export interface PiOtelConfig {
  enabled: boolean;
  bootstrapCreated?: boolean;
  bootstrapWarning?: string;
  metricsExporter?: string;
  logsExporter?: string;
  tracesExporter?: string;
  protocol?: string;
  captureContent: boolean;
  capture?: CaptureConfig;
  captureObservabilityToolContent: boolean;
  captureProviderPayload: boolean;
  captureProviderHeaders: boolean;
  captureUserPrompts?: boolean;
  captureAssistantResponses?: boolean;
  captureToolDetails?: boolean;
  captureToolContent?: boolean;
  captureSystemInstructions?: boolean;
  endpoint: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  logsEndpoint: string;
  headers: Record<string, string>;
  tracesHeaders?: Record<string, string>;
  metricsHeaders?: Record<string, string>;
  logsHeaders?: Record<string, string>;
  resourceAttributes: Record<string, string>;
  serviceName: string;
  serviceVersion: string;
  exportIntervalMillis: number;
  logsExportIntervalMillis?: number;
  exportTimeoutMillis: number;
  contentLimit: number;
}

const DEFAULTS = {
  enabled: false, metricsExporter: "otlp", logsExporter: "otlp", tracesExporter: "otlp",
  protocol: "http/protobuf", endpoint: "http://localhost:4318",
  capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false,
    systemInstructions: false, providerPayload: false, providerHeaders: false, observabilityToolContent: false },
  contentMaxLength: 16384, metricExportInterval: 1000, logsExportInterval: 5000, exportTimeout: 1000,
};

function settingsPath() {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
}

/** Bootstrap only the global file; project settings are deliberately never created. */
function mergeMissingDefaults(current: Record<string, unknown>, defaults: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    const existing = current[key];
    if (existing === undefined) {
      current[key] = value;
      changed = true;
    } else if (value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)) {
      changed = mergeMissingDefaults(existing as Record<string, unknown>, value as Record<string, unknown>) || changed;
    }
  }
  return changed;
}

export function bootstrapSettings(path = settingsPath(), onWarning: (message: string) => void = (message) => console.warn(`[pi-otel] ${message}`)): boolean {
  try {
    let text: string | undefined;
    try { text = readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const settings = text ? JSON.parse(text) as Record<string, unknown> : {};
    const existing = settings["pi-otel"];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      if (!mergeMissingDefaults(existing as Record<string, unknown>, DEFAULTS)) return false;
    } else if (Object.prototype.hasOwnProperty.call(settings, "pi-otel")) {
      return false;
    } else {
      settings["pi-otel"] = DEFAULTS;
    }
    mkdirSync(dirname(path), { recursive: true });
    const mode = (() => {
      try { return statSync(path).mode & 0o777; } catch { return 0o600; }
    })();
    const temporary = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
      chmodSync(temporary, mode);
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    return true;
  } catch (error) {
    onWarning(`Could not bootstrap settings: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
function truthy(value: unknown) { return String(value).toLowerCase() === "true" || value === "1"; }
function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function keyValues(value: string | undefined, decode = false) {
  if (!value) return {};
  return Object.fromEntries(value.split(",").flatMap(entry => {
    const index = entry.indexOf("="); if (index < 1) return [];
    try { return [[decode ? decodeURIComponent(entry.slice(0, index).trim()) : entry.slice(0, index).trim(), decode ? decodeURIComponent(entry.slice(index + 1).trim()) : entry.slice(index + 1).trim()]]; } catch { return []; }
  }));
}
function signalEndpoint(signal: "TRACES" | "METRICS" | "LOGS", base: string, env: NodeJS.ProcessEnv, settings: Record<string, unknown>) {
  return env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] || (settings[`${signal.toLowerCase()}Endpoint`] as string | undefined) || `${base.replace(/\/$/, "")}/v1/${signal.toLowerCase()}`;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): PiOtelConfig {
  const path = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
  let bootstrapWarning: string | undefined;
  const created = bootstrapSettings(path, (message) => { bootstrapWarning = message; });
  const global = readSettings(path)["pi-otel"];
  const project = readSettings(join(process.cwd(), ".pi", "settings.json"))["pi-otel"];
  const file = { ...DEFAULTS, ...(global && typeof global === "object" ? global : {}), ...(project && typeof project === "object" ? project : {}) } as Record<string, any>;
  const captureFile = { ...DEFAULTS.capture, ...(file.capture && typeof file.capture === "object" ? file.capture : {}) } as Record<string, unknown>;
  const get = (name: string, envName: string, fallback: unknown) => env[envName] ?? file[name] ?? fallback;
  const aggregate = truthy(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) || truthy(env.PI_OTEL_CAPTURE_CONTENT) || truthy(file.captureContent);
  const capture: CaptureConfig = {
    userPrompts: truthy(get("userPrompts", "OTEL_LOG_USER_PROMPTS", captureFile.userPrompts)) || aggregate,
    assistantResponses: truthy(get("assistantResponses", "OTEL_LOG_ASSISTANT_RESPONSES", captureFile.assistantResponses)) || aggregate,
    toolDetails: truthy(get("toolDetails", "OTEL_LOG_TOOL_DETAILS", captureFile.toolDetails)) || aggregate,
    toolContent: truthy(get("toolContent", "OTEL_LOG_TOOL_CONTENT", captureFile.toolContent)) || aggregate,
    systemInstructions: truthy(get("systemInstructions", "PI_OTEL_CAPTURE_SYSTEM_INSTRUCTIONS", captureFile.systemInstructions)) || aggregate,
    providerPayload: truthy(get("providerPayload", "PI_OTEL_CAPTURE_PROVIDER_PAYLOAD", captureFile.providerPayload)),
    providerHeaders: truthy(get("providerHeaders", "PI_OTEL_CAPTURE_PROVIDER_HEADERS", captureFile.providerHeaders)),
    observabilityToolContent: truthy(get("observabilityToolContent", "PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT", captureFile.observabilityToolContent)),
  };
  const endpoint = String(get("endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT", DEFAULTS.endpoint));
  const record = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  };
  const headers = { ...record(file.headers), ...keyValues(env.OTEL_EXPORTER_OTLP_HEADERS) };
  const signalHeaders = (signal: "TRACES" | "METRICS" | "LOGS") => ({
    ...headers,
    ...keyValues(env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`]),
  });
  const protocol = String(get("protocol", "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"));
  const exporter = (value: string, signal: string) => {
    if (protocol !== "http/protobuf") {
      console.warn(`[pi-otel] Unsupported OTLP protocol '${protocol}'; disabling ${signal}`);
      return "none";
    }
    if (value === "otlp" || value === "none") return value;
    console.warn(`[pi-otel] Unsupported ${signal} exporter '${value}'; disabling ${signal}`);
    return "none";
  };
  const enabled = env.PI_OTEL_ENABLED !== undefined ? truthy(env.PI_OTEL_ENABLED) : (truthy(file.enabled) || Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT));
  return {
    enabled, bootstrapCreated: created, bootstrapWarning,
    metricsExporter: exporter(String(get("metricsExporter", "OTEL_METRICS_EXPORTER", "otlp")), "metrics"), logsExporter: exporter(String(get("logsExporter", "OTEL_LOGS_EXPORTER", "otlp")), "logs"), tracesExporter: exporter(String(get("tracesExporter", "OTEL_TRACES_EXPORTER", "otlp")), "traces"), protocol,
    captureContent: aggregate, capture, captureObservabilityToolContent: capture.observabilityToolContent, captureProviderPayload: capture.providerPayload, captureProviderHeaders: capture.providerHeaders,
    endpoint, tracesEndpoint: signalEndpoint("TRACES", endpoint, env, file), metricsEndpoint: signalEndpoint("METRICS", endpoint, env, file), logsEndpoint: signalEndpoint("LOGS", endpoint, env, file), headers, tracesHeaders: signalHeaders("TRACES"), metricsHeaders: signalHeaders("METRICS"), logsHeaders: signalHeaders("LOGS"),
    resourceAttributes: { ...record(file.resourceAttributes), ...keyValues(env.OTEL_RESOURCE_ATTRIBUTES, true) }, serviceName: env.OTEL_SERVICE_NAME || String(file.serviceName || "pi"), serviceVersion: env.PI_OTEL_SERVICE_VERSION || String(file.serviceVersion || "unknown"),
    exportIntervalMillis: positiveNumber(get("metricExportInterval", "OTEL_METRIC_EXPORT_INTERVAL", 1000), 1000), logsExportIntervalMillis: positiveNumber(get("logsExportInterval", "OTEL_LOGS_EXPORT_INTERVAL", 5000), 5000), exportTimeoutMillis: positiveNumber(get("exportTimeout", "OTEL_EXPORTER_OTLP_TIMEOUT", 1000), 1000), contentLimit: positiveNumber(get("contentMaxLength", "PI_OTEL_CONTENT_MAX_LENGTH", 16384), 16384),
  };
}
