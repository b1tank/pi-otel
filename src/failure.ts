import type { Attributes } from "@opentelemetry/api";

export interface ToolFailure {
  errorType: string;
  category: string;
  code?: string | number;
  retryable?: boolean;
  recovery?: string;
}

export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

export function classifyToolFailure(
  toolName: string,
  result: unknown,
): ToolFailure {
  const text = toolResultText(result);

  const exitCode = text.match(/Command exited with code (\d+)/i)?.[1];
  if (exitCode !== undefined) {
    return {
      errorType: "process_exit",
      category: "process_exit",
      code: Number(exitCode),
    };
  }

  if (/Command timed out after|\btimeout:\d+/i.test(text)) {
    return {
      errorType: "timeout",
      category: "timeout",
      retryable: true,
    };
  }

  if (/Command aborted|Operation aborted|\baborted\b/i.test(text)) {
    return {
      errorType: "aborted",
      category: "cancelled",
      retryable: false,
    };
  }

  if (
    toolName === "edit" &&
    /Could not find (?:the exact text|edits\[\d+\])/i.test(text)
  ) {
    return {
      errorType: "edit_text_not_found",
      category: "mutation_conflict",
      retryable: true,
      recovery: "reread_required",
    };
  }

  if (toolName === "edit" && /Found \d+ occurrences/i.test(text)) {
    return {
      errorType: "edit_text_not_unique",
      category: "invalid_input",
      retryable: true,
      recovery: "use_unique_context",
    };
  }

  if (/visible desktop control is already held/i.test(text)) {
    return {
      errorType: "resource_lease_held",
      category: "resource_conflict",
      retryable: false,
      recovery: "external_state_change_required",
    };
  }

  if (
    /environment variable is required|(?:API|api)[ _-]?key (?:is )?(?:required|missing)|No .*API key/i.test(
      text,
    )
  ) {
    return {
      errorType: "dependency_unavailable",
      category: "dependency_unavailable",
      retryable: false,
      recovery: "configuration_change_required",
    };
  }

  if (/error TS\d+|typecheck.*failed|test.*failed/i.test(text)) {
    return {
      errorType: "validation_failure",
      category: "validation_failure",
    };
  }

  return {
    errorType: "tool_error",
    category: "tool_error",
  };
}

export function toolFailureAttributes(failure: ToolFailure): Attributes {
  return {
    "error.type": failure.errorType,
    "pi.tool.failure.category": failure.category,
    ...(failure.code !== undefined
      ? { "pi.tool.failure.code": failure.code }
      : {}),
    ...(failure.retryable !== undefined
      ? { "pi.tool.failure.retryable": failure.retryable }
      : {}),
    ...(failure.recovery !== undefined
      ? { "pi.tool.failure.recovery": failure.recovery }
      : {}),
  };
}
