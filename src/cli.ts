/**
 * md-todo CLI
 *
 * A Markdown-native task runtime for agentic workflows.
 */

import { Command } from "commander";
import { spawn } from "node:child_process";
import { resolveSources } from "./sources.js";
import { selectNextTask, selectTaskByLocation, hasUncheckedDescendants } from "./selector.js";
import { renderTemplate, type TemplateVars } from "./template.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import { validate, removeValidationFile } from "./validation.js";
import { correct } from "./correction.js";
import { executeInlineCli } from "./inline-cli.js";
import { checkTask } from "./checkbox.js";
import { loadProjectTemplates } from "./templates-loader.js";
import { parseTasks } from "./parser.js";
import { applyPlannerOutput } from "./planner.js";
import {
  loadTemplateVarsFile,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "./template-vars.js";
import { requiresWorkerCommand, resolveRunBehavior } from "./run-options.js";
import type { SortMode } from "./sorting.js";
import {
  createRuntimeArtifactsContext,
  displayArtifactsPath,
  findSavedRuntimeArtifact,
  finalizeRuntimeArtifacts,
  latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts,
  listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts,
  removeSavedRuntimeArtifacts,
  type RuntimeArtifactsContext,
} from "./runtime-artifacts.js";
import * as log from "./log.js";
import fs from "node:fs";

const RUNNER_MODES: readonly RunnerMode[] = ["wait", "tui", "detached"];
const PLANNER_MODES: readonly RunnerMode[] = ["wait"];
const PROMPT_TRANSPORTS: readonly PromptTransport[] = ["file", "arg"];
const SORT_MODES: readonly SortMode[] = ["name-sort", "none", "old-first", "new-first"];
const EXIT_TEST_MODE_ENV = "MD_TODO_TEST_MODE";

class CliExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`CLI exited with code ${code}`);
    this.code = code;
  }
}

function readCliVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };

    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Split argv at "--" before Commander sees it.
// Everything after "--" is the worker command (bash/cmd convention).
// PowerShell 5.1 strips "--" from $args, so we also support --worker flag.
let workerFromSeparator: string[] = [];

const program = new Command();

program
  .name("md-todo")
  .description("A Markdown-native task runtime for agentic workflows.")
  .version(readCliVersion());

// ── run command ────────────────────────────────────────────────

