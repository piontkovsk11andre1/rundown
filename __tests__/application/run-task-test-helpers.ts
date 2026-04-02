import path from "node:path";
import { vi } from "vitest";
import type { WorkerConfig } from "../../src/domain/worker-config.js";
import type { Task } from "../../src/domain/parser.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  CommandExecutor,
  FileLock,
  FileSystem,
  GitClient,
  ProcessRunner,
  TemplateLoader,
  VerificationStore,
} from "../../src/domain/ports/index.js";
import type {
  RunTaskDependencies,
  RunTaskOptions,
} from "../../src/application/run-task.js";

export function createDependencies(options: {
  cwd: string;
  task: Task;
  fileSystem: FileSystem;
  gitClient: GitClient;
  processRunner?: ProcessRunner;
  workerConfig?: WorkerConfig;
  cliBlockExecutor?: CommandExecutor;
}): { dependencies: RunTaskDependencies; events: ApplicationOutputEvent[] } {
  const events: ApplicationOutputEvent[] = [];
  const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
  const verificationStore: VerificationStore = {
    write: vi.fn(),
    read: vi.fn(() => null),
    remove: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn((contextOptions: Parameters<ArtifactStore["createContext"]>[0]) => ({
      runId: "run-test",
      rootDir: path.join(options.cwd, ".rundown", "runs", "run-test"),
      cwd: contextOptions.cwd ?? options.cwd,
      configDir: contextOptions.configDir,
      keepArtifacts: contextOptions.keepArtifacts ?? false,
      commandName: contextOptions.commandName,
      workerCommand: contextOptions.workerCommand,
      mode: contextOptions.mode,
      transport: contextOptions.transport,
      task: contextOptions.task,
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
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
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
    fileLock: createNoopFileLock(),
    templateLoader,
    verificationStore,
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
    workerConfigPort: {
      load: vi.fn(() => options.workerConfig),
    },
    traceWriter: {
      write: vi.fn(),
      flush: vi.fn(),
    },
    configDir: {
      configDir: path.join(options.cwd, ".rundown"),
      isExplicit: false,
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
    cliBlockExecutor: options.cliBlockExecutor,
  };

  return {
    dependencies,
    events,
  };
}

export function createInMemoryFileSystem(initialFiles: Record<string, string>): FileSystem {
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

export function createGitClientMock(): GitClient {
  return {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return "true";
      }
      return "";
    }),
  };
}

export function createInlineTask(file: string, text: string): Task {
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
    isRundownTask: false,
    cliCommand: text.replace(/^cli:\s*/i, ""),
    depth: 0,
    children: [],
    subItems: [],
  };
}

export function createTask(file: string, text: string): Task {
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
    isRundownTask: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

export function createOptions(overrides: Partial<RunTaskOptions>): RunTaskOptions {
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
    redo: false,
    resetAfter: false,
    clean: false,
    onFailCommand: undefined,
    showAgentOutput: false,
    trace: false,
    traceOnly: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    ...overrides,
  };
}

export function createNoopFileLock(): FileLock {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    isLocked: vi.fn(() => false),
    forceRelease: vi.fn(),
  };
}
