import { describe, it, expect } from "vitest";
import { ToolRuntime, formatUnknownToolMessage } from "./runtime.js";
import type { ToolExecutionContext, ToolSpec } from "@step-cli/protocol";

function makeSpec(name: string): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `${name} test tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    security: { risk: "read" },
    parseArgs: () => ({}),
    execute: async () => ({ ok: true, summary: "ok" }),
  };
}

const execContext: ToolExecutionContext = {
  workspaceRoot: "/",
  commandTimeoutMs: 1_000,
  commandOutputLimit: 1_000,
};

describe("ToolRuntime unknown tool errors", () => {
  it("auto-repairs a close top-level tool name instead of returning UNKNOWN_TOOL", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeTool("readfile", "{}");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
    expect(result.error?.message).toContain(
      "call exec and use tools.read_file(...) inside it",
    );
  });

  it("auto-repairs a close nested tool name inside exec", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeNestedTool("readfile", "{}");
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("ok");
  });

  it("preserves code-mode top-level UNKNOWN_TOOL behavior when only nested tools match", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeTool("readfile", "{}");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
    expect(result.error?.message).toContain(
      "call exec and use tools.read_file(...) inside it",
    );
  });

  it("adds plan mode guidance when unknown tools are rejected in plan mode", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
      { planMode: true },
    );
    const result = await runtime.executeTool("read_file", "{}");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PLAN_MODE_BLOCKED");
    expect(result.error?.message).toContain(
      "read_file is blocked in plan mode.",
    );
    expect(result.error?.message).toContain(
      "Finish your read-only investigation, then call exit_plan_mode to submit the plan.",
    );
  });

  it("reports unknown nested calls with the real nested tool list", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeNestedTool("readfile", "{}");
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("ok");
  });
});

describe("formatUnknownToolMessage", () => {
  const codeModeTools = {
    name: "read_file",
    scope: "top-level" as const,
    availableTools: ["exec", "wait"],
    nestedToolBindings: [
      "apply_patch",
      "edit_file",
      "list_directory",
      "read_file",
      "run_command",
    ],
  };

  it("routes a hallucinated top-level call to its nested code-mode binding", () => {
    const message = formatUnknownToolMessage(codeModeTools);
    expect(message).toContain("Tool 'read_file' is not registered.");
    expect(message).toContain("Available tools: exec, wait.");
    expect(message).toContain(
      "call exec and use tools.read_file(...) inside it",
    );
    expect(message).not.toContain("Nested bindings:");
  });

  it("lists all nested bindings when no close match exists", () => {
    const message = formatUnknownToolMessage({
      ...codeModeTools,
      name: "open_browser",
    });
    expect(message).toContain("Tool 'open_browser' is not registered.");
    expect(message).toContain("Available tools: exec, wait.");
    expect(message).toContain("Nested bindings:");
  });

  it("caps very long tool lists", () => {
    const many = Array.from({ length: 30 }, (_, index) => `tool_${index}`);
    const message = formatUnknownToolMessage({
      name: "nope",
      scope: "top-level",
      availableTools: many,
    });
    expect(message).toContain("tool_23 (+6 more).");
    expect(message).not.toContain("tool_24");
  });

  it("includes plan mode guidance when requested", () => {
    const message = formatUnknownToolMessage({
      name: "write_file",
      scope: "top-level",
      availableTools: ["read_file", "search_files"],
      planMode: true,
    });
    expect(message).toContain("Tool 'write_file' is not registered.");
    expect(message).toContain("This session is read-only planning mode.");
    expect(message).toContain(
      "only inspect, analyze, and give concrete implementation guidance",
    );
  });

  it("uses PLAN_MODE_BLOCKED code and summary when planModeBlocked is true", () => {
    const message = formatUnknownToolMessage({
      name: "run_command",
      scope: "top-level",
      availableTools: ["read_file", "search_files"],
      planModeBlocked: true,
    });
    expect(message).toContain("run_command is blocked in plan mode.");
    expect(message).toContain(
      "Finish your read-only investigation, then call exit_plan_mode to submit the plan.",
    );
    expect(message).not.toContain("Tool 'run_command' is not registered.");
  });

  it("falls back to UNKNOWN_TOOL wording when plan mode is not active", () => {
    const message = formatUnknownToolMessage({
      name: "run_command",
      scope: "top-level",
      availableTools: ["read_file", "search_files"],
    });
    expect(message).toContain("Tool 'run_command' is not registered.");
    expect(message).not.toContain("is blocked in plan mode.");
  });
});
