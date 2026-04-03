import { describe, expect, it } from "vitest";
import type { Task } from "../../src/domain/parser.js";

import {
  getAutomationWorkerCommand,
  isOpenCodeWorkerCommand,
  toRuntimeTaskMetadata,
} from "../../src/application/run-task-execution.js";

describe("run-task-execution helpers", () => {
  it("normalizes opencode tui worker commands", () => {
    expect(getAutomationWorkerCommand(["opencode"], "tui")).toEqual(["opencode", "run"]);
    expect(getAutomationWorkerCommand(["opencode", "run"], "tui")).toEqual(["opencode", "run"]);
    expect(getAutomationWorkerCommand(["agent"], "tui")).toEqual(["agent"]);
    expect(getAutomationWorkerCommand(["opencode"], "wait")).toEqual(["opencode"]);
  });

  it("detects supported opencode executable names", () => {
    expect(isOpenCodeWorkerCommand([])).toBe(false);
    expect(isOpenCodeWorkerCommand(["opencode"])).toBe(true);
    expect(isOpenCodeWorkerCommand([String.raw`C:\tools\opencode.cmd`])).toBe(true);
    expect(isOpenCodeWorkerCommand(["/usr/local/bin/opencode.exe"])).toBe(true);
    expect(isOpenCodeWorkerCommand(["node"])).toBe(false);
  });

  it("maps a task into runtime metadata", () => {
    const task: Task = {
      text: "cli: echo hello",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 17,
      file: "/workspace/tasks.md",
      isInlineCli: true,
      depth: 0,
      children: [],
      subItems: [],
    };

    expect(toRuntimeTaskMetadata(task, "tasks.md")).toEqual({
      text: "cli: echo hello",
      file: "/workspace/tasks.md",
      line: 1,
      index: 0,
      source: "tasks.md",
    });
  });
});
