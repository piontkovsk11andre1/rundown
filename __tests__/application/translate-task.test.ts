import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTranslateTask,
  type TranslateTaskDependencies,
  type TranslateTaskOptions,
} from "../../src/application/translate-task.js";
import { parseTasks } from "../../src/domain/parser.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import type {
  ArtifactStore,
  ApplicationOutputEvent,
  FileLock,
  FileSystem,
  TraceWriterPort,
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

  it("prints a translation-quality contract that forbids invention and requires explicit ambiguity signaling", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nDescribe rollout policy updates.\n",
      howContent: "# How\nUse framework-native governance terms.\n",
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
    expect(prompt).toContain("No invention: do not add or invent requirements, tasks, or implementation commitments.");
    expect(prompt).toContain("Uncertainty signaling: when no clear analog exists in <how>, keep the original concept explicit and clearly mark the mismatch.");
    expect(prompt).toContain("Markdown validity: return valid Markdown suitable for downstream rundown commands.");
    expect(prompt).toContain("Return only the full translated Markdown document body.");
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

  it("expands `cli` fenced blocks from <what> and <how> by default", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\n```cli\nwhoami\n```\n",
      howContent: "# How\n```cli\npwd\n```\n",
    });
    dependencies.configDir = undefined;
    vi.mocked(dependencies.cliBlockExecutor.execute)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "author\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/workspace\n", stderr: "" });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      printPrompt: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("<command>whoami</command>");
    expect(prompt).toContain("<command>pwd</command>");
    expect(prompt).toContain("author");
    expect(prompt).toContain("/workspace");
    const expectedWhatCwd = path.dirname(whatFile);
    const expectedHowCwd = path.dirname(howFile);
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).toHaveBeenNthCalledWith(
      1,
      "whoami",
      expectedWhatCwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).toHaveBeenNthCalledWith(
      2,
      "pwd",
      expectedHowCwd,
      expect.objectContaining({
        onCommandExecuted: expect.any(Function),
      }),
    );
  });

  it("bypasses cli fenced-block expansion when --ignore-cli-block is enabled", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\n```cli\nwhoami\n```\n",
      howContent: "# How\nReference\n",
    });
    dependencies.configDir = undefined;

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      printPrompt: true,
      ignoreCliBlock: true,
    }));

    expect(code).toBe(0);
    const prompt = events.find((event) => event.kind === "text")?.text ?? "";
    expect(prompt).toContain("```cli");
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).not.toHaveBeenCalled();
  });

  it("applies --cli-block-timeout to fenced-block expansion", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\n```cli\nwhoami\n```\n",
      howContent: "# How\nReference\n",
    });
    dependencies.configDir = undefined;
    vi.mocked(dependencies.cliBlockExecutor.execute).mockResolvedValue({
      exitCode: 0,
      stdout: "author\n",
      stderr: "",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      printPrompt: true,
      cliBlockTimeoutMs: 4321,
    }));

    expect(code).toBe(0);
    const expectedWhatCwd = path.dirname(whatFile);
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).toHaveBeenCalledWith(
      "whoami",
      expectedWhatCwd,
      expect.objectContaining({
        timeoutMs: 4321,
        onCommandExecuted: expect.any(Function),
      }),
    );
  });

  it("skips fenced-block expansion in dry-run mode unless print-prompt is enabled", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\n```cli\nwhoami\n```\n",
      howContent: "# How\n```cli\npwd\n```\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      dryRun: true,
    }));

    expect(code).toBe(0);
    expect(events).toContainEqual({
      kind: "info",
      message: "Dry run — skipped `cli` fenced block execution; would execute 2 blocks.",
    });
    expect(vi.mocked(dependencies.cliBlockExecutor.execute)).not.toHaveBeenCalled();
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
    const traceEvents = vi.mocked(dependencies.createTraceWriter).mock.results[0]?.value.write.mock.calls
      .map((call) => call[0]);
    expect(traceEvents?.some((event) => event?.event_type === "run.started")).toBe(true);
    expect(traceEvents?.some((event) => event?.event_type === "phase.started")).toBe(true);
    expect(traceEvents?.some((event) => event?.event_type === "phase.completed")).toBe(true);
    expect(traceEvents?.some((event) => event?.event_type === "output.volume")).toBe(true);
    expect(traceEvents?.some((event) => event?.event_type === "run.completed")).toBe(true);
    expect(vi.mocked(dependencies.fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("writes worker markdown output in a downstream-compatible form", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const translatedMarkdown = "# Domain Rewrite\n\n- [ ] verify: validate policy drift constraints\n";
    const { dependencies } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nValidate policy drift constraints.\n",
      howContent: "# How\nUse canonical governance controls language.\n",
    });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: translatedMarkdown,
      stderr: "",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
    }));

    expect(code).toBe(0);
    const writeCall = vi.mocked(dependencies.fileSystem.writeText).mock.calls[0];
    const writtenMarkdown = writeCall?.[1] ?? "";
    expect(writtenMarkdown).toBe(translatedMarkdown);
    expect(() => parseTasks(writtenMarkdown, outputFile)).not.toThrow();
    expect(parseTasks(writtenMarkdown, outputFile)).toHaveLength(1);
  });

  it("finalizes failed runs with preserved artifacts and trace completion", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, artifactStore, traceWriter, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "translate failed",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
      trace: true,
    }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-translate" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
    const traceEvents = vi.mocked(traceWriter.write).mock.calls.map((call) => call[0]);
    expect(traceEvents.some((event) => event.event_type === "run.completed" && event.payload.status === "execution-failed")).toBe(true);
    expect(vi.mocked(traceWriter.flush)).toHaveBeenCalledTimes(1);
  });

  it("preserves artifacts on success when keepArtifacts is enabled", async () => {
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
      keepArtifacts: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-translate" }),
      expect.objectContaining({
        status: "completed",
        preserve: true,
      }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
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

    const forceReleaseOrder = vi.mocked(dependencies.fileLock.forceRelease).mock.invocationCallOrder[0];
    const lockAcquireOrder = vi.mocked(dependencies.fileLock.acquire).mock.invocationCallOrder[0];
    expect(forceReleaseOrder).toBeLessThan(lockAcquireOrder);
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

  it("supports deterministic in-place writes when <output> matches <what>", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const { dependencies } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile: whatFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const resolvedWhatFile = path.resolve(cwd, whatFile);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: whatFile,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.acquire)).toHaveBeenCalledWith(resolvedWhatFile, { command: "translate" });
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      resolvedWhatFile,
      "# Translated\n\nDomain-native output\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalledWith(
      howFile,
      expect.any(String),
    );
  });

  it("never mutates <what> or <how> when output is a different file", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const resolvedOutputFile = path.resolve(cwd, outputFile);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dependencies.fileSystem.writeText)).toHaveBeenCalledWith(
      resolvedOutputFile,
      "# Translated\n\nDomain-native output\n",
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalledWith(
      whatFile,
      expect.any(String),
    );
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalledWith(
      howFile,
      expect.any(String),
    );
  });

  it("does not mutate <what> or <how> when translation execution fails", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, artifactStore } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 5,
      stdout: "",
      stderr: "translate failed",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: outputFile,
    }));

    expect(code).toBe(1);
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-translate" }),
      expect.objectContaining({
        status: "execution-failed",
        preserve: true,
      }),
    );
  });

  it("does not create or finalize artifacts when lock contention blocks execution", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const outputFile = path.join(cwd, "output.md");
    const { dependencies, artifactStore } = createDependencies({
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
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).not.toHaveBeenCalled();
  });

  it("rejects when <output> matches <how> and avoids mutation", async () => {
    const cwd = "/workspace";
    const whatFile = path.join(cwd, "what.md");
    const howFile = path.join(cwd, "how.md");
    const { dependencies, events } = createDependencies({
      cwd,
      whatFile,
      howFile,
      outputFile: howFile,
      whatContent: "# What\nShip auth flow.\n",
      howContent: "# How\nUse bounded contexts.\n",
    });

    const translateTask = createTranslateTask(dependencies);
    const code = await translateTask(createOptions({
      what: whatFile,
      how: howFile,
      output: howFile,
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("does not allow <output> to be the same path as <how>"))).toBe(true);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileLock.acquire)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.fileSystem.writeText)).not.toHaveBeenCalled();
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
  traceWriter: TraceWriterPort & { write: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
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

  const traceWriter = {
    write: vi.fn(),
    flush: vi.fn(),
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
    cliBlockExecutor: {
      execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
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
    traceWriter,
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
    traceWriter,
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
