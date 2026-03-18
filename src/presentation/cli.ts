import { Command } from "commander";
import { type RunnerMode, type PromptTransport } from "../infrastructure/runner.js";
import type { SortMode } from "../domain/sorting.js";
import { createApp } from "../create-app.js";
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

let workerFromSeparator: string[] = [];

const program = new Command();
const app = createApp();

type CliActionResult = number | Promise<number>;
program
  .name("md-todo")
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
  .action(withCliAction(async (source: string, opts: Record<string, string | string[] | boolean>) => {
    const mode = parseRunnerMode(opts.mode as string | undefined, RUNNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean((opts.onlyVerify as boolean) || (opts.onlyValidate as boolean));
    const noRepair = Boolean((opts.noRepair as boolean) || (opts.noCorrect as boolean));
    const retries = parseRetries(opts.retries as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;
    const commitAfterComplete = opts.commit as boolean;
    const commitMessageTemplate = opts.commitMessage as string | undefined;
    const onCompleteCommand = opts.onComplete as string | undefined;
    return app.runTask({
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
  .description("List or clean saved runtime artifact runs under .md-todo/runs.")
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
  .action(withCliAction((source: string, opts: Record<string, string | string[] | boolean>) => {
    const mode = parseRunnerMode(opts.mode as string | undefined, PLANNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;
    return app.planTask({
      source,
      at: opts.at as string | undefined,
      mode,
      transport,
      sortMode,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
    });
  }));
program
  .command("init")
  .description("Create a .md-todo/ directory with default templates (plan, execute, verify, repair).")
  .action(withCliAction(() => app.initProject()));
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
      log.error(String(err));
      terminate(1);
    }
  };
}

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
