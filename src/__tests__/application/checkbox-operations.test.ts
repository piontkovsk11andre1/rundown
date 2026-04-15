import { describe, it, expect } from "vitest";
import {
  advanceForLoopUsingFileSystem,
  insertTraceStatisticsUsingFileSystem,
  syncForLoopMetadataItemsUsingFileSystem,
} from "../../application/checkbox-operations.ts";
import { parseTasks } from "../../domain/parser.ts";
import type { Task } from "../../domain/parser.ts";
import type { FileSystem } from "../../domain/ports/file-system.ts";

class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  public writeCount = 0;

  public constructor(initialFiles: Record<string, string>) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.files.set(filePath, content);
    }
  }

  public exists(path: string): boolean {
    return this.files.has(path);
  }

  public readText(filePath: string): string {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }

    return value;
  }

  public writeText(filePath: string, content: string): void {
    this.writeCount += 1;
    this.files.set(filePath, content);
  }

  public mkdir(): void {
    throw new Error("Not implemented");
  }

  public readdir(): [] {
    return [];
  }

  public stat(): null {
    return null;
  }

  public unlink(): void {
    throw new Error("Not implemented");
  }

  public rm(): void {
    throw new Error("Not implemented");
  }
}

function createTask(file: string, line: number): Task {
  return {
    text: "Do this",
    checked: true,
    index: 0,
    line,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

describe("insertTraceStatisticsUsingFileSystem", () => {
  it("inserts statistics with normalized child indentation", () => {
    const file = "task.md";
    const source = [
      "- [x] Parent task",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    insertTraceStatisticsUsingFileSystem(
      createTask(file, 1),
      [
        "    - total time: 522s",
        "        - execution: 5s",
        "    - tokens estimated: 429391",
      ],
      fileSystem,
    );

    expect(fileSystem.readText(file)).toBe([
      "- [x] Parent task",
      "  - total time: 522s",
      "    - execution: 5s",
      "  - tokens estimated: 429391",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("places statistics after existing descendant sub-items", () => {
    const file = "task.md";
    const source = [
      "- [x] Parent task",
      "  - note: keep me",
      "    - nested detail",
      "  - [ ] Child task",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    insertTraceStatisticsUsingFileSystem(
      createTask(file, 1),
      ["    - total time: 1s"],
      fileSystem,
    );

    expect(fileSystem.readText(file)).toBe([
      "- [x] Parent task",
      "  - note: keep me",
      "    - nested detail",
      "  - [ ] Child task",
      "  - total time: 1s",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("is idempotent when statistics already exist", () => {
    const file = "task.md";
    const source = [
      "- [x] Parent task",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });
    const statistics = ["    - total time: 3s", "        - execution: 2s"];

    insertTraceStatisticsUsingFileSystem(createTask(file, 1), statistics, fileSystem);
    insertTraceStatisticsUsingFileSystem(createTask(file, 1), statistics, fileSystem);

    expect(fileSystem.writeCount).toBe(1);
    expect(fileSystem.readText(file)).toBe([
      "- [x] Parent task",
      "  - total time: 3s",
      "    - execution: 2s",
      "- [ ] Next task",
    ].join("\n"));
  });
});

describe("advanceForLoopUsingFileSystem", () => {
  function resolveLoopTask(fileSystem: InMemoryFileSystem, file: string): Task {
    const tasks = parseTasks(fileSystem.readText(file), file);
    const loopTask = tasks.find((task) => task.text.toLowerCase().startsWith("for:"));
    if (!loopTask) {
      throw new Error("Loop task not found in test source.");
    }

    return loopTask;
  }

  it("resets children before setting initial for-current cursor", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - [x] Do this",
      "  - [x] Do that",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    const transition = advanceForLoopUsingFileSystem(resolveLoopTask(fileSystem, file), fileSystem);

    expect(transition).toEqual({
      advanced: true,
      completed: false,
      current: "This",
      remainingItems: 1,
    });
    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("advances to next item by atomically resetting children and updating for-current", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [x] Do this",
      "  - [x] Do that",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    const transition = advanceForLoopUsingFileSystem(resolveLoopTask(fileSystem, file), fileSystem);

    expect(transition).toEqual({
      advanced: true,
      completed: false,
      current: "That",
      remainingItems: 0,
    });
    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: That",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("recovers from stale for-current metadata on resume by rewinding cursor and resetting children", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: Missing",
      "  - [x] Do this",
      "  - [x] Do that",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    const transition = advanceForLoopUsingFileSystem(resolveLoopTask(fileSystem, file), fileSystem);

    expect(transition).toEqual({
      advanced: true,
      completed: false,
      current: "This",
      remainingItems: 1,
    });
    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("finalizes loop by removing for-current while keeping baked for-item metadata", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: That",
      "  - [x] Do this",
      "  - [x] Do that",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    const transition = advanceForLoopUsingFileSystem(resolveLoopTask(fileSystem, file), fileSystem);

    expect(transition).toEqual({
      advanced: false,
      completed: true,
      current: undefined,
      remainingItems: 0,
    });
    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - [x] Do this",
      "  - [x] Do that",
      "- [ ] Next task",
    ].join("\n"));
  });
});

describe("syncForLoopMetadataItemsUsingFileSystem", () => {
  function resolveLoopTask(fileSystem: InMemoryFileSystem, file: string): Task {
    const tasks = parseTasks(fileSystem.readText(file), file);
    const loopTask = tasks.find((task) => task.text.toLowerCase().startsWith("for:"));
    if (!loopTask) {
      throw new Error("Loop task not found in test source.");
    }

    return loopTask;
  }

  it("replaces manual metadata with canonical baked for-item values", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: ManualOne",
      "  - for-current: ManualOne",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    syncForLoopMetadataItemsUsingFileSystem(
      resolveLoopTask(fileSystem, file),
      ["This", "That", "This"],
      fileSystem,
    );

    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - for-item: This",
      "  - for-item: That",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("removes pre-existing manual loop metadata when baked list is empty", () => {
    const file = "task.md";
    const source = [
      "- [ ] for: All controllers",
      "  - for-item: ManualOne",
      "  - for-current: ManualOne",
      "  - [ ] Do this",
      "- [ ] Next task",
    ].join("\n");
    const fileSystem = new InMemoryFileSystem({ [file]: source });

    syncForLoopMetadataItemsUsingFileSystem(resolveLoopTask(fileSystem, file), [], fileSystem);

    expect(fileSystem.readText(file)).toBe([
      "- [ ] for: All controllers",
      "  - [ ] Do this",
      "- [ ] Next task",
    ].join("\n"));
  });
});
