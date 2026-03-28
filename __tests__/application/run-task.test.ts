import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRunTask,
  finalizeRunArtifacts,
  getAutomationWorkerCommand,
  isOpenCodeWorkerCommand,
  toRuntimeTaskMetadata,
  type RunTaskDependencies,
  type RunTaskOptions,
} from "../../src/application/run-task.js";
import type { Task } from "../../src/domain/parser.js";
import type {
  ApplicationOutputEvent,
  ApplicationOutputPort,
  ArtifactStore,
  FileSystem,
  GitClient,
  ProcessRunner,
  TemplateLoader,
  VerificationSidecar,
} from "../../src/domain/ports/index.js";

describe("run-task commit behavior", () => {
  it("commits checked task with default commit message after successful completion", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
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
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--is-inside-work-tree"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      4,
      ["add", "-A", "--", ".", ":(exclude).rundown/runs/**"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      5,
      ["commit", "-m", "rundown: complete \"cli: echo hello\" in tasks.md"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      6,
      ["rev-parse", "HEAD"],
      cwd,
    );
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        preserve: false,
        extra: {
          commitSha: "abc123def",
          commitMessage: "rundown: complete \"cli: echo hello\" in tasks.md",
        },
      }),
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
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "def456abc";
        }
        return "";
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "docs/roadmap.md",
      verify: false,
      commitAfterComplete: true,
      commitMessageTemplate: "done: {{task}} @ {{file}}",
    }));

    expect(code).toBe(0);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(
      3,
      ["rev-parse", "--is-inside-work-tree"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      4,
      ["add", "-A", "--", ".", ":(exclude).rundown/runs/**"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      5,
      ["commit", "-m", "done: cli: echo ship @ docs/roadmap.md"],
      cwd,
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      6,
      ["rev-parse", "HEAD"],
      cwd,
    );
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        preserve: false,
        extra: {
          commitSha: "def456abc",
          commitMessage: "done: cli: echo ship @ docs/roadmap.md",
        },
      }),
    );
    expect(events.some((event) => event.kind === "success" && event.message === "Committed: done: cli: echo ship @ docs/roadmap.md")).toBe(true);
  });

  it("does not persist commit metadata when --commit is not enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: false,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");

    const finalizeMetadata = vi.mocked(dependencies.artifactStore.finalize).mock.calls[0]?.[1];
    expect(finalizeMetadata).toEqual(expect.objectContaining({
      status: "completed",
      preserve: false,
    }));
    expect(finalizeMetadata).not.toHaveProperty("extra");

    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) =>
      JSON.stringify(args) === JSON.stringify(["commit", "-m", "rundown: complete \"cli: echo hello\" in tasks.md"])
    )).toBe(false);
    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) =>
      JSON.stringify(args) === JSON.stringify(["rev-parse", "HEAD"])
    )).toBe(false);
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

  it("continues execution when --commit is used outside a git repository", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse") {
          throw new Error("not a repo");
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
    expect(events.some((event) => event.kind === "warn" && event.message === "--commit: not inside a git repository, skipping.")).toBe(true);
    expect(gitClient.run).toHaveBeenCalledTimes(2);
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) => args[0] === "status")).toBe(false);
  });

  it("errors and exits when --commit is used with a dirty working directory", async () => {
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
        if (args[0] === "status") {
          return "M file.txt\n";
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

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] cli: echo hello\n");
    expect(events.some((event) => event.kind === "error" && event.message.includes("working directory is not clean"))).toBe(true);
    expect(gitClient.run).toHaveBeenCalledTimes(2);
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) => args[0] === "add")).toBe(false);
    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) => args[0] === "commit")).toBe(false);
  });

  it("does not run git status --porcelain when --commit is not enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      commitAfterComplete: false,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(vi.mocked(gitClient.run).mock.calls.some(([args]) =>
      JSON.stringify(args) === JSON.stringify(["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"])
    )).toBe(false);
  });
});