program
  .command("run")
  .description("Find the next unchecked TODO and execute it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--mode <mode>", "Runner execution mode: wait, tui, detached", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--verify", "Run verification after task execution (default)")
  .option("--validate", "Legacy alias for --verify")
  .option("--no-verify", "Disable verification after task execution")
  .option("--no-validate", "Legacy alias for --no-verify")
  .option("--only-verify", "Skip execution and run verification directly", false)
  .option("--only-validate", "Legacy alias for --only-verify", false)
  .option("--retries <n>", "Max repair retries on verification failure", "0")
  .option("--no-repair", "Disable repair even when retries are set", false)
  .option("--no-correct", "Legacy alias for --no-repair", false)
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .md-todo/runs", false)
  .option("--vars-file [path]", "Load extra template variables from a JSON file (default: .md-todo/vars.json)")
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(async (source: string, opts: Record<string, string | string[] | boolean>) => {

    const mode = parseRunnerMode(opts.mode as string | undefined, RUNNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean((opts.onlyVerify as boolean) || (opts.onlyValidate as boolean));
    const noRepair = Boolean((opts.noRepair as boolean) || (opts.noCorrect as boolean));
    const runBehavior = resolveRunBehavior({
      validate: verify,
      onlyValidate: onlyVerify,
      noCorrect: noRepair,
      retries: parseRetries(opts.retries as string | undefined),
    });
    const shouldValidate = runBehavior.shouldValidate;
    const onlyValidate = runBehavior.onlyValidate;
    const allowCorrection = runBehavior.allowCorrection;
    const maxRetries = runBehavior.maxRetries;
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFilePath = resolveTemplateVarsFilePath(opts.varsFile as string | boolean | undefined);
    const fileTemplateVars = varsFilePath
      ? loadTemplateVarsFile(varsFilePath)
      : {};
    const cliTemplateVars = parseCliTemplateVars((opts.var as string[] | undefined) ?? []);
    const extraTemplateVars = { ...fileTemplateVars, ...cliTemplateVars };

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;

    let artifactContext: RuntimeArtifactsContext | null = null;
    let artifactsFinalized = false;

    const finalizeArtifacts = (status: string, preserve: boolean = keepArtifacts): void => {
      if (!artifactContext || artifactsFinalized) {
        return;
      }

      finalizeRunArtifacts(artifactContext, preserve, status);
      artifactsFinalized = true;
    };

    const finishRun = (code: number, status: string, preserve: boolean = keepArtifacts): never => {
      finalizeArtifacts(status, preserve);
      terminate(code);
    };

    try {
      const files = await resolveSources(source);
      if (files.length === 0) {
        log.warn("No Markdown files found matching: " + source);
        terminate(3);
      }

      const result = selectNextTask(files, sortMode);
      if (!result) {
        log.info("No unchecked tasks found.");
        terminate(3);
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
        terminate(0);
      }

      if (dryRun && onlyValidate) {
        log.info("Dry run — would run verification with: " + automationCommand.join(" "));
        log.info("Prompt length: " + validationPrompt.length + " chars");
        terminate(0);
      }

      if (requiresWorkerCommand({
        workerCommand,
        isInlineCli: task.isInlineCli,
        shouldValidate,
        onlyValidate,
      })) {
        log.error("No worker command specified. Use --worker <command...> or -- <command>.");
        terminate(1);
      }

      if (!onlyValidate && !task.isInlineCli) {
        if (printPrompt) {
          console.log(prompt);
          terminate(0);
        }

        if (dryRun) {
          log.info("Dry run — would run: " + workerCommand.join(" "));
          log.info("Prompt length: " + prompt.length + " chars");
          terminate(0);
        }
      }

      if (!onlyValidate && task.isInlineCli && dryRun) {
        log.info("Dry run — would execute inline CLI: " + task.cliCommand!);
        terminate(0);
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
          finishRun(2, "verification-failed");
        }

        checkTask(task);
        log.success("Task checked: " + task.text);
        finishRun(0, "completed");
      }

      if (task.isInlineCli) {
        log.info("Executing inline CLI: " + task.cliCommand!);
        const cliResult = await executeInlineCli(task.cliCommand!, process.cwd(), {
          artifactContext,
          keepArtifacts,
          artifactExtra: { taskType: "inline-cli" },
        });

        if (cliResult.stdout) process.stdout.write(cliResult.stdout);
        if (cliResult.stderr) process.stderr.write(cliResult.stderr);

        if (cliResult.exitCode !== 0) {
          log.error("Inline CLI exited with code " + cliResult.exitCode);
          finishRun(1, "execution-failed");
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
            finishRun(2, "verification-failed");
          }
        }

        checkTask(task);
        log.success("Task checked: " + task.text);
        finishRun(0, "completed");
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
        finishRun(1, "execution-failed");
      }

      if (mode === "detached") {
        log.info("Detached mode — skipping immediate verification and leaving the task unchecked.");
        finishRun(0, "detached", true);
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
          finishRun(2, "verification-failed");
        }
      }

      checkTask(task);
      log.success("Task checked: " + task.text);
      finishRun(0, "completed");
    } catch (err) {
      finalizeArtifacts("failed", keepArtifacts || mode === "detached");
      if (isCliExitSignal(err)) {
        throw err;
      }
      log.error(String(err));
      terminate(1);
    }
  });

// ── next command ───────────────────────────────────────────────

program
  .command("next")
  .description("Show the next unchecked task without executing it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .action(async (source: string, opts: Record<string, string>) => {
    try {
      const files = await resolveSources(source);
      if (files.length === 0) {
        log.warn("No Markdown files found matching: " + source);
        terminate(3);
      }

      const result = selectNextTask(files, parseSortMode(opts.sort));
      if (!result) {
        log.info("No unchecked tasks found.");
        terminate(3);
      }

      console.log(log.taskLabel(result.task));
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      log.error(String(err));
      terminate(1);
    }
  });

// ── list command ───────────────────────────────────────────────

program
  .command("list")
  .description("List all unchecked tasks across the source.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--all", "Show all tasks including checked ones", false)
  .action(async (source: string, opts: Record<string, string | boolean>) => {
    try {
      const { sortFiles } = await import("./sorting.js");
      const files = await resolveSources(source);
      if (files.length === 0) {
        log.warn("No Markdown files found matching: " + source);
        terminate(3);
      }

      const sorted = sortFiles(files, parseSortMode(opts.sort as string | undefined));
      let count = 0;

      for (const file of sorted) {
        const content = fs.readFileSync(file, "utf-8");
        const tasks = parseTasks(content, file);
        const filtered = opts.all ? tasks : tasks.filter((t) => !t.checked);

        for (const task of filtered) {
          const blocked = !task.checked && hasUncheckedDescendants(task, tasks);
          const suffix = blocked ? log.dim(" (blocked — has unchecked subtasks)") : "";
          console.log(log.taskLabel(task) + suffix);
          count++;
        }
      }

      if (count === 0) {
        log.info("No tasks found.");
      }
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      log.error(String(err));
      terminate(1);
    }
  });

