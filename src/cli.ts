/**
 * md-todo CLI
 *
 * A Markdown-native task runtime for agentic workflows.
 */

import { Command } from "commander";
import { resolveSources } from "./sources.js";
import { selectNextTask } from "./selector.js";
import { renderTemplate, type TemplateVars } from "./template.js";
import { runWorker, type RunnerMode, type PromptTransport } from "./runner.js";
import { validate, removeValidationFile } from "./validation.js";
import { correct } from "./correction.js";
import { executeInlineCli } from "./inline-cli.js";
import { checkTask } from "./checkbox.js";
import { loadProjectTemplates } from "./templates-loader.js";
import { parseTasks } from "./parser.js";
import {
  loadTemplateVarsFile,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "./template-vars.js";
import { requiresWorkerCommand, resolveRunBehavior } from "./run-options.js";
import type { SortMode } from "./sorting.js";
import * as log from "./log.js";
import fs from "node:fs";

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

// Split process.argv at "--" before Commander sees it.
// Everything after "--" is the worker command (bash/cmd convention).
// PowerShell 5.1 strips "--" from $args, so we also support --worker flag.
const rawArgv = process.argv.slice(2);
const sepIndex = rawArgv.indexOf("--");
const mdTodoArgs = sepIndex !== -1 ? rawArgv.slice(0, sepIndex) : rawArgv;
const workerFromSeparator = sepIndex !== -1 ? rawArgv.slice(sepIndex + 1) : [];

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
  .option("--validate", "Run validation after task execution", false)
  .option("--only-validate", "Skip execution and run validation directly", false)
  .option("--retries <n>", "Max correction retries on validation failure", "0")
  .option("--no-correct", "Disable correction even when retries are set", false)
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered prompt and exit", false)
  .option("--vars-file [path]", "Load extra template variables from a JSON file (default: .md-todo/vars.json)")
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(async (source: string, opts: Record<string, string | string[] | boolean>) => {

    const mode = opts.mode as RunnerMode;
    const transport = opts.transport as PromptTransport;
    const sortMode = opts.sort as SortMode;
    const runBehavior = resolveRunBehavior({
      validate: opts.validate as boolean,
      onlyValidate: opts.onlyValidate as boolean,
      noCorrect: opts.noCorrect as boolean,
      retries: parseInt(opts.retries as string, 10) || 0,
    });
    const shouldValidate = runBehavior.shouldValidate;
    const onlyValidate = runBehavior.onlyValidate;
    const allowCorrection = runBehavior.allowCorrection;
    const maxRetries = runBehavior.maxRetries;
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const varsFilePath = resolveTemplateVarsFilePath(opts.varsFile as string | boolean | undefined);
    const fileTemplateVars = varsFilePath
      ? loadTemplateVarsFile(varsFilePath)
      : {};
    const cliTemplateVars = parseCliTemplateVars((opts.var as string[] | undefined) ?? []);
    const extraTemplateVars = { ...fileTemplateVars, ...cliTemplateVars };

    // Resolve worker command: --worker flag takes precedence, then -- separator
    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker.flatMap((part) => part.split(/\s+/).filter(Boolean))
      : typeof opts.worker === "string"
        ? opts.worker.split(/\s+/).filter(Boolean)
        : workerFromSeparator;

    try {
      // 1. Resolve sources
      const files = await resolveSources(source);
      if (files.length === 0) {
        log.warn("No Markdown files found matching: " + source);
        process.exit(3);
      }

      // 2. Select the next task
      const result = selectNextTask(files, sortMode);
      if (!result) {
        log.info("No unchecked tasks found.");
        process.exit(3);
      }

      const { task, source: fileSource, contextBefore } = result;
      log.info("Next task: " + log.taskLabel(task));
      const automationCommand = getAutomationWorkerCommand(workerCommand, mode);

      // 3. Load templates
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
        process.exit(0);
      }

      if (dryRun && onlyValidate) {
        log.info("Dry run — would run validation with: " + automationCommand.join(" "));
        log.info("Prompt length: " + validationPrompt.length + " chars");
        process.exit(0);
      }

      if (requiresWorkerCommand({
        workerCommand,
        isInlineCli: task.isInlineCli,
        shouldValidate,
        onlyValidate,
      })) {
        log.error("No worker command specified. Use --worker <command...> or -- <command>.");
        process.exit(1);
      }

      if (onlyValidate) {
        log.info("Only validate mode — skipping task execution.");

        const valid = await runValidation(
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          mode,
          transport,
          maxRetries,
          allowCorrection,
          extraTemplateVars,
        );
        if (!valid) {
          log.error("Validation failed after all retries. Task not checked.");
          process.exit(2);
        }

        checkTask(task);
        log.success("Task checked: " + task.text);
        process.exit(0);
      }

      // 4. Handle inline CLI tasks
      if (task.isInlineCli) {
        if (dryRun) {
          log.info("Dry run — would execute inline CLI: " + task.cliCommand!);
          process.exit(0);
        }

        log.info("Executing inline CLI: " + task.cliCommand!);
        const cliResult = await executeInlineCli(task.cliCommand!);

        if (cliResult.stdout) process.stdout.write(cliResult.stdout);
        if (cliResult.stderr) process.stderr.write(cliResult.stderr);

        if (cliResult.exitCode === 0) {
          if (shouldValidate) {
            const valid = await runValidation(task, fileSource, contextBefore, templates, automationCommand, mode, transport, maxRetries, allowCorrection, extraTemplateVars);
            if (!valid) {
              log.error("Validation failed. Task not checked.");
              process.exit(2);
            }
          }

          checkTask(task);
          log.success("Task checked: " + task.text);
          process.exit(0);
        } else {
          log.error("Inline CLI exited with code " + cliResult.exitCode);
          process.exit(1);
        }
      }

      if (printPrompt) {
        console.log(prompt);
        process.exit(0);
      }

      if (dryRun) {
        log.info("Dry run — would run: " + workerCommand.join(" "));
        log.info("Prompt length: " + prompt.length + " chars");
        process.exit(0);
      }

      // 5. Execute the worker
      log.info("Running: " + workerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]");
      const runResult = await runWorker({
        command: workerCommand,
        prompt,
        mode,
        transport,
      });

      if (mode === "wait") {
        if (runResult.stdout) process.stdout.write(runResult.stdout);
        if (runResult.stderr) process.stderr.write(runResult.stderr);
      }

      if (mode !== "detached" && runResult.exitCode !== 0 && runResult.exitCode !== null) {
        log.error("Worker exited with code " + runResult.exitCode + ".");
        process.exit(1);
      }

      // 6. Validation
      if (shouldValidate) {
        const valid = await runValidation(
          task, fileSource, contextBefore, templates, automationCommand,
          mode, transport, maxRetries, allowCorrection, extraTemplateVars, runResult.stdout,
        );
        if (!valid) {
          log.error("Validation failed after all retries. Task not checked.");
          process.exit(2);
        }
      }

      // 7. Check the task
      if (mode !== "detached") {
        checkTask(task);
        log.success("Task checked: " + task.text);
      } else {
        log.info("Detached mode — task will not be auto-checked.");
      }

      process.exit(0);
    } catch (err) {
      log.error(String(err));
      process.exit(1);
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
        process.exit(3);
      }

      const result = selectNextTask(files, opts.sort as SortMode);
      if (!result) {
        log.info("No unchecked tasks found.");
        process.exit(3);
      }

      console.log(log.taskLabel(result.task));
    } catch (err) {
      log.error(String(err));
      process.exit(1);
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
        process.exit(3);
      }

      const sorted = sortFiles(files, (opts.sort as SortMode) ?? "name-sort");
      let count = 0;

      for (const file of sorted) {
        const content = fs.readFileSync(file, "utf-8");
        const tasks = parseTasks(content, file);
        const filtered = opts.all ? tasks : tasks.filter((t) => !t.checked);

        for (const task of filtered) {
          const prefix = task.checked ? "  [x]" : "  [ ]";
          console.log(log.taskLabel(task));
          count++;
        }
      }

      if (count === 0) {
        log.info("No tasks found.");
      }
    } catch (err) {
      log.error(String(err));
      process.exit(1);
    }
  });

