import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunCompletedEvent,
  createRunStartedEvent,
  createTaskCompletedEvent,
} from "../../../src/domain/trace.js";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";
import { createJsonlTraceWriter } from "../../../src/infrastructure/adapters/jsonl-trace-writer.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createJsonlTraceWriter", () => {
  it("writes multiple trace events as valid JSONL lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-trace-"));
    tempDirs.push(root);

    const filePath = path.join(root, ".rundown", "runs", "run-1", "trace.jsonl");
    const writer = createJsonlTraceWriter(filePath, createNodeFileSystem());

    writer.write(
      createRunStartedEvent({
        timestamp: "2026-03-25T19:20:40.486Z",
        run_id: "run-1",
        payload: {
          command: "run",
          source: "TODO.md",
          worker: ["opencode", "run"],
          mode: "default",
          transport: "stdin",
          task_text: "Add trace tests",
          task_file: "TODO.md",
          task_line: 248,
        },
      }),
    );
    writer.write(
      createTaskCompletedEvent({
        timestamp: "2026-03-25T19:20:42.000Z",
        run_id: "run-1",
        payload: {
          task_text: "Add trace tests",
          task_file: "TODO.md",
          task_line: 248,
          total_duration_ms: 1514,
          phases_count: 3,
        },
      }),
    );
    writer.write(
      createRunCompletedEvent({
        timestamp: "2026-03-25T19:20:42.001Z",
        run_id: "run-1",
        payload: {
          status: "completed",
          total_duration_ms: 1515,
          total_phases: 3,
        },
      }),
    );

    const lines = fs
      .readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string });

    expect(lines).toHaveLength(3);
    expect(lines.map((event) => event.event_type)).toEqual([
      "run.started",
      "task.completed",
      "run.completed",
    ]);
  });

  it("flush is a no-op and does not throw", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-trace-"));
    tempDirs.push(root);

    const filePath = path.join(root, ".rundown", "runs", "run-2", "trace.jsonl");
    const writer = createJsonlTraceWriter(filePath, createNodeFileSystem());

    expect(() => writer.flush()).not.toThrow();

    writer.write(
      createRunCompletedEvent({
        timestamp: "2026-03-25T19:20:43.000Z",
        run_id: "run-2",
        payload: {
          status: "completed",
          total_duration_ms: 10,
          total_phases: 1,
        },
      }),
    );

    expect(() => writer.flush()).not.toThrow();
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8").trim()).not.toBe("");
  });
});