// ── artifacts command ──────────────────────────────────────────

program
  .command("artifacts")
  .description("List or clean saved runtime artifact runs under .md-todo/runs.")
  .option("--clean", "Remove all saved runtime artifact runs", false)
  .option("--json", "Print saved runtime artifacts as JSON", false)
  .option("--failed", "Show only failed runtime artifact runs", false)
  .option("--open <runId>", "Open a saved runtime artifact folder by run id, unique prefix, or 'latest'")
  .action((opts: Record<string, boolean | string>) => {
    try {
      const shouldClean = opts.clean as boolean;
      const shouldPrintJson = opts.json as boolean;
      const onlyFailed = opts.failed as boolean;
      const runToOpen = typeof opts.open === "string" ? opts.open : "";

      if (shouldClean && (shouldPrintJson || runToOpen)) {
        log.error("--clean cannot be combined with --json or --open.");
        terminate(1);
      }

      if (runToOpen && (shouldPrintJson || onlyFailed)) {
        log.error("--open cannot be combined with --json or --failed.");
        terminate(1);
      }

      if (runToOpen) {
        const run = runToOpen === "latest"
          ? latestSavedRuntimeArtifact(process.cwd())
          : findSavedRuntimeArtifact(runToOpen, process.cwd());
        if (!run) {
          log.error("No saved runtime artifact run found for: " + runToOpen);
          terminate(3);
        }

        openDirectory(run.rootDir);
        log.success("Opened runtime artifacts: " + run.relativePath);
        terminate(0);
      }

      if (shouldClean) {
        const removed = onlyFailed
          ? removeFailedRuntimeArtifacts(process.cwd())
          : removeSavedRuntimeArtifacts(process.cwd());
        if (removed === 0) {
          log.info(onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found.");
          terminate(0);
        }

        log.success(
          "Removed " + removed + " "
          + (onlyFailed ? "failed " : "")
          + "runtime artifact run"
          + (removed === 1 ? "" : "s")
          + ".",
        );
        terminate(0);
      }

      const runs = onlyFailed
        ? listFailedRuntimeArtifacts(process.cwd())
        : listSavedRuntimeArtifacts(process.cwd());

      if (runs.length === 0) {
        log.info(onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found.");
        terminate(0);
      }

      if (shouldPrintJson) {
        console.log(JSON.stringify(runs, null, 2));
        terminate(0);
      }

      for (const run of runs) {
        const worker = run.workerCommand?.join(" ") ?? run.commandName;
        const summary = [
          run.runId,
          `[status=${run.status ?? "unknown"}]`,
          `[command=${run.commandName}]`,
          `[mode=${run.mode ?? "n/a"}]`,
          `[transport=${run.transport ?? "n/a"}]`,
          run.relativePath,
        ].join(" ");

        console.log(summary);
        if (run.task) {
          console.log("  task: " + run.task.text + " — " + run.task.file + ":" + run.task.line);
        }
        console.log("  worker: " + worker);
        console.log("  started: " + run.startedAt);
      }

      terminate(0);
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      log.error(String(err));
      terminate(1);
    }
  });

// ── plan command ───────────────────────────────────────────────

program
  .command("plan")
  .description("Decompose a task into subtasks using a worker command.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--at <file:line>", "Target a specific task by file path and line number")
  .option("--mode <mode>", "Planner mode: wait", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--dry-run", "Show what would be planned without executing", false)
  .option("--print-prompt", "Print the rendered plan prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .md-todo/runs", false)
  .option("--vars-file [path]", "Load extra template variables from a JSON file (default: .md-todo/vars.json)")
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(async (source: string, opts: Record<string, string | string[] | boolean>) => {

    const mode = parseRunnerMode(opts.mode as string | undefined, PLANNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFilePath = resolveTemplateVarsFilePath(opts.varsFile as string | boolean | undefined);
    const fileTemplateVars = varsFilePath
      ? loadTemplateVarsFile(varsFilePath)
      : {};
    const cliTemplateVars = parseCliTemplateVars((opts.var as string[] | undefined) ?? []);
    const extraTemplateVars = { ...fileTemplateVars, ...cliTemplateVars };

    // Resolve worker command
    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;

    try {
      // 1. Resolve task target
      let result: import("./selector.js").SelectionResult | null = null;

      if (opts.at) {
        const atValue = opts.at as string;
        const colonIdx = atValue.lastIndexOf(":");
        if (colonIdx === -1) {
          log.error("Invalid --at format. Expected file:line (e.g. roadmap.md:12).");
          terminate(1);
        }

        const filePath = atValue.slice(0, colonIdx);
        const lineNum = parseInt(atValue.slice(colonIdx + 1), 10);
        if (!Number.isFinite(lineNum) || lineNum < 1) {
          log.error("Invalid line number in --at: " + atValue.slice(colonIdx + 1));
          terminate(1);
        }

        result = selectTaskByLocation(filePath, lineNum);
        if (!result) {
          log.error("No task found at " + filePath + ":" + lineNum);
          terminate(3);
        }
      } else {
        // Use normal source resolution, select next unchecked task
        const files = await resolveSources(source);
        if (files.length === 0) {
          log.warn("No Markdown files found matching: " + source);
          terminate(3);
        }

        result = selectNextTask(files, sortMode);
        if (!result) {
          log.info("No unchecked tasks found.");
          terminate(3);
        }
      }

      const { task, source: fileSource, contextBefore } = result!;
      log.info("Planning task: " + log.taskLabel(task));
      const taskMetadata = toRuntimeTaskMetadata(task, fileSource);

      // 2. Ensure worker command
      if (workerCommand.length === 0) {
        log.error("No worker command specified. Use --worker <command...> or -- <command>.");
        terminate(1);
      }

      // 3. Load templates and render plan prompt
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
        terminate(0);
      }

      if (dryRun) {
        log.info("Dry run — would plan: " + workerCommand.join(" "));
        log.info("Prompt length: " + prompt.length + " chars");
        terminate(0);
      }

      const artifactContext = createRuntimeArtifactsContext({
        cwd: process.cwd(),
        commandName: "plan",
        workerCommand,
        mode,
        transport,
        source,
        task: taskMetadata,
        keepArtifacts,
      });
      let artifactsFinalized = false;
      let artifactStatus = "running";

      const finishPlan = (code: number, status: string): never => {
        artifactStatus = status;
        finalizeRunArtifacts(artifactContext, keepArtifacts, artifactStatus);
        artifactsFinalized = true;
        terminate(code);
      };

      try {
        // 4. Execute the worker
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

        if (mode === "wait") {
          if (runResult.stderr) process.stderr.write(runResult.stderr);
        }

        if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
          log.error("Planner worker exited with code " + runResult.exitCode + ".");
          finishPlan(1, "execution-failed");
        }

        if (!runResult.stdout || runResult.stdout.trim().length === 0) {
          log.warn("Planner produced no output. No subtasks created.");
          finishPlan(0, "completed");
        }

        // 5. Insert subtasks
        const count = applyPlannerOutput(task, runResult.stdout);
        if (count === 0) {
          log.warn("Planner output contained no valid task items. No subtasks created.");
          finishPlan(0, "completed");
        }

        log.success("Inserted " + count + " subtask" + (count === 1 ? "" : "s") + " under: " + task.text);
        finishPlan(0, "completed");
      } finally {
        if (!artifactsFinalized) {
          finalizeRunArtifacts(artifactContext, keepArtifacts, artifactStatus);
          artifactsFinalized = true;
        }
      }
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      log.error(String(err));
      terminate(1);
    }
  });

// ── init command ───────────────────────────────────────────────

program
  .command("init")
  .description("Create a .md-todo/ directory with default templates (plan, execute, verify, repair).")
  .action(async () => {
    const dir = ".md-todo";
    const templates = loadProjectTemplates();

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const write = (name: string, content: string) => {
      const p = `${dir}/${name}`;
      if (fs.existsSync(p)) {
        log.warn(`${p} already exists, skipping.`);
      } else {
        fs.writeFileSync(p, content, "utf-8");
        log.success(`Created ${p}`);
      }
    };

    const {
      DEFAULT_TASK_TEMPLATE,
      DEFAULT_VALIDATE_TEMPLATE,
      DEFAULT_CORRECT_TEMPLATE,
      DEFAULT_PLAN_TEMPLATE,
      DEFAULT_VARS_FILE_CONTENT,
    } = await import("./defaults.js");

    write("execute.md", DEFAULT_TASK_TEMPLATE);
    write("verify.md", DEFAULT_VALIDATE_TEMPLATE);
    write("repair.md", DEFAULT_CORRECT_TEMPLATE);
    write("plan.md", DEFAULT_PLAN_TEMPLATE);
    write("vars.json", DEFAULT_VARS_FILE_CONTENT);

    log.success("Initialized .md-todo/ with default templates.");
  });

// ── helpers ────────────────────────────────────────────────────

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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRunnerMode(value: string | undefined, allowed: readonly RunnerMode[]): RunnerMode {
  const mode = (value ?? "wait") as RunnerMode;
  if (!allowed.includes(mode)) {
    throw new Error(`Invalid --mode value: ${value}. Allowed: ${allowed.join(", ")}.`);
  }
  return mode;
}

function parsePromptTransport(value: string | undefined): PromptTransport {
  const transport = (value ?? "file") as PromptTransport;
  if (!PROMPT_TRANSPORTS.includes(transport)) {
    throw new Error(`Invalid --transport value: ${value}. Allowed: ${PROMPT_TRANSPORTS.join(", ")}.`);
  }
  return transport;
}

function parseSortMode(value: string | undefined): SortMode {
  const sortMode = (value ?? "name-sort") as SortMode;
  if (!SORT_MODES.includes(sortMode)) {
    throw new Error(`Invalid --sort value: ${value}. Allowed: ${SORT_MODES.join(", ")}.`);
  }
  return sortMode;
}

function parseRetries(value: string | undefined): number {
  const raw = value ?? "0";
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --retries value: ${raw}. Must be a non-negative integer.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --retries value: ${raw}. Must be a safe non-negative integer.`);
  }

  return parsed;
}

function resolveVerifyFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const verifyOpt = opts.verify as boolean | undefined;
  const validateOpt = opts.validate as boolean | undefined;

  if (verifyOpt === false || validateOpt === false) {
    return false;
  }

  if (verifyOpt === true || validateOpt === true) {
    return true;
  }

  return true;
}

function getAutomationWorkerCommand(
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

function finalizeRunArtifacts(
  artifactContext: RuntimeArtifactsContext,
  preserve: boolean,
  status: string,
): void {
  finalizeRuntimeArtifacts(artifactContext, { status, preserve });

  if (preserve) {
    log.info("Runtime artifacts saved at " + displayArtifactsPath(artifactContext) + ".");
  }
}

function toRuntimeTaskMetadata(
  task: Parameters<typeof validate>[0]["task"],
  source: string,
): RuntimeArtifactsContext["task"] {
  return {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source,
  };
}

function isOpenCodeWorkerCommand(workerCommand: string[]): boolean {
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

function openDirectory(dirPath: string): void {
  const targetPath = dirPath;

  if (process.platform === "win32") {
    const child = spawn("explorer", [targetPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const child = spawn("open", [targetPath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [targetPath], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.unref();
}

// ── parse and run ──────────────────────────────────────────────

export async function parseCliArgs(argv: string[]): Promise<void> {
  const { mdTodoArgs, workerFromSeparator: workerCommandArgs } = splitWorkerFromSeparator(argv);
  workerFromSeparator = workerCommandArgs;
  await program.parseAsync(mdTodoArgs, { from: "user" });
}

if (process.env.MD_TODO_DISABLE_AUTO_PARSE !== "1") {
  parseCliArgs(process.argv.slice(2)).catch((err) => {
    if (isCliExitSignal(err)) {
      process.exit(err.code);
    }
    log.error(String(err));
    process.exit(1);
  });
}

function splitWorkerFromSeparator(argv: string[]): { mdTodoArgs: string[]; workerFromSeparator: string[] } {
  const sepIndex = argv.indexOf("--");
  return {
    mdTodoArgs: sepIndex !== -1 ? argv.slice(0, sepIndex) : argv,
    workerFromSeparator: sepIndex !== -1 ? argv.slice(sepIndex + 1) : [],
  };
}

function terminate(code: number): never {
  if (process.env[EXIT_TEST_MODE_ENV] === "1") {
    throw new CliExitSignal(code);
  }

  process.exit(code);
}

function isCliExitSignal(error: unknown): error is CliExitSignal {
  return error instanceof CliExitSignal;
}
