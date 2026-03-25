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

import {
  isVerificationOk,
  readVerificationFile,
  removeVerificationFile,
  verify,
  verificationFilePath,
  writeVerificationFile,
} from "../../src/infrastructure/verification.js";

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

  it("normalizes empty NOT_OK output into a default failure message", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "NOT_OK:   ", stderr: "" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
    });

    expect(valid).toBe(false);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("Verification failed (no details).");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses stderr when verification exits successfully without stdout", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "missing proof" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
    });

    expect(valid).toBe(false);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("missing proof");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a default message when verifier returns empty output", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    fs.writeFileSync(file, "# Tasks\n", "utf-8");

    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const valid = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
    });

    expect(valid).toBe(false);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe(
      "Verification worker returned empty output. Expected OK or a short failure reason.",
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("verification helpers", () => {
  it("writes, reads, checks, and removes verification sidecars", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validation-"));
    const file = path.join(tempDir, "Tasks.md");
    const task = makeTask(file);
    const sidecar = verificationFilePath(task);

    expect(readVerificationFile(task)).toBeNull();
    expect(isVerificationOk(task)).toBe(false);

    writeVerificationFile(task, "  OK  ");
    expect(readVerificationFile(task)).toBe("OK");
    expect(isVerificationOk(task)).toBe(true);

    writeVerificationFile(task, "   ");
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("Verification failed (no details).");

    removeVerificationFile(task);
    expect(fs.existsSync(sidecar)).toBe(false);
    removeVerificationFile(task);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
