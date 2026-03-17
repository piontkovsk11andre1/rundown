import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template.js";

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
    const template = "{{task}} — again: {{task}}";
    const result = renderTemplate(template, {
      task: "hello",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
    });

    expect(result).toBe("hello — again: hello");
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

  it("should include optional validationResult", () => {
    const template = "Validation: {{validationResult}}";
    const result = renderTemplate(template, {
      task: "",
      file: "",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "",
      validationResult: "Missing tests",
    });

    expect(result).toBe("Validation: Missing tests");
  });
});
