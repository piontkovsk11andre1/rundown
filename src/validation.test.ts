import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./parser.js";

const { runWorkerMock } = vi.hoisted(() => ({
  runWorkerMock: vi.fn(),
}));

vi.mock("./runner.js", () => ({
  runWorker: runWorkerMock,
}));

import { validate, validationFilePath } from "./validation.js";

function makeTask(file: string): Task {
  return {
    text: "Do the thing",
    checked: false,
    index: 2,
    line: 3,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file,
    isInlineCli: false,
    depth: 0,
  };
}

describe("validate", () => {
  afterEach(() => {
    runWorkerMock.mockReset();
  });

  it("removes stale sidecar before running validation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = validationFilePath(task);
    fs.writeFileSync(sidecar, "OK", "utf-8");

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const valid = await validate({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when validator exits non-zero even if sidecar says OK", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = validationFilePath(task);

    runWorkerMock.mockImplementation(async () => {
      fs.writeFileSync(sidecar, "OK", "utf-8");
      return { exitCode: 2, stdout: "", stderr: "validation failed" };
    });

    const valid = await validate({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts case-insensitive OK on successful validator exit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = validationFilePath(task);

    runWorkerMock.mockImplementation(async () => {
      fs.writeFileSync(sidecar, "ok", "utf-8");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const valid = await validate({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
