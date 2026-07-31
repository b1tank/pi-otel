import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Attributes } from "@opentelemetry/api"
import { resolveConfig } from "./config.js"
import { SpanKind, Telemetry, type Operation } from "./telemetry.js"

const VERSION = "0.1.0"

type Usage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

function modelAttributes(ctx: { model?: { provider?: string; id?: string } | null }) {
  return {
    "gen_ai.provider.name": ctx.model?.provider ?? "unknown",
    "gen_ai.request.model": ctx.model?.id ?? "unknown",
  }
}

function messageUsage(message: unknown): Usage {
  if (!message || typeof message !== "object") return {}
  const usage = (message as { usage?: unknown }).usage
  return usage && typeof usage === "object" ? (usage as Usage) : {}
}

function finishReason(message: unknown) {
  if (!message || typeof message !== "object") return "unknown"
  const value = (message as { stopReason?: unknown }).stopReason
  return typeof value === "string" ? value : "unknown"
}

function messageContent(message: unknown) {
  if (!message || typeof message !== "object") return message
  const value = message as { role?: unknown; content?: unknown }
  return [{ role: typeof value.role === "string" ? value.role : "assistant", parts: value.content }]
}

export default function piOtel(pi: ExtensionAPI) {
  const config = resolveConfig()
  if (!config.enabled) return

  let otel: Telemetry | undefined
  let sessionID = "unknown"
  let agent: Operation | undefined
  let chat: Operation | undefined
  let prompt: string | undefined
  let systemPrompt: string | undefined
  let inferenceCalls = 0
  let toolCalls = 0
  const tools = new Map<string, Operation>()

  const attrs = (ctx: { model?: { provider?: string; id?: string } | null }): Attributes => ({
    ...modelAttributes(ctx),
    "gen_ai.conversation.id": sessionID,
    "session.id": sessionID,
  })

  const ensure = () => {
    if (!otel) otel = new Telemetry({ ...config, serviceVersion: VERSION })
    return otel
  }

  pi.on("session_start", (event, ctx) => {
    sessionID = ctx.sessionManager.getSessionId()
    const telemetry = ensure()
    telemetry.count("pi.session.count", 1, { "session.start_type": event.reason })
    telemetry.event("pi.session.start", {
      "session.id": sessionID,
      "session.start_type": event.reason,
      "pi.session.file": telemetry.content(ctx.sessionManager.getSessionFile() ?? ""),
      "pi.cwd": telemetry.content(ctx.cwd),
    })
  })

  pi.on("before_agent_start", (event, ctx) => {
    prompt = event.prompt
    systemPrompt = event.systemPrompt
    const telemetry = ensure()
    telemetry.event("pi.user.message", {
      ...attrs(ctx),
      "gen_ai.input.messages": telemetry.content([{ role: "user", parts: [{ type: "text", content: event.prompt }] }]),
      "gen_ai.system_instructions": telemetry.content([{ type: "text", content: event.systemPrompt }]),
      "pi.system_prompt_options": telemetry.content(event.systemPromptOptions),
      "pi.image.count": event.images?.length ?? 0,
    }, agent)
  })

  pi.on("agent_start", (_event, ctx) => {
    const telemetry = ensure()
    inferenceCalls = 0
    toolCalls = 0
    agent = telemetry.start(`invoke_agent pi`, SpanKind.INTERNAL, {
      ...attrs(ctx),
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "pi.default",
      "gen_ai.agent.name": "pi",
      "gen_ai.agent.version": VERSION,
      "gen_ai.input.messages": telemetry.content([{ role: "user", parts: [{ type: "text", content: prompt ?? "" }] }]),
      "gen_ai.system_instructions": telemetry.content([{ type: "text", content: systemPrompt ?? "" }]),
    })
    telemetry.event("pi.agent.start", attrs(ctx), agent)
  })

  pi.on("before_provider_request", (event, ctx) => {
    const telemetry = ensure()
    if (chat) {
      telemetry.end(chat, { "error.type": "superseded_provider_request" }, new Error("Provider request superseded"))
    }
    inferenceCalls++
    const model = ctx.model?.id ?? "unknown"
    chat = telemetry.start(`chat ${model}`, SpanKind.CLIENT, {
      ...attrs(ctx),
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": true,
      "gen_ai.input.messages": telemetry.content([{ role: "user", parts: [{ type: "text", content: prompt ?? "" }] }]),
      "gen_ai.system_instructions": telemetry.content([{ type: "text", content: systemPrompt ?? "" }]),
      "pi.provider.request.body": telemetry.content(event.payload),
    }, agent)
    telemetry.event("pi.provider.request", {
      ...attrs(ctx),
      "pi.provider.request.body": telemetry.content(event.payload),
    }, chat)
  })

  pi.on("after_provider_response", (event, ctx) => {
    const telemetry = ensure()
    chat?.span.setAttributes({
      "http.response.status_code": event.status,
      "pi.provider.response.headers": telemetry.content(event.headers),
    })
    telemetry.event("pi.provider.response", {
      ...attrs(ctx),
      "http.response.status_code": event.status,
      "pi.provider.response.headers": telemetry.content(event.headers),
    }, chat)
  })

  pi.on("turn_start", (event, ctx) => {
    ensure().event("pi.turn.start", { ...attrs(ctx), "pi.turn.index": event.turnIndex }, chat ?? agent)
  })

  pi.on("turn_end", (event, ctx) => {
    const telemetry = ensure()
    const usage = messageUsage(event.message)
    const common = attrs(ctx)
    const usageAttributes: Attributes = {
      "gen_ai.response.finish_reasons": [finishReason(event.message)],
      ...(usage.input !== undefined ? { "gen_ai.usage.input_tokens": usage.input } : {}),
      ...(usage.output !== undefined ? { "gen_ai.usage.output_tokens": usage.output } : {}),
      ...(usage.cacheRead !== undefined ? { "gen_ai.usage.cache_read.input_tokens": usage.cacheRead } : {}),
      ...(usage.cacheWrite !== undefined ? { "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite } : {}),
      "gen_ai.output.messages": telemetry.content(messageContent(event.message)),
    }
    if (chat) {
      const duration = (performance.now() - chat.startedAt) / 1000
      telemetry.histogram("gen_ai.client.operation.duration", duration, "s", {
        ...common,
        "gen_ai.operation.name": "chat",
        "error.type": "",
      })
      telemetry.end(chat, usageAttributes)
      chat = undefined
    }
    for (const [type, value] of [
      ["input", usage.input],
      ["output", usage.output],
      ["cache_read", usage.cacheRead],
      ["cache_creation", usage.cacheWrite],
    ] as const) {
      if (value !== undefined) {
        telemetry.histogram("gen_ai.client.token.usage", value, "{token}", {
          ...common,
          "gen_ai.operation.name": "chat",
          "gen_ai.token.type": type,
        })
      }
    }
    if (usage.cost?.total !== undefined) {
      telemetry.histogram("pi.gen_ai.cost.usage", usage.cost.total, "USD", common)
    }
    telemetry.event("pi.assistant.message", {
      ...common,
      ...usageAttributes,
      "pi.tool_result.messages": telemetry.content(event.toolResults),
    }, agent)
  })

  pi.on("tool_execution_start", (event, ctx) => {
    const telemetry = ensure()
    toolCalls++
    const operation = telemetry.start(`execute_tool ${event.toolName}`, SpanKind.INTERNAL, {
      ...attrs(ctx),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.call.id": event.toolCallId,
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.arguments": telemetry.content(event.args),
    }, chat ?? agent)
    tools.set(event.toolCallId, operation)
    telemetry.event("pi.tool.execution.start", {
      ...attrs(ctx),
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.call.id": event.toolCallId,
      "gen_ai.tool.call.arguments": telemetry.content(event.args),
    }, operation)
  })

  pi.on("tool_execution_end", (event, ctx) => {
    const telemetry = ensure()
    const operation = tools.get(event.toolCallId)
    tools.delete(event.toolCallId)
    const duration = operation ? (performance.now() - operation.startedAt) / 1000 : 0
    const toolAttributes = {
      ...attrs(ctx),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.call.id": event.toolCallId,
      "gen_ai.tool.call.result": telemetry.content(event.result),
      "error.type": event.isError ? "ToolError" : "",
    }
    telemetry.histogram("gen_ai.execute_tool.duration", duration, "s", toolAttributes)
    telemetry.event("pi.tool.execution.end", toolAttributes, operation ?? agent)
    telemetry.end(operation, toolAttributes, event.isError ? new Error("Tool execution failed") : undefined)
  })

  pi.on("session_compact", (event, ctx) => {
    ensure().event("pi.session.compaction", {
      ...attrs(ctx),
      "pi.compaction.reason": event.reason,
      "pi.compaction.retry": event.willRetry,
      "pi.compaction.entry": ensure().content(event.compactionEntry),
    }, agent)
  })

  pi.on("model_select", (event, ctx) => {
    ensure().event("pi.model.select", {
      ...attrs(ctx),
      "pi.model.previous": event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : "",
      "pi.model.source": event.source,
    }, agent)
  })

  pi.on("agent_end", (event, ctx) => {
    const telemetry = ensure()
    if (chat) {
      telemetry.end(chat, { "error.type": "agent_ended_before_turn" }, new Error("Agent ended before turn completion"))
      chat = undefined
    }
    for (const operation of tools.values()) telemetry.end(operation, { "error.type": "agent_ended" })
    tools.clear()
    if (agent) {
      const duration = (performance.now() - agent.startedAt) / 1000
      telemetry.histogram("gen_ai.invoke_agent.duration", duration, "s", attrs(ctx))
      telemetry.histogram("gen_ai.invoke_agent.inference_calls", inferenceCalls, "{call}", attrs(ctx))
      telemetry.histogram("gen_ai.invoke_agent.tool_calls", toolCalls, "{call}", attrs(ctx))
      telemetry.end(agent, {
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.output.messages": telemetry.content(event.messages),
      })
      telemetry.event("pi.agent.end", { ...attrs(ctx), "pi.agent.messages": telemetry.content(event.messages) })
      agent = undefined
    }
  })

  pi.on("session_shutdown", async (event, ctx) => {
    if (!otel) return
    otel.event("pi.session.shutdown", {
      ...attrs(ctx),
      "session.shutdown_type": event.reason,
    }, agent)
    otel.end(chat, { "error.type": "session_shutdown" })
    for (const operation of tools.values()) otel.end(operation, { "error.type": "session_shutdown" })
    otel.end(agent, { "gen_ai.response.finish_reasons": [event.reason] })
    chat = undefined
    agent = undefined
    tools.clear()
    await otel.shutdown()
    otel = undefined
  })
}
