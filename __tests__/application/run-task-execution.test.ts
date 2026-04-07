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
        env: {
          RUNDOWN_VAR_API_TOKEN: "from-cli",
          RUNDOWN_VAR_CHANNEL: "stable",
          RUNDOWN_VAR_DB_HOST: "localhost",
        },
      }),
    );
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        RUNDOWN_VAR_API_TOKEN: "from-cli",
        RUNDOWN_VAR_CHANNEL: "stable",
        RUNDOWN_VAR_DB_HOST: "localhost",
      },
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
        env: {
          RUNDOWN_VAR_REGION: "eu-west",
          RUNDOWN_VAR_RELEASE: "v1",
        },
      }),
    );
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
      return {
        task: next,
        source: "tasks.md",
        contextBefore: "",
      };
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
      return {
        task: next,
        source: "tasks.md",
        contextBefore: "",
      };
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
      return {
        task: next,
        source: "tasks.md",
        contextBefore: "",
      };
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
      return {
        task: next,
        source: "tasks.md",
        contextBefore: "",
      };
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
      task: createTask(taskFile, "force: profile: fast, verify: tests pass"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] force: profile: fast, verify: tests pass\n" }),
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
});
