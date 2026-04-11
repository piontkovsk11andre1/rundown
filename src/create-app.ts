import { createRunTask, type RunTaskOptions } from "./application/run-task.js";
import { createDiscussTask, type DiscussTaskOptions } from "./application/discuss-task.js";
import { createHelpTask, type HelpTaskOptions } from "./application/help-task.js";
import {
  createViewMemory,
  type ViewMemoryOptions,
} from "./application/view-memory.js";
import {
  createValidateMemory,
  type ValidateMemoryOptions,
} from "./application/validate-memory.js";
import {
  createCleanMemory,
  type CleanMemoryOptions,
} from "./application/clean-memory.js";
import { createPlanTask, type PlanTaskOptions as PlanTaskUseCaseOptions } from "./application/plan-task.js";
import { createResearchTask, type ResearchTaskOptions as ResearchTaskUseCaseOptions } from "./application/research-task.js";
import {
  createQueryTask,
  type QueryTaskOptions as QueryTaskUseCaseOptions,
} from "./application/query-task.js";
import { createListTasks, type ListTasksOptions } from "./application/list-tasks.js";
import { createNextTask, type NextTaskOptions } from "./application/next-task.js";
import { createUnlockTask, type UnlockTaskOptions } from "./application/unlock-task.js";
import { createInitProject, type InitProjectOptions } from "./application/init-project.js";
import { createReverifyTask, type ReverifyTaskOptions } from "./application/reverify-task.js";
import { createRevertTask, type RevertTaskOptions } from "./application/revert-task.js";
import { createUndoTask, type UndoTaskOptions } from "./application/undo-task.js";
import { createLogRuns, type LogRunsOptions } from "./application/log-runs.js";
import {
  createManageArtifacts,
  type ManageArtifactsOptions,
} from "./application/manage-artifacts.js";
import type { ApplicationOutputPort } from "./domain/ports/output-port.js";
import type {
  ArtifactStore,
  CommandExecutor,
  Clock,
  ConfigDirPort,
  ConfigDirResult,
  DirectoryOpenerPort,
  FileLock,
  FileSystem,
  GitClient,
  MemoryReaderPort,
  MemoryResolverPort,
  MemoryWriterPort,
  ToolResolverPort,
  ProcessRunner,
  PathOperationsPort,
  SourceResolverPort,
  TaskRepairPort,
  TaskSelectorPort,
  TaskVerificationPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  VerificationStore,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "./domain/ports/index.js";
import {
  createCrossSpawnProcessRunner,
  createConfigDirAdapter,
  createDirectoryOpenerAdapter,
  createExecFileGitClient,
  createArtifactVerificationStore,
  createFsArtifactStore,
  createFsFileLock,
  createFsTemplateLoader,
  createFsTemplateVarsLoaderAdapter,
  createFanoutTraceWriter,
  createCliBlockExecutor,
  createJsonlTraceWriter,
  createMemoryReaderAdapter,
  createMemoryResolverAdapter,
  createMemoryWriterAdapter,
  createTerminalInteractiveInputAdapter,
  createToolResolverAdapter,
  createNodeFileSystem,
  createNoopTraceWriter,
  createNodePathOperationsAdapter,
  createSourceResolverAdapter,
  createSystemClock,
  createTaskRepairAdapter,
  createTaskSelectorAdapter,
  createTaskVerificationAdapter,
  createWorkerConfigAdapter,
  createWorkerExecutorAdapter,
  createWorkingDirectoryAdapter,
} from "./infrastructure/adapters/index.js";
import { CONFIG_DIR_NAME } from "./domain/ports/config-dir-port.js";

export type { DiscussTaskOptions };

type ReverifyTaskCommandOptions = Omit<ReverifyTaskOptions, "varsFileOption" | "cliTemplateVarArgs"> & {
  varsFileOption?: string | boolean | undefined;
  cliTemplateVarArgs?: string[];
};

export type App = {
  helpTask: (options: HelpTaskOptions) => Promise<number>;
  runTask: (options: RunTaskOptions) => Promise<number>;
  discussTask: (options: DiscussTaskOptions) => Promise<number>;
  viewMemory: (options: ViewMemoryOptions) => Promise<number>;
  validateMemory: (options: ValidateMemoryOptions) => Promise<number>;
  cleanMemory: (options: CleanMemoryOptions) => Promise<number>;
  reverifyTask: (options: ReverifyTaskCommandOptions) => Promise<number>;
  revertTask: (options: RevertTaskOptions) => Promise<number>;
  undoTask: (options: UndoTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskCommandOptions) => Promise<number>;
  researchTask: (options: ResearchTaskCommandOptions) => Promise<number>;
  queryTask: (options: QueryTaskCommandOptions) => Promise<number>;
  unlockTask: (options: UnlockTaskOptions) => Promise<number>;
  listTasks: (options: ListTasksOptions) => Promise<number>;
  nextTask: (options: NextTaskOptions) => Promise<number>;
  logRuns: (options: LogRunsOptions) => number;
  initProject: (options?: InitProjectOptions) => Promise<number>;
  manageArtifacts: (options: ManageArtifactsOptions) => number;
  emitOutput?: (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
  releaseAllLocks?: () => void;
  awaitShutdown?: () => Promise<void>;
};

export interface PlanTaskCommandOptions {
  source: string;
  cwd?: string;
  scanCount?: number;
  maxItems?: number;
  deep?: number;
  mode: PlanTaskUseCaseOptions["mode"];
  workerPattern: PlanTaskUseCaseOptions["workerPattern"];
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  verbose?: boolean;
}

export interface ResearchTaskCommandOptions {
  source: string;
  cwd?: string;
  mode: ResearchTaskUseCaseOptions["mode"];
  workerPattern: ResearchTaskUseCaseOptions["workerPattern"];
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  configDirOption?: string;
  verbose?: boolean;
}

export interface QueryTaskCommandOptions {
  queryText: string;
  dir: string;
  format: QueryTaskUseCaseOptions["format"];
  output?: string;
  skipResearch: boolean;
  mode: QueryTaskUseCaseOptions["mode"];
  workerPattern: QueryTaskUseCaseOptions["workerPattern"];
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  scanCount?: number;
  maxItems?: number;
  deep?: number;
  verbose?: boolean;
}

export type AppUseCaseFactories = {
  [Key in Exclude<keyof App, "releaseAllLocks" | "emitOutput" | "awaitShutdown">]: (ports: AppPorts) => App[Key];
};

export interface AppPorts {
  fileSystem: FileSystem;
  fileLock: FileLock;
  configDirPort: ConfigDirPort;
  configDir: ConfigDirResult | undefined;
  processRunner: ProcessRunner;
  gitClient: GitClient;
  templateLoader: TemplateLoader;
  verificationStore: VerificationStore;
  artifactStore: ArtifactStore;
  clock: Clock;
  directoryOpener: DirectoryOpenerPort;
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  workingDirectory: WorkingDirectoryPort;
  pathOperations: PathOperationsPort;
  memoryResolver: MemoryResolverPort;
  memoryReader: MemoryReaderPort;
  toolResolver: ToolResolverPort;
  memoryWriter?: MemoryWriterPort;
  workerConfigPort: WorkerConfigPort;
  templateVarsLoader: TemplateVarsLoaderPort;
  traceWriter: TraceWriterPort;
  cliBlockExecutor: CommandExecutor;
  output: ApplicationOutputPort;
}

export interface CreateAppDependencies {
  ports?: Partial<AppPorts>;
  useCaseFactories?: Partial<AppUseCaseFactories>;
}

function createAppPorts(overrides: Partial<AppPorts> = {}): AppPorts {
  const workingDirectory = overrides.workingDirectory ?? createWorkingDirectoryAdapter();
  const pathOperations = overrides.pathOperations ?? createNodePathOperationsAdapter();
  const configDirPort = overrides.configDirPort ?? createConfigDirAdapter();
  const discoveredConfigDir = overrides.configDir ?? configDirPort.resolve(workingDirectory.cwd());
  const configDir: ConfigDirResult = discoveredConfigDir ?? {
    configDir: pathOperations.join(workingDirectory.cwd(), CONFIG_DIR_NAME),
    isExplicit: false,
  };
  const verificationStore = overrides.verificationStore
    ?? createArtifactVerificationStore(configDir.configDir);
  const taskVerification = overrides.taskVerification
    ?? createTaskVerificationAdapter(verificationStore);
  const taskRepair = overrides.taskRepair
    ?? createTaskRepairAdapter(verificationStore);
  const fileSystem = overrides.fileSystem ?? createNodeFileSystem();
  const memoryWriter = overrides.memoryWriter ?? createMemoryWriterAdapter({
    fileSystem,
    pathOperations,
  });
  const memoryReader = overrides.memoryReader ?? createMemoryReaderAdapter({
    fileSystem,
    pathOperations,
  });
  const interactiveInput = createTerminalInteractiveInputAdapter();
  const toolResolver = overrides.toolResolver ?? createToolResolverAdapter({
    fileSystem,
    pathOperations,
    configDir,
    memoryWriter,
    interactiveInput,
  });
  const memoryResolver = overrides.memoryResolver ?? createMemoryResolverAdapter({
    fileSystem,
    pathOperations,
  });

  return {
    fileSystem,
    fileLock: overrides.fileLock ?? createFsFileLock(),
    configDirPort,
    configDir,
    processRunner: overrides.processRunner ?? createCrossSpawnProcessRunner(),
    gitClient: overrides.gitClient ?? createExecFileGitClient(),
    templateLoader: overrides.templateLoader ?? createFsTemplateLoader(),
    verificationStore,
    artifactStore: overrides.artifactStore ?? createFsArtifactStore(),
    clock: overrides.clock ?? createSystemClock(),
    directoryOpener: overrides.directoryOpener ?? createDirectoryOpenerAdapter(),
    sourceResolver: overrides.sourceResolver ?? createSourceResolverAdapter(),
    taskSelector: overrides.taskSelector ?? createTaskSelectorAdapter(),
    workerExecutor: overrides.workerExecutor ?? createWorkerExecutorAdapter(),
    taskVerification,
    taskRepair,
    workingDirectory,
    pathOperations,
    toolResolver,
    memoryResolver,
    memoryReader,
    memoryWriter,
    workerConfigPort: overrides.workerConfigPort ?? createWorkerConfigAdapter(),
    templateVarsLoader: overrides.templateVarsLoader ?? createFsTemplateVarsLoaderAdapter(),
    traceWriter: overrides.traceWriter ?? createNoopTraceWriter(),
    cliBlockExecutor: overrides.cliBlockExecutor ?? createCliBlockExecutor(),
    output: overrides.output ?? createNoopOutputPort(),
  };
}

function createNoopOutputPort(): ApplicationOutputPort {
  return {
    emit() {},
  };
}

function createArtifactTraceWriter(ports: AppPorts, artifactContext: { rootDir: string }): TraceWriterPort {
  const perRunTracePath = ports.pathOperations.join(artifactContext.rootDir, "trace.jsonl");
  const globalTracePath = ports.pathOperations.join(
    artifactContext.rootDir,
    "..",
    "..",
    "logs",
    "trace.jsonl",
  );

  return createFanoutTraceWriter([
    createJsonlTraceWriter(perRunTracePath, ports.fileSystem),
    createJsonlTraceWriter(globalTracePath, ports.fileSystem),
  ]);
}

function createDefaultUseCaseFactories(): AppUseCaseFactories {
  const planTaskUseCase = (ports: AppPorts) => createPlanTask({
    workerExecutor: ports.workerExecutor,
    workingDirectory: ports.workingDirectory,
    cliBlockExecutor: ports.cliBlockExecutor,
    fileSystem: ports.fileSystem,
    fileLock: ports.fileLock,
    templateLoader: ports.templateLoader,
    pathOperations: ports.pathOperations,
    memoryResolver: ports.memoryResolver,
    templateVarsLoader: ports.templateVarsLoader,
    workerConfigPort: ports.workerConfigPort,
    artifactStore: ports.artifactStore,
    traceWriter: ports.traceWriter,
    configDir: ports.configDir,
    createTraceWriter: (trace, artifactContext) => {
      if (!trace) {
        return ports.traceWriter;
      }

      return createArtifactTraceWriter(ports, artifactContext);
    },
    output: ports.output,
  });

  return {
    helpTask: (ports) => createHelpTask({
      workerExecutor: ports.workerExecutor,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      templateLoader: ports.templateLoader,
      artifactStore: ports.artifactStore,
      workerConfigPort: ports.workerConfigPort,
      traceWriter: ports.traceWriter,
      configDir: ports.configDir,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createArtifactTraceWriter(ports, artifactContext);
      },
      output: ports.output,
    }),
    runTask: (ports) => createRunTask({
      sourceResolver: ports.sourceResolver,
      taskSelector: ports.taskSelector,
      workerExecutor: ports.workerExecutor,
      taskVerification: ports.taskVerification,
      taskRepair: ports.taskRepair,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      fileLock: ports.fileLock,
      templateLoader: ports.templateLoader,
      verificationStore: ports.verificationStore,
      artifactStore: ports.artifactStore,
      gitClient: ports.gitClient,
      processRunner: ports.processRunner,
      pathOperations: ports.pathOperations,
      toolResolver: ports.toolResolver,
      memoryResolver: ports.memoryResolver,
      memoryWriter: ports.memoryWriter,
      templateVarsLoader: ports.templateVarsLoader,
      workerConfigPort: ports.workerConfigPort,
      traceWriter: ports.traceWriter,
      cliBlockExecutor: ports.cliBlockExecutor,
      configDir: ports.configDir,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createArtifactTraceWriter(ports, artifactContext);
      },
      output: ports.output,
    }),
    validateMemory: (ports) => createValidateMemory({
      sourceResolver: ports.sourceResolver,
      memoryResolver: ports.memoryResolver,
      memoryReader: ports.memoryReader,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    cleanMemory: (ports) => createCleanMemory({
      sourceResolver: ports.sourceResolver,
      memoryResolver: ports.memoryResolver,
      memoryReader: ports.memoryReader,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    viewMemory: (ports) => createViewMemory({
      sourceResolver: ports.sourceResolver,
      memoryResolver: ports.memoryResolver,
      memoryReader: ports.memoryReader,
      output: ports.output,
    }),
    reverifyTask: (ports) => createReverifyTask({
      artifactStore: ports.artifactStore,
      taskVerification: ports.taskVerification,
      taskRepair: ports.taskRepair,
      verificationStore: ports.verificationStore,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      traceWriter: ports.traceWriter,
      configDir: ports.configDir,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createArtifactTraceWriter(ports, artifactContext);
      },
      memoryResolver: ports.memoryResolver,
      templateLoader: ports.templateLoader,
      templateVarsLoader: ports.templateVarsLoader,
      workerConfigPort: ports.workerConfigPort,
      cliBlockExecutor: ports.cliBlockExecutor,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    revertTask: (ports) => createRevertTask({
      artifactStore: ports.artifactStore,
      gitClient: ports.gitClient,
      configDir: ports.configDir,
      workingDirectory: ports.workingDirectory,
      fileLock: ports.fileLock,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    undoTask: (ports) => createUndoTask({
      artifactStore: ports.artifactStore,
      workerExecutor: ports.workerExecutor,
      taskVerification: ports.taskVerification,
      fileSystem: ports.fileSystem,
      gitClient: ports.gitClient,
      templateLoader: ports.templateLoader,
      workingDirectory: ports.workingDirectory,
      pathOperations: ports.pathOperations,
      configDir: ports.configDir,
      output: ports.output,
    }),
    planTask: (ports) => {
      const runPlanTask = planTaskUseCase(ports);

      return async (options) => runPlanTask({
        ...options,
        cwd: options.cwd,
        maxItems: options.maxItems,
      });
    },
    researchTask: (ports) => createResearchTask({
      workerExecutor: ports.workerExecutor,
      cliBlockExecutor: ports.cliBlockExecutor,
      artifactStore: ports.artifactStore,
      fileSystem: ports.fileSystem,
      fileLock: ports.fileLock,
      workingDirectory: ports.workingDirectory,
      pathOperations: ports.pathOperations,
      memoryResolver: ports.memoryResolver,
      templateLoader: ports.templateLoader,
      templateVarsLoader: ports.templateVarsLoader,
      workerConfigPort: ports.workerConfigPort,
      configDir: ports.configDir,
      output: ports.output,
    }),
    queryTask: (ports) => createQueryTask({
      runTask: createRunTask({
        sourceResolver: ports.sourceResolver,
        taskSelector: ports.taskSelector,
        workerExecutor: ports.workerExecutor,
        taskVerification: ports.taskVerification,
        taskRepair: ports.taskRepair,
        workingDirectory: ports.workingDirectory,
        fileSystem: ports.fileSystem,
        fileLock: ports.fileLock,
        templateLoader: ports.templateLoader,
        verificationStore: ports.verificationStore,
        artifactStore: ports.artifactStore,
        gitClient: ports.gitClient,
        processRunner: ports.processRunner,
        pathOperations: ports.pathOperations,
        toolResolver: ports.toolResolver,
        memoryResolver: ports.memoryResolver,
        memoryWriter: ports.memoryWriter,
        templateVarsLoader: ports.templateVarsLoader,
        workerConfigPort: ports.workerConfigPort,
        traceWriter: ports.traceWriter,
        cliBlockExecutor: ports.cliBlockExecutor,
        configDir: ports.configDir,
        createTraceWriter: (trace, artifactContext) => {
          if (!trace) {
            return ports.traceWriter;
          }

          return createArtifactTraceWriter(ports, artifactContext);
        },
        output: ports.output,
      }),
      researchTask: createResearchTask({
        workerExecutor: ports.workerExecutor,
        cliBlockExecutor: ports.cliBlockExecutor,
        artifactStore: ports.artifactStore,
        fileSystem: ports.fileSystem,
        fileLock: ports.fileLock,
        workingDirectory: ports.workingDirectory,
        pathOperations: ports.pathOperations,
        memoryResolver: ports.memoryResolver,
        templateLoader: ports.templateLoader,
        templateVarsLoader: ports.templateVarsLoader,
        workerConfigPort: ports.workerConfigPort,
        configDir: ports.configDir,
        output: ports.output,
      }),
      planTask: createPlanTask({
        workerExecutor: ports.workerExecutor,
        workingDirectory: ports.workingDirectory,
        cliBlockExecutor: ports.cliBlockExecutor,
        fileSystem: ports.fileSystem,
        fileLock: ports.fileLock,
        templateLoader: ports.templateLoader,
        pathOperations: ports.pathOperations,
        memoryResolver: ports.memoryResolver,
        templateVarsLoader: ports.templateVarsLoader,
        workerConfigPort: ports.workerConfigPort,
        artifactStore: ports.artifactStore,
        traceWriter: ports.traceWriter,
        configDir: ports.configDir,
        createTraceWriter: (trace, artifactContext) => {
          if (!trace) {
            return ports.traceWriter;
          }

          return createArtifactTraceWriter(ports, artifactContext);
        },
        output: ports.output,
      }),
      artifactStore: ports.artifactStore,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      workingDirectory: ports.workingDirectory,
      output: ports.output,
      templateLoader: ports.templateLoader,
      configDir: ports.configDir,
    }),
    unlockTask: (ports) => createUnlockTask({
      fileLock: ports.fileLock,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    listTasks: (ports) => createListTasks({
      fileSystem: ports.fileSystem,
      sourceResolver: ports.sourceResolver,
      output: ports.output,
    }),
    nextTask: (ports) => createNextTask({
      sourceResolver: ports.sourceResolver,
      taskSelector: ports.taskSelector,
      output: ports.output,
    }),
    discussTask: (ports) => createDiscussTask({
      sourceResolver: ports.sourceResolver,
      taskSelector: ports.taskSelector,
      workerExecutor: ports.workerExecutor,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      fileLock: ports.fileLock,
      templateLoader: ports.templateLoader,
      artifactStore: ports.artifactStore,
      pathOperations: ports.pathOperations,
      memoryResolver: ports.memoryResolver,
      templateVarsLoader: ports.templateVarsLoader,
      workerConfigPort: ports.workerConfigPort,
      traceWriter: ports.traceWriter,
      cliBlockExecutor: ports.cliBlockExecutor,
      configDir: ports.configDir,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createArtifactTraceWriter(ports, artifactContext);
      },
      output: ports.output,
    }),
    logRuns: (ports) => createLogRuns({
      artifactStore: ports.artifactStore,
      configDir: ports.configDir,
      clock: ports.clock,
      output: ports.output,
    }),
    initProject: (ports) => createInitProject({
      fileSystem: ports.fileSystem,
      configDir: ports.configDir,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    manageArtifacts: (ports) => createManageArtifacts({
      artifactStore: ports.artifactStore,
      directoryOpener: ports.directoryOpener,
      configDir: ports.configDir,
      output: ports.output,
    }),
  };
}

function createAppFromFactories(
  ports: AppPorts,
  factoryOverrides: Partial<AppUseCaseFactories> = {},
): App {
  const factories: AppUseCaseFactories = {
    ...createDefaultUseCaseFactories(),
    ...factoryOverrides,
  };

  const helpTask = factories.helpTask(ports);
  const runTask = factories.runTask(ports);
  const discussTask = factories.discussTask(ports);
  const viewMemory = factories.viewMemory(ports);
  const validateMemory = factories.validateMemory(ports);
  const cleanMemory = factories.cleanMemory(ports);
  const reverifyTask = factories.reverifyTask(ports);
  const revertTask = factories.revertTask(ports);
  const undoTask = factories.undoTask(ports);
  const planTask = factories.planTask(ports);
  const researchTask = factories.researchTask(ports);
  const queryTask = factories.queryTask(ports);
  const unlockTask = factories.unlockTask(ports);
  const listTasks = factories.listTasks(ports);
  const nextTask = factories.nextTask(ports);
  const logRuns = factories.logRuns(ports);
  const initProject = factories.initProject(ports);
  const manageArtifacts = factories.manageArtifacts(ports);
  const inFlightRunTasks = new Set<Promise<number>>();

  const trackInFlightRun = (taskRun: Promise<number>): Promise<number> => {
    inFlightRunTasks.add(taskRun);
    void taskRun.finally(() => {
      inFlightRunTasks.delete(taskRun);
    });
    return taskRun;
  };

  return {
    helpTask,
    runTask: (options) => trackInFlightRun(runTask(options)),
    discussTask,
    viewMemory,
    validateMemory,
    cleanMemory,
    reverifyTask,
    revertTask,
    undoTask,
    planTask,
    researchTask,
    queryTask,
    unlockTask,
    listTasks,
    nextTask,
    logRuns,
    initProject,
    manageArtifacts,
    emitOutput: (event) => {
      ports.output.emit(event);
    },
    releaseAllLocks: () => {
      ports.fileLock.releaseAll();
    },
    awaitShutdown: async () => {
      while (inFlightRunTasks.size > 0) {
        await Promise.allSettled([...inFlightRunTasks]);
      }
    },
  };
}

export function createApp(
  dependencies: CreateAppDependencies = {},
): App {
  const portOverrides = dependencies.ports ?? {};
  const useCaseFactoryOverrides = dependencies.useCaseFactories ?? {};
  const ports = createAppPorts(portOverrides);

  return createAppFromFactories(ports, useCaseFactoryOverrides);
}
