import { createRunTask, type RunTaskOptions } from "./application/run-task.js";
import { createPlanTask, type PlanTaskOptions as PlanTaskUseCaseOptions } from "./application/plan-task.js";
import { createListTasks, type ListTasksOptions } from "./application/list-tasks.js";
import { createNextTask, type NextTaskOptions } from "./application/next-task.js";
import { createInitProject } from "./application/init-project.js";
import { createReverifyTask, type ReverifyTaskOptions } from "./application/reverify-task.js";
import { createRevertTask, type RevertTaskOptions } from "./application/revert-task.js";
import {
  createManageArtifacts,
  type ManageArtifactsOptions,
} from "./application/manage-artifacts.js";
import type { ApplicationOutputPort } from "./domain/ports/output-port.js";
import type {
  ArtifactStore,
  Clock,
  DirectoryOpenerPort,
  FileSystem,
  GitClient,
  ProcessRunner,
  PathOperationsPort,
  SourceResolverPort,
  TaskRepairPort,
  TaskSelectorPort,
  TaskVerificationPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  VerificationSidecar,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "./domain/ports/index.js";
import {
  createCrossSpawnProcessRunner,
  createDirectoryOpenerAdapter,
  createExecFileGitClient,
  createFsArtifactStore,
  createFsTemplateLoader,
  createFsVerificationSidecar,
  createFsTemplateVarsLoaderAdapter,
  createJsonlTraceWriter,
  createNodeFileSystem,
  createNoopTraceWriter,
  createNodePathOperationsAdapter,
  createSourceResolverAdapter,
  createSystemClock,
  createTaskRepairAdapter,
  createTaskSelectorAdapter,
  createTaskVerificationAdapter,
  createWorkerExecutorAdapter,
  createWorkingDirectoryAdapter,
} from "./infrastructure/adapters/index.js";

export type App = {
  runTask: (options: RunTaskOptions) => Promise<number>;
  reverifyTask: (options: ReverifyTaskOptions) => Promise<number>;
  revertTask: (options: RevertTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskCommandOptions) => Promise<number>;
  listTasks: (options: ListTasksOptions) => Promise<number>;
  nextTask: (options: NextTaskOptions) => Promise<number>;
  initProject: () => Promise<number>;
  manageArtifacts: (options: ManageArtifactsOptions) => number;
};

export interface PlanTaskCommandOptions {
  source: string;
  scanCount?: number;
  mode: PlanTaskUseCaseOptions["mode"];
  transport: PlanTaskUseCaseOptions["transport"];
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  trace: boolean;
}

export type AppUseCaseFactories = {
  [Key in keyof App]: (ports: AppPorts) => App[Key];
};

export interface AppPorts {
  fileSystem: FileSystem;
  processRunner: ProcessRunner;
  gitClient: GitClient;
  templateLoader: TemplateLoader;
  verificationSidecar: VerificationSidecar;
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
  templateVarsLoader: TemplateVarsLoaderPort;
  traceWriter: TraceWriterPort;
  output: ApplicationOutputPort;
}

export interface CreateAppDependencies {
  ports?: Partial<AppPorts>;
  useCaseFactories?: Partial<AppUseCaseFactories>;
}

function createAppPorts(overrides: Partial<AppPorts> = {}): AppPorts {
  return {
    fileSystem: overrides.fileSystem ?? createNodeFileSystem(),
    processRunner: overrides.processRunner ?? createCrossSpawnProcessRunner(),
    gitClient: overrides.gitClient ?? createExecFileGitClient(),
    templateLoader: overrides.templateLoader ?? createFsTemplateLoader(),
    verificationSidecar: overrides.verificationSidecar ?? createFsVerificationSidecar(),
    artifactStore: overrides.artifactStore ?? createFsArtifactStore(),
    clock: overrides.clock ?? createSystemClock(),
    directoryOpener: overrides.directoryOpener ?? createDirectoryOpenerAdapter(),
    sourceResolver: overrides.sourceResolver ?? createSourceResolverAdapter(),
    taskSelector: overrides.taskSelector ?? createTaskSelectorAdapter(),
    workerExecutor: overrides.workerExecutor ?? createWorkerExecutorAdapter(),
    taskVerification: overrides.taskVerification ?? createTaskVerificationAdapter(),
    taskRepair: overrides.taskRepair ?? createTaskRepairAdapter(),
    workingDirectory: overrides.workingDirectory ?? createWorkingDirectoryAdapter(),
    pathOperations: overrides.pathOperations ?? createNodePathOperationsAdapter(),
    templateVarsLoader: overrides.templateVarsLoader ?? createFsTemplateVarsLoaderAdapter(),
    traceWriter: overrides.traceWriter ?? createNoopTraceWriter(),
    output: overrides.output ?? createNoopOutputPort(),
  };
}

function createNoopOutputPort(): ApplicationOutputPort {
  return {
    emit() {},
  };
}

function createDefaultUseCaseFactories(): AppUseCaseFactories {
  const planTaskUseCase = (ports: AppPorts) => createPlanTask({
    workerExecutor: ports.workerExecutor,
    workingDirectory: ports.workingDirectory,
    fileSystem: ports.fileSystem,
    templateLoader: ports.templateLoader,
    pathOperations: ports.pathOperations,
    templateVarsLoader: ports.templateVarsLoader,
    artifactStore: ports.artifactStore,
    traceWriter: ports.traceWriter,
    createTraceWriter: (trace, artifactContext) => {
      if (!trace) {
        return ports.traceWriter;
      }

      return createJsonlTraceWriter(
        ports.pathOperations.join(artifactContext.rootDir, "trace.jsonl"),
        ports.fileSystem,
      );
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
      templateLoader: ports.templateLoader,
      verificationSidecar: ports.verificationSidecar,
      artifactStore: ports.artifactStore,
      gitClient: ports.gitClient,
      processRunner: ports.processRunner,
      pathOperations: ports.pathOperations,
      templateVarsLoader: ports.templateVarsLoader,
      traceWriter: ports.traceWriter,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createJsonlTraceWriter(
          ports.pathOperations.join(artifactContext.rootDir, "trace.jsonl"),
          ports.fileSystem,
        );
      },
      output: ports.output,
    }),
    reverifyTask: (ports) => createReverifyTask({
      artifactStore: ports.artifactStore,
      taskVerification: ports.taskVerification,
      taskRepair: ports.taskRepair,
      verificationSidecar: ports.verificationSidecar,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      traceWriter: ports.traceWriter,
      createTraceWriter: (trace, artifactContext) => {
        if (!trace) {
          return ports.traceWriter;
        }

        return createJsonlTraceWriter(
          ports.pathOperations.join(artifactContext.rootDir, "trace.jsonl"),
          ports.fileSystem,
        );
      },
      templateLoader: ports.templateLoader,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    revertTask: (ports) => createRevertTask({
      artifactStore: ports.artifactStore,
      gitClient: ports.gitClient,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      pathOperations: ports.pathOperations,
      output: ports.output,
    }),
    planTask: (ports) => planTaskUseCase(ports),
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
    initProject: (ports) => createInitProject({
      fileSystem: ports.fileSystem,
      output: ports.output,
    }),
    manageArtifacts: (ports) => createManageArtifacts({
      artifactStore: ports.artifactStore,
      directoryOpener: ports.directoryOpener,
      workingDirectory: ports.workingDirectory,
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
    reverifyTask: factories.reverifyTask(ports),
    revertTask: factories.revertTask(ports),
    planTask: factories.planTask(ports),
    listTasks: factories.listTasks(ports),
    nextTask: factories.nextTask(ports),
    initProject: factories.initProject(ports),
    manageArtifacts: factories.manageArtifacts(ports),
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
