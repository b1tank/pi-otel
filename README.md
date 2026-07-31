# pi-otel

Vendor-neutral OpenTelemetry instrumentation for the [Pi coding agent](https://github.com/earendil-works/pi).

`pi-otel` is a Pi extension that exports **traces, metrics, and logs** over OTLP/HTTP. It follows the OpenTelemetry GenAI semantic conventions where Pi's extension lifecycle exposes equivalent operations, and uses `pi.*` attributes only for Pi-specific details.

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
- `pi.gen_ai.cost.usage`

### Logs

Structured lifecycle logs include session, user-message, provider-request/response, turn, assistant-message, tool, compaction, model-selection, and shutdown events. Logs emitted inside an operation carry that operation's trace and span IDs.

## Installation

Install directly as a Pi package:

```bash
pi install git:github.com/b1tank/pi-otel
```

For local development:

```bash
pi install ~/pi-otel
```

## Configuration

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
| `PI_OTEL_ENABLED` | Enable the extension without relying on endpoint inference |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP/HTTP endpoint; setting it also enables export |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated exporter headers |
| `OTEL_RESOURCE_ATTRIBUTES` | Percent-encoded comma-separated resource attributes |
| `OTEL_SERVICE_NAME` | Service name; defaults to `pi` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in milliseconds; defaults to 1000 |
| `PI_OTEL_CONTENT_MAX_LENGTH` | Maximum content attribute length; defaults to 61,440 characters |
| `PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT` | Set `true` to capture results from `otel_*`/OTelux MCP tools; defaults to redacted to prevent self-observation feedback |
| `PI_OTEL_SERVICE_VERSION` | Override the Pi service version stamped on resources |

The current implementation uses OTLP/HTTP protobuf, matching the OpenTelemetry JS exporter default. A backend can receive the signals directly or through an OpenTelemetry Collector.

## Sensitive content capture

Content is redacted by default. Enable full prompt, response, tool, system-prompt, and provider-payload capture explicitly:

```bash
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

`PI_OTEL_CAPTURE_CONTENT=true` is accepted as a Pi-specific alias.

When enabled, telemetry can contain:

- User prompts and images metadata
- Assistant responses and usage
- Full effective system instructions
- Full serialized provider request payloads
- Tool arguments and results, including shell output and file contents
- Session paths and working directories

Treat the destination as sensitive storage. Provider HTTP headers are not captured by `before_provider_request`; response headers are captured when content capture is enabled.

Results from `otel_*` and `mcp__otelux*` tools are redacted from content attributes by default. Their spans, names, call IDs, timing, status, and input arguments are still exported. This prevents a query of an OTel backend from being embedded into telemetry, queried again, and recursively amplified through later provider payloads. Set `PI_OTEL_CAPTURE_OBSERVABILITY_TOOL_CONTENT=true` only when that feedback risk is intentional and bounded.

## Design

The extension intentionally keeps OTel dependencies outside Pi core. It maps Pi's stable extension events onto a vendor-neutral telemetry model and can serve as an implementation reference for a future optional native `packages/otel` adapter in Pi.

The span hierarchy, GenAI attributes, metric names, content gate, exporter behavior, and failure isolation were informed by the OpenTelemetry implementation in GitHub Copilot's agent runtime.

Exporter failures never alter agent behavior. Providers are initialized on `session_start`, flushed on `session_shutdown`, and all extension handlers remain passive.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
