import { describe, it, expect } from "vitest";
import { renderCodeModeExecDescription } from "./description.js";

interface SampleTool {
  internalName: string;
  externalName: string;
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

const sampleTools: SampleTool[] = [
  {
    internalName: "read_file",
    externalName: "read_file",
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    },
  },
  {
    internalName: "apply_patch",
    externalName: "apply_patch",
    definition: {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch",
        parameters: { type: "object", properties: {} },
      },
    },
  },
  {
    internalName: "run_command",
    externalName: "run_command",
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command",
        parameters: { type: "object", properties: {} },
      },
    },
  },
];

describe("renderCodeModeExecDescription", () => {
  it("includes file-write guidance when patch binding exists", () => {
    const description = renderCodeModeExecDescription(sampleTools);
    expect(description).toContain(
      "Use `tools.apply_patch({ patch })` for structured edits",
    );
    expect(description).toContain(
      "Do not use Node fs APIs or shell redirection",
    );
    expect(description).toContain(
      "Use the provided file-edit tool bindings instead",
    );
  });

  it("warns against inventing tool names when a binding is missing", () => {
    const description = renderCodeModeExecDescription(sampleTools);
    expect(description).toContain("do not invent tool names");
  });
});
