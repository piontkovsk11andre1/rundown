import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { TraceEvent } from "../../src/domain/trace.js";
import { parseTasks } from "../../src/domain/parser.js";

import {
  createRunTaskExecution,
  getAutomationWorkerCommand,
  isOpenCodeWorkerCommand,
  toRuntimeTaskMetadata,
} from "../../src/application/run-task-execution.js";
import type { WorkerHealthSnapshot } from "../../src/domain/ports/worker-health-store.js";
import {
  WORKER_FAILURE_CLASS_SUCCESS,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_HEALTHY,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  buildWorkerHealthProfileKey,
  buildWorkerHealthWorkerKey,
} from "../../src/domain/worker-health.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import {
  createDependencies,
  createGitClientMock,
  createInMemoryFileSystem,
  createInlineTask,
  createOptions,
  createTask,
} from "./run-task-test-helpers.js";

describe("run-task-execution helpers", () => {
  it("normalizes opencode tui worker commands", () => {
    expect(getAutomationWorkerCommand(["opencode"], "tui")).toEqual(["opencode", "run"]);
    expect(getAutomationWorkerCommand(["opencode", "run"], "tui")).toEqual(["opencode", "run"]);
    expect(getAutomationWorkerCommand(["agent"], "tui")).toEqual(["agent"]);
    expect(getAutomationWorkerCommand(["opencode"], "wait")).toEqual(["opencode"]);
  });

  it("detects supported opencode executable names", () => {
    expect(isOpenCodeWorkerCommand([])).toBe(false);
    expect(isOpenCodeWorkerCommand(["opencode"])).toBe(true);
    expect(isOpenCodeWorkerCommand([String.raw`C:\tools\opencode.cmd`])).toBe(true);
    expect(isOpenCodeWorkerCommand(["/usr/local/bin/opencode.exe"])).toBe(true);
    expect(isOpenCodeWorkerCommand(["node"])).toBe(false);
  });

  it("maps a task into runtime metadata", () => {
    const task: Task = {
      text: "cli: echo hello",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 17,
      file: "/workspace/tasks.md",
      isInlineCli: true,
      depth: 0,
      children: [],
      subItems: [],
    };

    expect(toRuntimeTaskMetadata(task, "tasks.md")).toEqual({
      text: "cli: echo hello",
      file: "/workspace/tasks.md",
      line: 1,
      index: 0,
      source: "tasks.md",
    });
  });

  it("builds RUNDOWN_VAR_* env from merged vars and threads it to cli blocks and workers", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const cliBlockExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    dependencies.templateVarsLoader.load = () => ({
      api_token: "from-file",
      channel: "stable",
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\necho from-template\n```";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      varsFileOption: ".rundown/vars.json",
      cliTemplateVarArgs: ["api_token=from-cli", "db_Host=localhost"],
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(dependencies.cliBlockExecutor?.execute).toHaveBeenCalledWith(
      "echo from-template",
      cwd,
      expect.objectContaining({
        env: expect.objectContaining({
          RUNDOWN_VAR_API_TOKEN: "from-cli",
          RUNDOWN_VAR_CHANNEL: "stable",
          RUNDOWN_VAR_DB_HOST: "localhost",
        }),
      }),
    );
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        RUNDOWN_VAR_API_TOKEN: "from-cli",
        RUNDOWN_VAR_CHANNEL: "stable",
        RUNDOWN_VAR_DB_HOST: "localhost",
      }),
    }));
  });

  it("threads merged RUNDOWN_VAR_* env to inline cli execution", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] cli: echo hello\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.templateVarsLoader.load = () => ({ region: "us-east" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      varsFileOption: ".rundown/vars.json",
      cliTemplateVarArgs: ["region=eu-west", "release=v1"],
    }));

    expect(code).toBe(0);
    const expectedInlineCwd = path.dirname(path.resolve(taskFile));
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledWith(
      "echo hello",
      expectedInlineCwd,
      expect.objectContaining({
        env: expect.objectContaining({
          RUNDOWN_VAR_REGION: "eu-west",
          RUNDOWN_VAR_RELEASE: "v1",
        }),
      }),
    );
  });

  it("keeps workspace context template variables authoritative over file and CLI vars", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.templateVarsLoader.load = () => ({
      invocationDir: "/fake/file/invocation",
      workspaceDir: "/fake/file/workspace",
      workspaceLinkPath: "/fake/file/workspace.link",
      isLinkedWorkspace: "false",
      workspaceDesignPlacement: "workdir",
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return [
          "invocationDir={{invocationDir}}",
          "workspaceDir={{workspaceDir}}",
          "workspaceLinkPath={{workspaceLinkPath}}",
          "isLinkedWorkspace={{isLinkedWorkspace}}",
          "workspaceDesignDir={{workspaceDesignDir}}",
          "workspaceSpecsDir={{workspaceSpecsDir}}",
          "workspaceMigrationsDir={{workspaceMigrationsDir}}",
          "workspaceDesignPlacement={{workspaceDesignPlacement}}",
          "workspaceSpecsPlacement={{workspaceSpecsPlacement}}",
          "workspaceMigrationsPlacement={{workspaceMigrationsPlacement}}",
          "workspaceDesignPath={{workspaceDesignPath}}",
          "workspaceSpecsPath={{workspaceSpecsPath}}",
          "workspaceMigrationsPath={{workspaceMigrationsPath}}",
        ].join("\n");
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      printPrompt: true,
      verify: false,
      varsFileOption: ".rundown/vars.json",
      cliTemplateVarArgs: [
        "invocationDir=/fake/cli/invocation",
        "workspaceDir=/fake/cli/workspace",
        "workspaceLinkPath=/fake/cli/workspace.link",
        "isLinkedWorkspace=false",
        "workspaceDesignPlacement=workdir",
      ],
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`invocationDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain(`workspaceDir=${path.resolve("/real/workspace")}`);
    expect(prompt).toContain(`workspaceLinkPath=${path.resolve("/real/invocation/.rundown/workspace.link")}`);
    expect(prompt).toContain("isLinkedWorkspace=true");
    expect(prompt).toContain("workspaceDesignDir=design");
    expect(prompt).toContain("workspaceSpecsDir=specs");
    expect(prompt).toContain("workspaceMigrationsDir=migrations");
    expect(prompt).toContain("workspaceDesignPlacement=sourcedir");
    expect(prompt).toContain("workspaceSpecsPlacement=sourcedir");
    expect(prompt).toContain("workspaceMigrationsPlacement=sourcedir");
    expect(prompt).toContain(`workspaceDesignPath=${path.resolve("/real/workspace", "design")}`);
    expect(prompt).toContain(`workspaceSpecsPath=${path.resolve("/real/workspace", "specs")}`);
    expect(prompt).toContain(`workspaceMigrationsPath=${path.resolve("/real/workspace", "migrations")}`);
    expect(prompt).not.toContain(path.resolve("/fake/file/invocation"));
    expect(prompt).not.toContain(path.resolve("/fake/cli/invocation"));
  });

  it("emits non-linked workspace context template variables with fallback values", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return [
          "invocationDir={{invocationDir}}",
          "workspaceDir={{workspaceDir}}",
          "workspaceLinkPath={{workspaceLinkPath}}",
          "isLinkedWorkspace={{isLinkedWorkspace}}",
          "workspaceDesignDir={{workspaceDesignDir}}",
          "workspaceSpecsDir={{workspaceSpecsDir}}",
          "workspaceMigrationsDir={{workspaceMigrationsDir}}",
          "workspaceDesignPlacement={{workspaceDesignPlacement}}",
          "workspaceSpecsPlacement={{workspaceSpecsPlacement}}",
          "workspaceMigrationsPlacement={{workspaceMigrationsPlacement}}",
          "workspaceDesignPath={{workspaceDesignPath}}",
          "workspaceSpecsPath={{workspaceSpecsPath}}",
          "workspaceMigrationsPath={{workspaceMigrationsPath}}",
        ].join("\n");
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      printPrompt: true,
      verify: false,
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`invocationDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain(`workspaceDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain("workspaceLinkPath=");
    expect(prompt).toContain("isLinkedWorkspace=false");
    expect(prompt).toContain("workspaceDesignDir=design");
    expect(prompt).toContain("workspaceSpecsDir=specs");
    expect(prompt).toContain("workspaceMigrationsDir=migrations");
    expect(prompt).toContain("workspaceDesignPlacement=sourcedir");
    expect(prompt).toContain("workspaceSpecsPlacement=sourcedir");
    expect(prompt).toContain("workspaceMigrationsPlacement=sourcedir");
    expect(prompt).toContain(`workspaceDesignPath=${path.resolve("/real/invocation", "design")}`);
    expect(prompt).toContain(`workspaceSpecsPath=${path.resolve("/real/invocation", "specs")}`);
    expect(prompt).toContain(`workspaceMigrationsPath=${path.resolve("/real/invocation", "migrations")}`);
    expect(prompt).not.toContain(path.resolve("/real/workspace"));
    expect(prompt).not.toContain(path.resolve("/real/invocation/.rundown/workspace.link"));
  });

  it("emits deterministic fallback workspace context vars for stale-link runtime inputs", async () => {
    const cwd = "/workspace/invocation";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return [
          "invocationDir={{invocationDir}}",
          "workspaceDir={{workspaceDir}}",
          "workspaceLinkPath={{workspaceLinkPath}}",
          "isLinkedWorkspace={{isLinkedWorkspace}}",
        ].join("\n");
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      printPrompt: true,
      verify: false,
      invocationDir: "/real/invocation",
      workspaceDir: "/real/stale-workspace",
      workspaceLinkPath: "/real/invocation/.rundown/workspace.link",
      isLinkedWorkspace: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain(`invocationDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain(`workspaceDir=${path.resolve("/real/invocation")}`);
    expect(prompt).toContain("workspaceLinkPath=");
    expect(prompt).toContain("isLinkedWorkspace=false");
    expect(prompt).not.toContain(path.resolve("/real/stale-workspace"));
    expect(prompt).not.toContain(path.resolve("/real/invocation/.rundown/workspace.link"));
  });

  it("keeps execution cwd rooted at resolved workspace even when link metadata falls back", async () => {
    const invocationDir = "/workspace/invocation";
    const workspaceDir = "/workspace/resolved";
    const taskFile = `${workspaceDir}/tasks.md`;
    const cliBlockExecutor = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({
      cwd: workspaceDir,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\npwd\n```";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      invocationDir,
      workspaceDir,
      workspaceLinkPath: `${invocationDir}/.rundown/workspace.link`,
      isLinkedWorkspace: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "pwd",
      workspaceDir,
      expect.any(Object),
    );
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      cwd: workspaceDir,
    }));
  });

  it("uses parser-appended cli-args directly for inline cli execution", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSource = [
      "- cli-args: --worker opencode",
      "  - [ ] cli: npm test",
    ].join("\n");
    const parsedTask = parseTasks(fileSource, taskFile)[0]!;
    const { dependencies } = createDependencies({
      cwd,
      task: parsedTask,
      fileSystem: createInMemoryFileSystem({ [taskFile]: fileSource + "\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledWith(
      "npm test --worker opencode",
      path.dirname(path.resolve(taskFile)),
      expect.any(Object),
    );
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("updates worker and profile health to healthy on successful fallback execution", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const workerHealthStore = {
      read: vi.fn(() => ({
        schemaVersion: 1,
        updatedAt: "2026-04-12T09:00:00.000Z",
        entries: [
          {
            key: buildWorkerHealthWorkerKey(["primary", "worker"]),
            source: "worker" as const,
            status: WORKER_HEALTH_STATUS_UNAVAILABLE,
            lastFailureClass: "transport_unavailable" as const,
            lastFailureAt: "2026-04-12T08:59:00.000Z",
            failureCountWindow: 4,
          },
          {
            key: buildWorkerHealthWorkerKey(["fallback", "worker"]),
            source: "worker" as const,
            status: WORKER_HEALTH_STATUS_COOLING_DOWN,
            cooldownUntil: "2026-04-12T08:00:00.000Z",
            lastFailureClass: "usage_limit" as const,
            lastFailureAt: "2026-04-12T07:59:00.000Z",
            failureCountWindow: 2,
          },
          {
            key: buildWorkerHealthProfileKey("fast"),
            source: "profile" as const,
            status: WORKER_HEALTH_STATUS_COOLING_DOWN,
            cooldownUntil: "2026-04-12T08:00:00.000Z",
            lastFailureClass: "usage_limit" as const,
            lastFailureAt: "2026-04-12T07:58:00.000Z",
            failureCountWindow: 3,
          },
        ],
      })),
      write: vi.fn(),
      filePath: vi.fn(() => `${cwd}/.rundown/worker-health.json`),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement fallback behavior", { directiveProfile: "fast" }),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement fallback behavior\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        profiles: {
          fast: ["primary", "worker"],
        },
      },
    });
    dependencies.workerHealthStore = workerHealthStore;

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      workerPattern: expect.objectContaining({
        command: ["fallback", "worker"],
      }),
    }));
    expect(workerHealthStore.write).toHaveBeenCalled();

    const persistedSnapshot = workerHealthStore.write.mock.calls.at(-1)?.[0];
    expect(persistedSnapshot).toBeDefined();
    if (!persistedSnapshot) {
      throw new Error("Expected persisted worker health snapshot.");
    }

    const fallbackEntry = persistedSnapshot.entries.find(
      (entry: { key: string; source: string }) => entry.source === "worker"
        && entry.key === buildWorkerHealthWorkerKey(["fallback", "worker"]),
    );
    expect(fallbackEntry).toBeDefined();
    if (!fallbackEntry) {
      throw new Error("Expected fallback worker health entry.");
    }
    expect(fallbackEntry).toEqual(expect.objectContaining({
      key: buildWorkerHealthWorkerKey(["fallback", "worker"]),
      source: "worker",
      status: WORKER_HEALTH_STATUS_HEALTHY,
      lastFailureClass: WORKER_FAILURE_CLASS_SUCCESS,
      failureCountWindow: 0,
    }));
    expect(fallbackEntry.cooldownUntil).toBeUndefined();
    expect(fallbackEntry.lastFailureAt).toBeUndefined();
    expect(typeof fallbackEntry.lastSuccessAt).toBe("string");

    const profileEntry = persistedSnapshot.entries.find(
      (entry: { key: string; source: string }) => entry.source === "profile"
        && entry.key === buildWorkerHealthProfileKey("fast"),
    );
    expect(profileEntry).toBeDefined();
    if (!profileEntry) {
      throw new Error("Expected profile worker health entry.");
    }
    expect(profileEntry).toEqual(expect.objectContaining({
      key: buildWorkerHealthProfileKey("fast"),
      source: "profile",
      status: WORKER_HEALTH_STATUS_HEALTHY,
      lastFailureClass: WORKER_FAILURE_CLASS_SUCCESS,
      failureCountWindow: 0,
    }));
    expect(profileEntry.cooldownUntil).toBeUndefined();
    expect(profileEntry.lastFailureAt).toBeUndefined();
    expect(typeof profileEntry.lastSuccessAt).toBe("string");
  });

  it("preserves quoted cli-args when executing inline cli tasks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSource = [
      "- cli-args: --worker \"my worker\"",
      "  - [ ] cli: npm test",
    ].join("\n");
    const parsedTask = parseTasks(fileSource, taskFile)[0]!;
    const { dependencies } = createDependencies({
      cwd,
      task: parsedTask,
      fileSystem: createInMemoryFileSystem({ [taskFile]: fileSource + "\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledWith(
      "npm test --worker \"my worker\"",
      path.dirname(path.resolve(taskFile)),
      expect.any(Object),
    );
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("retries force-prefixed inline cli tasks after inline command failure", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: {
        ...createInlineTask(taskFile, "force: cli: echo hello"),
        cliCommand: "echo hello",
      },
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: cli: echo hello\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.taskSelector.selectTaskByLocation = vi.fn(() => ({
      task: {
        ...createInlineTask(taskFile, "force: cli: echo hello"),
        cliCommand: "echo hello",
      },
      source: "tasks.md",
      contextBefore: "",
    }));

    dependencies.workerExecutor.executeInlineCli = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenNthCalledWith(
      1,
      "echo hello",
      path.dirname(path.resolve(taskFile)),
      expect.any(Object),
    );
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenNthCalledWith(
      2,
      "echo hello",
      path.dirname(path.resolve(taskFile)),
      expect.any(Object),
    );
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries full iteration for force-prefixed tasks until success", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 3, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 3, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 3 — restarting task iteration from scratch",
    }));
  });

  it("pairs group-start and group-end events across force retries", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    const groupEvents = events.filter((event) => event.kind === "group-start" || event.kind === "group-end");
    expect(groupEvents).toHaveLength(4);
    expect(groupEvents[0]).toEqual(expect.objectContaining({ kind: "group-start" }));
    expect(groupEvents[1]).toEqual(expect.objectContaining({ kind: "group-end", status: "failure" }));
    expect(groupEvents[2]).toEqual(expect.objectContaining({ kind: "group-start" }));
    expect(groupEvents[3]).toEqual(expect.objectContaining({ kind: "group-end", status: "success" }));
  });

  it("keeps retrying the same force task in --all mode before advancing", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, task one\n- [ ] task two\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, task one"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const executedPrompts: string[] = [];
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockImplementation(async ({ prompt }: { prompt: string }) => {
        executedPrompts.push(prompt);
        if (prompt.includes("task one") && executedPrompts.length === 1) {
          return { exitCode: 1, stdout: "", stderr: "boom" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    expect(executedPrompts).toEqual([
      "task one",
      "task one",
      "task two",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("increments --all task index only after force retry loop finishes", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, task one\n- [ ] task two\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, task one"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const executedPrompts: string[] = [];
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockImplementation(async ({ prompt }: { prompt: string }) => {
        executedPrompts.push(prompt);
        if (prompt.includes("task one") && executedPrompts.length === 1) {
          return { exitCode: 1, stdout: "", stderr: "boom" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    expect(executedPrompts).toEqual(["task one", "task one", "task two"]);
    const groupStartCounters = events
      .filter((event): event is Extract<typeof event, { kind: "group-start" }> => event.kind === "group-start")
      .map((event) => event.counter?.current)
      .filter((counter): counter is number => typeof counter === "number");
    expect(groupStartCounters).toEqual([1, 1, 2]);
  });

  it("inserts trace statistics per task in --all mode without cross-task carryover", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] AAAA\n- [ ] BBBBBBBB\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "AAAA"),
      fileSystem,
      gitClient: createGitClientMock(),
      workerConfig: {
        traceStatistics: {
          enabled: true,
          fields: ["tokens_estimated"],
        },
      },
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] AAAA",
      "  - tokens estimated: 1",
      "- [x] BBBBBBBB",
      "  - tokens estimated: 2",
      "",
    ].join("\n"));
  });

  it("cleans prior trace statistics during --redo and avoids duplication across reruns", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [x] AAAA",
        "  - total time: 9s",
        "    - execution: 8s",
        "  - tokens estimated: 999",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "AAAA"),
      fileSystem,
      gitClient: createGitClientMock(),
      workerConfig: {
        traceStatistics: {
          enabled: true,
          fields: ["tokens_estimated"],
        },
      },
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);

    const firstCode = await runTask(createOptions({ verify: false, redo: true, traceStats: true }));
    expect(firstCode).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] AAAA",
      "  - tokens estimated: 1",
      "",
    ].join("\n"));
    expect(fileSystem.readText(taskFile)).not.toContain("total time: 9s");
    expect(fileSystem.readText(taskFile)).not.toContain("tokens estimated: 999");

    const secondCode = await runTask(createOptions({ verify: false, redo: true, traceStats: true }));
    expect(secondCode).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] AAAA",
      "  - tokens estimated: 1",
      "",
    ].join("\n"));
  });

  it("selects unchecked tasks correctly when prior tasks contain trace-statistics subItems", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [x] Completed task",
        "  - total time: 5s",
        "    - execution: 2s",
        "  - tokens estimated: 42",
        "- [ ] Follow-up task",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "Follow-up task"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }

      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Follow-up task",
    }));
    expect(fileSystem.readText(taskFile)).toContain("- [x] Follow-up task");
  });

  it("refreshes force task text from source before retrying same task identity", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, implement feature v1\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature v1"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const executedPrompts: string[] = [];
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockImplementation(async ({ prompt }: { prompt: string }) => {
        executedPrompts.push(prompt);
        if (executedPrompts.length === 1) {
          fileSystem.writeText(taskFile, "- [ ] force: 2, implement feature v2\n");
          return { exitCode: 1, stdout: "", stderr: "boom" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(executedPrompts).toEqual([
      "implement feature v1",
      "implement feature v2",
    ]);
    expect(dependencies.taskSelector.selectTaskByLocation).toHaveBeenCalledWith(taskFile, 1);
  });

  it("recalculates group counter total before each force retry attempt", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, task one\n- [ ] task two\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, task one"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    let attempts = 0;
    dependencies.workerExecutor.runWorker = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (!prompt.includes("task one")) {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }

      attempts += 1;
      if (attempts === 1) {
        fileSystem.writeText(taskFile, "- [ ] force: 2, task one\n");
        return { exitCode: 1, stdout: "", stderr: "boom" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    const groupStartEvents = events.filter((event) => event.kind === "group-start");
    expect(groupStartEvents).toHaveLength(2);
    expect(groupStartEvents[0]).toEqual(expect.objectContaining({
      kind: "group-start",
      counter: expect.objectContaining({ total: 2 }),
    }));
    expect(groupStartEvents[1]).toEqual(expect.objectContaining({
      kind: "group-start",
      counter: expect.objectContaining({ total: 1 }),
    }));
  });

  it("refreshes group counter total before selecting the next task after dynamic insertion", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] first task\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "first task"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    let executionCount = 0;
    dependencies.workerExecutor.runWorker = vi.fn(async ({ prompt }: { prompt: string }) => {
      executionCount += 1;
      if (executionCount === 1 && prompt === "first task") {
        fileSystem.writeText(taskFile, "- [ ] first task\n- [ ] second task\n");
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    const groupStartEvents = events.filter((event) => event.kind === "group-start");
    expect(groupStartEvents).toHaveLength(2);
    expect(groupStartEvents[0]).toEqual(expect.objectContaining({
      kind: "group-start",
      counter: expect.objectContaining({ current: 1, total: 1 }),
    }));
    expect(groupStartEvents[1]).toEqual(expect.objectContaining({
      kind: "group-start",
      counter: expect.objectContaining({ current: 2, total: 2 }),
    }));
  });

  it("treats a force task as completed when it is already checked before retry", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, implement feature\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockImplementationOnce(async () => {
        fileSystem.writeText(taskFile, "- [x] force: 2, implement feature\n");
        return { exitCode: 1, stdout: "", stderr: "boom" };
      });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: expect.stringContaining("Force retry stopped: task is already checked"),
    }));
  });

  it("checks force-prefixed task only after final successful retry", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] force: 2, implement feature\n",
    });
    const writeTextSpy = vi.spyOn(fileSystem, "writeText");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
    expect(writeTextSpy).toHaveBeenCalledTimes(1);
    expect(fileSystem.readText(taskFile)).toBe("- [x] force: 2, implement feature\n");
  });

  it("runs --on-fail hook for each failed force retry attempt", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 3, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 3, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom-1" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom-2" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      onFailCommand: "node scripts/on-fail.js",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(3);
    expect(vi.mocked(dependencies.processRunner.run)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dependencies.processRunner.run)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "node scripts/on-fail.js" }),
    );
    expect(vi.mocked(dependencies.processRunner.run)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "node scripts/on-fail.js" }),
    );
  });

  it("propagates on-complete hook failures after a successful force retry", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });
    dependencies.processRunner.run = vi.fn(async () => ({
      exitCode: 17,
      stdout: "",
      stderr: "",
    }));

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      onCompleteCommand: "node scripts/on-complete.js",
    }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dependencies.processRunner.run)).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.kind === "warn"
      && event.message.includes("Force retry"))).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "--on-complete hook exited with code 17",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "group-end",
      status: "success",
    }));
  });

  it("stops retrying force-prefixed task after max attempts", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("stashes git state at commit retry boundary before failover retries", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const gitClient = createGitClientMock();
    let statusCheckCount = 0;
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return cwd;
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        if (args.includes("--untracked-files=no")) {
          return " M tasks.md";
        }
        statusCheckCount += 1;
        if (statusCheckCount === 1) {
          return "";
        }
        if (statusCheckCount === 2) {
          return " M tasks.md";
        }
        return "";
      }
      if (args[0] === "stash" && args[1] === "push") {
        return "Saved working directory and index state";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "stash@{0}") {
        return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      }
      if (args[0] === "add" || args[0] === "commit") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });

    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement fallback behavior"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement fallback behavior\n" }),
      gitClient,
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
      },
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      workerCommand: [],
      commitAfterComplete: true,
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["fallback", "worker"] }),
    }));
    const stashPushCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "push",
    );
    const stashApplyCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "apply",
    );
    expect(stashPushCalls).toHaveLength(1);
    expect(stashApplyCalls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: expect.stringContaining("--commit: stashed retry-boundary git state"),
    }));
  });

  it("restores stashed git state after terminal force retry failure in commit mode", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const gitClient = createGitClientMock();
    let statusCheckCount = 0;
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return cwd;
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        statusCheckCount += 1;
        if (statusCheckCount === 1) {
          return "";
        }
        if (statusCheckCount === 2) {
          return " M tasks.md";
        }
        return "";
      }
      if (args[0] === "stash" && args[1] === "push") {
        return "Saved working directory and index state";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "stash@{0}") {
        return "feedfacefeedfacefeedfacefeedfacefeedface";
      }
      if (args[0] === "stash" && args[1] === "apply") {
        return "";
      }
      return "";
    });

    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient,
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      commitAfterComplete: true,
    }));

    expect(code).toBe(1);
    const stashPushCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "push",
    );
    const stashApplyCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "apply",
    );
    expect(stashPushCalls).toHaveLength(1);
    expect(stashApplyCalls).toHaveLength(1);
    expect(stashApplyCalls[0]?.[0]).toEqual([
      "stash",
      "apply",
      "feedfacefeedfacefeedfacefeedfacefeedface",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: expect.stringContaining("--commit: restored stashed retry-boundary git state"),
    }));
  });

  it("reapplies deferred commit baseline state across failover retry boundaries in file-done mode", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const gitClient = createGitClientMock();
    let generalStatusCallCount = 0;
    let stashTopHash = "";
    let stashPushCount = 0;
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return cwd;
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        if (args.includes("--untracked-files=no")) {
          return " M tasks.md";
        }
        generalStatusCallCount += 1;
        if (generalStatusCallCount === 1) {
          return "";
        }
        if (generalStatusCallCount === 4) {
          return "";
        }
        return " M tasks.md";
      }
      if (args[0] === "stash" && args[1] === "push") {
        stashPushCount += 1;
        stashTopHash = stashPushCount === 1
          ? "1111111111111111111111111111111111111111"
          : "2222222222222222222222222222222222222222";
        return "Saved working directory and index state";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "stash@{0}") {
        return stashTopHash;
      }
      if (args[0] === "stash" && args[1] === "apply") {
        return "";
      }
      if (args[0] === "add" || args[0] === "commit") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });

    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] first task\n- [ ] second task\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "first task"),
      fileSystem,
      gitClient,
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
      },
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    let workerCallCount = 0;
    dependencies.workerExecutor.runWorker = vi.fn(async () => {
      workerCallCount += 1;
      if (workerCallCount === 2) {
        return { exitCode: null, stdout: "", stderr: "timed out" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      workerCommand: [],
      commitAfterComplete: true,
      commitMode: "file-done",
    }));

    expect(code).toBe(0);
    const stashPushCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "push",
    );
    const stashApplyCalls = vi.mocked(gitClient.run).mock.calls.filter(
      ([args]) => args[0] === "stash" && args[1] === "apply",
    );
    expect(stashPushCalls).toHaveLength(2);
    expect(stashApplyCalls).toHaveLength(2);
    expect(stashApplyCalls[0]?.[0]).toEqual([
      "stash",
      "apply",
      "1111111111111111111111111111111111111111",
    ]);
    expect(stashApplyCalls[1]?.[0]).toEqual([
      "stash",
      "apply",
      "1111111111111111111111111111111111111111",
    ]);
  });

  it("runs all force attempts on repeated failure and returns final failRun exit code", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 3, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 3, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 3 — restarting task iteration from scratch",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 3 of 3 — restarting task iteration from scratch",
    }));
  });

  it("uses default health-policy behavior when healthPolicy config is missing", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const workerHealthStore = {
      read: vi.fn(() => ({
        schemaVersion: 1,
        updatedAt: "2026-04-12T09:00:00.000Z",
        entries: [],
      })),
      write: vi.fn(),
      filePath: vi.fn(() => `${cwd}/.rundown/worker-health.json`),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement fallback behavior"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement fallback behavior\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
      },
    });
    dependencies.workerHealthStore = workerHealthStore;
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "connection reset by peer" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerPattern: expect.objectContaining({
        command: ["fallback", "worker"],
      }),
    }));

    const persistedSnapshot = workerHealthStore.write.mock.calls.at(-1)?.[0];
    expect(persistedSnapshot).toBeDefined();
    if (!persistedSnapshot) {
      throw new Error("Expected persisted worker health snapshot.");
    }

    const primaryEntry = persistedSnapshot.entries.find(
      (entry: { key: string; source: string }) => entry.source === "worker"
        && entry.key === buildWorkerHealthWorkerKey(["primary", "worker"]),
    );
    expect(primaryEntry).toEqual(expect.objectContaining({
      status: WORKER_HEALTH_STATUS_UNAVAILABLE,
      lastFailureClass: WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
    }));

    const fallbackEntry = persistedSnapshot.entries.find(
      (entry: { key: string; source: string }) => entry.source === "worker"
        && entry.key === buildWorkerHealthWorkerKey(["fallback", "worker"]),
    );
    expect(fallbackEntry).toEqual(expect.objectContaining({
      status: WORKER_HEALTH_STATUS_HEALTHY,
      lastFailureClass: WORKER_FAILURE_CLASS_SUCCESS,
      failureCountWindow: 0,
    }));
  });

  it("persists profile-level failure health across runs and blocks later profile resolution", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    let persistedSnapshot: WorkerHealthSnapshot = {
      schemaVersion: 1,
      updatedAt: "2026-04-12T09:00:00.000Z",
      entries: [],
    };
    const workerHealthStore = {
      read: vi.fn(() => persistedSnapshot),
      write: vi.fn((nextSnapshot: WorkerHealthSnapshot) => {
        persistedSnapshot = nextSnapshot;
      }),
      filePath: vi.fn(() => `${cwd}/.rundown/worker-health.json`),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement fallback behavior", { directiveProfile: "fast" }),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement fallback behavior\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        profiles: {
          fast: ["primary", "worker"],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 0,
        },
      },
    });
    dependencies.workerHealthStore = workerHealthStore;
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "connection reset by peer" });

    const runTask = createRunTaskExecution(dependencies);
    const firstRunCode = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(firstRunCode).toBe(1);
    const profileEntryAfterFirstRun = persistedSnapshot.entries.find(
      (entry) => entry.source === "profile" && entry.key === buildWorkerHealthProfileKey("fast"),
    );
    expect(profileEntryAfterFirstRun).toEqual(expect.objectContaining({
      key: buildWorkerHealthProfileKey("fast"),
      source: "profile",
      lastFailureClass: WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
    }));
    expect(profileEntryAfterFirstRun?.status === WORKER_HEALTH_STATUS_UNAVAILABLE
      || profileEntryAfterFirstRun?.status === WORKER_HEALTH_STATUS_COOLING_DOWN).toBe(true);

    const emittedEventCountAfterFirstRun = events.length;
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const secondRunCode = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(secondRunCode).toBe(1);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(events.slice(emittedEventCountAfterFirstRun)).toContainEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("No worker command available"),
    }));
  });

  it("enforces per-task failover limit and stops before additional fallbacks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement failover limits"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement failover limits\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
            ["fallback", "two"],
          ],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 1,
        },
      },
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "connection reset by peer" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerPattern: expect.objectContaining({
        command: ["fallback", "one"],
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("Failover exhausted: per-task failover attempt limit reached"),
    }));
  });

  it("enforces per-run failover limit across multiple tasks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] task one\n- [ ] task two\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "task one"),
      fileSystem,
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 2,
          maxFailoverAttemptsPerRun: 1,
        },
      },
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" })
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "connection reset by peer" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true, workerCommand: [] }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("Failover exhausted: per-run failover attempt limit reached"),
    }));
  });

  it("tracks semantic reset retries independently from failover budgets", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "task with reset route"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] task with reset route\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 1,
        },
        run: {
          workerRouting: {
            reset: {
              worker: ["reset", "worker"],
            },
          },
        },
      },
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });
    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, formatWarning: undefined })
      .mockResolvedValueOnce({ valid: true, formatWarning: undefined });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: true,
      noRepair: true,
      workerCommand: [],
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(3);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["primary", "worker"] }),
    }));
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["fallback", "worker"] }),
    }));
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(3, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["reset", "worker"] }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: expect.stringContaining("retrying with next eligible fallback"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: expect.stringContaining("Verification/repair exhausted; retrying with configured reset worker"),
    }));
  });

  it("allows semantic reset retry when failover attempts are disabled", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "verification failure with reset"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] verification failure with reset\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 0,
        },
        run: {
          workerRouting: {
            reset: {
              worker: ["reset", "worker"],
            },
          },
        },
      },
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });
    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, formatWarning: undefined })
      .mockResolvedValueOnce({ valid: true, formatWarning: undefined });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: true,
      noRepair: true,
      workerCommand: [],
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["default", "worker"] }),
    }));
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workerPattern: expect.objectContaining({ command: ["reset", "worker"] }),
    }));
    expect(events.some((event) => event.kind === "error"
      && event.message.includes("Failover exhausted"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: expect.stringContaining("Verification/repair exhausted; retrying with configured reset worker"),
    }));
  });

  it("does not create retry-boundary stash entries when commit-mode retries start clean", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const gitClient = createGitClientMock();
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return cwd;
      }
      if (args[0] === "check-ignore") {
        throw new Error("not ignored");
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return "";
      }
      if (args[0] === "add" || args[0] === "commit") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });

    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "implement fallback behavior"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] implement fallback behavior\n" }),
      gitClient,
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
      },
    });
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timed out" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      workerCommand: [],
      commitAfterComplete: true,
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    const stashCalls = vi.mocked(gitClient.run).mock.calls.filter(([args]) => args[0] === "stash");
    expect(stashCalls).toHaveLength(0);
  });

  it("passes stripped force payload into iteration prefix parsing", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: verify: tests pass\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: expect.stringContaining("Task classified as verify-only"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: "Execution phase skipped; entering verification phase.",
    }));
  });

  it("keeps force: outer retries independent from --force-execute verify-only override", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: verify: tests pass\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      forceExecute: true,
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.taskVerification.verify).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: expect.stringContaining("--force-execute is enabled; running execution."),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries force-prefixed task after verification failure", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, failureReason: "still failing" })
      .mockResolvedValueOnce({ valid: true });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: true, noRepair: true }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("clears verificationStore between force retries so stale failures do not leak", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    let storedVerificationFailure: string | null = "first attempt stale verification failure";
    const verificationSnapshots: Array<string | null> = [];
    dependencies.verificationStore.read = vi.fn(() => storedVerificationFailure);
    dependencies.verificationStore.remove = vi.fn(() => {
      storedVerificationFailure = null;
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    dependencies.taskVerification.verify = vi.fn(async () => {
      verificationSnapshots.push(storedVerificationFailure);
      return { valid: false, formatWarning: undefined };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: true, noRepair: true }));

    expect(code).toBe(2);
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.verificationStore.remove).toHaveBeenCalledTimes(1);
    expect(verificationSnapshots).toEqual([
      "first attempt stale verification failure",
      null,
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("runs full --repair-attempts budget on each force retry", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValue({ valid: false, formatWarning: undefined });
    dependencies.taskRepair.repair = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, attempts: 1 })
      .mockResolvedValueOnce({ valid: false, attempts: 1 })
      .mockResolvedValueOnce({ valid: false, attempts: 1 })
      .mockResolvedValueOnce({ valid: true, attempts: 1 });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: true, repairAttempts: 2 }));

    expect(code).toBe(0);
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.taskRepair.repair).toHaveBeenCalledTimes(4);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
    expect(events.filter((event) => event.kind === "info"
      && event.message === "  Repair attempt 1 of 2: starting...")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "info"
      && event.message === "  Repair attempt 2 of 2: starting...")).toHaveLength(2);
  });

  it("retries outer force loop after inner repair exhaustion", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: verify: tests pass\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, failureReason: "tests still failing" })
      .mockResolvedValueOnce({ valid: true });
    dependencies.taskRepair.repair = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, attempts: 1 })
      .mockResolvedValueOnce({ valid: false, attempts: 1 });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, repairAttempts: 2 }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.taskRepair.repair).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Repair phase complete: all repair attempts exhausted.",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries verify-only iteration for force: verify: tasks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: verify: tests pass\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, failureReason: "tests still failing" })
      .mockResolvedValueOnce({ valid: true });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, noRepair: true }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: "Execution phase skipped; entering verification phase.",
    }));
  });

  it("applies profile modifier on each force retry attempt", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: profile=fast, verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: profile=fast, verify: tests pass\n" }),
      gitClient: createGitClientMock(),
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--profile", "default"],
        },
        profiles: {
          fast: ["opencode", "run", "--profile", "fast"],
        },
      },
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    dependencies.taskVerification.verify = vi
      .fn()
      .mockResolvedValueOnce({ valid: false, failureReason: "tests still failing" })
      .mockResolvedValueOnce({ valid: true });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, noRepair: true, workerCommand: [] }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.taskVerification.verify).toHaveBeenCalledTimes(2);
    expect(dependencies.taskVerification.verify).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--profile", "fast"],
        }),
      }),
    );
    expect(dependencies.taskVerification.verify).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--profile", "fast"],
        }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries force-prefixed task after template cli failure", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const cliBlockExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "boom" })
        .mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\necho fail-once\n```";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries include expansion for force: include: tasks after include execution failure", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const childFile = `${cwd}/child.md`;
    const resolvedChildFile = path.resolve(childFile);
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: include: ./child.md"),
      fileSystem: createInMemoryFileSystem({
        [taskFile]: "- [ ] force: include: ./child.md\n",
        [childFile]: "- [ ] nested task\n",
        [resolvedChildFile]: "- [ ] nested task\n",
      }),
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    dependencies.workerExecutor.executeRundownTask = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "include failed" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.executeRundownTask).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("retries memory capture for force: memory: tasks after persistence failure", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: memory: capture notes"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: memory: capture notes\n" }),
      gitClient: createGitClientMock(),
    });

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Captured release context", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("clears cached cli block executor between force retry attempts", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const cliBlockExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "boom" })
        .mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\necho fail-once\n```";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, cacheCliBlocks: true }));

    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
  });

  it("resets per-iteration artifacts between force retry attempts", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const cliBlockExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "boom" }),
    };
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "```cli\necho fail-once\n```";
      }
      return null;
    };
    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, trace: true }));

    expect(code).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
    expect(cliBlockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
  });

  it("runs trace enrichment only once after final force attempt outcome", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    let executionAttempts = 0;
    const runWorkerMock = vi.fn(async (input) => {
      if (input.artifactExtra?.taskType === "trace-enrichment") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      executionAttempts += 1;
      if (executionAttempts === 1) {
        return { exitCode: 1, stdout: "", stderr: "boom" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    dependencies.workerExecutor.runWorker = runWorkerMock;

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, trace: true }));

    expect(code).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "warn",
      message: "Force retry 2 of 2 — restarting task iteration from scratch",
    }));
    const traceEnrichmentCalls = runWorkerMock.mock.calls.filter(
      ([input]) => input.artifactExtra?.taskType === "trace-enrichment",
    );
    expect(traceEnrichmentCalls).toHaveLength(1);
  });

  it("emits force.retry trace event with prior run id across force attempts", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 2, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 2, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    let runCounter = 0;
    dependencies.artifactStore.createContext = vi.fn((contextOptions) => {
      runCounter += 1;
      return {
        runId: `run-test-${runCounter}`,
        rootDir: `${cwd}/.rundown/runs/run-test-${runCounter}`,
        cwd: contextOptions.cwd ?? cwd,
        configDir: contextOptions.configDir,
        keepArtifacts: contextOptions.keepArtifacts ?? false,
        commandName: contextOptions.commandName,
        workerCommand: contextOptions.workerCommand,
        mode: contextOptions.mode,
        transport: contextOptions.transport,
        task: contextOptions.task,
      };
    });

    const traceEvents: TraceEvent[] = [];
    const writeTrace = vi.fn((event: TraceEvent) => {
      traceEvents.push(event);
    });
    dependencies.traceWriter = {
      write: writeTrace,
      flush: vi.fn(),
    };
    dependencies.createTraceWriter = vi.fn(() => ({
      write: writeTrace,
      flush: vi.fn(),
    }));

    dependencies.workerExecutor.runWorker = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, trace: true }));

    expect(code).toBe(0);
    expect(dependencies.artifactStore.createContext).toHaveBeenCalledTimes(2);
    const runStartedEvents = traceEvents.filter((event) => event.event_type === "run.started");
    expect(runStartedEvents).toHaveLength(2);
    expect(runStartedEvents[0]?.run_id).toBe("run-test-1");
    expect(runStartedEvents[1]?.run_id).toBe("run-test-2");
    const forceRetryEvent = traceEvents.find((event) => event.event_type === "force.retry");
    expect(forceRetryEvent).toBeDefined();
    expect(forceRetryEvent?.run_id).toBe("run-test-2");
    expect(forceRetryEvent?.payload).toEqual(expect.objectContaining({
      attempt_number: 2,
      max_attempts: 2,
      previous_run_id: "run-test-1",
      previous_exit_code: 1,
    }));
  });

  it("does not retry force-prefixed task for empty-payload validation failures", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: memory:"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: memory:\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.taskSelector.selectTaskByLocation).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Force retry"))).toBe(false);
  });

  it("does not retry force-prefixed task for missing-worker-command validation failures", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, workerCommand: [] }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.taskSelector.selectTaskByLocation).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
    }));
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Force retry"))).toBe(false);
  });

  it("does not retry force-prefixed task during --dry-run", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 3, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 3, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ dryRun: true }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Force retry"))).toBe(false);
  });

  it("does not retry force-prefixed task during --print-prompt", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "force: 3, implement feature"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: 3, implement feature\n" }),
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ printPrompt: true }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Force retry"))).toBe(false);
  });

  it.each([
    { label: "--dry-run", options: { dryRun: true } },
    { label: "--print-prompt", options: { printPrompt: true } },
  ])("keeps fenced get-result lines stable during $label", async ({ options }) => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const initialSource = [
      "- [ ] get: All current names of this and that",
      "  ```md",
      "  - get-result: Example inside fence",
      "  ```",
      "",
    ].join("\n");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: initialSource,
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "get: All current names of this and that"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      ...options,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe(initialSource);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("refreshes get-result metadata without mutating fenced regions during normal run", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] get: All current names of this and that",
        "  ~~~md",
        "  - get-result: Example inside fence",
        "  ~~~",
        "  - get-mode: refresh",
        "  - get-result: Legacy",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "get: All current names of this and that"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"results":["This","That"]}',
      stderr: "",
    }));

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] get: All current names of this and that",
      "  ~~~md",
      "  - get-result: Example inside fence",
      "  ~~~",
      "  - get-mode: refresh",
      "  - get-result: This",
      "  - get-result: That",
      "",
    ].join("\n"));
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
  });

  it("writes canonical escaped get-result metadata during refresh and avoids inline-code wrappers", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] get: All current names of this and that",
        "  - get-mode: refresh",
        "  - get-result: Legacy",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "get: All current names of this and that"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"results":["`edge` : [parser]*module*"]}',
      stderr: "",
    }));

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] get: All current names of this and that",
      "  - get-mode: refresh",
      "  - get-result: \\`edge\\` : \\[parser\\]\\*module\\*",
      "",
    ].join("\n"));
    expect(fileSystem.readText(taskFile)).not.toContain("  - get-result: ```edge` : [parser]*module*```");
  });

  it("keeps mixed legacy/canonical metadata stable in reuse and canonicalizes on refresh rerun", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] get: All current names of this and that",
        "  - get-result: `legacy [value]*`",
        "  - get-result: canonical \\[value\\]",
        "",
      ].join("\n"),
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "get: All current names of this and that"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    const runTask = createRunTaskExecution(dependencies);
    const firstCode = await runTask(createOptions({ verify: false }));

    expect(firstCode).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] get: All current names of this and that",
      "  - get-result: `legacy [value]*`",
      "  - get-result: canonical \\[value\\]",
      "",
    ].join("\n"));

    fileSystem.writeText(taskFile, [
      "- [ ] get: All current names of this and that",
      "  - get-mode: refresh",
      "  - get-result: `legacy [value]*`",
      "  - get-result: canonical \\[value\\]",
      "",
    ].join("\n"));
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"results":["legacy [value]*","canonical [value]"]}',
      stderr: "",
    }));

    const secondCode = await runTask(createOptions({ verify: false }));

    expect(secondCode).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] get: All current names of this and that",
      "  - get-mode: refresh",
      "  - get-result: legacy \\[value\\]\\*",
      "  - get-result: canonical \\[value\\]",
      "",
    ].join("\n"));
    const reparsed = parseTasks(fileSystem.readText(taskFile), taskFile)[0];
    expect(reparsed?.subItems.map((subItem) => subItem.text)).toEqual([
      "get-mode: refresh",
      "get-result: legacy [value]*",
      "get-result: canonical [value]",
    ]);
  });

  it("re-parses task context after tool updates so downstream tasks see new sub-items", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] answerinject: Which module should we improve?\n- [ ] inspect: confirm answer visibility\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "answerinject: Which module should we improve?"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    let inspectObservedAnswer = false;
    dependencies.toolResolver = {
      resolve: (toolName) => {
        if (toolName === "answerinject") {
          return {
            name: "answerinject",
            kind: "handler",
            handler: async (context) => {
              const source = context.fileSystem.readText(context.task.file);
              const lines = source.split("\n");
              const taskLineIndex = context.task.line - 1;
              lines.splice(taskLineIndex + 1, 0, "  - answer: CliResourceModule");
              context.fileSystem.writeText(context.task.file, lines.join("\n"));
              return {
                skipExecution: true,
                shouldVerify: false,
              };
            },
            frontmatter: { skipExecution: true, shouldVerify: false },
          };
        }

        if (toolName === "inspect") {
          return {
            name: "inspect",
            kind: "handler",
            handler: async (context) => {
              const injectedTask = context.allTasks?.find((task) => task.text.startsWith("answerinject:"));
              inspectObservedAnswer = injectedTask?.subItems.some((subItem) => subItem.text === "answer: CliResourceModule")
                ?? false;
              return inspectObservedAnswer
                ? { skipExecution: true, shouldVerify: false }
                : {
                  exitCode: 1,
                  failureMessage: "Downstream tool did not observe injected answer sub-item.",
                  failureReason: "Updated task context did not include injected answer sub-item.",
                };
            },
            frontmatter: { skipExecution: true, shouldVerify: false },
          };
        }

        return undefined;
      },
      listKnownToolNames: () => ["answerinject", "inspect"],
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false, runAll: true }));

    expect(code).toBe(0);
    expect(inspectObservedAnswer).toBe(true);
    expect(fileSystem.readText(taskFile)).toContain("  - answer: CliResourceModule");
  });

  it("keeps get-result/for-item metadata as non-executable sub-items across execution and reruns", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] metadatainject: seed metadata",
        "- [ ] inspect: metadata remains non-executable",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "metadatainject: seed metadata"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const inspectionSnapshots: Array<{ taskCount: number; metadataTaskCount: number; metadataSubItems: string[] }> = [];
    dependencies.toolResolver = {
      resolve: (toolName) => {
        if (toolName === "metadatainject") {
          return {
            name: "metadatainject",
            kind: "handler",
            handler: async (context) => {
              const source = context.fileSystem.readText(context.task.file);
              const lines = source.split("\n");
              const taskLineIndex = context.task.line - 1;
              const existingMetadataStart = taskLineIndex + 1;
              const existingMetadata = [
                lines[existingMetadataStart],
                lines[existingMetadataStart + 1],
              ];
              const hasMetadata = existingMetadata[0] === "  - get-result: Alpha"
                && existingMetadata[1] === "  - for-item: Beta";
              if (!hasMetadata) {
                lines.splice(taskLineIndex + 1, 0, "  - get-result: Alpha", "  - for-item: Beta");
                context.fileSystem.writeText(context.task.file, lines.join("\n"));
              }
              return {
                skipExecution: true,
                shouldVerify: false,
              };
            },
            frontmatter: { skipExecution: true, shouldVerify: false },
          };
        }

        if (toolName === "inspect") {
          return {
            name: "inspect",
            kind: "handler",
            handler: async (context) => {
              const source = context.fileSystem.readText(context.task.file);
              const parsedTasks = parseTasks(source, context.task.file);
              const metadataTaskCount = parsedTasks.filter((task) => /^(?:get-result|for-item)\s*:/i.test(task.text)).length;
              const metadataSubItems = parsedTasks[0]?.subItems.map((subItem) => subItem.text) ?? [];
              inspectionSnapshots.push({
                taskCount: parsedTasks.length,
                metadataTaskCount,
                metadataSubItems,
              });

              const metadataPreservedAsSubItems = metadataSubItems.includes("get-result: Alpha")
                && metadataSubItems.includes("for-item: Beta");
              if (metadataTaskCount === 0 && metadataPreservedAsSubItems) {
                return { skipExecution: true, shouldVerify: false };
              }

              return {
                exitCode: 1,
                failureMessage: "Metadata was promoted to executable tasks.",
                failureReason: "Expected get-result:/for-item: to remain sub-items and not become checkbox tasks.",
              };
            },
            frontmatter: { skipExecution: true, shouldVerify: false },
          };
        }

        return undefined;
      },
      listKnownToolNames: () => ["metadatainject", "inspect"],
    };

    const runTask = createRunTaskExecution(dependencies);

    const firstCode = await runTask(createOptions({ verify: false, runAll: true }));
    expect(firstCode).toBe(0);

    const secondCode = await runTask(createOptions({ verify: false, runAll: true, redo: true }));
    expect(secondCode).toBe(0);

    expect(inspectionSnapshots).toHaveLength(2);
    expect(inspectionSnapshots[0]).toEqual({
      taskCount: 2,
      metadataTaskCount: 0,
      metadataSubItems: ["get-result: Alpha", "for-item: Beta"],
    });
    expect(inspectionSnapshots[1]).toEqual({
      taskCount: 2,
      metadataTaskCount: 0,
      metadataSubItems: ["get-result: Alpha", "for-item: Beta"],
    });
    expect(fileSystem.readText(taskFile)).toContain("  - get-result: Alpha");
    expect(fileSystem.readText(taskFile)).toContain("  - for-item: Beta");
  });

  it("auto-completes parallel tasks with no children without invoking worker execution", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] parallel: setup all environments\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "parallel: setup all environments"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
    expect(fileSystem.readText(taskFile)).toBe("- [x] parallel: setup all environments\n");
  });

  it("auto-completes runnable parallel-group parents without creating worker runs", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup all environments",
        "  - [x] cli: npm install",
        "  - [x] cli: pip install -r requirements.txt",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "parallel: setup all environments"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] parallel: setup all environments",
      "  - [x] cli: npm install",
      "  - [x] cli: pip install -r requirements.txt",
      "",
    ].join("\n"));
  });

  it("auto-completes composed-prefix parallel-group parents without creating worker runs", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] profile=fast, parallel: setup all environments",
        "  - [x] cli: npm install",
        "  - [x] cli: pip install -r requirements.txt",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "profile=fast, parallel: setup all environments"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] profile=fast, parallel: setup all environments",
      "  - [x] cli: npm install",
      "  - [x] cli: pip install -r requirements.txt",
      "",
    ].join("\n"));
  });

  it("does not re-check or re-emit previously auto-completed parallel-group parents on later scans", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup all environments",
        "  - [x] cli: npm install",
        "  - [x] cli: pip install -r requirements.txt",
      ].join("\n") + "\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "parallel: setup all environments"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };
    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }

      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const runTask = createRunTaskExecution(dependencies);
    const firstCode = await runTask(createOptions({ verify: false }));

    expect(firstCode).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] parallel: setup all environments",
      "  - [x] cli: npm install",
      "  - [x] cli: pip install -r requirements.txt",
      "",
    ].join("\n"));

    const firstCheckEventCount = events
      .filter((event) => event.kind === "success" && event.message.startsWith("Task checked:"))
      .length;
    expect(firstCheckEventCount).toBe(1);

    const secondCode = await runTask(createOptions({ verify: false }));
    const secondCheckEventCount = events
      .filter((event) => event.kind === "success" && event.message.startsWith("Task checked:"))
      .length;

    expect(secondCode).toBe(3);
    expect(secondCheckEventCount).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] parallel: setup all environments",
      "  - [x] cli: npm install",
      "  - [x] cli: pip install -r requirements.txt",
      "",
    ].join("\n"));
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
  });

  it("does not auto-complete parallel-group parents while unchecked descendants remain", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup all environments",
        "  - [ ] cli: npm install",
      ].join("\n") + "\n",
    });
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "parallel: setup all environments"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.toolResolver = {
      resolve: (toolName) => resolveBuiltinTool(toolName),
      listKnownToolNames: () => listBuiltinToolNames(),
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({ verify: false }));

    expect(code).toBe(1);
    expect(dependencies.workerExecutor.runWorker).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeInlineCli).not.toHaveBeenCalled();
    expect(dependencies.workerExecutor.executeRundownTask).not.toHaveBeenCalled();
    expect(fileSystem.readText(taskFile)).toBe([
      "- [ ] parallel: setup all environments",
      "  - [ ] cli: npm install",
      "",
    ].join("\n"));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: "Parallel-group parent cannot auto-complete while unchecked descendants remain.",
    }));
  });

  it("falls back to sequential execution for selected parallel batches in tui mode", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const secondTask = createTask(taskFile, "second task", { index: 2, line: 3, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      if (source.includes("- [x] first task") && source.includes("- [x] second task")) {
        return null;
      }

      return [{
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: secondTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] first task",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prompt: "first task", mode: "tui" }),
    );
    expect(dependencies.workerExecutor.runWorker).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: "second task", mode: "tui" }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: "Parallel batch selected in TUI mode; executing tasks sequentially.",
    }));
    expect(fileSystem.readText(taskFile)).toContain("  - [x] first task");
    expect(fileSystem.readText(taskFile)).toContain("  - [x] second task");
  });

  it("deduplicates duplicate child selections within a single parallel batch", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const secondTask = createTask(taskFile, "second task", { index: 2, line: 3, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      if (source.includes("- [x] first task") && source.includes("- [x] second task")) {
        return null;
      }

      return [{
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: secondTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] first task",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(code).toBe(0);
    const workerPrompts = vi.mocked(dependencies.workerExecutor.runWorker).mock.calls
      .map(([request]) => request.prompt);
    expect(workerPrompts.filter((prompt) => prompt === "first task")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "second task")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: `Skipping duplicate parallel sibling selection at ${taskFile}:2.`,
    }));
  });

  it("skips parallel siblings that become checked mid-batch without failing completed siblings", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const secondTask = createTask(taskFile, "second task", { index: 2, line: 3, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      if (source.includes("- [x] first task") && source.includes("- [x] second task")) {
        return null;
      }

      return [{
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: secondTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] first task",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    dependencies.workerExecutor.runWorker = vi.fn(async (request) => {
      if (request.prompt === "first task") {
        const lines = fileSystem.readText(taskFile).split("\n");
        lines[2] = "  - [x] second task";
        fileSystem.writeText(taskFile, lines.join("\n"));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "first task",
      mode: "tui",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: `Skipping parallel sibling at ${taskFile}:3 because it is already checked.`,
    }));
    expect(fileSystem.readText(taskFile)).toContain("  - [x] first task");
    expect(fileSystem.readText(taskFile)).toContain("  - [x] second task");
  });

  it("counts only successfully auto/completed children in mixed-result parallel batches", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] auto: annotate setup",
        "  - [ ] complete task",
        "  - [ ] skip task",
      ].join("\n") + "\n",
    });
    const autoTask = createTask(taskFile, "auto: annotate setup", { index: 1, line: 2, depth: 1 });
    const completeTask = createTask(taskFile, "complete task", { index: 2, line: 3, depth: 1 });
    const skipTask = createTask(taskFile, "skip task", { index: 3, line: 4, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: autoTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      if (source.includes("- [x] auto: annotate setup")
        && source.includes("- [x] complete task")
        && source.includes("- [x] skip task")) {
        return null;
      }

      return [{
        task: autoTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: completeTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] auto: annotate setup",
      }, {
        task: skipTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] auto: annotate setup\n  - [ ] complete task",
      }];
    });

    dependencies.toolResolver = {
      resolve: (toolName) => {
        if (toolName === "auto") {
          return {
            name: "auto",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => ({ skipExecution: true, shouldVerify: false }),
          };
        }
        return undefined;
      },
      listKnownToolNames: () => ["auto"],
    };

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    dependencies.workerExecutor.runWorker = vi.fn(async (request) => {
      if (request.prompt === "complete task") {
        const lines = fileSystem.readText(taskFile).split("\n");
        lines[3] = "  - [x] skip task";
        fileSystem.writeText(taskFile, lines.join("\n"));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "complete task",
      mode: "tui",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: `Skipping parallel sibling at ${taskFile}:4 because it is already checked.`,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "success",
      message: "All tasks completed (2 tasks total).",
    }));
    expect(fileSystem.readText(taskFile)).toContain("  - [x] auto: annotate setup");
    expect(fileSystem.readText(taskFile)).toContain("  - [x] complete task");
    expect(fileSystem.readText(taskFile)).toContain("  - [x] skip task");
  });

  it("does not reprocess already-completed siblings when retrying a failed parallel batch", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const secondTask = createTask(taskFile, "second task", { index: 2, line: 3, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      if (source.includes("- [x] first task") && source.includes("- [x] second task")) {
        return null;
      }

      return [{
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: secondTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] first task",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    let secondTaskAttempts = 0;
    dependencies.workerExecutor.runWorker = vi.fn(async (request) => {
      if (request.prompt === "second task") {
        secondTaskAttempts++;
        if (secondTaskAttempts === 1) {
          return { exitCode: 1, stdout: "", stderr: "first attempt failed" };
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const firstRunCode = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(firstRunCode).toBe(1);
    expect(fileSystem.readText(taskFile)).toContain("  - [x] first task");
    expect(fileSystem.readText(taskFile)).toContain("  - [ ] second task");

    const retryRunCode = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "tui",
    }));

    expect(retryRunCode).toBe(0);
    const workerPrompts = vi.mocked(dependencies.workerExecutor.runWorker).mock.calls
      .map(([request]) => request.prompt);
    expect(workerPrompts.filter((prompt) => prompt === "first task")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "second task")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "info",
      message: `Skipping parallel sibling at ${taskFile}:2 because it is already checked.`,
    }));
    expect(fileSystem.readText(taskFile)).toContain("  - [x] first task");
    expect(fileSystem.readText(taskFile)).toContain("  - [x] second task");
  });

  it("keeps deferred commit aggregation deterministic for parallel children regardless of completion order", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const gitClient = createGitClientMock();
    let statusCallCount = 0;
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "status") {
        statusCallCount += 1;
        return statusCallCount === 1 ? "" : " M tasks.md";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });
    const { dependencies } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient,
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const runnableChildren = parseTasks(source, taskFile).filter((task) => !task.checked && task.depth === 1);
      if (runnableChildren.length === 0) {
        return null;
      }

      return runnableChildren.map((task) => ({
        task,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }));
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    dependencies.workerExecutor.runWorker = vi.fn(async (request) => {
      if (request.prompt === "first task") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      commitAfterComplete: true,
      commitMode: "file-done",
      mode: "wait",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    const commitCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => args[0] === "commit");
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]?.[0]).toEqual([
      "commit",
      "-m",
      "rundown: complete \"second task\" in tasks.md",
    ]);
  });

  it("benchmarks representative parallel execution while preserving sequential pacing for non-parallel tasks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const stepDelayMs = 200;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] parallel child 1",
        "  - [ ] parallel child 2",
        "  - [ ] parallel child 3",
        "- [ ] sequential task 1",
        "- [ ] sequential task 2",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "parallel child 1", { index: 1, line: 2, depth: 1 }),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const parsed = parseTasks(source, taskFile);
      const parent = parsed.find((task) => task.depth === 0 && task.text === "parallel: setup");
      const parallelChildren = parsed
        .filter((task) => task.depth === 1 && task.text.startsWith("parallel child "));
      const runnableChildren = parallelChildren.filter((task) => !task.checked);
      const allChildrenChecked = parallelChildren.length > 0 && runnableChildren.length === 0;

      if (runnableChildren.length > 0) {
        return runnableChildren.map((task) => ({
          task,
          source: "tasks.md",
          contextBefore: "- [ ] parallel: setup",
        }));
      }

      if (parent && !parent.checked && allChildrenChecked) {
        return [{
          task: parent,
          source: "tasks.md",
          contextBefore: "",
        }];
      }

      const nextSequential = parsed.find(
        (task) => task.depth === 0 && task.text.startsWith("sequential task ") && !task.checked,
      );
      if (!nextSequential) {
        return null;
      }

      return [{
        task: nextSequential,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const taskStartTimes = new Map<string, number>();
    dependencies.workerExecutor.runWorker = vi.fn(async (request) => {
      taskStartTimes.set(request.prompt, Date.now());
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      runAll: true,
      mode: "wait",
    }));

    expect(code).toBe(0);
    const workerPrompts = vi.mocked(dependencies.workerExecutor.runWorker).mock.calls
      .map(([request]) => request.prompt);
    expect(workerPrompts.filter((prompt) => prompt === "parallel child 1")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "parallel child 2")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "parallel child 3")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "sequential task 1")).toHaveLength(1);
    expect(workerPrompts.filter((prompt) => prompt === "sequential task 2")).toHaveLength(1);

    const parallelStarts = [
      taskStartTimes.get("parallel child 1"),
      taskStartTimes.get("parallel child 2"),
      taskStartTimes.get("parallel child 3"),
    ]
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    const sequentialStarts = [
      taskStartTimes.get("sequential task 1"),
      taskStartTimes.get("sequential task 2"),
    ]
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);

    expect(parallelStarts).toHaveLength(3);
    expect(sequentialStarts).toHaveLength(2);

    const parallelStartSpreadMs = parallelStarts[2]! - parallelStarts[0]!;
    const sequentialGapMs = sequentialStarts[1]! - sequentialStarts[0]!;
    const parallelStartsBeforeSequential = parallelStarts.filter(
      (startedAtMs) => startedAtMs < sequentialStarts[0]!,
    ).length;

    expect(parallelStartSpreadMs).toBeLessThan(stepDelayMs * 3);
    expect(parallelStartsBeforeSequential).toBe(3);
    expect(sequentialGapMs).toBeGreaterThanOrEqual(stepDelayMs - 40);

    const latestParallelStartMs = parallelStarts[2]!;
    expect(sequentialStarts[0]!).toBeGreaterThanOrEqual(latestParallelStartMs + stepDelayMs - 40);

    expect(fileSystem.readText(taskFile)).toBe([
      "- [x] parallel: setup",
      "  - [x] parallel child 1",
      "  - [x] parallel child 2",
      "  - [x] parallel child 3",
      "- [x] sequential task 1",
      "- [x] sequential task 2",
      "",
    ].join("\n"));
  });

  it("continues selecting a single task when mode is not tui", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: [
        "- [ ] parallel: setup",
        "  - [ ] first task",
        "  - [ ] second task",
      ].join("\n") + "\n",
    });
    const firstTask = createTask(taskFile, "first task", { index: 1, line: 2, depth: 1 });
    const secondTask = createTask(taskFile, "second task", { index: 2, line: 3, depth: 1 });
    const { dependencies, events } = createDependencies({
      cwd,
      task: firstTask,
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn()
      .mockReturnValueOnce([{
        task: firstTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup",
      }, {
        task: secondTask,
        source: "tasks.md",
        contextBefore: "- [ ] parallel: setup\n  - [ ] first task",
      }])
      .mockReturnValueOnce(null);

    dependencies.templateLoader.load = (templatePath: string) => {
      if (templatePath.endsWith("execute.md")) {
        return "{{task}}";
      }
      return null;
    };

    const runTask = createRunTaskExecution(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      mode: "wait",
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first task" }));
    expect(events.some((event) => event.kind === "info"
      && event.message === "Parallel batch selected in TUI mode; executing tasks sequentially.")).toBe(false);
  });

  it("pauses --all execution until interactive question input resolves", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] question: Which module should we improve?\n- [ ] inspect: verify answer\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "question: Which module should we improve?"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    let resolvePrompt: ((value: { value: string; usedDefault: boolean; interactive: boolean }) => void) | undefined;
    const prompt = vi.fn(() => new Promise<{ value: string; usedDefault: boolean; interactive: boolean }>((resolve) => {
      resolvePrompt = resolve;
    }));

    let inspectRan = false;
    dependencies.toolResolver = {
      resolve: (toolName) => {
        if (toolName === "question") {
          return {
            name: "question",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async (context) => {
              const answer = (await prompt()).value;
              const source = context.fileSystem.readText(context.task.file);
              const lines = source.split("\n");
              const questionLineIndex = context.task.line - 1;
              lines.splice(questionLineIndex + 1, 0, `  - answer: ${answer}`);
              context.fileSystem.writeText(context.task.file, lines.join("\n"));
              return { skipExecution: true, shouldVerify: false };
            },
          };
        }

        if (toolName === "inspect") {
          return {
            name: "inspect",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async () => {
              inspectRan = true;
              return { skipExecution: true, shouldVerify: false };
            },
          };
        }

        return undefined;
      },
      listKnownToolNames: () => ["question", "inspect"],
    };

    const runTask = createRunTaskExecution(dependencies);
    const runPromise = runTask(createOptions({ verify: false, runAll: true }));

    for (let attempt = 0; attempt < 20 && prompt.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(inspectRan).toBe(false);

    resolvePrompt?.({
      value: "CliResourceModule",
      usedDefault: false,
      interactive: true,
    });

    await expect(runPromise).resolves.toBe(0);
    expect(inspectRan).toBe(true);
    expect(fileSystem.readText(taskFile)).toContain("  - answer: CliResourceModule");
  });

  it("pauses independently for multiple sequential question tasks", async () => {
    const cwd = "/workspace";
    const taskFile = `${cwd}/tasks.md`;
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] question: Which module should we improve?\n- [ ] question: Which area should we harden?\n- [ ] inspect: verify answers\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "question: Which module should we improve?"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      const source = fileSystem.readText(taskFile);
      const next = parseTasks(source, taskFile).find((task) => !task.checked);
      if (!next) {
        return null;
      }
      return [{
        task: next,
        source: "tasks.md",
        contextBefore: "",
      }];
    });

    const promptResolvers: Array<(value: { value: string; usedDefault: boolean; interactive: boolean }) => void> = [];
    const prompt = vi.fn(() => new Promise<{ value: string; usedDefault: boolean; interactive: boolean }>((resolve) => {
      promptResolvers.push(resolve);
    }));

    let inspectRan = false;
    dependencies.toolResolver = {
      resolve: (toolName) => {
        if (toolName === "question") {
          return {
            name: "question",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: async (context) => {
              const answer = (await prompt()).value;
              const source = context.fileSystem.readText(context.task.file);
              const lines = source.split("\n");
              const questionLineIndex = context.task.line - 1;
              lines.splice(questionLineIndex + 1, 0, `  - answer: ${answer}`);
              context.fileSystem.writeText(context.task.file, lines.join("\n"));
              return { skipExecution: true, shouldVerify: false };
            },
          };
        }

        if (toolName === "inspect") {
          return {
            name: "inspect",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
            handler: (context) => {
              inspectRan = true;
              const questionTasks = context.allTasks?.filter((task) => task.text.startsWith("question:")) ?? [];
              const hasFirstAnswer = questionTasks.some((task) => task.subItems.some((subItem) => subItem.text === "answer: CliResourceModule"));
              const hasSecondAnswer = questionTasks.some((task) => task.subItems.some((subItem) => subItem.text === "answer: ParserModule"));
              return hasFirstAnswer && hasSecondAnswer
                ? Promise.resolve({ skipExecution: true, shouldVerify: false })
                : Promise.resolve({
                  exitCode: 1,
                  failureMessage: "Inspect task did not observe both question answers.",
                  failureReason: "Expected each sequential question to persist its own answer before continuing.",
                });
            },
          };
        }

        return undefined;
      },
      listKnownToolNames: () => ["question", "inspect"],
    };

    const runTask = createRunTaskExecution(dependencies);
    const runPromise = runTask(createOptions({ verify: false, runAll: true }));

    for (let attempt = 0; attempt < 20 && prompt.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(inspectRan).toBe(false);

    promptResolvers[0]?.({
      value: "CliResourceModule",
      usedDefault: false,
      interactive: true,
    });

    for (let attempt = 0; attempt < 20 && prompt.mock.calls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(inspectRan).toBe(false);

    promptResolvers[1]?.({
      value: "ParserModule",
      usedDefault: false,
      interactive: true,
    });

    await expect(runPromise).resolves.toBe(0);
    expect(inspectRan).toBe(true);
    expect(fileSystem.readText(taskFile)).toContain("  - answer: CliResourceModule");
    expect(fileSystem.readText(taskFile)).toContain("  - answer: ParserModule");
  });
});
