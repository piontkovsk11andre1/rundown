import path from "node:path";
import type { Task } from "../domain/parser.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import { requiresWorkerCommand, resolveRunBehavior } from "../domain/run-options.js";
import type { SortMode } from "../domain/sorting.js";
import { resolveSources } from "../infrastructure/sources.js";
import { selectNextTask } from "../infrastructure/selector.js";
import { runWorker, type PromptTransport, type RunnerMode } from "../infrastructure/runner.js";
import { validate, removeValidationFile } from "../infrastructure/validation.js";
import { correct } from "../infrastructure/correction.js";
import { executeInlineCli } from "../infrastructure/inline-cli.js";
import { checkTask } from "../infrastructure/checkbox-io.js";
import { loadTemplateVarsFile } from "../infrastructure/template-vars-io.js";
import { isGitRepo, commitCheckedTask } from "../infrastructure/git.js";
import { runOnCompleteHook } from "../infrastructure/hooks.js";
import { loadProjectTemplates } from "../infrastructure/templates-loader.js";
import {
  createRuntimeArtifactsContext,
  displayArtifactsPath,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
  type RuntimeTaskMetadata,
} from "../infrastructure/runtime-artifacts.js";
import * as log from "../presentation/log.js";

export interface RunTaskOptions {
  source: string;
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  verify: boolean;
  onlyVerify: boolean;
  noRepair: boolean;
  retries: number;
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

export async function runTask(options: RunTaskOptions): Promise<number> {
  const {
    source,
    mode,
    transport,
    sortMode,
    verify,
    onlyVerify,
    noRepair,
    retries,
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
    retries,
  });
  const shouldValidate = runBehavior.shouldValidate;
  const onlyValidate = runBehavior.onlyValidate;
  const allowCorrection = runBehavior.allowCorrection;
  const maxRetries = runBehavior.maxRetries;

  const varsFilePath = resolveTemplateVarsFilePath(varsFileOption);
  const fileTemplateVars = varsFilePath
    ? loadTemplateVarsFile(varsFilePath)
    : {};
  const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
  const extraTemplateVars: ExtraTemplateVars = {
    ...fileTemplateVars,
    ...cliTemplateVars,
  };

  let artifactContext: RuntimeArtifactsContext | null = null;
  let artifactsFinalized = false;

  const finalizeArtifacts = (status: string, preserve: boolean = keepArtifacts): void => {
    if (!artifactContext || artifactsFinalized) {
      return;
    }

    finalizeRunArtifacts(artifactContext, preserve, status);
    artifactsFinalized = true;
  };

  const finishRun = (code: number, status: string, preserve: boolean = keepArtifacts): number => {
    finalizeArtifacts(status, preserve);
    return code;
  };

  try {
    const files = await resolveSources(source);
    if (files.length === 0) {
      log.warn("No Markdown files found matching: " + source);
      return 3;
    }

    const result = selectNextTask(files, sortMode);
    if (!result) {
      log.info("No unchecked tasks found.");
      return 3;
    }

    const { task, source: fileSource, contextBefore } = result;
    log.info("Next task: " + log.taskLabel(task));
    const automationCommand = getAutomationWorkerCommand(workerCommand, mode);

    const templates = loadProjectTemplates();
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
      console.log(validationPrompt);
      return 0;
    }

    if (dryRun && onlyValidate) {
      log.info("Dry run — would run verification with: " + automationCommand.join(" "));
      log.info("Prompt length: " + validationPrompt.length + " chars");
      return 0;
    }

    if (requiresWorkerCommand({
      workerCommand,
      isInlineCli: task.isInlineCli,
      shouldValidate,
      onlyValidate,
    })) {
      log.error("No worker command specified. Use --worker <command...> or -- <command>.");
      return 1;
    }

    if (!onlyValidate && !task.isInlineCli) {
      if (printPrompt) {
        console.log(prompt);
        return 0;
      }

      if (dryRun) {
        log.info("Dry run — would run: " + workerCommand.join(" "));
        log.info("Prompt length: " + prompt.length + " chars");
        return 0;
      }
    }

    if (!onlyValidate && task.isInlineCli && dryRun) {
      log.info("Dry run — would execute inline CLI: " + task.cliCommand!);
      return 0;
    }

    artifactContext = createRuntimeArtifactsContext({
      cwd: process.cwd(),
      commandName: "run",
      workerCommand: onlyValidate ? automationCommand : workerCommand,
      mode,
      transport,
      source,
      task: toRuntimeTaskMetadata(task, fileSource),
      keepArtifacts,
    });

    if (onlyValidate) {
      log.info("Only verify mode — skipping task execution.");

      const valid = await runValidation(
        task,
        fileSource,
        contextBefore,
        templates,
        automationCommand,
        transport,
        maxRetries,
        allowCorrection,
        extraTemplateVars,
        artifactContext,
      );
      if (!valid) {
        log.error("Verification failed after all retries. Task not checked.");
        return finishRun(2, "verification-failed");
      }

      checkTask(task);
      log.success("Task checked: " + task.text);
      await afterTaskComplete(task, source, commitAfterComplete, commitMessageTemplate, onCompleteCommand);
      return finishRun(0, "completed");
    }

