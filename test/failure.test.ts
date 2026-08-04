import { describe, expect, it } from "vitest";
import {
  classifyToolFailure,
  toolFailureAttributes,
} from "../src/failure.js";

function result(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}

describe("classifyToolFailure", () => {
  it("classifies process exits without guessing retryability", () => {
    const failure = classifyToolFailure(
      "bash",
      result("output\n\nCommand exited with code 2"),
    );
    expect(failure).toEqual({
      errorType: "process_exit",
      category: "process_exit",
      code: 2,
    });
    expect(toolFailureAttributes(failure)).toMatchObject({
      "error.type": "process_exit",
      "pi.tool.failure.category": "process_exit",
      "pi.tool.failure.code": 2,
    });
  });

  it("requires a reread after an exact edit conflict", () => {
    expect(
      classifyToolFailure(
        "edit",
        result(
          "Could not find the exact text in file.ts. The old text must match exactly including all whitespace and newlines.",
        ),
      ),
    ).toEqual({
      errorType: "edit_text_not_found",
      category: "mutation_conflict",
      retryable: true,
      recovery: "reread_required",
    });
  });

  it("classifies missing configuration as unavailable", () => {
    expect(
      classifyToolFailure(
        "bash",
        result("Error: BRAVE_API_KEY environment variable is required."),
      ),
    ).toEqual({
      errorType: "dependency_unavailable",
      category: "dependency_unavailable",
      retryable: false,
      recovery: "configuration_change_required",
    });
  });

  it("classifies a shared desktop lease conflict", () => {
    expect(
      classifyToolFailure(
        "deskpal_launch_app",
        result("visible desktop control is already held by deskpal pid 42"),
      ),
    ).toEqual({
      errorType: "resource_lease_held",
      category: "resource_conflict",
      retryable: false,
      recovery: "external_state_change_required",
    });
  });

  it("uses bounded generic values for unknown failures", () => {
    expect(classifyToolFailure("custom", result("arbitrary failure"))).toEqual({
      errorType: "tool_error",
      category: "tool_error",
    });
  });
});
