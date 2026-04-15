import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolChain } from "../../src/application/tool-execution.js";
import type { PrefixChain } from "../../src/domain/prefix-chain.js";
import type { ToolDefinition } from "../../src/domain/ports/tool-resolver-port.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../../src/infrastructure/adapters/node-path-operations-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tool-execution-"));
  tempDirs.push(dir);
  return dir;
}

function makeChain(tool: ToolDefinition, payload = "run"): PrefixChain {
  return {
    modifiers: [],
    handler: {
      tool,
      payload,
    },
    remainingText: payload,
  };
}

function makeModifierChain(modifiers: PrefixChain["modifiers"], remainingText = "run"): PrefixChain {
  return {
    modifiers,
    remainingText,
  };
}

function makeContext(rootDir: string) {
  const fileSystem = createNodeFileSystem();
  const pathOperations = createNodePathOperationsAdapter();

  return {
    task: {
      text: "tool: run",
      checked: false,
      line: 1,
      column: 1,
      index: 0,
      offsetStart: 0,
      offsetEnd: 0,
      file: path.join(rootDir, "task.md"),
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    },
    allTasks: undefined,
    payload: "run",
    source: "- [ ] tool: run",
    contextBefore: "",
    fileSystem,
    pathOperations,
    emit: () => undefined,
    configDir: rootDir,
    workerExecutor: {
      runWorker: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      executeInlineCli: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      executeRundownTask: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
    workerPattern: {
      command: ["node", "script.js"],
      usesBootstrap: false,
      usesFile: false,
      appendFile: true,
    },
    workerCommand: ["node", "script.js"],
    mode: "wait",
    trace: false,
    cwd: rootDir,
    executionEnv: undefined,
    artifactContext: {
      runId: "test-run",
      rootDir,
      cwd: rootDir,
      keepArtifacts: false,
      commandName: "run",
    },
    keepArtifacts: false,
    templateVars: {
      task: "tool: run",
      payload: "run",
      file: path.join(rootDir, "task.md"),
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] tool: run",
    },
    showAgentOutput: false,
  };
}

describe("executeToolChain JS tool validation", () => {
  it("fails with clear message when JS tool exports no handler", async () => {
    const rootDir = makeTempDir();
    const modulePath = path.join(rootDir, "no-handler.js");
    fs.writeFileSync(modulePath, "export const meaning = 42;", "utf-8");

    const tool: ToolDefinition = {
      name: "no-handler",
      kind: "handler",
      handlerPath: pathToFileURL(modulePath).href,
    };

    const result = await executeToolChain(makeChain(tool), makeContext(rootDir), () => undefined);
    expect(result.kind).toBe("execution-failed");
    if (result.kind !== "execution-failed") {
      return;
    }

    expect(result.executionFailureMessage).toContain("Invalid JavaScript tool module for \"no-handler\"");
    expect(result.executionFailureMessage).toContain("Missing handler export");
    expect(result.executionFailureMessage).toContain("Found exports: meaning");
    expect(result.executionFailureRunReason).toBe("JavaScript tool module has no callable handler export.");
  });

  it("fails with clear message when JS tool exports non-function default", async () => {
    const rootDir = makeTempDir();
    const modulePath = path.join(rootDir, "bad-shape.js");
    fs.writeFileSync(modulePath, "export default { run: true };", "utf-8");

    const tool: ToolDefinition = {
      name: "bad-shape",
      kind: "handler",
      handlerPath: pathToFileURL(modulePath).href,
    };

    const result = await executeToolChain(makeChain(tool), makeContext(rootDir), () => undefined);
    expect(result.kind).toBe("execution-failed");
    if (result.kind !== "execution-failed") {
      return;
    }

    expect(result.executionFailureMessage).toContain("Invalid JavaScript tool module for \"bad-shape\"");
    expect(result.executionFailureMessage).toContain("Invalid handler export type");
    expect(result.executionFailureMessage).toContain("received object");
    expect(result.executionFailureRunReason).toBe("JavaScript tool module exports a non-function handler.");
  });

  it("fails with clear message when JS tool module cannot be imported", async () => {
    const rootDir = makeTempDir();
    const missingPath = path.join(rootDir, "missing.js");

    const tool: ToolDefinition = {
      name: "missing-tool",
      kind: "handler",
      handlerPath: pathToFileURL(missingPath).href,
    };

    const result = await executeToolChain(makeChain(tool), makeContext(rootDir), () => undefined);
    expect(result.kind).toBe("execution-failed");
    if (result.kind !== "execution-failed") {
      return;
    }

    expect(result.executionFailureMessage).toContain("Invalid JavaScript tool module for \"missing-tool\"");
    expect(result.executionFailureMessage).toContain("Failed to import module:");
    expect(result.executionFailureRunReason).toBe("JavaScript tool module failed to load.");
  });
});

