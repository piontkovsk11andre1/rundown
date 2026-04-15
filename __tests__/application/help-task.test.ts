import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../../src/domain/exit-codes.js";
import {
  createHelpTask,
  type HelpTaskDependencies,
  type HelpTaskOptions,
} from "../../src/application/help-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  CommandExecutor,
  FileSystem,
  TraceWriterPort,
} from "../../src/domain/ports/index.js";

describe("help-task", () => {
  it("resolves worker from config and creates/finalizes artifacts for success", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        default: ["opencode", "run"],
        tui: ["opencode", "run", "--tui"],
      },
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ keepArtifacts: true, workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(dependencies.workerConfigPort.load)).toHaveBeenCalledWith(
      path.join(cwd, ".rundown"),
    );
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd,
        commandName: "help",
        mode: "tui",
        workerCommand: ["opencode", "run", "--tui"],
        keepArtifacts: true,
      }),
    );
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledWith(expect.objectContaining({
      workerPattern: expect.objectContaining({
        command: ["opencode", "run", "--tui"],
      }),
      mode: "tui",
      cwd,
      artifactPhase: "worker",
      artifactPhaseLabel: "help",
      artifactContext: expect.objectContaining({
        runId: "run-help",
      }),
    }));
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-help" }),
      {
        status: "completed",
        preserve: true,
      },
    );
  });

  it("renders help template with cli vars, command index, and docs context", async () => {
    const cwd = "/workspace";
    const docsDir = path.join(cwd, "docs");
    const { dependencies, workerExecutor, fileSystem } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "help.md"))) {
        return [
          "version={{cliVersion}}",
          "cwd={{workingDirectory}}",
          "docs={{docsContext}}",
          "commands={{commandIndex}}",
        ].join("\n");
      }
      return null;
    });

    vi.mocked(fileSystem.exists).mockImplementation((filePath) => filePath === docsDir);
    vi.mocked(fileSystem.stat).mockImplementation((filePath) => {
      if (filePath === docsDir) {
        return { isFile: false, isDirectory: true };
      }
      return null;
    });
    vi.mocked(fileSystem.readdir).mockImplementation((dirPath) => {
      if (dirPath !== docsDir) {
        return [];
      }
      return [
        { name: "z-last.md", isFile: true, isDirectory: false },
        { name: "README.txt", isFile: true, isDirectory: false },
        { name: "a-first.md", isFile: true, isDirectory: false },
      ];
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [], cliVersion: "9.9.9" }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("version=9.9.9");
    expect(prompt).toContain("cwd=/workspace");
    expect(prompt).toContain("docs=- docs/a-first.md\n- docs/z-last.md");
    expect(prompt).toContain("commands=- run: execute unchecked TODO tasks");
    expect(prompt).toContain("- discuss: interactive task discussion");
  });

  it("prepends agent.md warmup content before help template", async () => {
    const cwd = "/workspace";
    const { dependencies, workerExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "agent.md"))) {
        return "AGENT_WARMUP_MARKER";
      }
      if (templatePath.endsWith(path.join(".rundown", "help.md"))) {
        return "HELP_MARKER";
      }
      return null;
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("AGENT_WARMUP_MARKER");
    expect(prompt).toContain("HELP_MARKER");
    expect(prompt.indexOf("AGENT_WARMUP_MARKER")).toBeLessThan(prompt.indexOf("HELP_MARKER"));
  });

  it("falls back to default agent warmup when agent.md is empty", async () => {
    const cwd = "/workspace";
    const { dependencies, workerExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "agent.md"))) {
        return "   \n\t  ";
      }
      if (templatePath.endsWith(path.join(".rundown", "help.md"))) {
        return "HELP_MARKER";
      }
      return null;
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("You are running in rundown root no-argument help mode.");
    expect(prompt).toContain("HELP_MARKER");
    expect(prompt.indexOf("You are running in rundown root no-argument help mode.")).toBeLessThan(
      prompt.indexOf("HELP_MARKER"),
    );
  });

  it("expands cli fenced blocks in the help template before worker execution", async () => {
    const cwd = "/workspace";
    const { dependencies, workerExecutor, cliBlockExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "help.md"))) {
        return [
          "before",
          "```cli",
          "echo dynamic-help",
          "```",
          "after",
        ].join("\n");
      }
      return null;
    });
    vi.mocked(cliBlockExecutor.execute).mockResolvedValue({
      exitCode: 0,
      stdout: "dynamic-output",
      stderr: "",
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(cliBlockExecutor.execute)).toHaveBeenCalledWith(
      "echo dynamic-help",
      cwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    const prompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("<command>echo dynamic-help</command>");
    expect(prompt).toContain("<output>");
    expect(prompt).toContain("dynamic-output");
    expect(prompt).not.toContain("```cli");
  });

  it("keeps expanded --help --everything output readable in worker prompt", async () => {
    const cwd = "/workspace";
    const { dependencies, workerExecutor, cliBlockExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "help.md"))) {
        return [
          "intro",
          "```cli",
          "rundown --help --everything",
          "```",
          "outro",
        ].join("\n");
      }
      return null;
    });
    vi.mocked(cliBlockExecutor.execute).mockResolvedValue({
      exitCode: 0,
      stdout: [
        "Usage: rundown [options] [command]",
        "",
        "Commands:",
        "  help [command]  display help for command",
        "  run <source>    Execute unchecked TODO tasks",
        "",
        "Options:",
        "  --print-prompt  Print rendered prompts and exit",
        "  --cache-cli-blocks Cache `cli` fenced block command output",
      ].join("\n"),
      stderr: "",
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    const prompt = vi.mocked(workerExecutor.runWorker).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("<command>rundown --help --everything</command>");
    expect(prompt).toContain("Usage: rundown [options] [command]");
    expect(prompt).toContain("Commands:\n  help [command]  display help for command");
    expect(prompt).toContain("Options:\n  --print-prompt  Print rendered prompts and exit");
    expect(prompt).toContain("--cache-cli-blocks Cache `cli` fenced block command output");
    expect(prompt).toContain("intro");
    expect(prompt).toContain("outro");
    expect(prompt).not.toContain("```cli");
  });

  it("returns no-work when no interactive help worker is configured", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor, events } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue(undefined);

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_NO_WORK);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "No interactive help worker is configured. Falling back to static help output.",
    });
  });

  it("returns no-work with info message when worker resolution throws", async () => {
    const cwd = "/workspace";
    const { dependencies, workerExecutor, events } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockImplementation(() => {
      throw new Error("invalid config");
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_NO_WORK);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("Interactive help worker could not be resolved"))).toBe(true);
    expect(events.some((event) => event.kind === "info"
      && event.message.includes("invalid config"))).toBe(true);
  });

  it("finalizes help artifacts as failed when worker throws", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(workerExecutor.runWorker).mockRejectedValueOnce(new Error("worker crashed"));

    const helpTask = createHelpTask(dependencies);

    await expect(helpTask(createOptions())).rejects.toThrow("worker crashed");
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-help" }),
      {
        status: "failed",
        preserve: false,
      },
    );
  });

  it("returns failure and emits an error when worker exits non-zero", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor, events } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValueOnce({
      exitCode: 17,
      stdout: "",
      stderr: "",
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_FAILURE);
    expect(events).toContainEqual({
      kind: "error",
      message: "Interactive help exited with code 17.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-help" }),
      {
        status: "failed",
        preserve: false,
      },
    );
  });

  it("returns failure when worker exits without an exit code", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor, events } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValueOnce({
      exitCode: null,
      stdout: "",
      stderr: "",
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_FAILURE);
    expect(events).toContainEqual({
      kind: "error",
      message: "Interactive help failed: worker exited without a code.",
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-help" }),
      {
        status: "failed",
        preserve: false,
      },
    );
  });

  it("writes trace lifecycle events when trace is enabled", async () => {
    const cwd = "/workspace";
    const { dependencies, traceWriter } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ trace: true, keepArtifacts: true, workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(vi.mocked(dependencies.createTraceWriter)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "run-help" }),
    );
    expect(vi.mocked(traceWriter.write)).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "run.started",
    }));
    expect(vi.mocked(traceWriter.write)).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "run.completed",
    }));
    expect(vi.mocked(traceWriter.flush)).toHaveBeenCalled();
  });

  it("flushes the default trace writer when returning no-work before artifact context exists", async () => {
    const cwd = "/workspace";
    const { dependencies, traceWriter } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue(undefined);

    const helpTask = createHelpTask(dependencies);
    const code = await helpTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(EXIT_CODE_NO_WORK);
    expect(vi.mocked(traceWriter.flush)).toHaveBeenCalledTimes(1);
  });

  it("does not apply TTY gating inside createHelpTask", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      get: () => false,
    });

    try {
      const cwd = "/workspace";
      const { dependencies, workerExecutor } = createDependencies({ cwd });
      vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
        workers: {
          tui: ["opencode", "run", "--tui"],
        },
      });

      const helpTask = createHelpTask(dependencies);
      const code = await helpTask(createOptions({ workerCommand: [] }));

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledTimes(1);
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }

      if (stderrDescriptor) {
        Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
      } else {
        Reflect.deleteProperty(process.stderr, "isTTY");
      }
    }
  });

  it("finalizes artifacts and trace as failed when worker is cancelled", async () => {
    const cwd = "/workspace";
    const { dependencies, artifactStore, workerExecutor, traceWriter } = createDependencies({ cwd });
    vi.mocked(dependencies.workerConfigPort.load).mockReturnValue({
      workers: {
        tui: ["opencode", "run", "--tui"],
      },
    });
    const abortError = Object.assign(new Error("cancelled by user"), {
      name: "AbortError",
    });
    vi.mocked(workerExecutor.runWorker).mockRejectedValueOnce(abortError);

    const helpTask = createHelpTask(dependencies);

    await expect(helpTask(createOptions({ trace: true, workerCommand: [] }))).rejects.toThrow("cancelled by user");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-help" }),
      {
        status: "failed",
        preserve: false,
      },
    );
    expect(vi.mocked(traceWriter.write)).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "run.completed",
      payload: expect.objectContaining({ status: "failed" }),
    }));
    expect(vi.mocked(traceWriter.flush)).toHaveBeenCalledTimes(1);
  });
});

