import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ProcessRunner,
} from "../../src/domain/ports/index.js";

import {
  afterTaskComplete,
  afterTaskFailed,
  finalizeRunArtifacts,
} from "../../src/application/run-lifecycle.js";

describe("run-lifecycle", () => {
  const task: Task = {
    text: "Ship release",
    checked: false,
    index: 3,
    line: 12,
    column: 1,
    offsetStart: 10,
    offsetEnd: 40,
    file: "tasks.md",
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };

  it("injects RUNDOWN_VAR_* env vars into on-fail hooks", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const processRunner: ProcessRunner = { run };

    const pathOperations = {
      resolve: vi.fn((value: string) => `/abs/${value}`),
      join: vi.fn(),
      dirname: vi.fn(),
      relative: vi.fn(),
      isAbsolute: vi.fn(),
    };

    await afterTaskFailed(
      {
        workingDirectory: { cwd: vi.fn(() => "/workspace") },
        output: { emit: vi.fn() },
        processRunner,
        pathOperations,
        gitClient: { run: vi.fn() },
        configDir: undefined,
      },
      task,
      "# Tasks",
      "echo fail-hook",
      true,
      {
        db_host: "localhost",
        region: "eu-west",
      },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const [options] = run.mock.calls[0] as [{ env: Record<string, string | undefined> }];
    expect(options.env.RUNDOWN_TASK).toBe("Ship release");
    expect(options.env.RUNDOWN_FILE).toBe("/abs/tasks.md");
    expect(options.env.RUNDOWN_SOURCE).toBe("# Tasks");
    expect(options.env.RUNDOWN_VAR_DB_HOST).toBe("localhost");
    expect(options.env.RUNDOWN_VAR_REGION).toBe("eu-west");
  });

  it("injects RUNDOWN_VAR_* env vars into on-complete hooks", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const processRunner: ProcessRunner = { run };

    const pathOperations = {
      resolve: vi.fn((value: string) => `/abs/${value}`),
      join: vi.fn(),
      dirname: vi.fn(),
      relative: vi.fn(),
      isAbsolute: vi.fn(),
    };

    await afterTaskComplete(
      {
        workingDirectory: { cwd: vi.fn(() => "/workspace") },
        output: { emit: vi.fn() },
        processRunner,
        pathOperations,
        gitClient: { run: vi.fn() },
        configDir: undefined,
      },
      task,
      "# Tasks",
      false,
      undefined,
      "echo complete-hook",
      true,
      {
        release: "v1",
      },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const [options] = run.mock.calls[0] as [{ env: Record<string, string | undefined> }];
    expect(options.env.RUNDOWN_VAR_RELEASE).toBe("v1");
    expect(options.env.RUNDOWN_TASK).toBe("Ship release");
  });

  it("logs informational skip when commit has no changes", async () => {
    const emit = vi.fn();
    const gitClientRun = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/workspace";
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status") {
        return "";
      }
      return "";
    });

    const result = await afterTaskComplete(
      {
        workingDirectory: { cwd: vi.fn(() => "/workspace") },
        output: { emit },
        processRunner: { run: vi.fn() },
        pathOperations: {
          resolve: vi.fn((value: string) => value),
          join: vi.fn(),
          dirname: vi.fn(),
          relative: vi.fn((from: string, to: string) => to.replace(`${from}/`, "")),
          isAbsolute: vi.fn(),
        },
        gitClient: { run: gitClientRun },
        configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      },
      task,
      "# Tasks",
      true,
      "done: {{task}}",
      undefined,
      true,
      {},
    );

    expect(result).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "--commit: skipped - no changes to commit (working tree clean).",
    });
  });

  it("keeps normal commit behavior when committable changes exist", async () => {
    const emit = vi.fn();
    const gitClientRun = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/workspace";
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status") {
        return " M tasks.md";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });

    const result = await afterTaskComplete(
      {
        workingDirectory: { cwd: vi.fn(() => "/workspace") },
        output: { emit },
        processRunner: { run: vi.fn() },
        pathOperations: {
          resolve: vi.fn((value: string) => value),
          join: vi.fn(),
          dirname: vi.fn(),
          relative: vi.fn((from: string, to: string) => to.replace(`${from}/`, "")),
          isAbsolute: vi.fn(),
        },
        gitClient: { run: gitClientRun },
        configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      },
      task,
      "# Tasks",
      true,
      "done: {{task}}",
      undefined,
      true,
      {},
    );

    expect(result).toEqual({
      commitSha: "abc123",
      commitMessage: "done: Ship release",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "success",
      message: "Committed: done: Ship release",
    });
    expect(emit).not.toHaveBeenCalledWith({
      kind: "info",
      message: "--commit: skipped - no changes to commit (working tree clean).",
    });
    expect(gitClientRun).toHaveBeenCalledWith(["commit", "-m", "done: Ship release"], "/workspace");
  });

  it("throws and emits error for real commit failures", async () => {
    const emit = vi.fn();
    const gitClientRun = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return "/workspace";
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status") {
        return " M tasks.md";
      }
      if (args[0] === "commit") {
        throw new Error("hook rejected commit");
      }
      return "";
    });

    await expect(afterTaskComplete(
      {
        workingDirectory: { cwd: vi.fn(() => "/workspace") },
        output: { emit },
        processRunner: { run: vi.fn() },
        pathOperations: {
          resolve: vi.fn((value: string) => value),
          join: vi.fn(),
          dirname: vi.fn(),
          relative: vi.fn((from: string, to: string) => to.replace(`${from}/`, "")),
          isAbsolute: vi.fn(),
        },
        gitClient: { run: gitClientRun },
        configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      },
      task,
      "# Tasks",
      true,
      "done: {{task}}",
      undefined,
      true,
      {},
    )).rejects.toThrow("--commit failed: Error: hook rejected commit");

    expect(emit).toHaveBeenCalledWith({
      kind: "error",
      message: "--commit failed: Error: hook rejected commit",
    });
  });

  describe("finalizeRunArtifacts", () => {
    it("finalizes runtime artifacts and emits the saved path when preserved", () => {
      const emit = vi.fn();
      const artifactStore: ArtifactStore = {
        createContext: vi.fn(),
        beginPhase: vi.fn(),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ".rundown/runs/run-1"),
        rootDir: vi.fn(),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      };
      const context: ArtifactRunContext = {
        runId: "run-1",
        rootDir: "/workspace/.rundown/runs/run-1",
        cwd: "/workspace",
        keepArtifacts: true,
        commandName: "run",
      };

      finalizeRunArtifacts(
        artifactStore,
        context,
        true,
        "completed",
        emit,
      );

      expect(artifactStore.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1" }),
        { status: "completed", preserve: true },
      );
      expect(emit).toHaveBeenCalledWith({
        kind: "info",
        message: "Runtime artifacts saved at .rundown/runs/run-1.",
      });
    });
  });
});