    if (task.isInlineCli) {
      const inlineCliCwd = path.dirname(path.resolve(task.file));
      log.info("Executing inline CLI: " + task.cliCommand! + " [cwd=" + inlineCliCwd + "]");
      const cliResult = await executeInlineCli(task.cliCommand!, inlineCliCwd, {
        artifactContext,
        keepArtifacts,
        artifactExtra: { taskType: "inline-cli" },
      });

      if (cliResult.stdout) process.stdout.write(cliResult.stdout);
      if (cliResult.stderr) process.stderr.write(cliResult.stderr);

      if (cliResult.exitCode !== 0) {
        log.error("Inline CLI exited with code " + cliResult.exitCode);
        return finishRun(1, "execution-failed");
      }

      if (shouldValidate) {
        const valid = await runValidation(
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          transport,
          maxRetries,
          allowCorrection,
          extraTemplateVars,
          artifactContext,
        );
        if (!valid) {
          log.error("Verification failed. Task not checked.");
          return finishRun(2, "verification-failed");
        }
      }

      checkTask(task);
      log.success("Task checked: " + task.text);
      await afterTaskComplete(task, source, commitAfterComplete, commitMessageTemplate, onCompleteCommand);
      return finishRun(0, "completed");
    }

    log.info("Running: " + workerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]");
    const runResult = await runWorker({
      command: workerCommand,
      prompt,
      mode,
      transport,
      cwd: process.cwd(),
      artifactContext,
      artifactPhase: "execute",
    });

    if (mode === "wait") {
      if (runResult.stdout) process.stdout.write(runResult.stdout);
      if (runResult.stderr) process.stderr.write(runResult.stderr);
    }

    if (mode !== "detached" && runResult.exitCode !== 0 && runResult.exitCode !== null) {
      log.error("Worker exited with code " + runResult.exitCode + ".");
      return finishRun(1, "execution-failed");
    }

    if (mode === "detached") {
      log.info("Detached mode — skipping immediate verification and leaving the task unchecked.");
      return finishRun(0, "detached", true);
    }

    if (shouldValidate) {
      const valid = await runValidation(
        task,
        fileSource,
        contextBefore,
        templates,
        automationCommand,
        transport,
        maxRetries,
        allowCorrection,
        extraTemplateVars,
        artifactContext,
      );
      if (!valid) {
        log.error("Verification failed after all retries. Task not checked.");
        return finishRun(2, "verification-failed");
      }
    }

    checkTask(task);
    log.success("Task checked: " + task.text);
    await afterTaskComplete(task, source, commitAfterComplete, commitMessageTemplate, onCompleteCommand);
    return finishRun(0, "completed");
  } catch (error) {
    finalizeArtifacts("failed", keepArtifacts || mode === "detached");
    throw error;
  }
}

async function runValidation(
  task: Parameters<typeof validate>[0]["task"],
  fileSource: string,
  contextBefore: string,
  templates: { validate: string; correct: string },
  workerCommand: string[],
  transport: PromptTransport,
  maxRetries: number,
  allowCorrection: boolean,
  extraTemplateVars: ExtraTemplateVars,
  artifactContext: RuntimeArtifactsContext,
): Promise<boolean> {
  log.info("Running verification…");

  const valid = await validate({
    task,
    source: fileSource,
    contextBefore,
    template: templates.validate,
    command: workerCommand,
    mode: "wait",
    transport,
    templateVars: extraTemplateVars,
    artifactContext,
  });

  if (valid) {
    removeValidationFile(task);
    log.success("Verification passed.");
    return true;
  }

  if (allowCorrection) {
    log.warn("Verification failed. Running repair (" + maxRetries + " retries)…");
    const result = await correct({
      task,
      source: fileSource,
      contextBefore,
      correctTemplate: templates.correct,
      validateTemplate: templates.validate,
      command: workerCommand,
      maxRetries,
      mode: "wait",
      transport,
      templateVars: extraTemplateVars,
      artifactContext,
    });

    if (result.valid) {
      removeValidationFile(task);
      log.success("Repair succeeded after " + result.attempts + " attempt(s).");
      return true;
    }
  }

  return false;
}

async function afterTaskComplete(
  task: Parameters<typeof checkTask>[0],
  source: string,
  commit: boolean,
  commitMessageTemplate: string | undefined,
  onCompleteCommand: string | undefined,
): Promise<void> {
  const cwd = process.cwd();

  if (commit) {
    try {
      const inGitRepo = await isGitRepo(cwd);
      if (!inGitRepo) {
        log.warn("--commit: not inside a git repository, skipping.");
      } else {
        const message = await commitCheckedTask({
          task: task.text,
          file: task.file,
          line: task.line,
          index: task.index,
          cwd,
          messageTemplate: commitMessageTemplate,
        });
        log.success("Committed: " + message);
      }
    } catch (error) {
      log.warn("--commit failed: " + String(error));
    }
  }

  if (onCompleteCommand) {
    try {
      const result = await runOnCompleteHook({
        command: onCompleteCommand,
        taskInfo: {
          task: task.text,
          file: task.file,
          line: task.line,
          index: task.index,
        },
        source,
        cwd,
      });

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);

      if (!result.success) {
        log.warn("--on-complete hook exited with code " + result.exitCode);
      }
    } catch (error) {
      log.warn("--on-complete hook failed: " + String(error));
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
  artifactContext: RuntimeArtifactsContext,
  preserve: boolean,
  status: string,
): void {
  finalizeRuntimeArtifacts(artifactContext, { status, preserve });

  if (preserve) {
    log.info("Runtime artifacts saved at " + displayArtifactsPath(artifactContext) + ".");
  }
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
