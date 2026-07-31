const REDACTED = "[REDACTED TO PREVENT OBSERVABILITY FEEDBACK]";

export function isObservabilityTool(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return normalized.startsWith("otel_") || normalized.startsWith("mcp__otelux");
}

export function toolCallKeys(id: string): readonly string[] {
  const separator = id.indexOf("|");
  return separator > 0 ? [id, id.slice(0, separator)] : [id];
}

export function sanitizeForCapture(
  value: unknown,
  observabilityCallIds: ReadonlySet<string>,
  captureObservabilityToolContent: boolean,
): unknown {
  if (captureObservabilityToolContent) return value;
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map(visit);

    const record = current as Record<string, unknown>;
    const toolName = [record.toolName, record.tool_name, record.name].find(
      (item): item is string => typeof item === "string",
    );
    const callId = [
      record.toolCallId,
      record.tool_call_id,
      record.call_id,
      record.id,
    ].find((item): item is string => typeof item === "string");
    const excluded =
      isObservabilityTool(toolName) ||
      (callId !== undefined && observabilityCallIds.has(callId));
    const isResult =
      record.role === "toolResult" ||
      record.type === "function_call_output" ||
      record.type === "tool_result" ||
      (excluded &&
        ("result" in record || "output" in record || "isError" in record));

    if (excluded && isResult) {
      return {
        ...Object.fromEntries(
          Object.entries(record)
            .filter(
              ([key]) =>
                ![
                  "content",
                  "details",
                  "output",
                  "result",
                  "partialResult",
                ].includes(key),
            )
            .map(([key, item]) => [key, visit(item)]),
        ),
        content: REDACTED,
      };
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, visit(item)]),
    );
  };

  return visit(value);
}

export { REDACTED };
