import { describe, expect, it, vi } from "vitest";
import { createExploreTasks, type ExploreTasksDependencies, type ExploreTasksOptions } from "../../src/application/explore-tasks.js";
import type { ApplicationOutputEvent, FileSystem } from "../../src/domain/ports/index.js";

describe("explore-tasks", () => {
  it("returns exit code 3 when source glob matches no files", async () => {
    const { dependencies, events, fileSystem } = createDependencies({
      files: [],
      fileContentByPath: {},
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ source: "missing/**/*.md" }));

    expect(code).toBe(3);
    expect(fileSystem.readText).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "warn",
      message: "No Markdown files found matching: missing/**/*.md.",
    });
  });

  it("default behavior: multiple files with mixed checked/unchecked tasks produce per-file and aggregate totals", async () => {
    const { dependencies, events } = createDependencies({
      files: ["a.md", "b.md", "empty.md"],
      fileContentByPath: {
        "a.md": "- [ ] A\n- [x] B\n",
        "b.md": "- [x] C\n- [x] D\n- [ ] E\n",
        "empty.md": "# Notes\nNo tasks here.\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions());

    expect(code).toBe(0);
    const fileSummaries = events.filter(
      (event): event is Extract<ApplicationOutputEvent, { kind: "explore-file-summary" }> =>
        event.kind === "explore-file-summary",
    );

    expect(fileSummaries).toHaveLength(3);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "a.md", total: 2, checked: 1, unchecked: 1, percent: 50 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "b.md", total: 3, checked: 2, unchecked: 1, percent: 67 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "5 tasks across 3 files: 3 checked, 2 unchecked (60%).",
    });
  });

  it("includes files with all tasks checked as 100% complete when no filter is set", async () => {
    const { dependencies, events } = createDependencies({
      files: ["all-done.md", "mixed.md"],
      fileContentByPath: {
        "all-done.md": "- [x] Done one\n- [x] Done two\n",
        "mixed.md": "- [x] Done\n- [ ] Todo\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions());

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "all-done.md", total: 2, checked: 2, unchecked: 0, percent: 100 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "mixed.md", total: 2, checked: 1, unchecked: 1, percent: 50 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "4 tasks across 2 files: 3 checked, 1 unchecked (75%).",
    });
  });

  it("applies --file-status filter and skips non-matching files", async () => {
    const { dependencies, events } = createDependencies({
      files: ["complete.md", "incomplete.md", "empty.md"],
      fileContentByPath: {
        "complete.md": "- [x] Done\n",
        "incomplete.md": "- [ ] Todo\n",
        "empty.md": "# Notes\nNo tasks here.\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ fileStatus: ["complete,incomplete"] }));

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "complete.md", total: 1, checked: 1, unchecked: 0, percent: 100 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "incomplete.md", total: 1, checked: 0, unchecked: 1, percent: 0 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "2 tasks across 2 files: 1 checked, 1 unchecked (50%).",
    });
  });

  it("filters --file-status complete to only 100% completion files", async () => {
    const { dependencies, events } = createDependencies({
      files: ["complete-one.md", "complete-two.md", "incomplete.md", "empty.md"],
      fileContentByPath: {
        "complete-one.md": "- [x] Done\n",
        "complete-two.md": "- [x] Done one\n- [x] Done two\n",
        "incomplete.md": "- [x] Done\n- [ ] Todo\n",
        "empty.md": "# Notes\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ fileStatus: ["complete"] }));

    expect(code).toBe(0);
    const fileSummaries = events.filter(
      (event): event is Extract<ApplicationOutputEvent, { kind: "explore-file-summary" }> =>
        event.kind === "explore-file-summary",
    );
    expect(fileSummaries).toHaveLength(2);
    expect(fileSummaries.every((event) => event.summary.percent === 100)).toBe(true);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "complete-one.md", total: 1, checked: 1, unchecked: 0, percent: 100 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "complete-two.md", total: 2, checked: 2, unchecked: 0, percent: 100 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "incomplete.md", total: 2, checked: 1, unchecked: 1, percent: 50 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "3 tasks across 2 files: 3 checked, 0 unchecked (100%).",
    });
  });

  it("filters --file-status incomplete to only files with unchecked tasks", async () => {
    const { dependencies, events } = createDependencies({
      files: ["complete.md", "incomplete-zero.md", "incomplete-mixed.md", "empty.md"],
      fileContentByPath: {
        "complete.md": "- [x] Done\n",
        "incomplete-zero.md": "- [ ] Todo one\n- [ ] Todo two\n",
        "incomplete-mixed.md": "- [x] Done\n- [ ] Todo\n",
        "empty.md": "# Notes\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ fileStatus: ["incomplete"] }));

    expect(code).toBe(0);
    const fileSummaries = events.filter(
      (event): event is Extract<ApplicationOutputEvent, { kind: "explore-file-summary" }> =>
        event.kind === "explore-file-summary",
    );
    expect(fileSummaries).toHaveLength(2);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "incomplete-zero.md", total: 2, checked: 0, unchecked: 2, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "incomplete-mixed.md", total: 2, checked: 1, unchecked: 1, percent: 50 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "complete.md", total: 1, checked: 1, unchecked: 0, percent: 100 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "4 tasks across 2 files: 1 checked, 3 unchecked (25%).",
    });
  });

  it("classifies files with only checked tasks as complete for --file-status filtering", async () => {
    const { dependencies, events } = createDependencies({
      files: ["checked-only.md", "incomplete.md", "empty.md"],
      fileContentByPath: {
        "checked-only.md": "- [x] Done one\n- [x] Done two\n",
        "incomplete.md": "- [ ] Todo\n",
        "empty.md": "# Notes\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ fileStatus: ["complete"] }));

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "checked-only.md", total: 2, checked: 2, unchecked: 0, percent: 100 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "incomplete.md", total: 1, checked: 0, unchecked: 1, percent: 0 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "2 tasks across 1 file: 2 checked, 0 unchecked (100%).",
    });
  });

  it("includes zero-task files when --file-status includes empty", async () => {
    const { dependencies, events } = createDependencies({
      files: ["complete.md", "empty.md"],
      fileContentByPath: {
        "complete.md": "- [x] Done\n",
        "empty.md": "# Notes\nNo tasks here.\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ fileStatus: ["empty"] }));

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "empty.md", total: 0, checked: 0, unchecked: 0, percent: 0 },
    });
    expect(events).not.toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "complete.md", total: 1, checked: 1, unchecked: 0, percent: 100 },
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "0 tasks across 1 file: 0 checked, 0 unchecked (0%).",
    });
  });

  it("emits unchecked task events with blocked state and nested detail when compact is disabled", async () => {
    const markdown = [
      "- [ ] Parent task",
      "  - [ ] Child task",
      "  - Parent detail",
      "- [x] Done task",
      "",
    ].join("\n");
    const { dependencies, events } = createDependencies({
      files: ["tasks.md"],
      fileContentByPath: { "tasks.md": markdown },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ compact: false }));

    expect(code).toBe(0);
    const taskEvents = events.filter((event): event is Extract<ApplicationOutputEvent, { kind: "task" }> => event.kind === "task");
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[0]?.task.text).toBe("Parent task");
    expect(taskEvents[0]?.blocked).toBe(true);
    expect(taskEvents[0]?.task.children.map((child) => child.text)).toEqual(["Child task"]);
    expect(taskEvents[0]?.task.subItems.map((subItem) => subItem.text)).toEqual(["Parent detail"]);
    expect(taskEvents[0]?.children?.map((child) => child.text)).toEqual(["Child task"]);
    expect(taskEvents[0]?.subItems?.map((subItem) => subItem.text)).toEqual(["Parent detail"]);
    expect(taskEvents[0]?.children).toBe(taskEvents[0]?.task.children);
    expect(taskEvents[0]?.subItems).toBe(taskEvents[0]?.task.subItems);
    expect(taskEvents[1]?.task.text).toBe("Child task");
    expect(taskEvents[1]?.blocked).toBe(false);
    expect(taskEvents[1]?.task.children).toEqual([]);
    expect(taskEvents[1]?.task.subItems).toEqual([]);
    expect(taskEvents[1]?.children).toEqual([]);
    expect(taskEvents[1]?.subItems).toEqual([]);
  });

  it("omits per-task events when compact output is enabled", async () => {
    const { dependencies, events } = createDependencies({
      files: ["tasks.md"],
      fileContentByPath: {
        "tasks.md": "- [ ] Todo\n- [x] Done\n",
      },
    });

    const exploreTasks = createExploreTasks(dependencies);
    const code = await exploreTasks(createOptions({ compact: true }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "task")).toBe(false);
    expect(events).toContainEqual({
      kind: "explore-file-summary",
      summary: { file: "tasks.md", total: 2, checked: 1, unchecked: 1, percent: 50 },
    });
  });

  it("supports --sort modes: name-sort, old-first, new-first, and none", async () => {
    const files = ["2-second.md", "10-third.md", "1-first.md"];
    const fileContentByPath = {
      "1-first.md": "- [ ] First\n",
      "2-second.md": "- [ ] Second\n",
      "10-third.md": "- [ ] Third\n",
    };
    const birthtimeByPath = {
      "1-first.md": 300,
      "2-second.md": 100,
      "10-third.md": 200,
    };

    const noneOrder = await runAndGetFileOrder({ files, fileContentByPath, birthtimeByPath, sortMode: "none" });
    const nameSortOrder = await runAndGetFileOrder({ files, fileContentByPath, birthtimeByPath, sortMode: "name-sort" });
    const oldFirstOrder = await runAndGetFileOrder({ files, fileContentByPath, birthtimeByPath, sortMode: "old-first" });
    const newFirstOrder = await runAndGetFileOrder({ files, fileContentByPath, birthtimeByPath, sortMode: "new-first" });

    expect(noneOrder).toEqual(["2-second.md", "10-third.md", "1-first.md"]);
    expect(nameSortOrder).toEqual(["1-first.md", "2-second.md", "10-third.md"]);
    expect(oldFirstOrder).toEqual(["2-second.md", "10-third.md", "1-first.md"]);
    expect(newFirstOrder).toEqual(["1-first.md", "10-third.md", "2-second.md"]);
  });
});

