import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SpanKind, Telemetry } from "../src/telemetry.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() =>
  Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  ),
);

describe("Telemetry", () => {
  it("exports traces, metrics, and logs and honors content capture", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      request.resume();
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing test address");
    const base = `http://127.0.0.1:${address.port}`;
    const telemetry = new Telemetry({
      enabled: true,
      captureContent: true,
      captureObservabilityToolContent: false,
      captureProviderPayload: false,
      captureProviderHeaders: false,
      endpoint: base,
      tracesEndpoint: `${base}/v1/traces`,
      metricsEndpoint: `${base}/v1/metrics`,
      logsEndpoint: `${base}/v1/logs`,
      headers: {},
      resourceAttributes: {},
      serviceName: "pi-test",
      serviceVersion: "test",
      exportIntervalMillis: 100,
      contentLimit: 20,
    });
    const operation = telemetry.start("chat test", SpanKind.CLIENT, {
      "gen_ai.operation.name": "chat",
    });
    telemetry.event(
      "pi.test",
      { content: telemetry.content("sensitive prompt") },
      operation,
    );
    telemetry.count("pi.test.count");
    telemetry.histogram("gen_ai.client.operation.duration", 0.1, "s");
    telemetry.end(operation);
    await telemetry.shutdown();

    expect(paths).toContain("/v1/traces");
    expect(paths).toContain("/v1/metrics");
    expect(paths).toContain("/v1/logs");
    expect(telemetry.content("1234567890123456789012345")).toContain(
      "TRUNCATED",
    );
    expect(telemetry.content(undefined)).toBe("undefined");
  });
});
