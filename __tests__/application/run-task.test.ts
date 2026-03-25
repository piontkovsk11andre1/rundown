import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunTask, type RunTaskDependencies, type RunTaskOptions } from "../../src/application/run-task.js";
import type { Task } from "../../src/domain/parser.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  FileSystem,
  GitClient,
  ProcessRunner,
  TemplateLoader,
  ValidationSidecar,
} from "../../src/domain/ports/index.js";

describe("run-task commit behavior", () => {
  it("commits checked task with default commit message after successful completion", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: true,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["add", "-A", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(
      3,
      ["commit", "-m", "rundown: complete \"cli: echo hello\" in tasks.md"],
      cwd,
    );
    expect(events.some((event) => event.kind === "success" && event.message === "Committed: rundown: complete \"cli: echo hello\" in tasks.md")).toBe(true);
  });

  it("uses commit message template placeholders in commit path", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "docs", "roadmap.md");
    const task = createInlineTask(taskFile, "cli: echo ship");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo ship\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "docs/roadmap.md",
      verify: false,
      commitAfterComplete: true,
      commitMessageTemplate: "done: {{task}} @ {{file}}",
    }));

    expect(code).toBe(0);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["add", "-A", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(
      3,
      ["commit", "-m", "done: cli: echo ship @ docs/roadmap.md"],
      cwd,
    );
    expect(events.some((event) => event.kind === "success" && event.message === "Committed: done: cli: echo ship @ docs/roadmap.md")).toBe(true);
  });

  it("warns on commit failure but still returns success", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse") {
          return "true";
        }
        if (args[0] === "commit") {
          throw new Error("commit failed");
        }
        return "";
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: true,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(events.some((event) => event.kind === "warn" && event.message.includes("--commit failed:"))).toBe(true);
  });

  it("warns and skips commit when not inside a git repository", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async () => {
        throw new Error("not a repo");
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: true,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(events.some((event) => event.kind === "warn" && event.message === "--commit: not inside a git repository, skipping.")).toBe(true);
  });
});

describe("run-task on-complete hook behavior", () => {
  it("runs on-complete hook with task metadata after successful completion", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "hook out",
        stderr: "hook err",
      })),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(processRunner.run).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(processRunner.run).mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      command: "node scripts/after.js",
      args: [],
      cwd,
      mode: "wait",
      shell: true,
      timeoutMs: 60_000,
    });
    expect(firstCall?.env).toMatchObject({
      RUNDOWN_TASK: "cli: echo hello",
      RUNDOWN_FILE: path.resolve(taskFile),
      RUNDOWN_LINE: "1",
      RUNDOWN_INDEX: "0",
      RUNDOWN_SOURCE: "tasks.md",
    });
    expect(events.some((event) => event.kind === "text" && event.text === "hook out")).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook err")).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("--on-complete"))).toBe(false);
  });

  it("warns when on-complete hook exits with non-zero code", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 17,
        stdout: "",
        stderr: "hook failed",
      })),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook failed")).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message === "--on-complete hook exited with code 17")).toBe(true);
  });

  it("warns when on-complete hook process throws and still returns success", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "stderr" && event.text.includes("spawn failed"))).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message === "--on-complete hook exited with code null")).toBe(true);
  });
});

describe("run-task exit code behavior with completion side effects", () => {
  it("returns execution failure code and does not run commit or hook", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 9,
      stdout: "",
      stderr: "boom",
    }));

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: true,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] cli: echo hello\n");
    expect(gitClient.run).not.toHaveBeenCalled();
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it("returns verification failure code and does not run commit or hook", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });
    dependencies.taskValidation.validate = vi.fn(async () => false);

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: true,
      workerCommand: ["opencode", "run"],
      commitAfterComplete: true,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(2);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] cli: echo hello\n");
    expect(gitClient.run).not.toHaveBeenCalled();
    expect(processRunner.run).not.toHaveBeenCalled();
  });
});

function createDependencies(options: {
  cwd: string;
  task: Task;
  fileSystem: FileSystem;
  gitClient: GitClient;
  processRunner?: ProcessRunner;
}): { dependencies: RunTaskDependencies; events: ApplicationOutputEvent[] } {
  const events: ApplicationOutputEvent[] = [];
  const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
  const validationSidecar: ValidationSidecar = {
    filePath: vi.fn(() => ""),
    read: vi.fn(() => null),
    remove: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-test",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-test"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "run",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-test")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const processRunner = options.processRunner ?? {
    run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const dependencies: RunTaskDependencies = {
    sourceResolver: {
      resolveSources: vi.fn(async () => [options.task.file]),
    },
    taskSelector: {
      selectNextTask: vi.fn(() => ({
        task: options.task,
        source: path.relative(options.cwd, options.task.file).replace(/\\/g, "/"),
        contextBefore: "",
      })),
      selectTaskByLocation: vi.fn(() => null),
    },
    workerExecutor: {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    taskValidation: {
      validate: vi.fn(async () => true),
    },
    taskCorrection: {
      correct: vi.fn(async () => ({ valid: true, attempts: 0 })),
    },
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    fileSystem: options.fileSystem,
    templateLoader,
    validationSidecar,
    artifactStore,
    gitClient: options.gitClient,
    processRunner,
    output: {
      emit: (event) => {
        events.push(event);
      },
    },
  };

  return {
    dependencies,
    events,
  };
}

function createInMemoryFileSystem(initialFiles: Record<string, string>): FileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    exists: (filePath) => files.has(filePath),
    readText: (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }
      return content;
    },
    writeText: (filePath, content) => {
      files.set(filePath, content);
    },
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createGitClientMock(): GitClient {
  return {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return "true";
      }
      return "";
    }),
  };
}

function createInlineTask(file: string, text: string): Task {
  return {
    text,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: text.length,
    file,
    isInlineCli: true,
    cliCommand: text.replace(/^cli:\s*/i, ""),
    depth: 0,
  };
}

function createOptions(overrides: Partial<RunTaskOptions>): RunTaskOptions {
  return {
    source: "tasks.md",
    mode: "wait",
    transport: "file",
    sortMode: "name-sort",
    verify: true,
    onlyVerify: false,
    forceExecute: false,
    noRepair: false,
    repairAttempts: 0,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: undefined,
    cliTemplateVarArgs: [],
    workerCommand: [],
    commitAfterComplete: false,
    commitMessageTemplate: undefined,
    onCompleteCommand: undefined,
    ...overrides,
  };
}
