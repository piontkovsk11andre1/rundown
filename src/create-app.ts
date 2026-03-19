import { createRunTask, type RunTaskOptions } from "./application/run-task.js";
import { createPlanTask, type PlanTaskOptions } from "./application/plan-task.js";
import { createListTasks, type ListTasksOptions } from "./application/list-tasks.js";
import { createNextTask, type NextTaskOptions } from "./application/next-task.js";
import { createInitProject } from "./application/init-project.js";
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
  SourceResolverPort,
  TaskCorrectionPort,
  TaskSelectorPort,
  TaskValidationPort,
  TemplateLoader,
  ValidationSidecar,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "./domain/ports/index.js";
import {
  createCrossSpawnProcessRunner,
  createDirectoryOpenerAdapter,
  createExecFileGitClient,
  createFsArtifactStore,
  createFsTemplateLoader,
  createFsValidationSidecar,
  createNodeFileSystem,
  createSourceResolverAdapter,
  createSystemClock,
  createTaskCorrectionAdapter,
  createTaskSelectorAdapter,
  createTaskValidationAdapter,
  createWorkerExecutorAdapter,
  createWorkingDirectoryAdapter,
} from "./infrastructure/adapters/index.js";

export type App = {
  runTask: (options: RunTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskOptions) => Promise<number>;
  listTasks: (options: ListTasksOptions) => Promise<number>;
  nextTask: (options: NextTaskOptions) => Promise<number>;
  initProject: () => Promise<number>;
  manageArtifacts: (options: ManageArtifactsOptions) => number;
};

export type AppUseCaseFactories = {
  [Key in keyof App]: (ports: AppPorts) => App[Key];
};

export interface AppPorts {
  fileSystem: FileSystem;
  processRunner: ProcessRunner;
  gitClient: GitClient;
  templateLoader: TemplateLoader;
  validationSidecar: ValidationSidecar;
  artifactStore: ArtifactStore;
  clock: Clock;
  directoryOpener: DirectoryOpenerPort;
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  taskValidation: TaskValidationPort;
  taskCorrection: TaskCorrectionPort;
  workingDirectory: WorkingDirectoryPort;
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
    validationSidecar: overrides.validationSidecar ?? createFsValidationSidecar(),
    artifactStore: overrides.artifactStore ?? createFsArtifactStore(),
    clock: overrides.clock ?? createSystemClock(),
    directoryOpener: overrides.directoryOpener ?? createDirectoryOpenerAdapter(),
    sourceResolver: overrides.sourceResolver ?? createSourceResolverAdapter(),
    taskSelector: overrides.taskSelector ?? createTaskSelectorAdapter(),
    workerExecutor: overrides.workerExecutor ?? createWorkerExecutorAdapter(),
    taskValidation: overrides.taskValidation ?? createTaskValidationAdapter(),
    taskCorrection: overrides.taskCorrection ?? createTaskCorrectionAdapter(),
    workingDirectory: overrides.workingDirectory ?? createWorkingDirectoryAdapter(),
    output: overrides.output ?? createNoopOutputPort(),
  };
}

function createNoopOutputPort(): ApplicationOutputPort {
  return {
    emit() {},
  };
}

function createDefaultUseCaseFactories(): AppUseCaseFactories {
  return {
    runTask: (ports) => createRunTask({
      sourceResolver: ports.sourceResolver,
      taskSelector: ports.taskSelector,
      workerExecutor: ports.workerExecutor,
      taskValidation: ports.taskValidation,
      taskCorrection: ports.taskCorrection,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      templateLoader: ports.templateLoader,
      validationSidecar: ports.validationSidecar,
      artifactStore: ports.artifactStore,
      gitClient: ports.gitClient,
      processRunner: ports.processRunner,
      output: ports.output,
    }),
    planTask: (ports) => createPlanTask({
      sourceResolver: ports.sourceResolver,
      taskSelector: ports.taskSelector,
      workerExecutor: ports.workerExecutor,
      workingDirectory: ports.workingDirectory,
      fileSystem: ports.fileSystem,
      templateLoader: ports.templateLoader,
      artifactStore: ports.artifactStore,
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