describe("run-task helper exports", () => {
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

  it("finalizes runtime artifacts and emits the saved path when preserved", () => {
    const emit = vi.fn<ApplicationOutputPort["emit"]>();
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

    finalizeRunArtifacts(
      artifactStore,
      {
        runId: "run-1",
        rootDir: "/workspace/.rundown/runs/run-1",
        cwd: "/workspace",
        keepArtifacts: true,
        commandName: "run",
      },
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

  it("maps a task into runtime metadata", () => {
    const task = createInlineTask("/workspace/tasks.md", "cli: echo hello");

    expect(toRuntimeTaskMetadata(task, "tasks.md")).toEqual({
      text: "cli: echo hello",
      file: "/workspace/tasks.md",
      line: 1,
      index: 0,
      source: "tasks.md",
    });
  });
});

describe("run-task trace enrichment", () => {
  it("emits prompt.metrics events per traced phase", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "def456abc";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    vi.mocked(dependencies.taskSelector.selectNextTask).mockReturnValue({
      task,
      source: "tasks.md",
      contextBefore: "abc",
    });
    vi.mocked(dependencies.templateLoader.load).mockImplementation((templatePath: string) => {
      if (templatePath.endsWith(path.join(".rundown", "execute.md"))) {
        return "{{context}}::{{task}}";
      }
      if (templatePath.endsWith(path.join(".rundown", "trace.md"))) {
        return "TRACE {{task}}";
      }
      return null;
    });
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "execution complete",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: [],
            wasted_effort_pct: 0,
            key_decisions: [],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    const promptMetricsEvents = traceWriter.write.mock.calls
      .map((call) => call[0])
      .filter((event) => event?.event_type === "prompt.metrics");

    expect(promptMetricsEvents.length).toBeGreaterThanOrEqual(2);
    expect(promptMetricsEvents).toContainEqual(expect.objectContaining({
      event_type: "prompt.metrics",
      payload: expect.objectContaining({
        char_count: 18,
        estimated_tokens: 4.5,
        template_name: "execute.md",
      }),
    }));
    const executePromptMetrics = promptMetricsEvents.find((event) => event.payload.template_name === "execute.md");
    expect(executePromptMetrics?.payload.context_ratio).toBeCloseTo(3 / 18);
    expect(promptMetricsEvents.some((event) => event.payload.template_name === "trace.md")).toBe(true);
  });

  it("emits task.context event with deterministic selection metrics", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n- [ ] Follow-up\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    vi.mocked(dependencies.taskSelector.selectNextTask).mockReturnValue({
      task,
      source: "tasks.md",
      contextBefore: "Intro\nNotes",
    });
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "execution complete",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: [],
            wasted_effort_pct: 0,
            key_decisions: [],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "task.context",
      payload: {
        source_files_scanned: 1,
        total_unchecked_tasks: 2,
        task_position_in_file: 1,
        document_context_lines: 2,
        has_subtasks: false,
        is_inline_cli: false,
        is_verify_only: false,
      },
    }));
  });

  it("emits timing.waterfall event at run end with phase timings and totals", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "def456abc";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "execution complete",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: [],
            wasted_effort_pct: 0,
            key_decisions: [],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    const timingWaterfallEvents = traceWriter.write.mock.calls
      .map((call) => call[0])
      .filter((event) => event?.event_type === "timing.waterfall");

    expect(timingWaterfallEvents).toHaveLength(1);
    const timingEvent = timingWaterfallEvents[0];
    expect(Array.isArray(timingEvent.payload.phases)).toBe(true);
    expect(timingEvent.payload.phases.length).toBeGreaterThanOrEqual(2);
    expect(timingEvent.payload.phases).toContainEqual(expect.objectContaining({ phase: "execute", sequence: 1 }));
    expect(timingEvent.payload.phases.some((phase: { phase: string }) => phase.phase === "plan")).toBe(true);

    const totalDurationFromPhases = timingEvent.payload.phases
      .reduce((sum: number, phase: { duration_ms: number }) => sum + phase.duration_ms, 0);

    expect(timingEvent.payload.total_worker_time_ms).toBe(totalDurationFromPhases);
    expect(timingEvent.payload.idle_time_ms).toBeGreaterThanOrEqual(0);
    expect(timingEvent.payload.total_wall_time_ms).toBeGreaterThanOrEqual(timingEvent.payload.total_worker_time_ms);
  });

  it("emits output.volume events per traced phase with byte and line counts", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "line one\nline two",
        stderr: "warn one",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: [],
            wasted_effort_pct: 0,
            key_decisions: [],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    const outputVolumeEvents = traceWriter.write.mock.calls
      .map((call) => call[0])
      .filter((event) => event?.event_type === "output.volume");

    expect(outputVolumeEvents.length).toBeGreaterThanOrEqual(2);
    expect(outputVolumeEvents).toContainEqual(expect.objectContaining({
      event_type: "output.volume",
      payload: {
        phase: "execute",
        sequence: 1,
        stdout_bytes: Buffer.byteLength("line one\nline two", "utf8"),
        stderr_bytes: Buffer.byteLength("warn one", "utf8"),
        stdout_lines: 2,
        stderr_lines: 1,
      },
    }));
  });

  it("emits agent trace events from phase stdout when tracing is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "def456abc";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "<thinking>",
        "compare adapter choices",
        "</thinking>",
        "```rundown-trace",
        "confidence: 90",
        "files_read: src/application/run-task.ts, src/domain/trace.ts",
        "files_written: src/application/run-task.ts",
        "tools_used: read, apply_patch, read",
        "approach: emit parsed events after each phase",
        "blockers: none",
        "```",
      ].join("\n"),
      stderr: "",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    const eventTypes = traceWriter.write.mock.calls.map((call) => call[0]?.event_type);

    expect(eventTypes).toContain("agent.signals");
    expect(eventTypes).toContain("agent.thinking");
    expect(eventTypes).toContain("agent.tool_usage");
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "agent.signals",
      payload: {
        confidence: 90,
        files_read: ["src/application/run-task.ts", "src/domain/trace.ts"],
        files_written: ["src/application/run-task.ts"],
        tools_used: ["read", "apply_patch", "read"],
        approach: "emit parsed events after each phase",
        blockers: "none",
      },
    }));
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "agent.tool_usage",
      payload: {
        tools: ["read", "apply_patch"],
      },
    }));
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "agent.thinking",
      payload: {
        thinking_blocks_count: 1,
        total_thinking_chars: "compare adapter choices".length,
      },
    }));
  });

  it("does not emit agent tool usage when tools_used is omitted", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "```rundown-trace",
        "confidence: not-a-number",
        "approach: keep scope narrow",
        "```",
      ].join("\n"),
      stderr: "",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "agent.signals",
      payload: {
        confidence: null,
        files_read: [],
        files_written: [],
        tools_used: [],
        approach: "keep scope narrow",
        blockers: null,
      },
    }));
    expect(traceWriter.write.mock.calls.some((call) => call[0]?.event_type === "agent.tool_usage")).toBe(false);
  });

  it("emits analysis.summary event from the final trace enrichment phase", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "def456abc";
        }
        return "";
      }),
    };
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "execution complete",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "high",
            execution_quality: "clean",
            direction_changes: 1,
            modules_touched: ["src/application/run-task.ts"],
            wasted_effort_pct: 5,
            key_decisions: ["reuse runtime artifacts metadata"],
            risk_flags: [],
            improvement_suggestions: ["reduce prompt size"],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(dependencies.workerExecutor.runWorker).toHaveBeenCalledTimes(2);
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "analysis.summary",
      payload: {
        task_complexity: "high",
        execution_quality: "clean",
        direction_changes: 1,
        modules_touched: ["src/application/run-task.ts"],
        wasted_effort_pct: 5,
        key_decisions: ["reuse runtime artifacts metadata"],
        risk_flags: [],
        improvement_suggestions: ["reduce prompt size"],
        skill_gaps: [],
        thinking_quality: "clear",
        uncertainty_moments: 0,
      },
    }));
  });

  it("warns and skips analysis.summary when trace enrichment output is malformed", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "execution complete",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "not structured",
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(traceWriter.write.mock.calls.some((call) => call[0]?.event_type === "analysis.summary")).toBe(false);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("analysis.summary"))).toBe(true);
  });
});

