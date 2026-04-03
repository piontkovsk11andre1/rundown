import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createReverifyTask,
  type ReverifyTaskDependencies,
  type ReverifyTaskOptions,
} from "../../src/application/reverify-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStoreStatus,
  ArtifactStore,
  CommandExecutor,
  FileSystem,
  TaskRepairResult,
  VerificationStore,
} from "../../src/domain/ports/index.js";
import type { Task } from "../../src/domain/parser.js";
import type { WorkerConfigPort } from "../../src/domain/ports/worker-config-port.js";

describe("reverify-task", () => {
  it("prints verify prompt and exits without running verification", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationStore } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [completedRun],
      });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", printPrompt: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationStore.remove)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Build release"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("## Phase"))).toBe(true);
  });

  it("dry-run reports planned command and skips verification execution", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationStore } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [completedRun],
      });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationStore.remove)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run - would run verification with: opencode run"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
  });

  it("dry-run skips cli block expansion and reports skipped block count", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      })),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });

    vi.mocked(dependencies.templateLoader.load).mockImplementation((filePath: string) => {
      if (filePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho from-verify\n```";
      }

      if (filePath.endsWith(path.join(".rundown", "repair.md"))) {
        return "```cli\necho from-repair\n```";
      }

      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "Dry run — skipped `cli` fenced block execution; would execute 2 blocks.",
    });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run - would run verification with: opencode run"))).toBe(true);
  });

  it("re-verifies all completed runs and emits a success summary", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "reverify-completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(3);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Task newest", "Task middle", "Task oldest"]);
    expect(events.some((event) => event.kind === "success" && event.message === "Re-verified 3 tasks successfully.")).toBe(true);
  });

  it("loads worker config once across multi-run reverify", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "reverify-completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, workerConfigPort } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(workerConfigPort.load)).toHaveBeenCalledTimes(1);
  });

  it("uses config defaults worker when no CLI worker is provided", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const completedRun = {
      ...createRunMetadata({
        runId: "run-defaults-worker",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      workerCommand: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, taskVerification, workerConfigPort } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(workerConfigPort.load).mockReturnValue({
      defaults: {
        worker: ["default", "worker"],
        workerArgs: ["--model", "gpt-5.3-codex"],
      },
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-defaults-worker" }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      command: ["default", "worker", "--model", "gpt-5.3-codex"],
    }));
  });

  it("uses commands.reverify config over defaults when no CLI worker is provided", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const completedRun = {
      ...createRunMetadata({
        runId: "run-reverify-command-worker",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      workerCommand: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, taskVerification, workerConfigPort } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(workerConfigPort.load).mockReturnValue({
      defaults: {
        worker: ["default", "worker"],
        workerArgs: ["--speed", "slow"],
      },
      commands: {
        reverify: {
          worker: ["reverify", "worker"],
          workerArgs: ["--speed", "fast"],
        },
      },
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-reverify-command-worker" }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      command: ["reverify", "worker", "--speed", "slow", "--speed", "fast"],
    }));
  });

  it("prefers CLI worker over config defaults and commands.reverify", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const completedRun = {
      ...createRunMetadata({
        runId: "run-cli-worker-wins",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      workerCommand: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, taskVerification, workerConfigPort } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(workerConfigPort.load).mockReturnValue({
      defaults: {
        worker: ["default", "worker"],
      },
      commands: {
        reverify: {
          worker: ["reverify", "worker"],
        },
      },
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "run-cli-worker-wins",
      workerCommand: ["cli", "worker", "--model", "gpt-5.3-codex"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      command: ["cli", "worker", "--model", "gpt-5.3-codex"],
    }));
  });

  it("uses resolved worker command from config during reverify", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "---\nprofile: complex\n---\n\n- [x] Build release\n",
    });

    const completedRun = {
      ...createRunMetadata({
        runId: "run-config-worker",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 5,
          index: 0,
          source: "roadmap.md",
        },
      }),
      workerCommand: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, taskVerification, workerConfigPort } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(workerConfigPort.load).mockReturnValue({
      defaults: {
        worker: ["opencode", "run"],
      },
      commands: {
        reverify: {
          workerArgs: ["--base", "1"],
        },
      },
      profiles: {
        complex: {
          workerArgs: ["--model", "opus-4.6"],
        },
      },
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-config-worker" }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      command: ["opencode", "run", "--base", "1", "--model", "opus-4.6"],
    }));
  });

  it("re-verifies only the 2 most recent completed runs with --last 2", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ last: 2, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(2);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Task newest", "Task middle"]);
    expect(events.some((event) => event.kind === "success" && event.message === "Re-verified 2 tasks successfully.")).toBe(true);
  });

  it("re-verifies all completed runs in oldest-first order with --oldest-first", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "reverify-completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      all: true,
      oldestFirst: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(3);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Task oldest", "Task middle", "Task newest"]);
  });

  it("re-verifies --last N newest runs in oldest-first order with --oldest-first", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n- [x] Task very oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });
    const runVeryOldest = createRunMetadata({
      runId: "run-very-oldest",
      status: "completed",
      task: {
        text: "Task very oldest",
        file: taskFile,
        line: 4,
        index: 3,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:57:00.000Z",
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest, runVeryOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      last: 3,
      oldestFirst: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(3);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Task oldest", "Task middle", "Task newest"]);
  });

  it("ignores --oldest-first when re-verifying a single explicit --run <id>", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T18:00:00.000Z",
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "run-middle",
      oldestFirst: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Task middle" }),
      artifactContext: expect.objectContaining({
        runId: "run-reverify",
      }),
    }));
  });

  it("re-verifies --all runs in ascending startedAt order with --oldest-first", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Run @ 18:00\n- [x] Run @ 17:59\n- [x] Run @ 17:58\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Run @ 18:00",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T18:00:00.000Z",
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Run @ 17:59",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Run @ 17:58",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      all: true,
      oldestFirst: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(3);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Run @ 17:58", "Run @ 17:59", "Run @ 18:00"]);
  });

  it("stops multi-run reverify on first verification failure", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task middle\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runMiddle = createRunMetadata({
      runId: "run-middle",
      status: "completed",
      task: {
        text: "Task middle",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 3,
        index: 2,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runMiddle, runOldest],
    });
    vi.mocked(taskVerification.verify)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, noRepair: true, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(2);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Re-verify stopped on run-middle after 1 successful task(s)."))).toBe(true);
  });

  it("skips non-completed and non-reverifiable runs during multi-run selection", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runFailed = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Task failed",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:30.000Z",
    });
    const runWithoutTask = {
      ...createRunMetadata({
        runId: "run-no-task",
        status: "completed",
        task: {
          text: "Task newest",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: undefined,
      startedAt: "2026-03-19T17:59:00.000Z",
    } as ArtifactRunMetadata;
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "reverify-completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:58:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runFailed, runWithoutTask, runOldest],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(2);
    const verifiedTaskTexts = vi.mocked(taskVerification.verify).mock.calls
      .map(([input]) => (input as { task: Task }).task.text);
    expect(verifiedTaskTexts).toEqual(["Task newest", "Task oldest"]);
    expect(events.some((event) => event.kind === "success" && event.message === "Re-verified 2 tasks successfully.")).toBe(true);
  });

  it("lists all selected runs for multi-run dry-run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Task newest\n- [x] Task oldest\n",
    });

    const runNewest = createRunMetadata({
      runId: "run-newest",
      status: "completed",
      task: {
        text: "Task newest",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const runOldest = createRunMetadata({
      runId: "run-oldest",
      status: "completed",
      task: {
        text: "Task oldest",
        file: taskFile,
        line: 2,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runNewest, runOldest],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("would re-verify 2 completed runs"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-newest"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-oldest"))).toBe(true);
  });

  it("returns 3 for --all when no completed runs are available", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Build release",
        file: path.join(cwd, "roadmap.md"),
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events } = createDependencies({
      cwd,
      fileSystem,
      runs: [failedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No completed runs found to re-verify."))).toBe(true);
  });

  it("returns 1 for --all with --print-prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, printPrompt: true }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("--print-prompt is not supported"))).toBe(true);
  });

  it("returns 1 for --all with explicit --run <id>", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, runId: "run-completed" }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --run <id> with --all or --last."))).toBe(true);
  });

  it("returns 1 for --last with --all", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ all: true, last: 1 }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --all with --last."))).toBe(true);
  });

  it("returns 1 when --last is less than 1", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ last: 0 }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("--last must be a positive integer."))).toBe(true);
  });

  it("re-verifies latest completed task and does not mutate markdown checkboxes", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n- [ ] Publish docs\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });
    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Publish docs",
        file: taskFile,
        line: 3,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T18:01:00.000Z",
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationStore } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [failedRun, completedRun],
      });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationStore.remove)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-completed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "success" && event.message === "Re-verification passed.")).toBe(true);
  });

  it("returns 2 with reverify-failed status when verification does not pass", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationStore } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(false);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", noRepair: true, repairAttempts: 2 }));

    expect(code).toBe(2);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationStore.remove)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-failed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "error" && event.message
      === "Verification failed after all repair attempts.\nVerification failed (no details)."))
      .toBe(true);
  });

  it("returns 3 when no completed saved run can be resolved", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Build release",
        file: path.join(cwd, "roadmap.md"),
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [failedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("latest completed"))).toBe(true);
  });

  it("resolves latest target by skipping non-reverifiable saved runs", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const completedWithoutTask = {
      ...createRunMetadata({
        runId: "run-no-task",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: undefined,
    } as ArtifactRunMetadata;

    const completedWithTask = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedWithoutTask, completedWithTask],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Build release", line: 1, index: 0 }),
      artifactContext: expect.objectContaining({
        runId: "run-reverify",
      }),
    }));
  });

  it("returns 3 when explicit run id points to non-completed run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [failedRun, completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-failed" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("not completed"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run metadata is missing", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const runWithMissingMetadata = createRunMetadata({
      runId: "run-metadata-missing",
      status: "metadata-missing",
      task: {
        text: "Build release",
        file: path.join(cwd, "roadmap.md"),
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runWithMissingMetadata],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-metadata-missing" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("run.json"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("--keep-artifacts"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run has no task metadata", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const completedRunWithoutTask = {
      ...createRunMetadata({
        runId: "run-no-task",
        status: "completed",
        task: {
          text: "Build release",
          file: path.join(cwd, "roadmap.md"),
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRunWithoutTask],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-no-task" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("no task metadata"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("different run"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run task metadata is invalid", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRunWithInvalidTask = {
      ...createRunMetadata({
        runId: "run-invalid-task-metadata",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: -1,
        source: "roadmap.md",
      },
    } as ArtifactRunMetadata;

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRunWithInvalidTask],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-invalid-task-metadata" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("invalid task metadata"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("non-negative integer"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("regenerate runtime artifacts"))).toBe(true);
  });

  it("returns 1 when no worker command can be resolved", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = {
      ...createRunMetadata({
        runId: "run-no-worker",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      workerCommand: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-no-worker" }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("No worker command available"))).toBe(true);
  });

  it("returns 3 when historical task metadata cannot be resolved in markdown", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Different task text\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("returns 3 when metadata does not uniquely match task text", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 99,
        index: 99,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("returns 3 when metadata file path no longer exists", async () => {
    const cwd = "/workspace";
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: path.join(cwd, "missing.md"),
        line: 1,
        index: 0,
        source: "missing.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem: createInMemoryFileSystem({}),
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("resolves moved task by index and text fallback", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n\n- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-completed", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Build release", index: 0, line: 3 }),
      artifactContext: expect.objectContaining({
        runId: "run-reverify",
      }),
    }));
  });

  it("keeps children and subItems template vars authoritative during --print-prompt", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n  - [ ] Child item\n  - Extra note\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "{{children}}|{{subItems}}";
      }
      return null;
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("\"text\":\"Child item\"");
    expect(prompt).toContain("\"text\":\"Extra note\"");
  });

  it("includes memory path and summary in reverify prompts without memory body text", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const memoryFilePath = path.join(cwd, ".rundown", "roadmap.memory.md");
    const memoryBodyText = "MEMORY-BODY-SHOULD-NOT-BE-INLINED";
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-memory",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: true,
        filePath: memoryFilePath,
        summary: "Verification caveats and prior fixes",
      })),
    };
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "Verify memory path: {{memoryFilePath}}\nVerify memory summary: {{memorySummary}}";
      }
      if (templatePath.endsWith(path.join(".rundown", "repair.md"))) {
        return "Repair memory path: {{memoryFilePath}}\nRepair memory summary: {{memorySummary}}";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("Verify memory path: " + memoryFilePath);
    expect(prompt).toContain("Verify memory summary: Verification caveats and prior fixes");
    expect(prompt).not.toContain(memoryBodyText);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(taskFile);
  });

  it("keeps dry-run exit code and behavior when memory metadata is unavailable", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-memory-unavailable",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationStore } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [completedRun],
      });
    dependencies.memoryResolver = {
      resolve: vi.fn(() => ({
        available: false,
        filePath: path.join(cwd, ".rundown", "roadmap.memory.md"),
        summary: undefined,
      })),
    };

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationStore.remove)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run - would run verification with: opencode run"))).toBe(true);
    expect(dependencies.memoryResolver.resolve).toHaveBeenCalledWith(taskFile);
  });

  it("loads verify/repair templates from resolved config dir", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const resolvedConfigDir = path.join(cwd, "nested", ".rundown");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    dependencies.configDir = {
      configDir: resolvedConfigDir,
      isExplicit: true,
    };

    const verifyTemplatePath = path.join(resolvedConfigDir, "verify.md");
    const repairTemplatePath = path.join(resolvedConfigDir, "repair.md");
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath === verifyTemplatePath) {
        return "Verify template";
      }
      if (templatePath === repairTemplatePath) {
        return "Repair template";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.templateLoader.load)).toHaveBeenCalledWith(verifyTemplatePath);
    expect(vi.mocked(dependencies.templateLoader.load)).toHaveBeenCalledWith(repairTemplatePath);
  });

  it("expands cli fenced blocks in print-prompt output", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-cli-print",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "cli output",
        stderr: "",
      })),
    };
    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho {{task}}\n```";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "echo Build release",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("<command>echo Build release</command>");
  });

  it("passes exec timeout to cli block expansion in reverify prompts", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-cli-timeout",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "expanded",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho verify-{{task}}\n```";
      }
      if (templatePath.endsWith(path.join(".rundown", "repair.md"))) {
        return "```cli\necho repair-{{task}}\n```";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
      workerCommand: ["opencode", "run"],
      cliBlockTimeoutMs: 1234,
    }));

    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "echo verify-Build release",
      cwd,
      expect.objectContaining({
        timeoutMs: 1234,
        onCommandExecuted: expect.any(Function),
      }),
    );
  });

  it("expands cli fenced blocks in verify and repair templates before verify-repair loop", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-cli-verify-repair",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async (command: string) => ({
        exitCode: 0,
        stdout: `expanded:${command}`,
        stderr: "",
      })),
    };
    const { dependencies, taskVerification, taskRepair } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(false);
    vi.mocked(taskRepair.repair).mockResolvedValue({
      valid: true,
      attempts: 1,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho verify-{{task}}\n```";
      }
      if (templatePath.endsWith(path.join(".rundown", "repair.md"))) {
        return "```cli\necho repair-{{task}}\n```";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      repairAttempts: 1,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "echo verify-Build release",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "echo repair-Build release",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    expect(vi.mocked(taskRepair.repair)).toHaveBeenCalledWith(expect.objectContaining({
      verifyTemplate: "<command>echo verify-Build release</command>\n<output>\nexpanded:echo verify-Build release\n</output>",
      repairTemplate: "<command>echo repair-Build release</command>\n<output>\nexpanded:echo repair-Build release\n</output>",
      templateVars: {},
    }));
  });

  it("skips cli block expansion when ignoreCliBlock is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-cli-skip",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "expanded",
        stderr: "",
      })),
    };

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho verify-{{task}}\n```";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      printPrompt: true,
      ignoreCliBlock: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(cliBlockExecutor.execute)).not.toHaveBeenCalled();
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("```cli\necho verify-Build release\n```");
  });

  it("emits an error and aborts when verify template cli block fails", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-cli-template-fail",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async (command: string) => {
        if (command === "echo verify-Build release") {
          return {
            exitCode: 8,
            stdout: "",
            stderr: "verify template failed",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
    };
    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
      cliBlockExecutor,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "verify.md"))) {
        return "```cli\necho verify-{{task}}\n```";
      }
      if (templatePath.endsWith(path.join(".rundown", "repair.md"))) {
        return "```cli\necho repair-{{task}}\n```";
      }
      return null;
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "latest",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "error",
      message: "`cli` fenced command failed in verification/repair template (exit 8): echo verify-Build release. Aborting run.",
    });
  });

  it("resolves relative task file metadata and falls back to a unique text match", async () => {
    const cwd = "/workspace";
    const absoluteTaskFile = path.resolve(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [absoluteTaskFile]: "# Roadmap\n- [x] Ship release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-relative-path",
      status: "completed",
      task: {
        text: "Ship release",
        file: "roadmap.md",
        line: 99,
        index: 99,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-relative-path", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Ship release", file: absoluteTaskFile, line: 2 }),
      artifactContext: expect.objectContaining({
        runId: "run-reverify",
      }),
    }));
  });

  it("accepts previously reverified runs and reports preserved artifact paths", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-reverified",
      status: "reverify-completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({
      runId: "run-reverified",
      keepArtifacts: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-completed", preserve: true }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at .rundown/runs/run-reverify."))).toBe(true);
  });

  it("finalizes reverify artifacts as failed when verification throws", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-throws",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockRejectedValue(new Error("verification exploded"));

    const reverifyTask = createReverifyTask(dependencies);

    await expect(reverifyTask(createOptions({ runId: "run-throws", workerCommand: ["opencode", "run"] }))).rejects.toThrow("verification exploded");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-failed", preserve: false }),
    );
  });
});

