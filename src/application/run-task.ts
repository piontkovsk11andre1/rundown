import path from "node:path";
import {
  DEFAULT_CORRECT_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VALIDATE_TEMPLATE,
} from "../domain/defaults.js";
import { markChecked } from "../domain/checkbox.js";
import type { Task } from "../domain/parser.js";
import type { SortMode } from "../domain/sorting.js";
import { requiresWorkerCommand, resolveRunBehavior } from "../domain/run-options.js";
import { classifyTaskIntent } from "../domain/task-intent.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import type {
  ArtifactStoreStatus,
  ArtifactStore,
  FileSystem,
  GitClient,
  ProcessRunMode,
  ProcessRunner,
  PromptTransport as PortPromptTransport,
  SourceResolverPort,
  TaskCorrectionPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
  TaskValidationPort,
  TemplateLoader,
  ValidationSidecar,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type RunnerMode = ProcessRunMode;
export type PromptTransport = PortPromptTransport;
type ArtifactContext = any;

interface ProjectTemplates {
  task: string;
  validate: string;
  correct: string;
  plan: string;
}

export type TaskSelectionResult = PortTaskSelectionResult;

export interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

export interface RunTaskDependencies {
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  taskValidation: TaskValidationPort;
  taskCorrection: TaskCorrectionPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  templateLoader: TemplateLoader;
  validationSidecar: ValidationSidecar;
  artifactStore: ArtifactStore;
  gitClient: GitClient;
  processRunner: ProcessRunner;
  output: ApplicationOutputPort;
}

export interface RunTaskOptions {
  source: string;
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  verify: boolean;
  onlyVerify: boolean;
  forceExecute: boolean;
  noRepair: boolean;
  repairAttempts: number;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  commitAfterComplete: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
}

