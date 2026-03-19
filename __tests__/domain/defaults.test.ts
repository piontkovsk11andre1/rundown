import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORRECT_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VALIDATE_TEMPLATE,
} from "../../src/domain/defaults.js";

const sharedPrefix = `{{context}}\n\n---\n\nThe Markdown above is the source document up to but not including the selected unchecked task.\n\n## Source file\n\n\`{{file}}\` (line {{taskLine}})\n\n## Selected task\n\n{{task}}\n`;

describe("default prompt templates", () => {
  it("starts every built-in template with the same shared prefix", () => {
    expect(DEFAULT_TASK_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_VALIDATE_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_CORRECT_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_PLAN_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
  });
});
