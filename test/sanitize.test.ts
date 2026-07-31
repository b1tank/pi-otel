import { describe, expect, it } from "vitest";
import { REDACTED, sanitizeForCapture, toolCallKeys } from "../src/sanitize.js";

describe("sanitizeForCapture", () => {
  it("redacts OTelux tool results throughout messages and provider payloads", () => {
    const fullId = "call-1|signed";
    const ids = new Set(toolCallKeys(fullId));
    const value = {
      messages: [
        {
          role: "toolResult",
          toolName: "otel_search_logs",
          toolCallId: fullId,
          content: "recursive telemetry",
        },
      ],
      provider: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "recursive telemetry",
        },
      ],
    };

    const sanitized = sanitizeForCapture(value, ids, false);
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("recursive telemetry");
    expect(text).toContain(REDACTED);
  });

  it("preserves tool arguments and ordinary tool results", () => {
    const value = [
      {
        type: "function_call",
        call_id: "call-1",
        name: "otel_search_logs",
        arguments: { query: "error" },
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-2",
        content: "normal output",
      },
    ];
    expect(sanitizeForCapture(value, new Set(["call-1"]), false)).toEqual(
      value,
    );
  });

  it("allows explicit recursive capture", () => {
    const value = {
      role: "toolResult",
      toolName: "otel_get_trace",
      content: "full result",
    };
    expect(sanitizeForCapture(value, new Set(), true)).toBe(value);
  });
});