export function createRunTask(
  dependencies: RunTaskDependencies,
): (options: RunTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function runTask(options: RunTaskOptions): Promise<number> {
    const {
      source,
      mode,
      transport,
      sortMode,
      verify,
      onlyVerify,
      forceExecute,
      noRepair,
      repairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      commitAfterComplete,
      commitMessageTemplate,
      onCompleteCommand,
    } = options;

    const runBehavior = resolveRunBehavior({
      validate: verify,
      onlyValidate: onlyVerify,
      noCorrect: noRepair,
      repairAttempts,
    });
    const configuredShouldValidate = runBehavior.shouldValidate;
    const configuredOnlyValidate = runBehavior.onlyValidate;
    const allowCorrection = runBehavior.allowCorrection;
    const maxRepairAttempts = runBehavior.maxRepairAttempts;

    const varsFilePath = resolveTemplateVarsFilePath(varsFileOption);
    const fileTemplateVars = varsFilePath
      ? loadTemplateVarsFileFromPorts(varsFilePath, dependencies.workingDirectory.cwd(), dependencies.fileSystem)
      : {};
    const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
    const extraTemplateVars: ExtraTemplateVars = {
      ...fileTemplateVars,
      ...cliTemplateVars,
    };

    let artifactContext: ArtifactContext | null = null;
    let artifactsFinalized = false;

    const finalizeArtifacts = (status: ArtifactStoreStatus, preserve: boolean = keepArtifacts): void => {
      if (!artifactContext || artifactsFinalized) {
        return;
      }

       finalizeRunArtifacts(dependencies.artifactStore, artifactContext, preserve, status, emit);
       artifactsFinalized = true;
     };

    const finishRun = (code: number, status: ArtifactStoreStatus, preserve: boolean = keepArtifacts): number => {
      finalizeArtifacts(status, preserve);
      return code;
    };

    try {
      const files = await dependencies.sourceResolver.resolveSources(source);
      if (files.length === 0) {
        emit({ kind: "warn", message: "No Markdown files found matching: " + source });
        return 3;
      }

      const result = dependencies.taskSelector.selectNextTask(files, sortMode);
      if (!result) {
        emit({ kind: "info", message: "No unchecked tasks found." });
        return 3;
      }

      const { task, source: fileSource, contextBefore } = result;
      emit({ kind: "info", message: "Next task: " + formatTaskLabel(task) });
      const automationCommand = getAutomationWorkerCommand(workerCommand, mode);

      const taskIntent = classifyTaskIntent(task.text);
      const shouldUseVerifyOnly = configuredOnlyValidate
        || (taskIntent.intent === "verify-only" && !forceExecute);
      const shouldValidate = configuredShouldValidate || shouldUseVerifyOnly;
      const onlyValidate = shouldUseVerifyOnly;

      if (!configuredOnlyValidate && taskIntent.intent === "verify-only") {
        if (forceExecute) {
          emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "), but --force-execute is enabled; running execution." });
        } else {
          emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "); skipping execution." });
        }
      }

      const templates = loadProjectTemplatesFromPorts(
        dependencies.workingDirectory.cwd(),
        dependencies.templateLoader,
      );
      const vars: TemplateVars = {
        ...extraTemplateVars,
        task: task.text,
        file: task.file,
        context: contextBefore,
        taskIndex: task.index,
        taskLine: task.line,
        source: fileSource,
      };

      const prompt = renderTemplate(templates.task, vars);
      const validationPrompt = shouldValidate
        ? renderTemplate(templates.validate, vars)
        : "";

      if (printPrompt && onlyValidate) {
        emit({ kind: "text", text: validationPrompt });
        return 0;
      }

      if (dryRun && onlyValidate) {
        emit({ kind: "info", message: "Dry run — would run verification with: " + automationCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + validationPrompt.length + " chars" });
        return 0;
      }

      if (requiresWorkerCommand({
        workerCommand,
        isInlineCli: task.isInlineCli,
        shouldValidate,
        onlyValidate,
      })) {
        emit({ kind: "error", message: "No worker command specified. Use --worker <command...> or -- <command>." });
        return 1;
      }

      if (!onlyValidate && !task.isInlineCli) {
        if (printPrompt) {
          emit({ kind: "text", text: prompt });
          return 0;
        }

        if (dryRun) {
          emit({ kind: "info", message: "Dry run — would run: " + workerCommand.join(" ") });
          emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
          return 0;
        }
      }

      if (!onlyValidate && task.isInlineCli && dryRun) {
        emit({ kind: "info", message: "Dry run — would execute inline CLI: " + task.cliCommand! });
        return 0;
      }

         artifactContext = dependencies.artifactStore.createContext({
         cwd: dependencies.workingDirectory.cwd(),
         commandName: "run",
         workerCommand: onlyValidate ? automationCommand : workerCommand,
        mode,
        transport,
        source,
        task: toRuntimeTaskMetadata(task, fileSource),
        keepArtifacts,
      });

      if (onlyValidate) {
        emit({ kind: "info", message: configuredOnlyValidate
          ? "Only verify mode — skipping task execution."
          : "Verify-only task mode — skipping task execution."
        });

        const valid = await runValidation(
          dependencies,
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          transport,
          maxRepairAttempts,
          allowCorrection,
          extraTemplateVars,
          artifactContext,
        );
        if (!valid) {
          emit({ kind: "error", message: "Verification failed after all repair attempts. Task not checked." });
          return finishRun(2, "verification-failed");
        }

        checkTaskUsingFileSystem(task, dependencies.fileSystem);
        emit({ kind: "success", message: "Task checked: " + task.text });
        await afterTaskComplete(
          dependencies,
          task,
          source,
          commitAfterComplete,
          commitMessageTemplate,
          onCompleteCommand,
        );
        return finishRun(0, "completed");
      }

      if (task.isInlineCli) {
        const inlineCliCwd = path.dirname(path.resolve(task.file));
        emit({ kind: "info", message: "Executing inline CLI: " + task.cliCommand! + " [cwd=" + inlineCliCwd + "]" });
        const cliResult = await dependencies.workerExecutor.executeInlineCli(task.cliCommand!, inlineCliCwd, {
          artifactContext,
          keepArtifacts,
          artifactExtra: { taskType: "inline-cli" },
        });

        if (cliResult.stdout) emit({ kind: "text", text: cliResult.stdout });
        if (cliResult.stderr) emit({ kind: "stderr", text: cliResult.stderr });

        if (cliResult.exitCode !== 0) {
          emit({ kind: "error", message: "Inline CLI exited with code " + cliResult.exitCode });
          return finishRun(1, "execution-failed");
        }

        if (shouldValidate) {
          const valid = await runValidation(
            dependencies,
            task,
            fileSource,
            contextBefore,
            templates,
            automationCommand,
            transport,
            maxRepairAttempts,
            allowCorrection,
            extraTemplateVars,
            artifactContext,
          );
          if (!valid) {
            emit({ kind: "error", message: "Verification failed. Task not checked." });
            return finishRun(2, "verification-failed");
          }
        }

        checkTaskUsingFileSystem(task, dependencies.fileSystem);
        emit({ kind: "success", message: "Task checked: " + task.text });
        await afterTaskComplete(
          dependencies,
          task,
          source,
          commitAfterComplete,
          commitMessageTemplate,
          onCompleteCommand,
        );
        return finishRun(0, "completed");
      }

      emit({ kind: "info", message: "Running: " + workerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]" });
      const runResult = await dependencies.workerExecutor.runWorker({
        command: workerCommand,
        prompt,
        mode,
        transport,
        cwd: dependencies.workingDirectory.cwd(),
        artifactContext,
        artifactPhase: "execute",
      });

      if (mode === "wait") {
        if (runResult.stdout) emit({ kind: "text", text: runResult.stdout });
        if (runResult.stderr) emit({ kind: "stderr", text: runResult.stderr });
      }

      if (mode !== "detached" && runResult.exitCode !== 0 && runResult.exitCode !== null) {
        emit({ kind: "error", message: "Worker exited with code " + runResult.exitCode + "." });
        return finishRun(1, "execution-failed");
      }

      if (mode === "detached") {
        emit({ kind: "info", message: "Detached mode — skipping immediate verification and leaving the task unchecked." });
        return finishRun(0, "detached", true);
      }

      if (shouldValidate) {
        const valid = await runValidation(
          dependencies,
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          transport,
          maxRepairAttempts,
          allowCorrection,
          extraTemplateVars,
          artifactContext,
        );
        if (!valid) {
          emit({ kind: "error", message: "Verification failed after all repair attempts. Task not checked." });
          return finishRun(2, "verification-failed");
        }
      }

      checkTaskUsingFileSystem(task, dependencies.fileSystem);
      emit({ kind: "success", message: "Task checked: " + task.text });
      await afterTaskComplete(
        dependencies,
        task,
        source,
        commitAfterComplete,
        commitMessageTemplate,
        onCompleteCommand,
      );
      return finishRun(0, "completed");
    } catch (error) {
      finalizeArtifacts("failed", keepArtifacts || mode === "detached");
      throw error;
    }
  };
}

