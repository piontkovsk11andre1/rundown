import { Command, Option } from "commander";
import { type ProcessRunMode, type PromptTransport } from "../domain/ports/index.js";
import type { SortMode } from "../domain/sorting.js";
import { createApp } from "../create-app.js";
import { cliOutputPort } from "./output-port.js";
import fs from "node:fs";
import pc from "picocolors";

const RUNNER_MODES: readonly ProcessRunMode[] = ["wait", "tui", "detached"];
const PLANNER_MODES: readonly ProcessRunMode[] = ["wait"];
const PROMPT_TRANSPORTS: readonly PromptTransport[] = ["file", "arg"];
const SORT_MODES: readonly SortMode[] = ["name-sort", "none", "old-first", "new-first"];
const REVERT_METHODS = ["revert", "reset"] as const;
const EXIT_TEST_MODE_ENV = "RUNDOWN_TEST_MODE";
const DEFAULT_PLAN_SCAN_COUNT = 1;

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

let workerFromSeparator: string[] = [];

const program = new Command();
const app = createApp({
  ports: {
    output: cliOutputPort,
  },
});

type CliActionResult = number | Promise<number>;
program
  .name("rundown")
  .description("A Markdown-native task runtime for agentic workflows.")
  .version(readCliVersion());
program
  .command("run")
  .description("Find the next unchecked TODO and execute it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--mode <mode>", "Runner execution mode: wait, tui, detached", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--verify", "Run verification after task execution (default)")
  .option("--no-verify", "Disable verification after task execution")
  .option("--only-verify", "Skip execution and run verification directly", false)
  .option("--force-execute", "Force execute phase even for verify-only task text", false)
  .option("--repair-attempts <n>", "Max repair attempts on verification failure", "1")
  .option("--no-repair", "Disable repair even when repair attempts are set")
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .rundown/runs", false)
  .option("--trace", "Enable structured trace output at .rundown/runs/<id>/trace.jsonl", false)
  .option("--trace-only", "Skip task execution and run only trace enrichment on the latest completed artifact run", false)
  .option("--vars-file [path]", "Load extra template variables from a JSON file (default: .rundown/vars.json)")
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--commit", "Auto-commit checked task file after successful completion", false)
  .option("--commit-message <template>", "Commit message template (supports {{task}} and {{file}})")
  .option("--on-complete <command>", "Run a shell command after successful task completion")
  .option("--on-fail <command>", "Run a shell command when a task fails (execution or verification failure)")
  .option("--hide-agent-output", "Hide worker stdout/stderr during execution; show only rundown status messages.", false)
  .option("--all", "Run all tasks sequentially instead of stopping after one", false)
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction(async (source: string, opts: Record<string, string | string[] | boolean>) => {
    const mode = parseRunnerMode(opts.mode as string | undefined, RUNNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean(opts.onlyVerify as boolean);
    const forceExecute = Boolean(opts.forceExecute as boolean);
    const noRepair = resolveNoRepairFlag(opts);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
    const traceOnly = opts.traceOnly as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined);
    const commitMessageTemplate = normalizeOptionalString(opts.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const hideAgentOutput = Boolean(opts.hideAgentOutput as boolean | undefined);
    const runAll = Boolean(opts.all as boolean | undefined);
    return app.runTask({
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
      trace,
      traceOnly,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      commitAfterComplete,
      commitMessageTemplate,
      onCompleteCommand,
      onFailCommand,
      hideAgentOutput,
      runAll,
    });
  }));

program
  .command("reverify")
  .description("Re-run verification for the previously completed task from saved artifacts.")
  .option("--run <id|latest>", "Choose artifact run id or 'latest'", "latest")
  .option("--last <n>", "Re-verify the last N completed runs")
  .option("--all", "Re-verify all completed runs", false)
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--repair-attempts <n>", "Max repair attempts on verification failure", "1")
  .option("--no-repair", "Disable repair even when repair attempts are set")
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered verify prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .rundown/runs", false)
  .option("--trace", "Enable structured trace output at .rundown/runs/<id>/trace.jsonl", false)
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction((opts: Record<string, string | string[] | boolean>) => {
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;

    return app.reverifyTask({
      runId: targetRun,
      last,
      all,
      transport,
      repairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      workerCommand,
      trace,
    });
  }));

