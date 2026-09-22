# pi-otel Configuration Plan

## Goal

Make `pi-otel` easy to install and configure while aligning its environment-variable interface with Claude Code and OpenTelemetry conventions.

On first use, the extension should create a default `pi-otel` configuration block in Pi's global settings file. Existing configuration must be preserved during upgrades.

## Configuration sources and precedence

Resolve configuration in this order, with later sources overriding earlier sources:

1. Built-in defaults
2. Global Pi settings: `~/.pi/agent/settings.json`
3. Project Pi settings: `.pi/settings.json`
4. Environment variables

Environment variables must always be able to override settings-file values for CI, temporary capture, and deployment-specific configuration.

## Settings schema

Use a namespaced top-level `pi-otel` object so Pi's own settings remain unaffected:

```json
{
  "pi-otel": {
    "enabled": false,
    "metricsExporter": "otlp",
    "logsExporter": "otlp",
    "tracesExporter": "otlp",
    "protocol": "http/protobuf",
    "endpoint": "http://localhost:4318",
    "capture": {
      "userPrompts": false,
      "assistantResponses": false,
      "toolDetails": false,
      "toolContent": false,
      "systemInstructions": false,
      "providerPayload": false,
      "providerHeaders": false,
      "observabilityToolContent": false
    },
    "contentMaxLength": 16384,
    "metricExportInterval": 1000,
    "logsExportInterval": 5000,
    "exportTimeout": 1000
  }
}
```

The settings block should be documented as optional. The safest default is telemetry disabled and content redacted.

## First-use settings bootstrap

Pi package installation does not provide a package post-install configuration hook. The extension should therefore perform an idempotent bootstrap on first load or first session startup.

### Bootstrap behavior

- Locate the global settings file using `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent/settings.json`.
- Create the parent directory and settings file if they do not exist.
- If the file is valid JSON and has no `pi-otel` key, add the complete default block.
- If `pi-otel` already exists, do not replace, reset, or reformat it.
- If a future schema migration is required, migrate only known missing keys and preserve all user values.
- Never write API keys, OTLP headers, or other secrets into settings.
- Write atomically using a temporary file and rename.
- Preserve file permissions; newly created settings should be user-readable/writable only where practical.
- If the file is malformed or cannot be written, emit a non-fatal warning and continue using environment variables/defaults. Telemetry must never prevent Pi from starting.

### Upgrade safety

Use a small internal schema/version marker only if migration becomes necessary. Do not use package version as the settings schema version. An upgrade from an older extension must retain every existing `pi-otel` value.

Project settings should not be auto-created by the extension. Project settings are explicit user/team configuration and require trust-aware handling.

## Environment variable interface

Prefer standard OpenTelemetry variable names:

```text
PI_OTEL_ENABLED
OTEL_METRICS_EXPORTER
OTEL_LOGS_EXPORTER
OTEL_TRACES_EXPORTER
OTEL_EXPORTER_OTLP_PROTOCOL
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
OTEL_EXPORTER_OTLP_HEADERS
OTEL_EXPORTER_OTLP_METRICS_HEADERS
OTEL_EXPORTER_OTLP_LOGS_HEADERS
OTEL_EXPORTER_OTLP_TRACES_HEADERS
OTEL_METRIC_EXPORT_INTERVAL
OTEL_LOGS_EXPORT_INTERVAL
OTEL_EXPORTER_OTLP_TIMEOUT
```

Content capture variables should align with Claude Code:

```text
OTEL_LOG_USER_PROMPTS
OTEL_LOG_ASSISTANT_RESPONSES
OTEL_LOG_TOOL_DETAILS
OTEL_LOG_TOOL_CONTENT
```

Pi-specific variables remain for functionality without a direct standard equivalent:

```text
PI_OTEL_CAPTURE_SYSTEM_INSTRUCTIONS
PI_OTEL_CAPTURE_PROVIDER_PAYLOAD
PI_OTEL_CAPTURE_PROVIDER_HEADERS
PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT
PI_OTEL_CONTENT_MAX_LENGTH
```

Continue supporting current variables as compatibility aliases, including `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` and `PI_OTEL_CAPTURE_CONTENT`.

## Export behavior

- Default protocol: `http/protobuf`.
- Generic OTLP endpoint gets `/v1/traces`, `/v1/metrics`, and `/v1/logs` when signal-specific endpoints are absent.
- Signal-specific endpoint variables take precedence over the generic endpoint.
- Generic headers apply to all signals; signal-specific headers override or merge according to OpenTelemetry conventions.
- Exporter selectors support `otlp` and `none` initially. Unsupported protocols/exporters should produce a clear warning and disable only the affected signal.
- Exporter errors and configuration failures remain isolated from Pi behavior.

## Capture semantics

Replace the current single all-content gate internally with independent capture gates:

- User prompts
- Assistant responses
- Tool arguments/details
- Tool results/content
- System instructions
- Provider payloads
- Provider headers
- Observability-tool results

The existing aggregate capture variables should enable the normal prompt, response, and tool gates but should not implicitly enable provider payloads, provider headers, or observability-tool results.

All captured values continue to pass through sanitization and the configured content-length limit.

## Documentation and UX

Update README documentation with:

1. Installation using `pi install npm:@b1tank/pi-otel`.
2. First-use settings bootstrap behavior.
3. The generated default settings block.
4. Environment variable precedence.
5. OTLP endpoint and header examples.
6. Explicit warnings that content capture may contain sensitive prompts, files, shell output, and system instructions.
7. A verification flow using an OTLP collector.

Expose a concise startup notification only when bootstrap creates settings or encounters a recoverable configuration problem. Do not notify on every normal startup.

## Verification plan

Add tests for:

- Creating settings with the default block.
- Preserving unrelated Pi settings.
- Preserving an existing `pi-otel` block byte-for-byte where possible.
- Merging missing migration keys without overwriting user values.
- Invalid JSON and read-only settings paths failing non-fatally.
- Global/project/environment precedence.
- Generic and signal-specific endpoints and headers.
- Each content-capture gate and legacy aliases.
- Exporter disablement and unsupported configuration.

Perform a manual smoke test with Pi 0.87.x and an OTLP/HTTP collector covering startup, prompt, tool call, retry/compaction, session switch, and shutdown.
