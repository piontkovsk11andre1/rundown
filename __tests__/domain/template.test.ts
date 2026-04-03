import { describe, it, expect } from "vitest";
import {
  buildMemoryTemplateVars,
  buildTaskHierarchyTemplateVars,
  renderTemplate,
} from "../../src/domain/template.js";

describe("renderTemplate", () => {
  it("should replace known placeholders", () => {
    const template = "Task: {{task}}\nFile: {{file}}";
    const result = renderTemplate(template, {
      task: "Write tests",
      file: "tasks.md",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
    });

    expect(result).toBe("Task: Write tests\nFile: tasks.md");
  });

  it("should leave unknown placeholders intact", () => {
    const template = "{{task}} and {{unknownVar}}";
    const result = renderTemplate(template, {
      task: "Do something",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
    });

    expect(result).toBe("Do something and {{unknownVar}}");
  });

  it("should replace all occurrences", () => {
    const template = "{{task}} - again: {{task}}";
    const result = renderTemplate(template, {
      task: "hello",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
    });

    expect(result).toBe("hello - again: hello");
  });

  it("should handle numeric variables", () => {
    const template = "Line {{taskLine}}, Index {{taskIndex}}";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 5,
      taskLine: 42,
      source: "",
    });

    expect(result).toBe("Line 42, Index 5");
  });

  it("should include context", () => {
    const template = "Context:\n{{context}}\n---\nTask: {{task}}";
    const result = renderTemplate(template, {
      task: "Do it",
      file: "f.md",
      context: "# Heading\n\nSome context.",
      taskIndex: 0,
      taskLine: 5,
      source: "",
    });

    expect(result).toContain("# Heading\n\nSome context.");
    expect(result).toContain("Task: Do it");
  });

  it("should include optional verificationResult", () => {
    const template = "Verification: {{verificationResult}}";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      verificationResult: "Missing tests",
    });

    expect(result).toBe("Verification: Missing tests");
  });

  it("should replace known optional placeholders with an empty string when undefined", () => {
    const template = "Verification: {{verificationResult}}";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      verificationResult: undefined,
    });

    expect(result).toBe("Verification: ");
  });

  it("should render traceInstructions as empty when variable is empty", () => {
    const template = "Before\n{{traceInstructions}}\nAfter";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      traceInstructions: "",
    });

    expect(result).toBe("Before\n\nAfter");
  });

  it("should render traceInstructions content when set", () => {
    const template = "Before\n{{traceInstructions}}\nAfter";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      traceInstructions: "## Trace output\nTracing is active.",
    });

    expect(result).toBe("Before\n## Trace output\nTracing is active.\nAfter");
  });

  it("should render children and subItems as JSON strings", () => {
    const template = "Children={{children}}\nSubItems={{subItems}}";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      ...buildTaskHierarchyTemplateVars({
        children: [{ text: "child", checked: false, index: 1 }],
        subItems: [{ text: "note", line: 10, depth: 1 }],
      }),
    });

    expect(result).toBe("Children=[{\"text\":\"child\",\"checked\":false,\"index\":1}]\nSubItems=[{\"text\":\"note\",\"line\":10,\"depth\":1}]");
  });

  it("should default children and subItems to empty arrays", () => {
    expect(buildTaskHierarchyTemplateVars({})).toEqual({
      children: "[]",
      subItems: "[]",
    });
  });

  it("should build unavailable memory map vars when metadata is missing", () => {
    expect(buildMemoryTemplateVars({ memoryMetadata: null })).toEqual({
      memoryStatus: "unavailable",
      memoryFilePath: "",
      memorySummary: "",
      memoryIndexPath: "",
      memoryMap: JSON.stringify({
        status: "unavailable",
        filePath: "",
        summary: "",
        indexPath: "",
      }),
    });
  });

  it("should build available memory map vars from metadata", () => {
    expect(buildMemoryTemplateVars({
      memoryMetadata: {
        available: true,
        filePath: "/repo/.rundown/todo.md.memory.md",
        summary: "Known constraints and decisions",
      },
    })).toEqual({
      memoryStatus: "available",
      memoryFilePath: "/repo/.rundown/todo.md.memory.md",
      memorySummary: "Known constraints and decisions",
      memoryIndexPath: "/repo/.rundown/memory-index.json",
      memoryMap: JSON.stringify({
        status: "available",
        filePath: "/repo/.rundown/todo.md.memory.md",
        summary: "Known constraints and decisions",
        indexPath: "/repo/.rundown/memory-index.json",
      }),
    });
  });

  it("should derive memory index path for Windows-style memory paths", () => {
    const vars = buildMemoryTemplateVars({
      memoryMetadata: {
        available: true,
        filePath: "C:\\repo\\.rundown\\todo.md.memory.md",
      },
    });

    expect(vars.memoryIndexPath).toBe("C:\\repo\\.rundown\\memory-index.json");
    expect(vars.memoryMap).toBe(JSON.stringify({
      status: "available",
      filePath: "C:\\repo\\.rundown\\todo.md.memory.md",
      summary: "",
      indexPath: "C:\\repo\\.rundown\\memory-index.json",
    }));
  });
});