async function runValidation(
  dependencies: RunTaskDependencies,
  task: Task,
  fileSource: string,
  contextBefore: string,
  templates: { validate: string; correct: string },
  workerCommand: string[],
  transport: PromptTransport,
  maxRepairAttempts: number,
  allowCorrection: boolean,
  extraTemplateVars: ExtraTemplateVars,
  artifactContext: ArtifactContext,
): Promise<boolean> {
  return runVerifyRepairLoop({
    taskValidation: dependencies.taskValidation,
    taskCorrection: dependencies.taskCorrection,
    validationSidecar: dependencies.validationSidecar,
    output: dependencies.output,
  }, {
    task,
    source: fileSource,
    contextBefore,
    validateTemplate: templates.validate,
    correctTemplate: templates.correct,
    workerCommand,
    transport,
    maxRepairAttempts,
    allowCorrection,
    templateVars: extraTemplateVars,
    artifactContext,
  });
}

async function afterTaskComplete(
  dependencies: RunTaskDependencies,
  task: Task,
  source: string,
  commit: boolean,
  commitMessageTemplate: string | undefined,
  onCompleteCommand: string | undefined,
): Promise<void> {
  const cwd = dependencies.workingDirectory.cwd();
  const emit = dependencies.output.emit.bind(dependencies.output);

  if (commit) {
    try {
      const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
      if (!inGitRepo) {
        emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
      } else {
        const message = buildCommitMessage(task, cwd, commitMessageTemplate);
        await commitCheckedTaskWithGitClient(dependencies.gitClient, task, cwd, message);
        emit({ kind: "success", message: "Committed: " + message });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--commit failed: " + String(error) });
    }
  }

  if (onCompleteCommand) {
    try {
      const result = await runOnCompleteHookWithProcessRunner(
        dependencies.processRunner,
        onCompleteCommand,
        task,
        source,
        cwd,
      );

      if (result.stdout) emit({ kind: "text", text: result.stdout });
      if (result.stderr) emit({ kind: "stderr", text: result.stderr });

      if (!result.success) {
        emit({ kind: "warn", message: "--on-complete hook exited with code " + result.exitCode });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--on-complete hook failed: " + String(error) });
    }
  }
}

export function getAutomationWorkerCommand(
  workerCommand: string[],
  mode: RunnerMode,
): string[] {
  if (mode !== "tui") {
    return workerCommand;
  }

  if (!isOpenCodeWorkerCommand(workerCommand)) {
    return workerCommand;
  }

  return workerCommand.length > 1
    ? workerCommand
    : [workerCommand[0], "run"];
}

export function finalizeRunArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactContext,
  preserve: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
): void {
  artifactStore.finalize(artifactContext, { status, preserve });

  if (preserve) {
    emit({ kind: "info", message: "Runtime artifacts saved at " + artifactStore.displayPath(artifactContext) + "." });
  }
}

const TEMPLATE_VAR_KEY = /^[A-Za-z_]\w*$/;
const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "rundown: complete \"{{task}}\" in {{file}}";

function loadTemplateVarsFileFromPorts(
  filePath: string,
  cwd: string,
  fileSystem: FileSystem,
): ExtraTemplateVars {
  const resolvedPath = path.resolve(cwd, filePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readText(resolvedPath));
  } catch (error) {
    throw new Error(`Failed to read template vars file \"${filePath}\": ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Template vars file \"${filePath}\" must contain a JSON object.`);
  }

  const vars: ExtraTemplateVars = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!TEMPLATE_VAR_KEY.test(key)) {
      throw new Error(`Invalid template variable name \"${key}\" in \"${filePath}\". Use letters, numbers, and underscores only.`);
    }

    if (value === null || value === undefined) {
      vars[key] = "";
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      vars[key] = String(value);
      continue;
    }

    throw new Error(`Template variable \"${key}\" in \"${filePath}\" must be a string, number, boolean, or null.`);
  }

  return vars;
}

