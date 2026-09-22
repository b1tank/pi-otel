import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Attributes } from "@opentelemetry/api";
import { resolveConfig } from "./config.js";
import {
  classifyToolFailure,
  toolFailureAttributes,
} from "./failure.js";
import {
  isObservabilityTool,
  sanitizeForCapture,
  toolCallKeys,
} from "./sanitize.js";
import { SpanKind, Telemetry, type Operation } from "./telemetry.js";

const VERSION = "0.2.1";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

function modelAttributes(ctx: {
  model?: { provider?: string; id?: string } | null;
}) {
  return {
    "gen_ai.provider.name": ctx.model?.provider ?? "unknown",
    "gen_ai.request.model": ctx.model?.id ?? "unknown",
  };
}

function metricAttributes(ctx: {
  model?: { provider?: string; id?: string } | null;
}): Attributes {
  return modelAttributes(ctx);
}

function messageUsage(message: unknown): Usage {
  if (!message || typeof message !== "object") return {};
  const usage = (message as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? (usage as Usage) : {};
}

function finishReason(message: unknown) {
  if (!message || typeof message !== "object") return "unknown";
  const value = (message as { stopReason?: unknown }).stopReason;
  return typeof value === "string" ? value : "unknown";
}

function messageContent(message: unknown) {
  if (!message || typeof message !== "object") return message;
  const value = message as { role?: unknown; content?: unknown };
  return [
    {
      role: typeof value.role === "string" ? value.role : "assistant",
      parts: value.content,
    },
  ];
}

function lastAssistantMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message !== null &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      return message;
    }
  }
  return undefined;
}

function outcome(message: unknown) {
  const reason = finishReason(message);
  const errorMessage =
    message && typeof message === "object"
      ? (message as { errorMessage?: unknown }).errorMessage
      : undefined;
  const failed = reason === "error" || reason === "aborted";
  return {
    reason,
    failed,
    errorType: reason === "aborted" ? "aborted" : "provider_error",
    errorMessage:
      typeof errorMessage === "string" ? errorMessage : "Provider operation failed",
  };
}