async function runAndGetFileOrder(options: {
  files: string[];
  fileContentByPath: Record<string, string>;
  birthtimeByPath: Record<string, number>;
  sortMode: ExploreTasksOptions["sortMode"];
}): Promise<string[]> {
  const { dependencies, events } = createDependencies({
    files: options.files,
    fileContentByPath: options.fileContentByPath,
    birthtimeByPath: options.birthtimeByPath,
  });

  const exploreTasks = createExploreTasks(dependencies);
  const code = await exploreTasks(createOptions({ sortMode: options.sortMode, compact: true }));
  expect(code).toBe(0);

  return events
    .filter((event): event is Extract<ApplicationOutputEvent, { kind: "explore-file-summary" }> => event.kind === "explore-file-summary")
    .map((event) => event.summary.file);
}

function createDependencies(options: {
  files: string[];
  fileContentByPath: Record<string, string>;
  birthtimeByPath?: Record<string, number>;
}): {
  dependencies: ExploreTasksDependencies;
  events: ApplicationOutputEvent[];
  sourceResolver: ExploreTasksDependencies["sourceResolver"];
  fileSystem: FileSystem;
} {
  const events: ApplicationOutputEvent[] = [];

  const sourceResolver: ExploreTasksDependencies["sourceResolver"] = {
    resolveSources: vi.fn(async () => options.files),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn(() => true),
    readText: vi.fn((filePath: string) => options.fileContentByPath[filePath] ?? ""),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn((filePath: string) => ({
      isFile: true,
      isDirectory: false,
      birthtimeMs: options.birthtimeByPath?.[filePath] ?? 0,
      mtimeMs: 0,
    })),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const dependencies: ExploreTasksDependencies = {
    fileSystem,
    sourceResolver,
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    sourceResolver,
    fileSystem,
  };
}

function createOptions(overrides: Partial<ExploreTasksOptions> = {}): ExploreTasksOptions {
  return {
    source: "*.md",
    sortMode: "none",
    ...overrides,
  };
}