function loadProjectTemplatesFromPorts(cwd: string, templateLoader: TemplateLoader): ProjectTemplates {
  const dir = path.join(cwd, ".rundown");
  return {
    task: templateLoader.load(path.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    validate: templateLoader.load(path.join(dir, "verify.md")) ?? DEFAULT_VALIDATE_TEMPLATE,
    correct: templateLoader.load(path.join(dir, "repair.md")) ?? DEFAULT_CORRECT_TEMPLATE,
    plan: templateLoader.load(path.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
  };
}

function checkTaskUsingFileSystem(task: Task, fileSystem: FileSystem): void {
  const source = fileSystem.readText(task.file);
  const updated = markChecked(source, task);
  fileSystem.writeText(task.file, updated);
}

async function isGitRepoWithGitClient(gitClient: GitClient, cwd: string): Promise<boolean> {
  try {
    await gitClient.run(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function commitCheckedTaskWithGitClient(
  gitClient: GitClient,
  task: Task,
  cwd: string,
  message: string,
): Promise<void> {
  // Stage full worktree output for the task, but skip transient runtime artifacts.
  await gitClient.run(["add", "-A", "--", ".", ":(exclude).rundown/runs/**"], cwd);
  await gitClient.run(["commit", "-m", message], cwd);
}

function buildCommitMessage(
  task: Task,
  cwd: string,
  messageTemplate: string | undefined,
): string {
  const relativePath = path.relative(cwd, task.file).replace(/\\/g, "/");
  return renderTemplate(messageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE, {
    task: task.text,
    file: relativePath,
    context: "",
    taskIndex: task.index,
    taskLine: task.line,
    source: "",
  });
}

async function runOnCompleteHookWithProcessRunner(
  processRunner: ProcessRunner,
  command: string,
  task: Task,
  source: string,
  cwd: string,
): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  try {
    const result = await processRunner.run({
      command,
      args: [],
      cwd,
      mode: "wait",
      shell: true,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        RUNDOWN_TASK: task.text,
        RUNDOWN_FILE: path.resolve(task.file),
        RUNDOWN_LINE: String(task.line),
        RUNDOWN_INDEX: String(task.index),
        RUNDOWN_SOURCE: source,
      },
    });

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      success: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatTaskLabel(task: Task): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

export function toRuntimeTaskMetadata(
  task: Task,
  source: string,
): RuntimeTaskMetadata {
  return {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source,
  };
}

export function isOpenCodeWorkerCommand(workerCommand: string[]): boolean {
  if (workerCommand.length === 0) {
    return false;
  }

  const command = workerCommand[0].toLowerCase();
  return command === "opencode"
    || command.endsWith("/opencode")
    || command.endsWith("\\opencode")
    || command.endsWith("/opencode.cmd")
    || command.endsWith("\\opencode.cmd")
    || command.endsWith("/opencode.exe")
    || command.endsWith("\\opencode.exe")
    || command.endsWith("/opencode.ps1")
    || command.endsWith("\\opencode.ps1");
}

export const runTask = createRunTask;