program
  .command("revert")
  .description("Undo completed task runs by reverting their git commits.")
  .option("--run <id|latest>", "Target artifact run id or 'latest'", "latest")
  .option("--last <n>", "Revert the last N completed+committed runs")
  .option("--all", "Revert all completed+committed runs", false)
  .option("--method <revert|reset>", "Git undo strategy", "revert")
  .option("--dry-run", "Show what would be reverted without changing git state", false)
  .option("--force", "Bypass clean-worktree and reset contiguous-HEAD checks", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .rundown/runs", false)
  .allowUnknownOption(false)
  .action(withCliAction((opts: Record<string, string | string[] | boolean>) => {
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const method = parseRevertMethod(opts.method as string | undefined);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const force = Boolean(opts.force as boolean | undefined);
    const keepArtifacts = Boolean(opts.keepArtifacts as boolean | undefined);

    return app.revertTask({
      runId: targetRun,
      last,
      all,
      method,
      dryRun,
      force,
      keepArtifacts,
    });
  }));

program
  .command("next")
  .description("Show the next unchecked task without executing it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .action(withCliAction((source: string, opts: Record<string, string | string[] | boolean>) => {
    return app.nextTask({
      source,
      sortMode: parseSortMode(opts.sort as string | undefined),
    });
  }));
program
  .command("list")
  .description("List all unchecked tasks across the source.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--all", "Show all tasks including checked ones", false)
  .action(withCliAction((source: string, opts: Record<string, string | boolean>) => {
    return app.listTasks({
      source,
      sortMode: parseSortMode(opts.sort as string | undefined),
      includeAll: opts.all as boolean,
    });
  }));
program
  .command("artifacts")
  .description("List or clean saved runtime artifact runs under .rundown/runs.")
  .option("--clean", "Remove all saved runtime artifact runs", false)
  .option("--json", "Print saved runtime artifacts as JSON", false)
  .option("--failed", "Show only failed runtime artifact runs", false)
  .option("--open <runId>", "Open a saved runtime artifact folder by run id, unique prefix, or 'latest'")
  .action(withCliAction((opts: Record<string, boolean | string>) => {
    return app.manageArtifacts({
      clean: opts.clean as boolean,
      json: opts.json as boolean,
      failed: opts.failed as boolean,
      open: typeof opts.open === "string" ? opts.open : "",
    });
  }));
program
  .command("plan")
  .description("Synthesize actionable TODOs for a Markdown document using a worker command.")
  .argument("[markdown-file...]", "Markdown document to plan")
  .addOption(new Option("--at <file:line>", "Deprecated legacy task selector for plan").hideHelp())
  .addOption(new Option("--sort <sort>", "Deprecated legacy sort selector for plan").hideHelp())
  .option("--scan-count <n>", "Max clean-session TODO coverage scans", String(DEFAULT_PLAN_SCAN_COUNT))
  .option("--mode <mode>", "Planner mode: wait", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--dry-run", "Show what would be planned without executing", false)
  .option("--print-prompt", "Print the rendered plan prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under .rundown/runs", false)
  .option("--trace", "Enable structured trace output at .rundown/runs/<id>/trace.jsonl", false)
  .option("--vars-file [path]", "Load extra template variables from a JSON file (default: .rundown/vars.json)")
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker <command...>", "Worker command to run (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction((markdownFiles: string[], opts: Record<string, string | string[] | boolean>) => {
    assertNoLegacyPlanSelectionOptions(opts);
    const markdownFile = resolvePlanMarkdownFile(markdownFiles);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);
    const mode = parseRunnerMode(opts.mode as string | undefined, PLANNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;
    return app.planTask({
      source: markdownFile,
      scanCount,
      mode,
      transport,
      dryRun,
      printPrompt,
      keepArtifacts,
      trace,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
    });
  }));
program
  .command("init")
  .description("Create a .rundown/ directory with default templates (plan, execute, verify, repair).")
  .action(withCliAction(() => app.initProject()));
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRunnerMode(value: string | undefined, allowed: readonly ProcessRunMode[]): ProcessRunMode {
  const mode = (value ?? "wait") as ProcessRunMode;
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

function parseRepairAttempts(value: string | undefined): number {
  const raw = value ?? "1";
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --repair-attempts value: ${raw}. Must be a non-negative integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --repair-attempts value: ${raw}. Must be a safe non-negative integer.`);
  }
  return parsed;
}

function parseScanCount(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_PLAN_SCAN_COUNT);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --scan-count value: ${raw}. Must be a positive integer.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --scan-count value: ${raw}. Must be a safe positive integer.`);
  }

  if (parsed < 1) {
    throw new Error(`Invalid --scan-count value: ${raw}. Must be a positive integer.`);
  }

  return parsed;
}

