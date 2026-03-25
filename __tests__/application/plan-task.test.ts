import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPlanTask, type PlanTaskDependencies, type PlanTaskOptions } from "../../src/application/plan-task.js";
import type { ApplicationOutputEvent, ArtifactStore, FileSystem } from "../../src/domain/ports/index.js";
import type { Task } from "../../src/domain/parser.js";

describe("plan-task", () => {
  it("prints the plan prompt and exits before running worker", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ printPrompt: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Build release"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("## Phase"))).toBe(true);
  });

  it("supports dry-run and skips worker execution", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, workerExecutor, artifactStore } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run"))).toBe(true);
  });

  it("returns 1 when worker command is missing", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ workerCommand: [] }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No worker command"))).toBe(true);
  });

  it("returns 1 for invalid --at format", async () => {
    const cwd = "/workspace";
    const { dependencies, events, taskSelector } = createDependencies({
      cwd,
      selectedTask: null,
      files: [],
      fileContent: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ at: "roadmap.md" }));

    expect(code).toBe(1);
    expect(vi.mocked(taskSelector.selectTaskByLocation)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Invalid --at format"))).toBe(true);
  });

  it("returns 1 for invalid --at line number", async () => {
    const cwd = "/workspace";
    const { dependencies, events, taskSelector } = createDependencies({
      cwd,
      selectedTask: null,
      files: [],
      fileContent: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ at: "roadmap.md:0" }));

    expect(code).toBe(1);
    expect(vi.mocked(taskSelector.selectTaskByLocation)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Invalid line number in --at: 0"))).toBe(true);
  });

  it("returns 3 when no task is found at an explicit location", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, events, taskSelector } = createDependencies({
      cwd,
      selectedTask: null,
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ at: `${taskFile}:2` }));

    expect(code).toBe(3);
    expect(vi.mocked(taskSelector.selectTaskByLocation)).toHaveBeenCalledWith(taskFile, 2);
    expect(events.some((event) => event.kind === "error" && event.message.includes(`No task found at ${taskFile}:2`))).toBe(true);
  });

  it("returns 3 when no files match source", async () => {
    const cwd = "/workspace";
    const { dependencies, events } = createDependencies({
      cwd,
      selectedTask: null,
      files: [],
      fileContent: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("No Markdown files"))).toBe(true);
  });

  it("returns 3 when no unchecked tasks are found", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, events } = createDependencies({
      cwd,
      selectedTask: null,
      files: [taskFile],
      fileContent: "# Roadmap\n- [x] Build release\n",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "info" && event.message.includes("No unchecked tasks found"))).toBe(true);
  });

  it("returns execution-failed when planner exits non-zero", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 9, stdout: "", stderr: "boom" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "execution-failed" }),
    );
  });

  it("completes with warning when planner produces no output", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore, fileSystem, events } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "   \n", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed" }),
    );
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Planner produced no output"))).toBe(true);
  });

  it("completes with warning when planner output has no task items", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const { dependencies, workerExecutor, artifactStore, fileSystem, events } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: "# Roadmap\n- [ ] Build release\n",
    });
    vi.mocked(workerExecutor.runWorker).mockResolvedValue({ exitCode: 0, stdout: "No task list here", stderr: "" });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed" }),
    );
    expect(events.some((event) => event.kind === "warn" && event.message.includes("no valid task items"))).toBe(true);
  });

  it("inserts parsed subtasks into markdown on success", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Build release\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "- [ ] Write tests\n- [ ] Update docs\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions());

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const updated = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(updated).toContain("  - [ ] Write tests");
    expect(updated).toContain("  - [ ] Update docs");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed" }),
    );
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 2 subtasks"))).toBe(true);
  });

  it("uses explicit location selection and preserves artifacts for a single subtask", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const content = "# Roadmap\n- [ ] Build release\n";
    const { dependencies, workerExecutor, fileSystem, artifactStore, events, taskSelector } = createDependencies({
      cwd,
      selectedTask: createSelection(taskFile),
      files: [taskFile],
      fileContent: content,
    });

    vi.mocked(workerExecutor.runWorker).mockResolvedValue({
      exitCode: 0,
      stdout: "- [ ] Write changelog\n",
      stderr: "",
    });

    const planTask = createPlanTask(dependencies);
    const code = await planTask(createOptions({ at: `${taskFile}:2`, keepArtifacts: true }));

    expect(code).toBe(0);
    expect(vi.mocked(taskSelector.selectTaskByLocation)).toHaveBeenCalledWith(taskFile, 2);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", preserve: true }),
    );
    expect(events.some((event) => event.kind === "success" && event.message.includes("Inserted 1 subtask under"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Runtime artifacts saved at"))).toBe(true);
  });
});

function createSelection(taskFile: string): { task: Task; source: string; contextBefore: string } {
  return {
    task: {
      text: "Build release",
      checked: false,
      index: 0,
      line: 2,
      column: 1,
      offsetStart: 0,
      offsetEnd: 0,
      file: taskFile,
      isInlineCli: false,
      depth: 0,
    },
    source: "roadmap.md",
    contextBefore: "# Roadmap",
  };
}

function createDependencies(options: {
  cwd: string;
  selectedTask: { task: Task; source: string; contextBefore: string } | null;
  files: string[];
  fileContent: string;
}): {
  dependencies: PlanTaskDependencies;
  events: ApplicationOutputEvent[];
  workerExecutor: PlanTaskDependencies["workerExecutor"];
  taskSelector: PlanTaskDependencies["taskSelector"];
  sourceResolver: PlanTaskDependencies["sourceResolver"];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
} {
  const events: ApplicationOutputEvent[] = [];

  const sourceResolver: PlanTaskDependencies["sourceResolver"] = {
    resolveSources: vi.fn(async () => options.files),
  };

  const taskSelector: PlanTaskDependencies["taskSelector"] = {
    selectNextTask: vi.fn(() => options.selectedTask),
    selectTaskByLocation: vi.fn(() => options.selectedTask),
  };

  const workerExecutor: PlanTaskDependencies["workerExecutor"] = {
    runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn(() => true),
    readText: vi.fn(() => options.fileContent),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-plan",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-plan"),
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "plan",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => path.join(options.cwd, ".rundown", "runs", "run-plan")),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const dependencies: PlanTaskDependencies = {
    sourceResolver,
    taskSelector,
    workerExecutor,
    workingDirectory: { cwd: vi.fn(() => options.cwd) },
    fileSystem,
    pathOperations: {
      join: vi.fn((...parts: string[]) => parts.join("/")),
      resolve: vi.fn((...parts: string[]) => parts.join("/")),
      dirname: vi.fn((filePath: string) => filePath.split("/").slice(0, -1).join("/") || "/"),
      relative: vi.fn((_from: string, to: string) => to),
      isAbsolute: vi.fn((filePath: string) => filePath.startsWith("/")),
    },
    templateVarsLoader: { load: vi.fn(() => ({})) },
    templateLoader: { load: vi.fn(() => null) },
    artifactStore,
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    workerExecutor,
    taskSelector,
    sourceResolver,
    artifactStore,
    fileSystem,
  };
}

function createOptions(overrides: Partial<PlanTaskOptions> = {}): PlanTaskOptions {
  return {
    source: "roadmap.md",
    at: undefined,
    mode: "wait",
    transport: "arg",
    sortMode: "none",
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    workerCommand: ["opencode", "run"],
    ...overrides,
  };
}
