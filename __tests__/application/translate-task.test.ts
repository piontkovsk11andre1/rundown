import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTranslateTask,
  type TranslateTaskDependencies,
  type TranslateTaskOptions,
} from "../../src/application/translate-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import type {
  ArtifactStore,
  ApplicationOutputEvent,
  FileLock,
  FileSystem,
} from "../../src/domain/ports/index.js";
import { FileLockError } from "../../src/domain/ports/file-lock.js";

describe("translate-task", () => {
  it("prints rendered translate prompt in print-prompt mode", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });
    dependencies.configDir = undefined;

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("## Source document (<what>)");
    expect(prompt).toContain("# What");
    expect(prompt).toContain("## Know-how reference (<how>)");
    expect(prompt).toContain("# How");
    expect(prompt).toContain("Ship auth flow.");
    expect(prompt).toContain("Use bounded contexts.");
    expect(prompt).toContain("Meaning fidelity");
    expect(prompt).toContain("No invention");
    expect(prompt).toContain("Uncertainty signaling");
    expect(prompt).toContain("Return only the full translated Markdown document body.");
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
  });

  it("reports dry-run details without executing worker", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({ kind: "info", message: "Dry run - would translate: opencode run" });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.acquire)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.releaseAll)).not.toHaveBeenCalled();
  });

  it("prefers print-prompt over dry-run and skips worker/output mutation", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events, artifactStore } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      printPrompt: true,
      dryRun: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("## Source document (<what>)");
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run"))).toBe(false);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.acquire)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.releaseAll)).not.toHaveBeenCalled();
  });

  it("runs single worker turn and writes deterministic output", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, artifactStore, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      verbose: true,
    }));

    const resolvedOutputFile = path.resolve(cwd, outputFile);

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(resolvedOutputFile, { command: "translate" });
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      artifactPhase: "translate",
    }));
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      resolvedOutputFile,
      "# Translated\n\nDomain-native output\n",
    );
    expect(events).toContainEqual({
      kind: "info",
      message: "Running translate worker: opencode run [mode=wait]",
    });
    expect(events).toContainEqual({ kind: "success", message: "Translated document written to: " + resolvedOutputFile });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-translate" }),
      expect.objectContaining({
        status: "completed",
        preserve: false,
      }),
    );
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("acquires and writes output lock using execution-cwd-resolved path", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = "nested/output.md";
    const resolvedOutputFile = path.resolve(cwd, outputFile);
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile: resolvedOutputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(resolvedOutputFile, { command: "translate" });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      resolvedOutputFile,
      "# Translated\n\nDomain-native output\n",
    );
    expect(events).toContainEqual({ kind: "success", message: "Translated document written to: " + resolvedOutputFile });
  });

  it("returns failure when output file is locked by another process", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    vi.mocked(dependencies.fileLock.acquire).mockImplementation(() => {
      throw new FileLockError(outputFile, {
        pid: 4321,
        command: "translate",
        startTime: "2026-01-01T00:00:00.000Z",
      });
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
    }));

    expect(code).toBe(1);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Source file is locked by another rundown process"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("pid=4321"))).toBe(true);
  });

  it("force-unlocks stale source lock on resolved output path when enabled", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = "nested/output.md";
    const resolvedOutputFile = path.resolve(cwd, outputFile);
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile: resolvedOutputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });
    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(false);

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      forceUnlock: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.isLocked)).toHaveBeenCalledWith(resolvedOutputFile);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).toHaveBeenCalledWith(resolvedOutputFile);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Force-unlocked stale source lock: " + resolvedOutputFile))).toBe(true);
  });

  it("does not force-unlock active source lock when enabled", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = "nested/output.md";
    const resolvedOutputFile = path.resolve(cwd, outputFile);
    const { dependencies } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile: resolvedOutputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });
    vi.mocked(dependencies.fileLock.isLocked).mockReturnValue(true);

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      forceUnlock: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.isLocked)).toHaveBeenCalledWith(resolvedOutputFile);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).not.toHaveBeenCalled();
  });
});

function createDependencies(options: {
  cwd: string;
  whatFile: string;
  howFile: string;
  outputFile: string;
  whatContent: string;
  howContent: string;
}): {
  dependencies: TranslateTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
} {
  const events: ApplicationOutputEvent[] = [];

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-translate",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-translate"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "translate",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-translate")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn((status) => typeof status === "string" && status.includes("failed")),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn((filePath: string) => filePath === options.whatFile || filePath === options.howFile),
    readText: vi.fn((filePath: string) => {
      if (filePath === options.whatFile) {
        return options.whatContent;
      }
      if (filePath === options.howFile) {
        return options.howContent;
      }
      return "";
    }),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const dependencies: TranslateTaskDependencies = {
    workerExecutor: {
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: "# Translated\n\nDomain-native output\n",
        stderr: "",
      })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    workingDirectory: { cwd: vi.fn(() => options.cwd) },
    fileSystem,
    fileLock: createNoopFileLock(),
    workerConfigPort: { load: vi.fn(() => undefined) },
    templateLoader: {
      load: vi.fn((filePath: string) => filePath.endsWith("translate.md")
        ? "## Source document (<what>)\n{{what}}\n\n## Know-how reference (<how>)\n{{how}}"
        : null),
    },
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    artifactStore,
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    artifactStore,
    fileSystem,
  };
}

function createNoopFileLock(): FileLock {
  return {
    acquire: vi.fn(),
    isLocked: vi.fn(() => false),
    release: vi.fn(),
    forceRelease: vi.fn(),
    releaseAll: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<TranslateTaskOptions> & { workerCommand?: string[] } = {},
): TranslateTaskOptions {
  const { workerCommand, ...optionOverrides } = overrides;

  return {
    what: "what.md",
    how: "how.md",
    output: "output.md",
    mode: "wait",
    workerPattern: inferWorkerPatternFromCommand(workerCommand ?? ["opencode", "run"]),
    showAgentOutput: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    configDirOption: undefined,
    ...optionOverrides,
  };
}
