# pi-otel

Vendor-neutral OpenTelemetry instrumentation for the [Pi coding agent](https://github.com/earendil-works/pi).

`pi-otel` is a Pi extension that exports **traces, metrics, and logs** over OTLP/HTTP. It follows the OpenTelemetry GenAI semantic conventions where Pi's extension lifecycle exposes equivalent operations, and uses `pi.*` attributes only for Pi-specific details.

> **Early open-source release.** Tested with Pi 0.87.x on Ubuntu Linux and macOS using Node.js 22.19 or newer. Omarchy, Arch Linux, and Windows have not yet been separately qualified.

## Signals

### Traces

Each agent interaction produces a causal tree:

```text
invoke_agent pi
├── chat <model>
├── execute_tool <tool>
└── chat <model>
```

Standard attributes include:

- `gen_ai.operation.name`
- `gen_ai.provider.name`
- `gen_ai.request.model`
- `gen_ai.conversation.id`
- `gen_ai.input.messages`
- `gen_ai.output.messages`
- `gen_ai.system_instructions`
- `gen_ai.tool.name`
- `gen_ai.tool.call.id`
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`
- `gen_ai.usage.*`

### Metrics

- `pi.session.count`
- `gen_ai.client.operation.duration`
- `gen_ai.client.token.usage`
- `gen_ai.invoke_agent.duration`
- `gen_ai.invoke_agent.inference_calls`
- `gen_ai.invoke_agent.tool_calls`
- `gen_ai.execute_tool.duration`
- `pi.tool.execution.count`
- `pi.gen_ai.cost.usage`

### Logs

Structured lifecycle logs include session, user-message, provider-request/response, turn, assistant-message, tool, compaction, model-selection, and shutdown events. Logs emitted inside an operation carry that operation's trace and span IDs. Failed provider and tool operations use `ERROR` severity; HTTP 4xx responses use `WARN` unless the provider operation later fails.

High-volume content is recorded once on the canonical span rather than repeated in lifecycle logs. Tool failures add bounded `error.type` and `pi.tool.failure.*` attributes for process exits, timeouts, edit conflicts, missing configuration, validation failures, and shared-resource conflicts.

## Installation

Install directly as a Pi package:

```bash
pi install npm:@b1tank/pi-otel
```

You can also install the development repository directly:

```bash
pi install git:github.com/b1tank/pi-otel
```

For local development:

```bash
pi install ~/pi-otel
```

## Configuration

On first load, the extension idempotently adds a `pi-otel` block to `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`). Existing settings and an existing `pi-otel` block are preserved; project `.pi/settings.json` is never created automatically. A malformed or unwritable settings file only produces a warning and does not prevent Pi from starting.

The generated defaults are safe and redacted:

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
    "exportTimeout": 1000,
    "serviceName": "pi",
    "serviceVersion": "unknown",
    "resourceAttributes": {},
    "headers": {}
  }
}
```

Configuration precedence is built-in defaults, global settings, project settings, then environment variables. Environment variables therefore always win and are suitable for CI. Optional `serviceName`, `serviceVersion`, `resourceAttributes`, and `headers` values can also be placed inside the `pi-otel` settings block. Keep credentials in environment variables rather than settings files.

Set a standard OTLP base endpoint before launching Pi:

```bash
export PI_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi
```

The generic endpoint gets `/v1/traces`, `/v1/metrics`, and `/v1/logs` appended. Signal-specific endpoint variables override it:

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`

Other supported variables:

| Variable | Purpose |
|---|---|
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER` | Select `otlp` or `none` per signal |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) |
| `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` | Independently capture prompts or responses |
| `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` | Independently capture tool arguments or results |
| `PI_OTEL_CAPTURE_SYSTEM_INSTRUCTIONS` | Capture effective system instructions |