// ── init command ───────────────────────────────────────────────

program
  .command("init")
  .description("Create a .md-todo/ directory with default templates.")
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
      DEFAULT_VARS_FILE_CONTENT,
    } = await import("./defaults.js");

    write("task.md", DEFAULT_TASK_TEMPLATE);
    write("validate.md", DEFAULT_VALIDATE_TEMPLATE);
    write("correct.md", DEFAULT_CORRECT_TEMPLATE);
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
  mode: RunnerMode,
  transport: PromptTransport,
  maxRetries: number,
  allowCorrection: boolean,
  extraTemplateVars: ExtraTemplateVars,
  commandOutput?: string,
): Promise<boolean> {
  log.info("Running validation…");

  const valid = await validate({
    task,
    source: fileSource,
    contextBefore,
    template: templates.validate,
    command: workerCommand,
    mode: "wait",
    transport,
    templateVars: extraTemplateVars,
  });

  if (valid) {
    removeValidationFile(task);
    log.success("Validation passed.");
    return true;
  }

  if (allowCorrection) {
    log.warn("Validation failed. Running correction (" + maxRetries + " retries)…");
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
    });

    if (result.valid) {
      removeValidationFile(task);
      log.success("Correction succeeded after " + result.attempts + " attempt(s).");
      return true;
    }
  }

  return false;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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

// ── parse and run ──────────────────────────────────────────────

program.parse(mdTodoArgs, { from: "user" });