export default function piOtel(pi: ExtensionAPI) {
  const config = resolveConfig();
  if (!config.enabled) return;

  let otel: Telemetry | undefined;
  let sessionID = "unknown";
  let agent: Operation | undefined;
  let chat: Operation | undefined;
  let prompt: string | undefined;
  let systemPrompt: string | undefined;
  let finalAgentMessage: unknown;
  let inferenceCalls = 0;
  let toolCalls = 0;
  const tools = new Map<string, Operation>();
  const observabilityCallIds = new Set<string>();

  const attrs = (ctx: {
    model?: { provider?: string; id?: string } | null;
  }): Attributes => ({
    ...modelAttributes(ctx),
    "gen_ai.conversation.id": sessionID,
    "session.id": sessionID,
  });

  const ensure = () => {
    if (!otel) otel = new Telemetry(config, VERSION);
    return otel;
  };

  const capture = (value: unknown) => {
    const telemetry = ensure();
    return telemetry.content(
      sanitizeForCapture(
        value,
        observabilityCallIds,
        config.captureObservabilityToolContent,
      ),
    );
  };

  pi.on("session_start", (event, ctx) => {
    sessionID = ctx.sessionManager.getSessionId();
    const telemetry = ensure();
    telemetry.count("pi.session.count", 1, {
      "session.start_type": event.reason,
    });
    telemetry.event("pi.session.start", {
      "session.id": sessionID,
      "session.start_type": event.reason,
      "pi.session.file": telemetry.content(
        ctx.sessionManager.getSessionFile() ?? "",
      ),
      "pi.cwd": telemetry.content(ctx.cwd),
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    prompt = event.prompt;
    systemPrompt = event.systemPrompt;
    ensure().event(
      "pi.user.message",
      {
        ...attrs(ctx),
        "pi.prompt.length": event.prompt.length,
        "pi.system_prompt.length": event.systemPrompt.length,
        "pi.context_file.count":
          event.systemPromptOptions.contextFiles?.length ?? 0,
        "pi.skill.count": event.systemPromptOptions.skills?.length ?? 0,
        "pi.active_tool.count":
          event.systemPromptOptions.selectedTools?.length ?? 0,
        "pi.image.count": event.images?.length ?? 0,
      },
      agent,
    );
  });

  pi.on("agent_start", (_event, ctx) => {
    const telemetry = ensure();
    // A single user interaction may contain multiple agent runs while Pi
    // retries or recovers from compaction. Keep one root span until
    // agent_settled rather than ending it at the first agent_end.
    if (agent) return;
    inferenceCalls = 0;
    toolCalls = 0;
    finalAgentMessage = undefined;
    agent = telemetry.start(`invoke_agent pi`, SpanKind.INTERNAL, {
      ...attrs(ctx),
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "pi.default",
      "gen_ai.agent.name": "pi",
      "gen_ai.agent.version": config.serviceVersion,
      "gen_ai.input.messages": telemetry.content([
        { role: "user", parts: [{ type: "text", content: prompt ?? "" }] },
      ]),
      "gen_ai.system_instructions": telemetry.content([
        { type: "text", content: systemPrompt ?? "" },
      ]),
    });
    telemetry.event("pi.agent.start", attrs(ctx), agent);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const telemetry = ensure();
    if (chat) {
      telemetry.end(
        chat,
        { "error.type": "superseded_provider_request" },
        new Error("Provider request superseded"),
      );
    }
    inferenceCalls++;
    const model = ctx.model?.id ?? "unknown";
    chat = telemetry.start(
      `chat ${model}`,
      SpanKind.CLIENT,
      {
        ...attrs(ctx),
        "gen_ai.operation.name": "chat",
        "gen_ai.request.stream": true,
        "pi.provider.payload.captured": config.captureProviderPayload,
        ...(config.captureProviderPayload
          ? { "pi.provider.request.body": capture(event.payload) }
          : {}),
      },
      agent,
    );
    telemetry.event(
      "pi.provider.request",
      {
        ...attrs(ctx),
        "pi.provider.payload.captured": config.captureProviderPayload,
      },
      chat,
    );
  });

  pi.on("after_provider_response", (event, ctx) => {
    const telemetry = ensure();
    chat?.span.setAttributes({
      "http.response.status_code": event.status,
      "pi.provider.headers.captured": config.captureProviderHeaders,
      ...(config.captureProviderHeaders
        ? {
            "pi.provider.response.headers": telemetry.content(event.headers),
          }
        : {}),
    });
    telemetry.event(
      "pi.provider.response",
      {
        ...attrs(ctx),
        "http.response.status_code": event.status,
        "pi.provider.headers.captured": config.captureProviderHeaders,
      },
      chat,
      event.status >= 500 ? "ERROR" : event.status >= 400 ? "WARN" : "INFO",
    );
  });

  pi.on("turn_start", (event, ctx) => {
    ensure().event(
      "pi.turn.start",
      { ...attrs(ctx), "pi.turn.index": event.turnIndex },
      chat ?? agent,
    );
  });

  pi.on("turn_end", (event, ctx) => {
    const telemetry = ensure();
    const usage = messageUsage(event.message);
    const common = attrs(ctx);
    const metricCommon = metricAttributes(ctx);
    const turnOutcome = outcome(event.message);
    const usageAttributes: Attributes = {
      "gen_ai.response.finish_reasons": [turnOutcome.reason],
      ...(usage.input !== undefined
        ? { "gen_ai.usage.input_tokens": usage.input }
        : {}),
      ...(usage.output !== undefined
        ? { "gen_ai.usage.output_tokens": usage.output }
        : {}),
      ...(usage.cacheRead !== undefined
        ? { "gen_ai.usage.cache_read.input_tokens": usage.cacheRead }
        : {}),
      ...(usage.cacheWrite !== undefined
        ? { "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite }
        : {}),
      "gen_ai.output.messages": capture(messageContent(event.message)),
      "error.type": turnOutcome.failed ? turnOutcome.errorType : "",
    };
    if (chat) {
      const duration = (performance.now() - chat.startedAt) / 1000;
      telemetry.histogram("gen_ai.client.operation.duration", duration, "s", {
        ...metricCommon,
        "gen_ai.operation.name": "chat",
        "error.type": turnOutcome.failed ? turnOutcome.errorType : "",
      });
      telemetry.end(
        chat,
        usageAttributes,
        turnOutcome.failed ? new Error(turnOutcome.errorMessage) : undefined,
      );
      chat = undefined;
    }
    for (const [type, value] of [
      ["input", usage.input],
      ["output", usage.output],
      ["cache_read", usage.cacheRead],
      ["cache_creation", usage.cacheWrite],
    ] as const) {
      if (value !== undefined) {
        telemetry.histogram("gen_ai.client.token.usage", value, "{token}", {
          ...metricCommon,
          "gen_ai.operation.name": "chat",
          "gen_ai.token.type": type,
        });
      }
    }
    if (usage.cost?.total !== undefined) {
      telemetry.histogram(
        "pi.gen_ai.cost.usage",
        usage.cost.total,
        "USD",
        metricCommon,
      );
    }
    telemetry.event(
      "pi.assistant.message",
      {
        ...common,
        "gen_ai.response.finish_reasons": [turnOutcome.reason],
        ...(usage.input !== undefined
          ? { "gen_ai.usage.input_tokens": usage.input }
          : {}),
        ...(usage.output !== undefined
          ? { "gen_ai.usage.output_tokens": usage.output }
          : {}),
        ...(usage.cacheRead !== undefined
          ? { "gen_ai.usage.cache_read.input_tokens": usage.cacheRead }
          : {}),
        ...(usage.cacheWrite !== undefined
          ? { "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite }
          : {}),
        "pi.tool_result.count": event.toolResults.length,
        "error.type": turnOutcome.failed ? turnOutcome.errorType : "",
      },
      agent,
      turnOutcome.failed ? "ERROR" : "INFO",
    );
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const telemetry = ensure();
    toolCalls++;
    if (isObservabilityTool(event.toolName)) {
      for (const key of toolCallKeys(event.toolCallId))
        observabilityCallIds.add(key);
    }
    const operation = telemetry.start(
      `execute_tool ${event.toolName}`,
      SpanKind.INTERNAL,
      {
        ...attrs(ctx),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.call.id": event.toolCallId,
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.arguments": telemetry.content(event.args),
      },
      chat ?? agent,
    );
    tools.set(event.toolCallId, operation);
    telemetry.event(
      "pi.tool.execution.start",
      {
        ...attrs(ctx),
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.call.id": event.toolCallId,
      },
      operation,
    );
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const telemetry = ensure();
    const operation = tools.get(event.toolCallId);
    tools.delete(event.toolCallId);
    const duration = operation
      ? (performance.now() - operation.startedAt) / 1000
      : 0;
    const failure = event.isError
      ? classifyToolFailure(event.toolName, event.result)
      : undefined;
    const failureAttributes = failure
      ? toolFailureAttributes(failure)
      : { "error.type": "" };
    const spanAttributes = {
      ...attrs(ctx),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.call.id": event.toolCallId,
      "gen_ai.tool.call.result": capture({
        type: "tool_result",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: event.result,
      }),
      ...failureAttributes,
    };
    const toolMetricAttributes = {
      ...metricAttributes(ctx),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": event.toolName,
      "error.type": failure?.errorType ?? "",
      ...(failure
        ? { "pi.tool.failure.category": failure.category }
        : {}),
    };
    telemetry.histogram(
      "gen_ai.execute_tool.duration",
      duration,
      "s",
      toolMetricAttributes,
    );
    telemetry.count("pi.tool.execution.count", 1, {
      ...toolMetricAttributes,
      "pi.tool.execution.status": event.isError ? "error" : "ok",
    });
    telemetry.event(
      "pi.tool.execution.end",
      {
        ...attrs(ctx),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.call.id": event.toolCallId,
        ...failureAttributes,
      },
      operation ?? agent,
      event.isError ? "ERROR" : "INFO",
    );
    telemetry.end(
      operation,
      spanAttributes,
      event.isError
        ? new Error(failure?.errorType ?? "tool_error")
        : undefined,
    );
  });

  pi.on("session_compact", (event, ctx) => {
    ensure().event(
      "pi.session.compaction",
      {
        ...attrs(ctx),
        "pi.compaction.reason": event.reason,
        "pi.compaction.retry": event.willRetry,
        "pi.compaction.entry": capture(event.compactionEntry),
      },
      agent,
    );
  });

  pi.on("model_select", (event, ctx) => {
    ensure().event(
      "pi.model.select",
      {
        ...attrs(ctx),
        "pi.model.previous": event.previousModel
          ? `${event.previousModel.provider}/${event.previousModel.id}`
          : "",
        "pi.model.source": event.source,
      },
      agent,
    );
  });

  pi.on("agent_end", (event, _ctx) => {
    const telemetry = ensure();
    finalAgentMessage = lastAssistantMessage(event.messages);
    if (agent) {
      const attemptOutcome = outcome(finalAgentMessage);
      telemetry.event(
        "pi.agent.end",
        {
          ...attrs(_ctx),
          "gen_ai.response.finish_reasons": [attemptOutcome.reason],
          "pi.agent.message.count": event.messages.length,
          "pi.agent.inference_call.count": inferenceCalls,
          "pi.agent.tool_call.count": toolCalls,
          "error.type": attemptOutcome.failed ? attemptOutcome.errorType : "",
        },
        agent,
        attemptOutcome.failed ? "ERROR" : "INFO",
      );
    }
    if (chat) {
      telemetry.end(
        chat,
        { "error.type": "agent_ended_before_turn" },
        new Error("Agent ended before turn completion"),
      );
      chat = undefined;
    }
    for (const operation of tools.values())
      telemetry.end(operation, { "error.type": "agent_ended" });
    tools.clear();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const telemetry = ensure();
    if (!agent) return;
    const agentOutcome = outcome(finalAgentMessage);
    const duration = (performance.now() - agent.startedAt) / 1000;
    const common = attrs(ctx);
    const metricCommon = metricAttributes(ctx);
    telemetry.histogram(
      "gen_ai.invoke_agent.duration",
      duration,
      "s",
      {
        ...metricCommon,
        "error.type": agentOutcome.failed ? agentOutcome.errorType : "",
      },
    );
    telemetry.histogram(
      "gen_ai.invoke_agent.inference_calls",
      inferenceCalls,
      "{call}",
      metricCommon,
    );
    telemetry.histogram(
      "gen_ai.invoke_agent.tool_calls",
      toolCalls,
      "{call}",
      metricCommon,
    );
    telemetry.event(
      "pi.agent.settled",
      {
        ...common,
        "gen_ai.response.finish_reasons": [agentOutcome.reason],
        "pi.agent.inference_call.count": inferenceCalls,
        "pi.agent.tool_call.count": toolCalls,
        "error.type": agentOutcome.failed ? agentOutcome.errorType : "",
      },
      agent,
      agentOutcome.failed ? "ERROR" : "INFO",
    );
    telemetry.end(
      agent,
      {
        "gen_ai.response.finish_reasons": [agentOutcome.reason],
        "gen_ai.output.messages": capture(messageContent(finalAgentMessage)),
        "error.type": agentOutcome.failed ? agentOutcome.errorType : "",
      },
      agentOutcome.failed ? new Error(agentOutcome.errorMessage) : undefined,
    );
    agent = undefined;
    finalAgentMessage = undefined;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!otel) return;
    otel.event(
      "pi.session.shutdown",
      {
        ...attrs(ctx),
        "session.shutdown_type": event.reason,
      },
      agent,
    );
    otel.end(chat, { "error.type": "session_shutdown" });
    for (const operation of tools.values())
      otel.end(operation, { "error.type": "session_shutdown" });
    otel.end(agent, { "gen_ai.response.finish_reasons": [event.reason] });
    chat = undefined;
    agent = undefined;
    tools.clear();
    await otel.shutdown();
    otel = undefined;
  });
}