function assertNoLegacyPlanSelectionOptions(opts: Record<string, string | string[] | boolean>): void {
  if (opts.at !== undefined) {
    throw new Error("The --at option is no longer supported for `plan`. `plan` now operates on the entire <markdown-file>. Remove --at and pass the target document as the command argument.");
  }

  if (opts.sort !== undefined) {
    throw new Error("The --sort option is no longer supported for `plan`. Planning no longer selects a task from multiple files. Remove --sort and pass only the target <markdown-file>.");
  }
}

function resolvePlanMarkdownFile(markdownFiles: string[]): string {
  if (markdownFiles.length === 0) {
    throw new Error("The `plan` command requires exactly one Markdown file path. Usage: rundown plan <markdown-file> [options].");
  }

  if (markdownFiles.length > 1) {
    throw new Error(`The \`plan\` command accepts exactly one Markdown file path. Received ${markdownFiles.length}: ${markdownFiles.join(", ")}.`);
  }

  const markdownFile = markdownFiles[0] ?? "";
  if (!/\.(md|markdown)$/i.test(markdownFile)) {
    throw new Error(`Invalid plan document path: ${markdownFile}. The \`plan\` command only accepts Markdown files (.md or .markdown).`);
  }

  return markdownFile;
}

function parseLastCount(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --last value: ${value}. Must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --last value: ${value}. Must be a safe positive integer.`);
  }

  return parsed;
}

function parseRevertMethod(value: string | undefined): "revert" | "reset" {
  const method = (value ?? "revert") as (typeof REVERT_METHODS)[number];
  if (!REVERT_METHODS.includes(method)) {
    throw new Error(`Invalid --method value: ${value}. Allowed: ${REVERT_METHODS.join(", ")}.`);
  }

  return method;
}

function normalizeOptionalString(value: string | string[] | boolean | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim() === "" ? undefined : value;
}

function resolveVerifyFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const verifyOpt = opts.verify as boolean | undefined;
  if (verifyOpt === false) {
    return false;
  }
  if (verifyOpt === true) {
    return true;
  }
  return true;
}

function resolveNoRepairFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const repairOpt = opts.repair as boolean | undefined;
  if (repairOpt === false) {
    return true;
  }

  const noRepairOpt = opts.noRepair as boolean | undefined;
  return noRepairOpt === true;
}

function withCliAction<Args extends unknown[]>(
  action: (...args: Args) => CliActionResult,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      const exitCode = await action(...args);
      terminate(exitCode);
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      console.error(pc.red("✖") + " " + String(err));
      terminate(1);
    }
  };
}

export async function parseCliArgs(argv: string[]): Promise<void> {
  const { rundownArgs, workerFromSeparator: workerCommandArgs } = splitWorkerFromSeparator(argv);
  workerFromSeparator = workerCommandArgs;
  await program.parseAsync(rundownArgs, { from: "user" });
}

if (process.env.RUNDOWN_DISABLE_AUTO_PARSE !== "1") {
  parseCliArgs(process.argv.slice(2)).catch((err) => {
    if (isCliExitSignal(err)) {
      process.exit(err.code);
    }
    console.error(pc.red("✖") + " " + String(err));
    process.exit(1);
  });
}

function splitWorkerFromSeparator(argv: string[]): { rundownArgs: string[]; workerFromSeparator: string[] } {
  const sepIndex = argv.indexOf("--");
  return {
    rundownArgs: sepIndex !== -1 ? argv.slice(0, sepIndex) : argv,
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
