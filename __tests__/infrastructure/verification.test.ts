import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { CommandExecutor } from "../../src/domain/ports/command-executor.js";
import type { VerificationStore } from "../../src/domain/ports/verification-store.js";

const { runWorkerMock } = vi.hoisted(() => ({
  runWorkerMock: vi.fn(),
}));

vi.mock("../../src/infrastructure/runner.js", () => ({
  runWorker: runWorkerMock,
}));

import {
  verify,
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
    children: [],
    subItems: [],
  };
}

function createVerificationStore(): VerificationStore {
  return {
    write: vi.fn(),
    read: vi.fn(() => null),
    remove: vi.fn(),
  };
}

describe("verify", () => {
  afterEach(() => {
    runWorkerMock.mockReset();
  });

  it("removes prior verification state before running verification", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "NOT_OK: still missing tests", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(verificationStore.remove).toHaveBeenCalledWith(task);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "still missing tests");
  });

  it("returns false when verifier exits non-zero and writes failure reason", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "validation failed" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "validation failed");
  });

  it("uses non-zero exit fallback when verifier returns no stdout/stderr", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 7, stdout: "", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(false);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "Verification worker exited with code 7.");
  });

  it("accepts case-insensitive OK on successful verifier exit", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
      mode: "wait",
      transport: "file",
    });

    expect(valid).toBe(true);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "OK");
  });

  it("normalizes empty NOT_OK output into a default failure message", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "NOT_OK:   ", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(valid).toBe(false);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "Verification failed (no details).");
  });

  it("uses stderr when verification exits successfully without stdout", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "missing proof" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(valid).toBe(false);
    expect(verificationStore.write).toHaveBeenCalledWith(task, "missing proof");
  });

  it("writes a default message when verifier returns empty output", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(valid).toBe(false);
    expect(verificationStore.write).toHaveBeenCalledWith(
      task,
      "Verification worker returned empty output. Expected OK or a short failure reason.",
    );
  });

  it("renders children and subItems template vars as JSON", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    task.children = [{
      text: "Child",
      checked: false,
      index: 3,
      line: 4,
      column: 1,
      offsetStart: 0,
      offsetEnd: 0,
      file,
      isInlineCli: false,
      depth: 1,
      children: [],
      subItems: [],
    }];
    task.subItems = [{ text: "Note", line: 5, depth: 1 }];
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });

    await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{children}}|{{subItems}}",
      command: ["worker"],
      verificationStore,
    });

    expect(runWorkerMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "[{\"text\":\"Child\",\"checked\":false,\"index\":3,\"line\":4,\"column\":1,\"offsetStart\":0,\"offsetEnd\":0,\"file\":\"Tasks.md\",\"isInlineCli\":false,\"depth\":1,\"children\":[],\"subItems\":[]}]|[{\"text\":\"Note\",\"line\":5,\"depth\":1}]",
    }));
  });

  it("keeps hierarchy template vars authoritative over injected template vars", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    task.children = [{
      text: "Child",
      checked: false,
      index: 3,
      line: 4,
      column: 1,
      offsetStart: 0,
      offsetEnd: 0,
      file,
      isInlineCli: false,
      depth: 1,
      children: [],
      subItems: [],
    }];
    task.subItems = [{ text: "Note", line: 5, depth: 1 }];
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });

    await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{children}}|{{subItems}}",
      command: ["worker"],
      verificationStore,
      templateVars: {
        children: "[{\"text\":\"Injected child\"}]",
        subItems: "[{\"text\":\"Injected note\"}]",
      },
    });

    expect(runWorkerMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "[{\"text\":\"Child\",\"checked\":false,\"index\":3,\"line\":4,\"column\":1,\"offsetStart\":0,\"offsetEnd\":0,\"file\":\"Tasks.md\",\"isInlineCli\":false,\"depth\":1,\"children\":[],\"subItems\":[]}]|[{\"text\":\"Note\",\"line\":5,\"depth\":1}]",
    }));
  });

  it("keeps plain task text in {{task}} template values", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    task.text = "rundown: Child.md --verify";
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });

    await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(runWorkerMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "rundown: Child.md --verify",
    }));
  });

  it("expands cli fenced blocks after template rendering", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "generated output",
        stderr: "",
      })),
    };

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });

    const { valid } = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "```cli\necho {{task}}\n```",
      command: ["worker"],
      verificationStore,
      cwd: "/repo",
      cliBlockExecutor,
      cliExecutionOptions: { timeoutMs: 42 },
    });

    expect(valid).toBe(true);
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith("echo Do the thing", "/repo", { timeoutMs: 42 });
    expect(runWorkerMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "<command>echo Do the thing</command>\n<output>\ngenerated output\n</output>",
    }));
  });

  it("accepts OK on the last line when preamble is present and sets formatWarning", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({
      exitCode: 0,
      stdout: "The task is complete. WorkerConfigCommandName already includes verify.\nOK",
      stderr: "",
    });

    const result = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(result.valid).toBe(true);
    expect(result.formatWarning).toBeDefined();
    expect(verificationStore.write).toHaveBeenCalledWith(task, "OK");
  });

  it("accepts NOT_OK on the last line when preamble is present", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({
      exitCode: 0,
      stdout: "I checked the code and found issues.\nNOT_OK: missing unit tests",
      stderr: "",
    });

    const result = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(result.valid).toBe(false);
    expect(result.formatWarning).toBeDefined();
    expect(verificationStore.write).toHaveBeenCalledWith(task, "missing unit tests");
  });

  it("accepts backtick-wrapped OK verdict", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({
      exitCode: 0,
      stdout: "`OK`",
      stderr: "",
    });

    const result = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(result.valid).toBe(true);
    expect(result.formatWarning).toBeUndefined();
    expect(verificationStore.write).toHaveBeenCalledWith(task, "OK");
  });

  it("accepts backtick-wrapped OK with preamble", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({
      exitCode: 0,
      stdout: "Everything looks good.\n`OK`",
      stderr: "",
    });

    const result = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(result.valid).toBe(true);
    expect(result.formatWarning).toBeDefined();
    expect(verificationStore.write).toHaveBeenCalledWith(task, "OK");
  });

  it("returns no formatWarning for clean single-line OK", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "OK", stderr: "" });

    const result = await verify({
      task,
      source: file,
      contextBefore: "",
      template: "{{task}}",
      command: ["worker"],
      verificationStore,
    });

    expect(result.valid).toBe(true);
    expect(result.formatWarning).toBeUndefined();
  });
});
