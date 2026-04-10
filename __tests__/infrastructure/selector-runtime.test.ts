import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectNextTask, selectTaskByLocation } from "../../src/infrastructure/selector.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("infrastructure selector", () => {
  it("supports old-first sorting when multiple files are provided", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const a = path.join(root, "a.md");
    const b = path.join(root, "b.md");

    fs.writeFileSync(a, "- [ ] Task A\n", "utf-8");
    fs.writeFileSync(b, "- [ ] Task B\n", "utf-8");

    const result = selectNextTask([a, b], "old-first");

    expect(result).not.toBeNull();
    expect(["Task A", "Task B"]).toContain(result?.[0]?.task.text);
  });

  it("selects first runnable task from sorted files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const first = path.join(root, "1-first.md");
    const second = path.join(root, "2-second.md");

    fs.writeFileSync(first, "- [ ] Parent\n  - [ ] Child\n", "utf-8");
    fs.writeFileSync(second, "- [ ] Later task\n", "utf-8");

    const result = selectNextTask([second, first], "name-sort");

    expect(result).not.toBeNull();
    expect(result?.[0]?.task.text).toBe("Child");
    expect(result?.[0]?.task.file).toBe(first);
    expect(result?.[0]?.contextBefore).toBe("- [ ] Parent");
  });

  it("returns runnable siblings under a parallel parent in document order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(
      file,
      [
        "- [ ] parallel: Setup",
        "  - [ ] Task 1",
        "  - [x] Task 2",
        "  - [ ] Task 3",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = selectNextTask([file], "name-sort");

    expect(result).not.toBeNull();
    expect(result?.map((entry) => entry.task.text)).toEqual(["Task 1", "Task 3"]);
    expect(result?.map((entry) => entry.task.line)).toEqual([2, 4]);
  });

  it("batches runnable siblings under composed-prefix parallel parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(
      file,
      [
        "- [ ] profile: fast, parallel: Setup",
        "  - [ ] Task 1",
        "  - [x] Task 2",
        "  - [ ] Task 3",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = selectNextTask([file], "name-sort");

    expect(result).not.toBeNull();
    expect(result?.map((entry) => entry.task.text)).toEqual(["Task 1", "Task 3"]);
    expect(result?.map((entry) => entry.task.line)).toEqual([2, 4]);
  });

  it("excludes already-checked siblings from a selected parallel batch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(
      file,
      [
        "- [ ] parallel: Setup",
        "  - [x] Task 1",
        "  - [ ] Task 2",
        "  - [x] Task 3",
        "  - [ ] Task 4",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = selectNextTask([file], "name-sort");

    expect(result).not.toBeNull();
    expect(result?.map((entry) => entry.task.text)).toEqual(["Task 2", "Task 4"]);
    expect(result?.map((entry) => entry.task.line)).toEqual([3, 5]);
  });

  it("still batches runnable siblings when the first parallel child is blocked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(
      file,
      [
        "- [ ] parallel: Setup",
        "  - [ ] Task 1",
        "    - [ ] Task 1.1",
        "  - [ ] Task 2",
        "  - [ ] Task 3",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = selectNextTask([file], "name-sort");

    expect(result).not.toBeNull();
    expect(result?.map((entry) => entry.task.text)).toEqual(["Task 2", "Task 3"]);
    expect(result?.map((entry) => entry.task.line)).toEqual([4, 5]);
  });

  it("returns exactly one task when runnable branches are not parallel", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(
      file,
      [
        "- [ ] Plan release",
        "  - [ ] Prepare changelog",
        "- [ ] Publish announcement",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = selectNextTask([file], "name-sort");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.task.text).toBe("Prepare changelog");
    expect(result?.[0]?.task.line).toBe(2);
  });

  it("returns null when no runnable tasks exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const only = path.join(root, "tasks.md");
    fs.writeFileSync(only, "- [x] Done\n", "utf-8");

    expect(selectNextTask([only], "old-first")).toBeNull();
  });

  it("selects task by file and line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(file, "# Tasks\n- [ ] Build\n- [ ] Ship\n", "utf-8");

    const selected = selectTaskByLocation(file, 3);

    expect(selected).not.toBeNull();
    expect(selected?.task.text).toBe("Ship");
    expect(selected?.contextBefore).toBe("# Tasks\n- [ ] Build");
  });

  it("returns null when line has no task", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-selector-"));
    tempDirs.push(root);

    const file = path.join(root, "tasks.md");
    fs.writeFileSync(file, "# Tasks\n- [ ] Build\n", "utf-8");

    expect(selectTaskByLocation(file, 1)).toBeNull();
  });
});