describe("run-task prompt and mode behavior", () => {
  it("returns 3 when no markdown files match the source", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.sourceResolver.resolveSources).mockResolvedValue([]);

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "missing/**/*.md",
      verify: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(3);
    expect(vi.mocked(dependencies.taskSelector.selectNextTask)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "warn" && event.message.includes("No Markdown files found matching: missing/**/*.md"))).toBe(true);
  });

  it("returns 3 when no unchecked task can be selected", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.taskSelector.selectNextTask).mockReturnValue(null);

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(3);
    expect(vi.mocked(dependencies.artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("No unchecked tasks found."))).toBe(true);
  });

  it("prints the rendered worker prompt for non-inline tasks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      printPrompt: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Build release"))).toBe(true);
  });

  it("reports dry-run details for non-inline tasks", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      dryRun: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run — would run: opencode run"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
  });

  it("prints inline CLI text when prompt output is requested", async () => {
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
      printPrompt: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.executeInlineCli)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "info",
      message: "Selected task is inline CLI; no worker prompt is rendered.",
    });
    expect(events).toContainEqual({
      kind: "text",
      text: "cli: echo hello",
    });
  });

  it("keeps tasks unchecked in detached mode and preserves runtime artifacts", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      mode: "detached",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Build release\n");
    expect(vi.mocked(dependencies.taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "detached", preserve: true }),
    );
    expect(events.some((event) => event.kind === "info" && event.message.includes("Detached mode"))).toBe(true);
  });

  it("runs explicit only-verify mode with the automation worker command", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      mode: "tui",
      onlyVerify: true,
      verify: false,
      workerCommand: ["opencode"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.artifactStore.createContext)).toHaveBeenCalledWith(expect.objectContaining({
      workerCommand: ["opencode", "run"],
    }));
    expect(vi.mocked(dependencies.taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      command: ["opencode", "run"],
    }));
    expect(fileSystem.readText(taskFile)).toBe("- [x] Build release\n");
    expect(events).toContainEqual({
      kind: "info",
      message: "Only verify mode — skipping task execution.",
    });
  });

  it("auto-skips execution for verify-only tasks and checks them after passing verification", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "verify: release docs are consistent");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] verify: release docs are consistent\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(dependencies.taskVerification.verify)).toHaveBeenCalledTimes(1);
    expect(fileSystem.readText(taskFile)).toBe("- [x] verify: release docs are consistent\n");
    expect(events.some((event) => event.kind === "info" && event.message.includes("Task classified as verify-only"))).toBe(true);
    expect(events).toContainEqual({
      kind: "info",
      message: "Verify-only task mode — skipping task execution.",
    });
  });

  it("returns execution failure for non-inline workers and emits wait-mode output", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 7,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Build release\n");
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "execution-failed", preserve: false }),
    );
    expect(events).toContainEqual({ kind: "text", text: "worker out" });
    expect(events).toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events.some((event) => event.kind === "error" && event.message.includes("Worker exited with code 7"))).toBe(true);
  });

  it("suppresses worker stdout and stderr when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] Build release\n");
    expect(events).not.toContainEqual({ kind: "text", text: "worker out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Running:"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Task checked: Build release"))).toBe(true);
  });

  it("keeps rundown status events visible on worker failure when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 7,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Build release\n");
    expect(events).not.toContainEqual({ kind: "text", text: "worker out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events.some((event) => event.kind === "info" && event.message.includes("Running:"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Worker exited with code 7"))).toBe(true);
  });

  it("returns failure code and specific worker error message when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 23,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: false,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Build release\n");
    expect(events).not.toContainEqual({ kind: "text", text: "worker out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events).toContainEqual({ kind: "error", message: "Worker exited with code 23." });
  });

  it("emits inline CLI stdout and stderr when hideAgentOutput is disabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "true";
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "abc123def";
        }
        return "";
      }),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: false,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(events).toContainEqual({ kind: "text", text: "inline out" });
    expect(events).toContainEqual({ kind: "stderr", text: "inline err" });
  });

  it("suppresses inline CLI stdout and stderr when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
    }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [x] cli: echo hello\n");
    expect(events).not.toContainEqual({ kind: "text", text: "inline out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "inline err" });
  });

  it("returns failure and keeps error messaging when inline CLI fails with hideAgentOutput enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: fail");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: fail\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 42,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
    }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] cli: fail\n");
    expect(events).not.toContainEqual({ kind: "text", text: "inline out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "inline err" });
    expect(events.some((event) => event.kind === "error" && event.message.includes("Inline CLI exited with code 42"))).toBe(true);
  });

  it("keeps verification and repair summaries visible when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "worker out",
      stderr: "worker err",
    });
    dependencies.taskVerification.verify = vi.fn(async () => false);
    dependencies.taskRepair.repair = vi.fn(async () => ({ valid: true, attempts: 1 }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: true,
      repairAttempts: 1,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).not.toContainEqual({ kind: "text", text: "worker out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events.some((event) => event.kind === "info" && event.message === "Running verification...")).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Verification failed. Running repair"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message === "Repair succeeded after 1 attempt(s).")).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message === "Task checked: Build release")).toBe(true);
  });

  it("keeps verification result messages visible when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "worker out",
      stderr: "worker err",
    });
    dependencies.taskVerification.verify = vi.fn(async () => true);

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      verify: true,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events).not.toContainEqual({ kind: "text", text: "worker out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err" });
    expect(events.some((event) => event.kind === "info" && event.message === "Running verification...")).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message === "Verification passed.")).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message === "Task checked: Build release")).toBe(true);
  });

  it("still emits phase and output-volume trace events when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.runWorker = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "worker out line 1\nworker out line 2",
        stderr: "worker err line 1",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "```analysis.summary",
          JSON.stringify({
            task_complexity: "medium",
            execution_quality: "clean",
            direction_changes: 0,
            modules_touched: [],
            wasted_effort_pct: 0,
            key_decisions: [],
            risk_flags: [],
            improvement_suggestions: [],
            skill_gaps: [],
            thinking_quality: "clear",
            uncertainty_moments: 0,
          }),
          "```",
        ].join("\n"),
        stderr: "",
      });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(events).not.toContainEqual({ kind: "text", text: "worker out line 1\nworker out line 2" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "worker err line 1" });
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "phase.completed",
      payload: expect.objectContaining({
        phase: "execute",
        sequence: 1,
        stdout_bytes: Buffer.byteLength("worker out line 1\nworker out line 2", "utf8"),
        stderr_bytes: Buffer.byteLength("worker err line 1", "utf8"),
        output_captured: true,
      }),
    }));
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "output.volume",
      payload: {
        phase: "execute",
        sequence: 1,
        stdout_bytes: Buffer.byteLength("worker out line 1\nworker out line 2", "utf8"),
        stderr_bytes: Buffer.byteLength("worker err line 1", "utf8"),
        stdout_lines: 2,
        stderr_lines: 1,
      },
    }));
  });

  it("still records traced output metrics for inline CLI when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient });
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    dependencies.createTraceWriter = vi.fn((_trace: boolean, _artifactContext) => traceWriter);
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "inline out",
      stderr: "inline err",
    }));
    dependencies.workerExecutor.runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "```analysis.summary",
        JSON.stringify({
          task_complexity: "medium",
          execution_quality: "clean",
          direction_changes: 0,
          modules_touched: [],
          wasted_effort_pct: 0,
          key_decisions: [],
          risk_flags: [],
          improvement_suggestions: [],
          skill_gaps: [],
          thinking_quality: "clear",
          uncertainty_moments: 0,
        }),
        "```",
      ].join("\n"),
      stderr: "",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      workerCommand: ["opencode", "run"],
      trace: true,
    }));

    expect(code).toBe(0);
    expect(events).not.toContainEqual({ kind: "text", text: "inline out" });
    expect(events).not.toContainEqual({ kind: "stderr", text: "inline err" });
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "phase.completed",
      payload: expect.objectContaining({
        phase: "execute",
        sequence: 1,
        stdout_bytes: Buffer.byteLength("inline out", "utf8"),
        stderr_bytes: Buffer.byteLength("inline err", "utf8"),
        output_captured: true,
      }),
    }));
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "output.volume",
      payload: {
        phase: "execute",
        sequence: 1,
        stdout_bytes: Buffer.byteLength("inline out", "utf8"),
        stderr_bytes: Buffer.byteLength("inline err", "utf8"),
        stdout_lines: 1,
        stderr_lines: 1,
      },
    }));
  });

  it("finalizes artifacts as failed when the worker throws", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });
    vi.mocked(dependencies.workerExecutor.runWorker).mockRejectedValue(new Error("worker exploded"));

    const runTask = createRunTask(dependencies);

    await expect(runTask(createOptions({
      verify: false,
      workerCommand: ["opencode", "run"],
    }))).rejects.toThrow("worker exploded");
    expect(vi.mocked(dependencies.artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", preserve: false }),
    );
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

  it("keeps on-complete hook stdout/stderr visible when hideAgentOutput is enabled", async () => {
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
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const runTask = createRunTask(dependencies);

    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      onCompleteCommand: "node scripts/after.js",
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "text" && event.text === "inline out")).toBe(false);
    expect(events.some((event) => event.kind === "stderr" && event.text === "inline err")).toBe(false);
    expect(events.some((event) => event.kind === "text" && event.text === "hook out")).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook err")).toBe(true);
  });

  it("suppresses worker output but still emits on-complete hook output when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
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
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      onCompleteCommand: "node scripts/after.js",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "text" && event.text === "worker out")).toBe(false);
    expect(events.some((event) => event.kind === "stderr" && event.text === "worker err")).toBe(false);
    expect(events.some((event) => event.kind === "text" && event.text === "hook out")).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook err")).toBe(true);
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
    expect(gitClient.run).toHaveBeenCalledTimes(2);
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"], cwd);
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
    dependencies.taskVerification.verify = vi.fn(async () => false);

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
    expect(gitClient.run).toHaveBeenCalledTimes(2);
    expect(gitClient.run).toHaveBeenNthCalledWith(1, ["rev-parse", "--is-inside-work-tree"], cwd);
    expect(gitClient.run).toHaveBeenNthCalledWith(2, ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"], cwd);
    expect(processRunner.run).not.toHaveBeenCalled();
  });
});

