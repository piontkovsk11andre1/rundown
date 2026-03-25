import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";

const { runWorkerMock } = vi.hoisted(() => ({
  runWorkerMock: vi.fn(),
}));

vi.mock("../../src/infrastructure/runner.js", () => ({
  runWorker: runWorkerMock,
}));

import { verify, verificationFilePath } from "../../src/infrastructure/verification.js";

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

describe("verify", () => {
  afterEach(() => {
    runWorkerMock.mockReset();
  });

  it("removes stale sidecar before running verification", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);
    fs.writeFileSync(sidecar, "OK", "utf-8");

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "NOT_OK: still missing tests", stderr: "" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("still missing tests");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when verifier exits non-zero and writes failure reason", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    runWorkerMock.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "validation failed" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("validation failed");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts case-insensitive OK on successful verifier exit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(true);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("OK");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
