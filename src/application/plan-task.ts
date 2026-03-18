import { renderTemplate, type TemplateVars } from "../domain/template.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import type { SortMode } from "../domain/sorting.js";
import { loadProjectTemplates } from "../infrastructure/templates-loader.js";
import { resolveSources } from "../infrastructure/sources.js";
import {
  selectNextTask,
  selectTaskByLocation,
  type SelectionResult,
} from "../infrastructure/selector.js";
import { runWorker, type PromptTransport, type RunnerMode } from "../infrastructure/runner.js";
import { applyPlannerOutput } from "../infrastructure/planner-io.js";
import { loadTemplateVarsFile } from "../infrastructure/template-vars-io.js";
import {
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
} from "../infrastructure/runtime-artifacts.js";
import * as log from "../presentation/log.js";

export interface PlanTaskOptions {
  source: string;
  at?: string;
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
}

export async function planTask(options: PlanTaskOptions): Promise<number> {
  const {
    source,
    at,
    mode,
    transport,
    sortMode,
    dryRun,
    printPrompt,
    keepArtifacts,
    varsFileOption,
    cliTemplateVarArgs,
    workerCommand,
  } = options;

  const varsFilePath = resolveTemplateVarsFilePath(varsFileOption);
  const fileTemplateVars = varsFilePath
    ? loadTemplateVarsFile(varsFilePath)
    : {};
  const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
  const extraTemplateVars: ExtraTemplateVars = {
    ...fileTemplateVars,
    ...cliTemplateVars,
  };

  const selection = await selectPlanTask(source, at, sortMode);
  if (!selection.result) {
    return selection.exitCode;
  }

  const { task, source: fileSource, contextBefore } = selection.result;
  log.info("Planning task: " + log.taskLabel(task));

  if (workerCommand.length === 0) {
    log.error("No worker command specified. Use --worker <command...> or -- <command>.");
    return 1;
  }

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

  const prompt = renderTemplate(templates.plan, vars);

  if (printPrompt) {
    console.log(prompt);
    return 0;
  }

  if (dryRun) {
    log.info("Dry run — would plan: " + workerCommand.join(" "));
    log.info("Prompt length: " + prompt.length + " chars");
    return 0;
  }

  const artifactContext = createRuntimeArtifactsContext({
    cwd: process.cwd(),
    commandName: "plan",
    workerCommand,
    mode,
    transport,
    source,
    task: {
      text: task.text,
      file: task.file,
      line: task.line,
      index: task.index,
      source: fileSource,
    },
    keepArtifacts,
  });
  let artifactsFinalized = false;
  let artifactStatus = "running";

  const finishPlan = (code: number, status: string): number => {
    artifactStatus = status;
    finalizeRuntimeArtifacts(artifactContext, { status: artifactStatus, preserve: keepArtifacts });
    artifactsFinalized = true;
    return code;
  };

  try {
    log.info("Running planner: " + workerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]");
    const runResult = await runWorker({
      command: workerCommand,
      prompt,
      mode,
      transport,
      cwd: process.cwd(),
      artifactContext,
      artifactPhase: "plan",
    });

    if (mode === "wait" && runResult.stderr) {
      process.stderr.write(runResult.stderr);
    }

    if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
      log.error("Planner worker exited with code " + runResult.exitCode + ".");
      return finishPlan(1, "execution-failed");
    }

    if (!runResult.stdout || runResult.stdout.trim().length === 0) {
      log.warn("Planner produced no output. No subtasks created.");
      return finishPlan(0, "completed");
    }

    const count = applyPlannerOutput(task, runResult.stdout);
    if (count === 0) {
      log.warn("Planner output contained no valid task items. No subtasks created.");
      return finishPlan(0, "completed");
    }

    log.success("Inserted " + count + " subtask" + (count === 1 ? "" : "s") + " under: " + task.text);
    return finishPlan(0, "completed");
  } finally {
    if (!artifactsFinalized) {
      finalizeRuntimeArtifacts(artifactContext, { status: artifactStatus, preserve: keepArtifacts });
      artifactsFinalized = true;
    }
  }
}

async function selectPlanTask(
  source: string,
  at: string | undefined,
  sortMode: SortMode,
): Promise<{ result: SelectionResult | null; exitCode: number }> {
  if (at) {
    const parsed = parseTaskLocation(at);
    if (parsed.kind === "invalid-format") {
      log.error("Invalid --at format. Expected file:line (e.g. roadmap.md:12).");
      return { result: null, exitCode: 1 };
    }

    if (parsed.kind === "invalid-line") {
      log.error("Invalid line number in --at: " + parsed.lineRaw);
      return { result: null, exitCode: 1 };
    }

    const { filePath, lineNum } = parsed;
    const selected = selectTaskByLocation(filePath, lineNum);
    if (!selected) {
      log.error("No task found at " + filePath + ":" + lineNum);
      return { result: null, exitCode: 3 };
    }

    return { result: selected, exitCode: 0 };
  }

  const files = await resolveSources(source);
  if (files.length === 0) {
    log.warn("No Markdown files found matching: " + source);
    return { result: null, exitCode: 3 };
  }

  const selected = selectNextTask(files, sortMode);
  if (!selected) {
    log.info("No unchecked tasks found.");
    return { result: null, exitCode: 3 };
  }

  return { result: selected, exitCode: 0 };
}

function parseTaskLocation(
  value: string,
):
  | { kind: "ok"; filePath: string; lineNum: number }
  | { kind: "invalid-format" }
  | { kind: "invalid-line"; lineRaw: string } {
  const colonIdx = value.lastIndexOf(":");
  if (colonIdx === -1) {
    return { kind: "invalid-format" };
  }

  const filePath = value.slice(0, colonIdx);
  const lineRaw = value.slice(colonIdx + 1);
  const lineNum = Number.parseInt(lineRaw, 10);
  if (!Number.isFinite(lineNum) || lineNum < 1) {
    return { kind: "invalid-line", lineRaw };
  }

  return { kind: "ok", filePath, lineNum };
}