describe("run-task --all mode", () => {
  it("runs multiple inline CLI tasks sequentially and returns 0 when all complete", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo one\n- [ ] cli: echo two\n- [ ] cli: echo three\n",
    });
    const gitClient = createGitClientMock();
    let selectCallCount = 0;
    const events: ApplicationOutputEvent[] = [];
    const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
    const verificationSidecar: VerificationSidecar = {
      filePath: vi.fn(() => ""),
      read: vi.fn(() => null),
      remove: vi.fn(),
    };
    const artifactStore: ArtifactStore = {
      createContext: vi.fn((opts: Record<string, unknown>) => ({
        runId: `run-${selectCallCount}`,
        rootDir: path.join(cwd, ".rundown", "runs", `run-${selectCallCount}`),
        cwd,
        keepArtifacts: false,
        commandName: "run",
      })),
      beginPhase: vi.fn(),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ".rundown/runs/run-test"),
      rootDir: vi.fn(() => path.join(cwd, ".rundown", "runs")),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const tasks = [
      { text: "cli: echo one", cmd: "echo one" },
      { text: "cli: echo two", cmd: "echo two" },
      { text: "cli: echo three", cmd: "echo three" },
    ];

    const dependencies: RunTaskDependencies = {
      sourceResolver: { resolveSources: vi.fn(async () => [taskFile]) },
      taskSelector: {
        selectNextTask: vi.fn(() => {
          if (selectCallCount >= tasks.length) return null;
          const t = tasks[selectCallCount];
          selectCallCount++;
          return {
            task: {
              text: t.text,
              checked: false,
              index: selectCallCount - 1,
              line: selectCallCount,
              column: 1,
              offsetStart: 0,
              offsetEnd: t.text.length,
              file: taskFile,
              isInlineCli: true,
              cliCommand: t.cmd,
              depth: 0,
            },
            source: "tasks.md",
            contextBefore: "",
          };
        }),
        selectTaskByLocation: vi.fn(() => null),
      },
      workerExecutor: {
        runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
      taskVerification: { verify: vi.fn(async () => true) },
      taskRepair: { repair: vi.fn(async () => ({ valid: true, attempts: 0 })) },
      workingDirectory: { cwd: vi.fn(() => cwd) },
      fileSystem,
      templateLoader,
      verificationSidecar,
      artifactStore,
      gitClient,
      processRunner: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
      pathOperations: {
        join: (...parts) => path.join(...parts),
        resolve: (...parts) => path.resolve(...parts),
        dirname: (p) => path.dirname(p),
        relative: (from, to) => path.relative(from, to),
        isAbsolute: (p) => path.isAbsolute(p),
      },
      templateVarsLoader: { load: vi.fn(() => ({})) },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      createTraceWriter: vi.fn((_trace: boolean, _artifactContext) => ({
        write: vi.fn(),
        flush: vi.fn(),
      })),
      output: { emit: (event) => { events.push(event); } },
    };

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      runAll: true,
    }));

    expect(code).toBe(0);
    expect(selectCallCount).toBe(3); // 3 tasks selected
    expect(dependencies.taskSelector.selectNextTask).toHaveBeenCalledTimes(4); // 3 tasks + 1 null
    expect(dependencies.workerExecutor.executeInlineCli).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.kind === "success" && e.message.startsWith("Task checked:"))).toHaveLength(3);
    expect(events.some((e) => e.kind === "success" && e.message.includes("All tasks completed (3 total)"))).toBe(true);
  });

  it("stops on first execution failure in --all mode", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo one\n- [ ] cli: fail\n",
    });
    const gitClient = createGitClientMock();
    let selectCallCount = 0;
    const events: ApplicationOutputEvent[] = [];

    const tasks = [
      { text: "cli: echo one", cmd: "echo one", exitCode: 0 },
      { text: "cli: fail", cmd: "fail", exitCode: 1 },
    ];

    const dependencies: RunTaskDependencies = {
      sourceResolver: { resolveSources: vi.fn(async () => [taskFile]) },
      taskSelector: {
        selectNextTask: vi.fn(() => {
          if (selectCallCount >= tasks.length) return null;
          const t = tasks[selectCallCount];
          selectCallCount++;
          return {
            task: {
              text: t.text,
              checked: false,
              index: selectCallCount - 1,
              line: selectCallCount,
              column: 1,
              offsetStart: 0,
              offsetEnd: t.text.length,
              file: taskFile,
              isInlineCli: true,
              cliCommand: t.cmd,
              depth: 0,
            },
            source: "tasks.md",
            contextBefore: "",
          };
        }),
        selectTaskByLocation: vi.fn(() => null),
      },
      workerExecutor: {
        runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        executeInlineCli: vi.fn(async (_cmd: string) => {
          if (_cmd === "fail") return { exitCode: 1, stdout: "", stderr: "error" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      },
      taskVerification: { verify: vi.fn(async () => true) },
      taskRepair: { repair: vi.fn(async () => ({ valid: true, attempts: 0 })) },
      workingDirectory: { cwd: vi.fn(() => cwd) },
      fileSystem,
      templateLoader: { load: vi.fn(() => null) },
      verificationSidecar: { filePath: vi.fn(() => ""), read: vi.fn(() => null), remove: vi.fn() },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test", rootDir: path.join(cwd, ".rundown", "runs", "run-test"),
          cwd, keepArtifacts: false, commandName: "run",
        })),
        beginPhase: vi.fn(), completePhase: vi.fn(), finalize: vi.fn(),
        displayPath: vi.fn(() => ".rundown/runs/run-test"),
        rootDir: vi.fn(() => path.join(cwd, ".rundown", "runs")),
        listSaved: vi.fn(() => []), listFailed: vi.fn(() => []),
        latest: vi.fn(() => null), find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0), removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      gitClient,
      processRunner: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
      pathOperations: {
        join: (...parts) => path.join(...parts),
        resolve: (...parts) => path.resolve(...parts),
        dirname: (p) => path.dirname(p),
        relative: (from, to) => path.relative(from, to),
        isAbsolute: (p) => path.isAbsolute(p),
      },
      templateVarsLoader: { load: vi.fn(() => ({})) },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      createTraceWriter: vi.fn((_trace: boolean, _artifactContext) => ({
        write: vi.fn(),
        flush: vi.fn(),
      })),
      output: { emit: (event) => { events.push(event); } },
    };

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      runAll: true,
    }));

    expect(code).toBe(1);
    expect(selectCallCount).toBe(2);
    expect(events.filter((e) => e.kind === "success" && e.message.startsWith("Task checked:"))).toHaveLength(1);
    expect(events.some((e) => e.kind === "error" && e.message.includes("Inline CLI exited with code 1"))).toBe(true);
  });

  it("runs only one task when --all is not set", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n- [ ] cli: echo world\n",
    });
    const gitClient = createGitClientMock();
    const { dependencies } = createDependencies({ cwd, task, fileSystem, gitClient });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      runAll: false,
    }));

    expect(code).toBe(0);
    expect(dependencies.taskSelector.selectNextTask).toHaveBeenCalledTimes(1);
  });
});