| Variable | Purpose |
|---|---|
| `PI_OTEL_ENABLED` | Enable the extension without relying on endpoint inference |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP/HTTP endpoint; setting it also enables export |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated exporter headers |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Export timeout in milliseconds; defaults to 1000 so an unavailable collector does not delay Pi shutdown |
| `OTEL_RESOURCE_ATTRIBUTES` | Percent-encoded comma-separated resource attributes |
| `OTEL_SERVICE_NAME` | Service name; defaults to `pi` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in milliseconds; defaults to 1000 |
| `PI_OTEL_CONTENT_MAX_LENGTH` | Maximum content attribute length; defaults to 16,384 characters |
| `PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT` | Set `true` to capture results from `otel_*`/OTelux MCP tools; defaults to redacted to prevent self-observation feedback |
| `PI_OTEL_CAPTURE_PROVIDER_PAYLOAD` | Set `true` to capture the full serialized provider request body; defaults to disabled because it duplicates the active conversation and system prompt |
| `PI_OTEL_CAPTURE_PROVIDER_HEADERS` | Set `true` to capture provider response headers; defaults to disabled because headers may contain sensitive or high-cardinality metadata |
| `PI_OTEL_SERVICE_VERSION` | Pi service and agent version stamped on resources and agent spans |

The current implementation uses OTLP/HTTP protobuf, matching the OpenTelemetry JS exporter default. A backend can receive the signals directly or through an OpenTelemetry Collector.

## Sensitive content capture

Content is redacted by default. Enable prompt, response, tool, and system-prompt capture explicitly:

```bash
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

`PI_OTEL_CAPTURE_CONTENT=true` is accepted as a Pi-specific alias.

When enabled, telemetry can contain:

- User prompts and images metadata
- Assistant responses and usage
- Full effective system instructions
- Tool arguments and results, including shell output and file contents
- Session paths and working directories

Treat the destination as sensitive storage. Full provider payloads and response headers remain separately gated by `PI_OTEL_CAPTURE_PROVIDER_PAYLOAD` and `PI_OTEL_CAPTURE_PROVIDER_HEADERS`; enabling general content capture does not enable them. Provider payload capture is particularly expensive because every request may repeat the system prompt and complete active conversation.

Results from `otel_*` and `mcp__otelux*` tools are redacted from content attributes by default. Their spans, names, call IDs, timing, status, and input arguments are still exported. This prevents a query of an OTel backend from being embedded into telemetry, queried again, and recursively amplified through later provider payloads. Set `PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT=true` only when that feedback risk is intentional and bounded.

## Design

The extension intentionally keeps OTel dependencies outside Pi core. It maps Pi's stable extension events onto a vendor-neutral telemetry model and can serve as an implementation reference for a future optional native `packages/otel` adapter in Pi.

Pi currently exposes tool failure as human-readable content plus `isError`, without a structured failure cause. `pi-otel` therefore classifies only a small set of stable, bounded failure patterns and falls back to `tool_error`; it does not infer retryability for generic nonzero process exits. Exact-edit conflicts carry `pi.tool.failure.recovery=reread_required`, but the extension does not alter or suppress agent tool calls.

The span hierarchy, GenAI attributes, metric names, content gate, exporter behavior, and failure isolation were informed by the OpenTelemetry implementation in GitHub Copilot's agent runtime.

Exporter failures never alter agent behavior. Providers are initialized on `session_start` and shut down on `session_shutdown`, which flushes pending telemetry once. Exports time out after one second by default so an unavailable collector does not significantly delay Pi shutdown. All extension handlers remain passive.

## Verify with an OTLP Collector

A local OpenTelemetry Collector can receive and print all three signals. Save this minimal configuration as `otel-collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
```

Run the collector (for example, with the contrib image, which includes the `debug` exporter):

```bash
docker run --rm -p 4318:4318 \\
  -v "$PWD/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \\
  otel/opentelemetry-collector-contrib:latest
```

In another terminal, enable export and start Pi:

```bash
export PI_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi
```

Send a prompt that causes a tool call and a final response. The collector output should show `invoke_agent pi`, `chat <model>`, and `execute_tool <tool>` spans, plus metrics and structured lifecycle logs. Content remains redacted by default; opt into sensitive capture only when appropriate (see [Sensitive content capture](#sensitive-content-capture)). Stop Pi normally to flush telemetry. Use `OTEL_EXPORTER_OTLP_TIMEOUT` to bound export and shutdown delay if the collector is unavailable.

## Development

```bash
npm install
npm run typecheck
npm test
```

`npm test` includes a focused end-to-end test using the installed Pi CLI, a local mock provider, and a local OTLP receiver. It verifies a prompt → provider → tool → final response trace and checks that sensitive content is absent when capture is disabled. It requires no external credentials or collector.

## License

MIT
