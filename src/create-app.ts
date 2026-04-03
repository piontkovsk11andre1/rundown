import { createRunTask, type RunTaskOptions } from "./application/run-task.js";
import { createDiscussTask, type DiscussTaskOptions } from "./application/discuss-task.js";
import { createPlanTask, type PlanTaskOptions as PlanTaskUseCaseOptions } from "./application/plan-task.js";
import { createResearchTask, type ResearchTaskOptions as ResearchTaskUseCaseOptions } from "./application/research-task.js";
import { createListTasks, type ListTasksOptions } from "./application/list-tasks.js";
import { createNextTask, type NextTaskOptions } from "./application/next-task.js";
import { createUnlockTask, type UnlockTaskOptions } from "./application/unlock-task.js";
import { createInitProject } from "./application/init-project.js";
import { createReverifyTask, type ReverifyTaskOptions } from "./application/reverify-task.js";
import { createRevertTask, type RevertTaskOptions } from "./application/revert-task.js";
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
  MemoryResolverPort,
  MemoryWriterPort,
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
  createMemoryWriterAdapter,
  createMemoryResolverAdapter,
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

export type App = {
  runTask: (options: RunTaskOptions) => Promise<number>;
  discussTask: (options: DiscussTaskOptions) => Promise<number>;
  reverifyTask: (options: ReverifyTaskOptions) => Promise<number>;
  revertTask: (options: RevertTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskCommandOptions) => Promise<number>;
  researchTask: (options: ResearchTaskCommandOptions) => Promise<number>;
  unlockTask: (options: UnlockTaskOptions) => Promise<number>;
  listTasks: (options: ListTasksOptions) => Promise<number>;
  nextTask: (options: NextTaskOptions) => Promise<number>;
  logRuns: (options: LogRunsOptions) => number;
  initProject: () => Promise<number>;
  manageArtifacts: (options: ManageArtifactsOptions) => number;
  releaseAllLocks?: () => void;
};

export interface PlanTaskCommandOptions {
  source: string;
  scanCount?: number;
  mode: PlanTaskUseCaseOptions["mode"];
  transport: PlanTaskUseCaseOptions["transport"];
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

export interface ResearchTaskCommandOptions {
  source: string;
  mode: ResearchTaskUseCaseOptions["mode"];
  transport: ResearchTaskUseCaseOptions["transport"];
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  configDirOption?: string;
}

export type AppUseCaseFactories = {
  [Key in Exclude<keyof App, "releaseAllLocks">]: (ports: AppPorts) => App[Key];
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
  const memoryResolver = overrides.memoryResolver ?? createMemoryResolverAdapter({
    fileSystem,
    pathOperations,
  });
  const memoryWriter = overrides.memoryWriter ?? createMemoryWriterAdapter({
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
    memoryResolver,
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
    planTask: (ports) => planTaskUseCase(ports),
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

  return {
    runTask: factories.runTask(ports),
    discussTask: factories.discussTask(ports),
    reverifyTask: factories.reverifyTask(ports),
    revertTask: factories.revertTask(ports),
    planTask: factories.planTask(ports),
    researchTask: factories.researchTask(ports),
    unlockTask: factories.unlockTask(ports),
    listTasks: factories.listTasks(ports),
    nextTask: factories.nextTask(ports),
    logRuns: factories.logRuns(ports),
    initProject: factories.initProject(ports),
    manageArtifacts: factories.manageArtifacts(ports),
    releaseAllLocks: () => {
      ports.fileLock.releaseAll();
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
