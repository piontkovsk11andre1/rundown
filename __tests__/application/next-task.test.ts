import { describe, expect, it, vi } from "vitest";
import { createNextTask, type NextTaskDependencies, type NextTaskOptions } from "../../src/application/next-task.js";
import type { ApplicationOutputEvent, TaskSelectionResult } from "../../src/domain/ports/index.js";

describe("next-task", () => {
  it("emits contextual next-task metadata before task details", async () => {
    const selection = createSelectionResult({
      file: "tasks.md",
      line: 3,
      index: 1,
      text: "Ship release notes",
      source: [
        "# Tasks",
        "- [x] Done",
        "- [ ] Ship release notes",
        "- [ ] Follow-up",
        "",
      ].join("\n"),
    });
    const { dependencies, events } = createDependencies({
      files: ["tasks.md"],
      selection: [selection],
    });

    const nextTask = createNextTask(dependencies);
    const code = await nextTask(createOptions());

    expect(code).toBe(0);
    expect(events[0]).toEqual({ kind: "info", message: "Next task: 2/3 in tasks.md" });
    expect(events[1]).toEqual({
      kind: "task",
      task: selection.task,
      children: selection.task.children,
      subItems: selection.task.subItems,
    });
  });

  it("preserves no-task messaging", async () => {
    const { dependencies, events } = createDependencies({
      files: ["tasks.md"],
      selection: null,
    });

    const nextTask = createNextTask(dependencies);
    const code = await nextTask(createOptions());

    expect(code).toBe(3);
    expect(events).toEqual([{ kind: "info", message: "No unchecked tasks found." }]);
  });

  it("returns no-work when source resolves to no markdown files", async () => {
    const { dependencies, events } = createDependencies({
      files: [],
      selection: null,
    });

    const nextTask = createNextTask(dependencies);
    const code = await nextTask(createOptions({ source: "missing/**/*.md" }));

    expect(code).toBe(3);
    expect(events).toEqual([{ kind: "warn", message: "No Markdown files found matching: missing/**/*.md." }]);
  });
});

function createDependencies(options: {
  files: string[];
  selection: TaskSelectionResult[] | null;
}): {
  dependencies: NextTaskDependencies;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];

  const dependencies: NextTaskDependencies = {
    sourceResolver: {
      resolveSources: vi.fn(async () => options.files),
    },
    taskSelector: {
      selectNextTask: vi.fn(() => options.selection),
      selectTaskByLocation: vi.fn(() => null),
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return { dependencies, events };
}

function createOptions(overrides: Partial<NextTaskOptions> = {}): NextTaskOptions {
  return {
    source: "tasks.md",
    sortMode: "none",
    ...overrides,
  };
}

function createSelectionResult(options: {
  file: string;
  line: number;
  index: number;
  text: string;
  source: string;
}): TaskSelectionResult {
  return {
    source: options.source,
    contextBefore: "",
    task: {
      text: options.text,
      checked: false,
      index: options.index,
      line: options.line,
      column: 1,
      offsetStart: 0,
      offsetEnd: options.source.length,
      file: options.file,
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    },
  };
}