function createDependencies(options: {
  cwd: string;
  fileSystem: FileSystem;
  runs: ArtifactRunMetadata[];
  cliBlockExecutor?: CommandExecutor;
}): {
  dependencies: ReverifyTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  taskVerification: { verify: ReturnType<typeof vi.fn> };
  taskRepair: { repair: ReturnType<typeof vi.fn> };
  verificationStore: VerificationStore;
  workerConfigPort: WorkerConfigPort;
} {
  const events: ApplicationOutputEvent[] = [];

  const taskVerification = {
    verify: vi.fn(async () => true),
  };

  const taskRepair = {
    repair: vi.fn(async (): Promise<TaskRepairResult> => ({
      valid: false,
      attempts: 0,
    })),
  };

  const verificationStore: VerificationStore = {
    write: vi.fn(),
    read: vi.fn(() => null),
    remove: vi.fn(),
  };

  const context = {
    runId: "run-reverify",
    rootDir: path.join(options.cwd, ".rundown", "runs", "run-reverify"),
    cwd: options.cwd,
    keepArtifacts: false,
    commandName: "reverify",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => context),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-reverify"),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => options.runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => options.runs[0] ?? null),
    find: vi.fn((runId: string) => options.runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const workerConfigPort: WorkerConfigPort = { load: vi.fn(() => undefined) };
  const cliBlockExecutor: CommandExecutor = options.cliBlockExecutor ?? {
    execute: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
  };

  const dependencies: ReverifyTaskDependencies = {
    artifactStore,
    taskVerification,
    taskRepair,
    verificationStore,
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    fileSystem: options.fileSystem,
    traceWriter: {
      write: vi.fn(),
      flush: vi.fn(),
    },
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    createTraceWriter: vi.fn((_trace: boolean, _artifactContext) => ({
      write: vi.fn(),
      flush: vi.fn(),
    })),
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateLoader: {
      load: vi.fn(() => null),
    },
    workerConfigPort,
    output: {
      emit: (event) => {
        events.push(event);
      },
    },
    cliBlockExecutor,
  };

  return {
    dependencies,
    events,
    artifactStore,
    taskVerification,
    taskRepair,
    verificationStore,
    workerConfigPort,
  };
}

function createRunMetadata(options: {
  runId: string;
  status: ArtifactStoreStatus;
  task: {
    text: string;
    file: string;
    line: number;
    index: number;
    source: string;
  };
  startedAt?: string;
}): ArtifactRunMetadata {
  return {
    runId: options.runId,
    rootDir: path.join("/workspace", ".rundown", "runs", options.runId),
    relativePath: `.rundown/runs/${options.runId}`,
    commandName: "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
    source: "roadmap.md",
    task: options.task,
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-19T18:00:00.000Z",
    completedAt: "2026-03-19T18:00:30.000Z",
    status: options.status,
  };
}

function createInMemoryFileSystem(initialFiles: Record<string, string>): FileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    exists: vi.fn((filePath: string) => files.has(filePath)),
    readText: vi.fn((filePath: string) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }
      return content;
    }),
    writeText: vi.fn((filePath: string, content: string) => {
      files.set(filePath, content);
    }),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createOptions(overrides: Partial<ReverifyTaskOptions>): ReverifyTaskOptions {
  return {
    runId: "latest",
    transport: "file",
    repairAttempts: 0,
    noRepair: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    workerCommand: [],
    trace: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    ...overrides,
  };
}
