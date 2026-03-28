import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
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

    const valid = await verify({
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

    const valid = await verify({
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

  it("accepts case-insensitive OK on successful verifier exit", async () => {
    const file = "Tasks.md";
    const task = makeTask(file);
    const verificationStore = createVerificationStore();

    runWorkerMock.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const valid = await verify({
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

    const valid = await verify({
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

    const valid = await verify({
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

    const valid = await verify({
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
});
