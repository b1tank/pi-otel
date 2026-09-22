import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type ExportRequest = { path: string; body: Buffer };
type TestSpan = { name: string; spanId: string; parentSpanId?: string; attributes: Record<string, unknown> };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolveClose => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  })));
});

function listen(server: Server): Promise<number> {
  return new Promise(resolveListen => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    resolveListen(address.port);
  }));
}

function attributes(span: any): Record<string, unknown> {
  return Object.fromEntries((span.attributes ?? []).map((item: any) => {
    const value = item.value ?? {};
    return [item.key, value.stringValue ?? value.intValue ?? value.boolValue];
  }));
}

function runPi(agentDir: string, cwd: string, prompt: string, collectorPort: number, capture: boolean) {
  const pi = spawn(join(process.cwd(), "node_modules", ".bin", "pi"), [
    "--provider", "local", "--model", "mock", "--no-session", "--print", prompt,
    "--extension", resolve("src/index.ts"),
  ], {
    cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      OTEL_EXPORTER_OTLP_TIMEOUT: "1000",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      ...(capture ? {
        OTEL_LOG_USER_PROMPTS: "true",
        OTEL_LOG_ASSISTANT_RESPONSES: "true",
        OTEL_LOG_TOOL_DETAILS: "true",
        OTEL_LOG_TOOL_CONTENT: "true",
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  pi.stdout.on("data", chunk => { stdout += chunk; });
  pi.stderr.on("data", chunk => { stderr += chunk; });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveRun => {
    pi.on("close", status => resolveRun({ status, stdout, stderr }));
  });
}

async function executeFlow(capture: boolean) {
  const requests: ExportRequest[] = [];
  let providerCalls = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      providerCalls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const base = { id: "local-test", object: "chat.completion.chunk", created: 1, model: "mock" };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (providerCalls === 1) {
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: "call_read", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
        }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: "PIOTEL_FINAL_ANSWER_9c4" }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      response.end("data: [DONE]\n\n");
    });
  });
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks) });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  servers.push(provider, collector);
  const providerPort = await listen(provider);
  const collectorPort = await listen(collector);
  const agentDir = mkdtempSync(join(tmpdir(), "pi-otel-e2e-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-otel-e2e-project-"));
  const fileText = "PIOTEL_TOOL_RESULT_SECRET_c19";
  writeFileSync(join(cwd, "README.md"), fileText);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    local: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: "local-test-key",
      api: "openai-completions",
      models: [{ id: "mock", name: "Mock", contextWindow: 8192, maxTokens: 1024, input: ["text"] }],
    },
  } }));
  const prompt = capture ? "PIOTEL_PROMPT_SECRET_a41" : "PIOTEL_REDACTED_PROMPT_b82";
  const result = await runPi(agentDir, cwd, prompt, collectorPort, capture);
  const exportDeadline = Date.now() + 3000;
  while (Date.now() < exportDeadline && !["/v1/traces", "/v1/metrics", "/v1/logs"].every(path => requests.some(item => item.path === path))) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  const traceRequest = requests.find(item => item.path === "/v1/traces");
  if (!traceRequest) throw new Error(`No trace export received. Pi stderr: ${result.stderr}`);
  const trace = JSON.parse(traceRequest.body.toString("utf8"));
  const spans = (trace.resourceSpans ?? []).flatMap((resource: any) =>
    (resource.scopeSpans ?? []).flatMap((scope: any) => scope.spans ?? []));
  return {
    ...result,
    providerCalls,
    requests,
    spans: spans.map((span: any): TestSpan => ({
      name: span.name,
      spanId: Buffer.from(span.spanId, "base64").toString("hex"),
      parentSpanId: span.parentSpanId ? Buffer.from(span.parentSpanId, "base64").toString("hex") : undefined,
      attributes: attributes(span),
    })),
  };
}

describe("Pi to OTLP critical flow", () => {
  it("exports the agent/tool trace tree and captures content only when opted in", async () => {
    const captured = await executeFlow(true);
    expect(captured.status, captured.stderr).toBe(0);
    expect(captured.providerCalls).toBe(2);
    expect(captured.stdout).toContain("PIOTEL_FINAL_ANSWER_9c4");
    expect(captured.requests.map(request => request.path)).toEqual(expect.arrayContaining([
      "/v1/traces", "/v1/metrics", "/v1/logs",
    ]));

    const root = captured.spans.find((span: TestSpan) => span.name === "invoke_agent pi");
    const tool = captured.spans.find((span: TestSpan) => span.name === "execute_tool read");
    const chats = captured.spans.filter((span: TestSpan) => span.name === "chat mock");
    expect(root).toBeDefined();
    expect(root?.parentSpanId).toBeUndefined();
    expect(chats).toHaveLength(2);
    expect(chats.every((span: TestSpan) => span.parentSpanId === root?.spanId)).toBe(true);
    expect(tool?.parentSpanId).toBe(chats[0]?.spanId);
    expect(String(root?.attributes["gen_ai.input.messages"])).toContain("PIOTEL_PROMPT_SECRET_a41");
    expect(String(root?.attributes["gen_ai.output.messages"])).toContain("PIOTEL_FINAL_ANSWER_9c4");
    expect(String(tool?.attributes["gen_ai.tool.call.arguments"])).toContain("README.md");
    expect(String(tool?.attributes["gen_ai.tool.call.result"])).toContain("PIOTEL_TOOL_RESULT_SECRET_c19");

    const redacted = await executeFlow(false);
    expect(redacted.status, redacted.stderr).toBe(0);
    const serialized = JSON.stringify(redacted.spans);
    const allExports = Buffer.concat(redacted.requests.map(request => request.body)).toString("utf8");
    expect(allExports).not.toContain("PIOTEL_REDACTED_PROMPT_b82");
    expect(allExports).not.toContain("PIOTEL_FINAL_ANSWER_9c4");
    expect(allExports).not.toContain("PIOTEL_TOOL_RESULT_SECRET_c19");
    expect(serialized).toContain("[REDACTED]");
  }, 30_000);
});
