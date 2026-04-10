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
        "- [ ] profile: fast, parallel: setup all environments",
        "  - [x] cli: npm install",
        "  - [x] cli: pip install -r requirements.txt",
      ].join("\n") + "\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "profile: fast, parallel: setup all environments"),
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
      "- [x] profile: fast, parallel: setup all environments",
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
    gitClient.run = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      if (args[0] === "status") {
        return "";
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