describe("executeToolChain modifier-only chains", () => {
  it("returns modifiers-only and preserves context modifications for default execution", async () => {
    const rootDir = makeTempDir();
    const events: Array<{ kind: string; message?: string }> = [];

    const profileModifier: ToolDefinition = {
      name: "profile",
      kind: "modifier",
      handler: async (context) => ({
        contextModifications: {
          profile: context.payload,
        },
      }),
    };

    const varsModifier: ToolDefinition = {
      name: "vars",
      kind: "modifier",
      handler: async (context) => ({
        contextModifications: {
          templateVars: {
            customValue: "enabled",
            seenPayload: context.payload,
          },
        },
      }),
    };

    const chain = makeModifierChain([
      { tool: profileModifier, payload: "fast" },
      { tool: varsModifier, payload: "capture" },
    ], "continue with default execution");

    const result = await executeToolChain(
      chain,
      makeContext(rootDir),
      (event) => events.push({ kind: event.kind, message: "message" in event ? event.message : undefined }),
    );

    expect(result.kind).toBe("modifiers-only");
    if (result.kind !== "modifiers-only") {
      return;
    }

    expect(result.modifierProfile).toBe("fast");
    expect(result.templateVars).toMatchObject({
      customValue: "enabled",
      seenPayload: "capture",
    });
    expect(result.templateVars?.task).toBe("tool: run");
    expect(events.filter((event) => event.kind === "info" && event.message?.startsWith("Applied modifier:")).length)
      .toBe(2);
  });
});

describe("executeToolChain handler signals", () => {
  it("propagates skipRemainingSiblings from handler result", async () => {
    const rootDir = makeTempDir();
    const tool: ToolDefinition = {
      name: "end",
      kind: "handler",
      handler: async () => ({
        skipExecution: true,
        skipRemainingSiblings: {
          reason: "no output to process",
        },
      }),
    };

    const result = await executeToolChain(makeChain(tool, "no output to process"), makeContext(rootDir), () => undefined);

    expect(result).toEqual({
      kind: "tool-handled",
      skipExecution: true,
      shouldVerify: false,
      skipRemainingSiblings: {
        reason: "no output to process",
      },
      childFile: undefined,
      childTaskCount: 0,
      modifierProfile: undefined,
    });
  });

  it("normalizes legacy stopRun/stopLoop flags into terminalStop", async () => {
    const rootDir = makeTempDir();
    const tool: ToolDefinition = {
      name: "exit",
      kind: "handler",
      handler: async () => ({
        skipExecution: true,
        shouldVerify: false,
        stopRun: true,
        stopLoop: true,
      }),
    };

    const result = await executeToolChain(makeChain(tool, ""), makeContext(rootDir), () => undefined);

    expect(result).toEqual({
      kind: "tool-handled",
      skipExecution: true,
      shouldVerify: false,
      terminalStop: {
        requestedBy: "exit",
        mode: "unconditional",
        reason: "exit: (no condition)",
        stopRun: true,
        stopLoop: true,
        exitCode: 0,
      },
      childFile: undefined,
      childTaskCount: 0,
      modifierProfile: undefined,
    });
  });
});
