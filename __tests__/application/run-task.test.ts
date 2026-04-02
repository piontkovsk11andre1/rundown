import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunTask } from "../../src/application/run-task.js";
import { FileLockError } from "../../src/domain/ports/file-lock.js";
import type { CommandExecutor, ProcessRunResult, ProcessRunner } from "../../src/domain/ports/index.js";
import {
  createDependencies,
  createGitClientMock,
  createInMemoryFileSystem,
  createInlineTask,
  createNoopFileLock,
  createOptions,
  createTask,
} from "./run-task-test-helpers.js";

describe("run-task orchestration", () => {
  it("returns configuration error when --only-verify is combined with reset flags", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });

    const code = await createRunTask(dependencies)(
      createOptions({
        onlyVerify: true,
        redo: true,
        workerCommand: ["opencode", "run"],
      }),
    );

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("cannot be combined with --only-verify"))).toBe(true);
  });

  it("returns not-found when source pattern resolves to no files", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.sourceResolver.resolveSources = vi.fn(async () => []);

    const code = await createRunTask(dependencies)(createOptions({ source: "missing/**/*.md", verify: false }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("No Markdown files found"))).toBe(true);
  });

  it("returns success in detached mode after dispatch", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({ exitCode: null, stdout: "", stderr: "" });

    const code = await createRunTask(dependencies)(
      createOptions({
        verify: false,
        mode: "detached",
        workerCommand: ["opencode", "run"],
      }),
    );

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Detached mode"))).toBe(true);
  });

  it("returns not-found when no task can be selected", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "build release");
    const { dependencies } = createDependencies({
      cwd,
      task,
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    vi.mocked(dependencies.taskSelector.selectNextTask).mockReturnValue(null);

    const code = await createRunTask(dependencies)(createOptions({ source: "tasks.md", verify: false }));
    expect(code).toBe(3);
  });

  it("returns trace-only not-found when no completed run exists", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });

    const code = await createRunTask(dependencies)(createOptions({ traceOnly: true, workerCommand: ["opencode", "run"] }));
    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No saved runtime artifact run found"))).toBe(true);
  });

  it("short-circuits to trace-only flow before option validation", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });

    const code = await createRunTask(dependencies)(
      createOptions({
        traceOnly: true,
        onlyVerify: true,
        redo: true,
        resetAfter: true,
        clean: true,
        workerCommand: ["opencode", "run"],
      }),
    );

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No saved runtime artifact run found"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("cannot be combined with --only-verify"))).toBe(false);
    expect(dependencies.sourceResolver.resolveSources).not.toHaveBeenCalled();
  });

  it("returns configuration error for each only-verify reset flag", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");

    for (const flag of [
      { redo: true },
      { resetAfter: true },
      { clean: true },
    ]) {
      const { dependencies, events } = createDependencies({
        cwd,
        task: createTask(taskFile, "build release"),
        fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
        gitClient: createGitClientMock(),
      });

      const code = await createRunTask(dependencies)(
        createOptions({
          onlyVerify: true,
          workerCommand: ["opencode", "run"],
          ...flag,
        }),
      );

      expect(code).toBe(1);
      expect(events.some((event) => event.kind === "error" && event.message.includes("cannot be combined with --only-verify"))).toBe(true);
      expect(dependencies.sourceResolver.resolveSources).not.toHaveBeenCalled();
    }
  });

  it("force-unlocks stale source lock before acquiring run lock", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });

    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(false);
    const code = await createRunTask(dependencies)(createOptions({ verify: false, forceUnlock: true, workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    const forceReleaseOrder = vi.mocked(dependencies.fileLock.forceRelease).mock.invocationCallOrder[0];
    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    expect(forceReleaseOrder).toBeLessThan(lockAcquireOrder);
  });

  it("releases all locks on non-zero worker exit", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({ exitCode: 7, stdout: "", stderr: "worker err" });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, workerCommand: ["opencode", "run"] }));
    expect(code).toBe(1);
    expect(dependencies.fileLock.releaseAll).toHaveBeenCalledTimes(1);
  });

  it("releases all locks on verification failure", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    dependencies.taskVerification.verify = vi.fn(async () => false);
    dependencies.verificationStore.read = vi.fn(() => "verification failed");

    const code = await createRunTask(dependencies)(createOptions({ verify: true, repairAttempts: 0, workerCommand: ["opencode", "run"] }));
    expect(code).toBe(2);
    expect(dependencies.fileLock.releaseAll).toHaveBeenCalledTimes(1);
  });

  it("runs on-complete hook before releasing locks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const processRunner: ProcessRunner = {
      run: vi.fn(async (): Promise<ProcessRunResult> => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] cli: echo hello\n" }),
      gitClient: createGitClientMock(),
      processRunner,
    });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, onCompleteCommand: "node scripts/after.js" }));
    expect(code).toBe(0);
    const hookCallOrder = vi.mocked(processRunner.run).mock.invocationCallOrder[0];
    const releaseCallOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];
    expect(hookCallOrder).toBeLessThan(releaseCallOrder);
  });

  it("runs on-fail hook before releasing locks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const processRunner: ProcessRunner = {
      run: vi.fn(async (): Promise<ProcessRunResult> => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] cli: echo hello\n" }),
      gitClient: createGitClientMock(),
      processRunner,
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }));

    const code = await createRunTask(dependencies)(createOptions({ verify: false, onFailCommand: "node scripts/on-fail.js" }));
    expect(code).toBe(1);
    const hookCallOrder = vi.mocked(processRunner.run).mock.invocationCallOrder[0];
    const releaseCallOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];
    expect(hookCallOrder).toBeLessThan(releaseCallOrder);
  });

  it("returns execution failure and skips completion side effects", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const processRunner: ProcessRunner = {
      run: vi.fn(async (): Promise<ProcessRunResult> => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] cli: echo hello\n" }),
      gitClient: createGitClientMock(),
      processRunner,
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({ exitCode: 9, stdout: "", stderr: "boom" }));

    const code = await createRunTask(dependencies)(createOptions({ verify: false, commitAfterComplete: true, onCompleteCommand: "node scripts/after.js" }));
    expect(code).toBe(1);
    expect(processRunner.run).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.gitClient.run).mock.calls.some(([args]) => args[0] === "commit")).toBe(false);
  });

  it("applies post-run reset only after a completed run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem,
      gitClient: createGitClientMock(),
    });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, resetAfter: true }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toContain("- [ ] cli: echo hello");
  });

  it("runs deferred commit before releasing locks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo hello"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] cli: echo hello\n" }),
      gitClient: createGitClientMock(),
    });

    const code = await createRunTask(dependencies)(
      createOptions({
        verify: false,
        commitAfterComplete: true,
        resetAfter: true,
      }),
    );

    expect(code).toBe(0);
    const commitCall = vi.mocked(dependencies.gitClient.run).mock.calls.find(([args]) => args[0] === "commit");
    expect(commitCall).toBeDefined();
    const commitOrder = vi.mocked(dependencies.gitClient.run).mock.invocationCallOrder[
      vi.mocked(dependencies.gitClient.run).mock.calls.findIndex(([args]) => args[0] === "commit")
    ];
    const releaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];
    expect(commitOrder).toBeLessThan(releaseOrder);
  });

  it("releases locks before unexpected-error artifact finalization", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockRejectedValue(new Error("worker crashed"));

    await expect(
      createRunTask(dependencies)(createOptions({ verify: false, workerCommand: ["opencode", "run"] })),
    ).rejects.toThrow("worker crashed");

    expect(dependencies.fileLock.releaseAll).toHaveBeenCalledTimes(1);
    expect(dependencies.artifactStore.finalize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ status: "failed" }),
    );
    const releaseOrder = vi.mocked(dependencies.fileLock.releaseAll).mock.invocationCallOrder[0];
    const finalizeOrder = vi.mocked(dependencies.artifactStore.finalize).mock.invocationCallOrder[0];
    expect(releaseOrder).toBeLessThan(finalizeOrder);
  });

  it("holds source lock for complete --all execution", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo one\n- [ ] cli: echo two\n- [ ] cli: echo three\n",
    });
    const fileLock = createNoopFileLock();
    let selectCallCount = 0;

    const tasks = [
      { text: "cli: echo one", cmd: "echo one" },
      { text: "cli: echo two", cmd: "echo two" },
      { text: "cli: echo three", cmd: "echo three" },
    ];

    const { dependencies } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo one"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    dependencies.fileLock = fileLock;
    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      if (selectCallCount >= tasks.length) {
        return null;
      }
      const current = tasks[selectCallCount];
      selectCallCount += 1;
      return {
        task: {
          ...createInlineTask(taskFile, current.text),
          index: selectCallCount - 1,
          line: selectCallCount,
        },
        source: "tasks.md",
        contextBefore: "",
      };
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async (command: string) => ({ exitCode: 0, stdout: command, stderr: "" }));

    const code = await createRunTask(dependencies)(createOptions({ verify: false, runAll: true }));
    expect(code).toBe(0);
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledTimes(3);
    expect(fileLock.acquire).toHaveBeenCalledTimes(1);
    expect(fileLock.releaseAll).toHaveBeenCalledTimes(1);
  });

  it("treats --redo as --all", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] cli: echo first\n- [x] cli: echo second\n",
    });
    const executed: string[] = [];
    const { dependencies, events } = createDependencies({
      cwd,
      task: createInlineTask(taskFile, "cli: echo first"),
      fileSystem,
      gitClient: createGitClientMock(),
    });
    let count = 0;
    dependencies.taskSelector.selectNextTask = vi.fn(() => {
      if (count === 0) {
        count += 1;
        return {
          task: { ...createInlineTask(taskFile, "cli: echo first"), index: 0, line: 1 },
          source: "tasks.md",
          contextBefore: "",
        };
      }
      if (count === 1) {
        count += 1;
        return {
          task: { ...createInlineTask(taskFile, "cli: echo second"), index: 1, line: 2 },
          source: "tasks.md",
          contextBefore: "",
        };
      }
      return null;
    });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async (command: string) => {
      executed.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, runAll: false, redo: true }));
    expect(code).toBe(0);
    expect(executed).toEqual(["echo first", "echo second"]);
    expect(events.some((event) => event.kind === "info" && event.message.includes("--redo implies --all"))).toBe(true);
  });

  it("passes cli block timeout to executor", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const cliBlockExecutor: CommandExecutor = {
      execute: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    };
    const { dependencies } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
      cliBlockExecutor,
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((filePath: string) => {
      if (filePath.endsWith("execute.md")) {
        return "```cli\necho hello\n```";
      }
      return null;
    });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, workerCommand: ["opencode", "run"], cliBlockTimeoutMs: 1234 }));
    expect(code).toBe(0);
    expect(cliBlockExecutor.execute).toHaveBeenCalledWith(
      "echo hello",
      cwd,
      expect.objectContaining({ timeoutMs: 1234, onCommandExecuted: expect.any(Function) }),
    );
  });

  it("returns lock error as execution failure", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const { dependencies, events } = createDependencies({
      cwd,
      task: createTask(taskFile, "build release"),
      fileSystem: createInMemoryFileSystem({ [taskFile]: "- [ ] build release\n" }),
      gitClient: createGitClientMock(),
    });
    vi.mocked(dependencies.fileLock.acquire).mockImplementation(() => {
      throw new FileLockError(taskFile, {
        pid: 123,
        command: "rundown run",
        startTime: new Date().toISOString(),
      }, "active lock held");
    });

    const code = await createRunTask(dependencies)(createOptions({ verify: false, source: "tasks.md" }));
    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Source file is locked by another rundown process"))).toBe(true);
  });
});