describe("run-task --on-fail hook", () => {
  it("runs on-fail hook on execution failure", async () => {
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
        stdout: "hook ran",
        stderr: "",
      })),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 9,
      stdout: "",
      stderr: "boom",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onFailCommand: "node scripts/handle-fail.js",
    }));

    expect(code).toBe(1);
    expect(processRunner.run).toHaveBeenCalledTimes(1);
    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "node scripts/handle-fail.js",
      shell: true,
    }));
    expect(events.some((e) => e.kind === "text" && e.text === "hook ran")).toBe(true);
  });

  it("runs on-fail hook on verification failure", async () => {
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
    dependencies.taskVerification.verify = vi.fn(async () => false);

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: true,
      workerCommand: ["opencode", "run"],
      onFailCommand: "node scripts/handle-fail.js",
    }));

    expect(code).toBe(2);
    expect(processRunner.run).toHaveBeenCalledTimes(1);
    expect(processRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "node scripts/handle-fail.js",
    }));
  });

  it("does not run on-fail hook on success", async () => {
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

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onFailCommand: "node scripts/handle-fail.js",
    }));

    expect(code).toBe(0);
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it("warns when on-fail hook exits with non-zero code", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createInlineTask(taskFile, "cli: echo hello");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] cli: echo hello\n",
    });
    const gitClient = createGitClientMock();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 5,
        stdout: "",
        stderr: "",
      })),
    };
    const { dependencies, events } = createDependencies({ cwd, task, fileSystem, gitClient, processRunner });
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      onFailCommand: "node scripts/handle-fail.js",
    }));

    expect(code).toBe(1);
    expect(events.some((e) => e.kind === "warn" && e.message === "--on-fail hook exited with code 5")).toBe(true);
  });

  it("keeps on-fail hook stdout/stderr visible when hideAgentOutput is enabled", async () => {
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
    dependencies.workerExecutor.executeInlineCli = vi.fn(async () => ({
      exitCode: 1,
      stdout: "inline out",
      stderr: "inline err",
    }));

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      onFailCommand: "node scripts/handle-fail.js",
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "text" && event.text === "inline out")).toBe(false);
    expect(events.some((event) => event.kind === "stderr" && event.text === "inline err")).toBe(false);
    expect(events.some((event) => event.kind === "text" && event.text === "hook out")).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook err")).toBe(true);
  });

  it("suppresses worker output but still emits on-fail hook output when hideAgentOutput is enabled", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const task = createTask(taskFile, "Build release");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] Build release\n",
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
    vi.mocked(dependencies.workerExecutor.runWorker).mockResolvedValue({
      exitCode: 8,
      stdout: "worker out",
      stderr: "worker err",
    });

    const runTask = createRunTask(dependencies);
    const code = await runTask(createOptions({
      source: "tasks.md",
      verify: false,
      hideAgentOutput: true,
      onFailCommand: "node scripts/handle-fail.js",
      workerCommand: ["opencode", "run"],
    }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "text" && event.text === "worker out")).toBe(false);
    expect(events.some((event) => event.kind === "stderr" && event.text === "worker err")).toBe(false);
    expect(events.some((event) => event.kind === "text" && event.text === "hook out")).toBe(true);
    expect(events.some((event) => event.kind === "stderr" && event.text === "hook err")).toBe(true);
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
  const verificationSidecar: VerificationSidecar = {
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
    taskVerification: {
      verify: vi.fn(async () => true),
    },
    taskRepair: {
      repair: vi.fn(async () => ({ valid: true, attempts: 0 })),
    },
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    fileSystem: options.fileSystem,
    templateLoader,
    verificationSidecar,
    artifactStore,
    gitClient: options.gitClient,
    processRunner,
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateVarsLoader: {
      load: vi.fn(() => ({})),
    },
    traceWriter: {
      write: vi.fn(),
      flush: vi.fn(),
    },
    createTraceWriter: vi.fn((_trace: boolean, _artifactContext) => ({
      write: vi.fn(),
      flush: vi.fn(),
    })),
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

function createTask(file: string, text: string): Task {
  return {
    text,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: text.length,
    file,
    isInlineCli: false,
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
    runAll: false,
    onFailCommand: undefined,
    hideAgentOutput: false,
    trace: false,
    traceOnly: false,
    ...overrides,
  };
}