function createDependencies(options: {
  cwd: string;
}): {
  dependencies: HelpTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
  cliBlockExecutor: CommandExecutor;
  workerExecutor: HelpTaskDependencies["workerExecutor"];
  traceWriter: TraceWriterPort;
} {
  const events: ApplicationOutputEvent[] = [];

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-help",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-help"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "help",
      mode: "tui",
      workerCommand: ["opencode", "run"],
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-help")),
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
    exists: vi.fn(() => false),
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const traceWriter: TraceWriterPort = {
    write: vi.fn(),
    flush: vi.fn(),
  };

  const workerExecutor: HelpTaskDependencies["workerExecutor"] = {
    runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const cliBlockExecutor: CommandExecutor = {
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const dependencies: HelpTaskDependencies = {
    workerExecutor,
    workingDirectory: { cwd: vi.fn(() => options.cwd) },
    fileSystem,
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateLoader: { load: vi.fn(() => null) },
    artifactStore,
    workerConfigPort: { load: vi.fn(() => undefined) },
    traceWriter,
    cliBlockExecutor,
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
    },
    createTraceWriter: vi.fn(() => traceWriter),
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    artifactStore,
    fileSystem,
    cliBlockExecutor,
    workerExecutor,
    traceWriter,
  };
}

function createOptions(overrides: Partial<HelpTaskOptions> & { workerCommand?: string[] } = {}): HelpTaskOptions {
  const { workerCommand, ...optionOverrides } = overrides;

  return {
    workerPattern: inferWorkerPatternFromCommand(workerCommand ?? ["opencode", "run"]),
    keepArtifacts: false,
    trace: false,
    cliVersion: "1.0.0",
    ...optionOverrides,
  };
}
