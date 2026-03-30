import { Command } from "commander";
import { type ProcessRunMode, type PromptTransport } from "../domain/ports/index.js";
import type { SortMode } from "../domain/sorting.js";
import { createApp } from "../create-app.js";
import type { ConfigDirResult } from "../domain/ports/index.js";
import { createConfigDirAdapter } from "../infrastructure/adapters/config-dir-adapter.js";
import { createNodeFileSystem } from "../infrastructure/adapters/fs-file-system.js";
import { createGlobalOutputLogWriter } from "../infrastructure/adapters/global-output-log-writer.js";
import { globalOutputLogFilePath } from "../infrastructure/runtime-artifacts.js";
import { createLoggedOutputPort } from "./logged-output-port.js";
import type { LoggedOutputContext } from "./logged-output-port.js";
import { cliOutputPort } from "./output-port.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pc from "picocolors";

const RUNNER_MODES: readonly ProcessRunMode[] = ["wait", "tui", "detached"];
const PLANNER_MODES: readonly ProcessRunMode[] = ["wait"];
const DISCUSS_MODES: readonly ProcessRunMode[] = ["wait", "tui"];
const PROMPT_TRANSPORTS: readonly PromptTransport[] = ["file", "arg"];
const SORT_MODES: readonly SortMode[] = ["name-sort", "none", "old-first", "new-first"];
const REVERT_METHODS = ["revert", "reset"] as const;
const EXIT_TEST_MODE_ENV = "RUNDOWN_TEST_MODE";
const DEFAULT_PLAN_SCAN_COUNT = 1;
const DEFAULT_VARS_FILE_HELP = "Load extra template variables from a JSON file (default: <config-dir>/vars.json)";

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

function createSessionId(): string {
  return `sess-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

let workerFromSeparator: string[] = [];
let cliInvocationLogState: CliInvocationLogState | undefined;
let cliInvocationArgv: string[] | undefined;

const program = new Command();
const cliVersion = readCliVersion();
let app: ReturnType<typeof createApp> | undefined;

interface CliInvocationLogState {
  writer: ReturnType<typeof createGlobalOutputLogWriter>;
  context: LoggedOutputContext;
}

function getApp(): ReturnType<typeof createApp> {
  if (!app) {
    throw new Error("CLI app is not initialized. Call parseCliArgs(...) before invoking commands.");
  }
  return app;
}

const LOCK_RELEASE_SIGNAL_HANDLER_MARKER = "__rundownLockReleaseSignalHandler";
const LOCK_RELEASE_EXIT_HANDLER_MARKER = "__rundownLockReleaseExitHandler";
const LOCK_RELEASE_STATE_SYMBOL = Symbol.for("rundown.lock-release-state");

interface LockReleaseState {
  app: ReturnType<typeof createApp> | undefined;
}

function getLockReleaseState(): LockReleaseState {
  const processWithState = process as typeof process & {
    [LOCK_RELEASE_STATE_SYMBOL]?: LockReleaseState;
  };
  if (!processWithState[LOCK_RELEASE_STATE_SYMBOL]) {
    processWithState[LOCK_RELEASE_STATE_SYMBOL] = {
      app: undefined,
    };
  }
  return processWithState[LOCK_RELEASE_STATE_SYMBOL];
}

function releaseHeldFileLocksBestEffort(): void {
  try {
    getLockReleaseState().app?.releaseAllLocks?.();
  } catch {
    // best-effort cleanup: never mask shutdown with lock release failures
  }
}

function hasRegisteredLockReleaseHandler(signal: NodeJS.Signals): boolean {
  return process.listeners(signal).some((listener) => {
    const tagged = listener as ((...args: unknown[]) => unknown) & {
      [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]?: boolean;
    };
    return tagged[LOCK_RELEASE_SIGNAL_HANDLER_MARKER] === true;
  });
}

function hasRegisteredLockReleaseExitHandler(): boolean {
  return process.listeners("exit").some((listener) => {
    const tagged = listener as ((...args: unknown[]) => unknown) & {
      [LOCK_RELEASE_EXIT_HANDLER_MARKER]?: boolean;
    };
    return tagged[LOCK_RELEASE_EXIT_HANDLER_MARKER] === true;
  });
}

function registerLockReleaseSignalHandlers(): void {
  if (!hasRegisteredLockReleaseHandler("SIGINT")) {
    const sigintHandler = Object.assign(() => {
      releaseHeldFileLocksBestEffort();
      terminate(130);
    }, { [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]: true });
    process.on("SIGINT", sigintHandler);
  }

  if (!hasRegisteredLockReleaseHandler("SIGTERM")) {
    const sigtermHandler = Object.assign(() => {
      releaseHeldFileLocksBestEffort();
      terminate(143);
    }, { [LOCK_RELEASE_SIGNAL_HANDLER_MARKER]: true });
    process.on("SIGTERM", sigtermHandler);
  }

  if (process.platform === "win32" && !hasRegisteredLockReleaseExitHandler()) {
    const exitHandler = Object.assign(() => {
      releaseHeldFileLocksBestEffort();
    }, { [LOCK_RELEASE_EXIT_HANDLER_MARKER]: true });
    process.on("exit", exitHandler);
  }
}

function createAppForInvocation(argv: string[]) {
  const invocationLogState = cliInvocationLogState ?? createCliInvocationLogState(argv);
  cliInvocationLogState = invocationLogState;
  const configDirOverride = resolveConfigDirForInvocation(argv);
  const loggedOutputPort = createLoggedOutputPort({
    output: cliOutputPort,
    writer: invocationLogState.writer,
    context: invocationLogState.context,
  });

  return createApp({
    ports: {
      output: loggedOutputPort,
      configDir: configDirOverride,
    },
  });
}

function resolveConfigDirForInvocation(
  argv?: string[],
  cwd: string = process.cwd(),
): ConfigDirResult | undefined {
  const explicitConfigDir = argv
    ? resolveExplicitConfigDirFromArgv(argv)
    : resolveExplicitConfigDirOption();
  if (explicitConfigDir) {
    return {
      configDir: path.resolve(explicitConfigDir),
      isExplicit: true,
    };
  }

  return createConfigDirAdapter().resolve(cwd);
}

function resolveExplicitConfigDirFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === "--config-dir") {
      const nextToken = argv[index + 1];
      return typeof nextToken === "string"
        ? normalizeOptionalString(nextToken)
        : undefined;
    }

    if (token.startsWith("--config-dir=")) {
      return normalizeOptionalString(token.slice("--config-dir=".length));
    }
  }

  return undefined;
}

type CliActionResult = number | Promise<number>;

interface LogCommandOptions {
  revertable: boolean;
  commandName?: string;
  limit?: number;
  json: boolean;
}

type LogCommandHandler = (options: LogCommandOptions) => CliActionResult;

configureCommanderOutputHandlers(program);
program
  .name("rundown")
  .description("A Markdown-native task runtime for agentic workflows.")
  .version(cliVersion)
  .option(
    "--config-dir <path>",
    "Explicit path to the .rundown configuration directory (bypasses upward discovery)",
  );
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
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--trace-only", "Skip task execution and run only trace enrichment on the latest completed artifact run", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--commit", "Auto-commit checked task file after successful completion", false)
  .option("--commit-message <template>", "Commit message template (supports {{task}} and {{file}})")
  .option("--on-complete <command>", "Run a shell command after successful task completion")
  .option("--on-fail <command>", "Run a shell command when a task fails (execution or verification failure)")
  .option("--hide-agent-output", "Hide worker stdout/stderr during execution; show only rundown status messages.", false)
  .option("--all", "Run all tasks sequentially instead of stopping after one (alias: runall)", false)
  .option("--redo", "Reset all checkboxes in the source file before running", false)
  .option("--reset-after", "Reset all checkboxes in the source file after the run completes", false)
  .option("--clean", "Shorthand for --redo --reset-after", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring run locks", false)
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
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
    const clean = Boolean(opts.clean as boolean | undefined);
    const redo = Boolean(opts.redo as boolean | undefined) || clean;
    const resetAfter = Boolean(opts.resetAfter as boolean | undefined) || clean;
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    return getApp().runTask({
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
      redo,
      resetAfter,
      clean,
      forceUnlock,
    });
  }));

program
  .command("discuss")
  .description("Start an interactive discussion session for the next unchecked task.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--mode <mode>", "Discuss execution mode: wait, tui", "tui")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered discuss prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--hide-agent-output", "Hide worker stdout/stderr during execution; show only rundown status messages.", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring discuss locks", false)
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction(async (source: string, opts: Record<string, string | string[] | boolean>) => {
    const mode = parseRunnerMode(opts.mode as string | undefined, DISCUSS_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const hideAgentOutput = Boolean(opts.hideAgentOutput as boolean | undefined);
    const trace = Boolean(opts.trace as boolean | undefined);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;

    return getApp().discussTask({
      source,
      mode,
      transport,
      sortMode,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      hideAgentOutput,
      trace,
      forceUnlock,
    });
  }));

program
  .command("reverify")
  .description("Re-run verification for the previously completed task from saved artifacts.")
  .option("--run <id|latest>", "Choose artifact run id or 'latest'", "latest")
  .option("--last <n>", "Re-verify the last N completed runs")
  .option("--all", "Re-verify all completed runs", false)
  .option("--oldest-first", "Process selected runs in oldest-first order", false)
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--repair-attempts <n>", "Max repair attempts on verification failure", "1")
  .option("--no-repair", "Disable repair even when repair attempts are set")
  .option("--dry-run", "Show what would be executed without running it", false)
  .option("--print-prompt", "Print the rendered verify prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction((opts: Record<string, string | string[] | boolean>) => {
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const oldestFirst = Boolean(opts.oldestFirst as boolean | undefined);
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

    return getApp().reverifyTask({
      runId: targetRun,
      last,
      all,
      oldestFirst,
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
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .allowUnknownOption(false)
  .action(withCliAction((opts: Record<string, string | string[] | boolean>) => {
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const method = parseRevertMethod(opts.method as string | undefined);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const force = Boolean(opts.force as boolean | undefined);
    const keepArtifacts = Boolean(opts.keepArtifacts as boolean | undefined);

    return getApp().revertTask({
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
    return getApp().nextTask({
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
    return getApp().listTasks({
      source,
      sortMode: parseSortMode(opts.sort as string | undefined),
      includeAll: opts.all as boolean,
    });
  }));
program
  .command("artifacts")
  .description("List or clean saved runtime artifact runs under <config-dir>/runs.")
  .option("--clean", "Remove all saved runtime artifact runs", false)
  .option("--json", "Print saved runtime artifacts as JSON", false)
  .option("--failed", "Show only failed runtime artifact runs", false)
  .option("--open <runId>", "Open a saved runtime artifact folder by run id, unique prefix, or 'latest'")
  .action(withCliAction((opts: Record<string, boolean | string>) => {
    return getApp().manageArtifacts({
      clean: opts.clean as boolean,
      json: opts.json as boolean,
      failed: opts.failed as boolean,
      open: typeof opts.open === "string" ? opts.open : "",
    });
  }));
program
  .command("log")
  .description("Show completed run history in a compact log view.")
  .option("--revertable", "Show only runs that can be reverted", false)
  .option("--command <name>", "Filter runs by command name")
  .option("--limit <n>", "Show only the first N matching runs")
  .option("--json", "Print matching runs as JSON", false)
  .allowUnknownOption(false)
  .action(withCliAction((opts: Record<string, string | boolean>) => {
    return resolveLogCommandHandler(getApp())({
      revertable: Boolean(opts.revertable as boolean | undefined),
      commandName: normalizeOptionalString(opts.command),
      limit: parseLimitCount(opts.limit as string | undefined),
      json: Boolean(opts.json as boolean | undefined),
    });
  }));
program
  .command("plan")
  .description("Synthesize actionable TODOs for a Markdown document.")
  .argument("[markdown-file...]", "Markdown document to plan")
  .option("--scan-count <n>", "Max clean-session TODO coverage scans", String(DEFAULT_PLAN_SCAN_COUNT))
  .option("--mode <mode>", "Planner mode: wait", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--dry-run", "Show what would be planned without executing", false)
  .option("--print-prompt", "Print the rendered plan prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring plan lock", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .allowUnknownOption(false)
  .action(withCliAction((markdownFiles: string[], opts: Record<string, string | string[] | boolean>) => {
    const markdownFile = resolvePlanMarkdownFile(markdownFiles);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);
    const mode = parseRunnerMode(opts.mode as string | undefined, PLANNER_MODES);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];

    const workerCommand = Array.isArray(opts.worker)
      ? opts.worker
      : typeof opts.worker === "string"
        ? [opts.worker]
        : workerFromSeparator;
    return getApp().planTask({
      source: markdownFile,
      scanCount,
      mode,
      transport,
      dryRun,
      printPrompt,
      keepArtifacts,
      trace,
      forceUnlock,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
    });
  }));
program
  .command("unlock")
  .description("Manually release a stale source lockfile.")
  .argument("<source>", "Markdown source file path used to derive <config-dir>/locks/<basename>.lock")
  .allowUnknownOption(false)
  .action(withCliAction((source: string) => getApp().unlockTask({ source })));
program
  .command("init")
  .description("Create a .rundown/ directory with default templates (plan, execute, verify, repair, trace) plus vars.json and config.json. Use --config-dir to control where it is created.")
  .action(withCliAction(() => getApp().initProject()));
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

function parseLimitCount(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --limit value: ${value}. Must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --limit value: ${value}. Must be a safe positive integer.`);
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

function resolveExplicitConfigDirOption(): string | undefined {
  const opts = program.opts<{ configDir?: unknown }>();
  if (typeof opts.configDir !== "string") {
    return undefined;
  }

  return normalizeOptionalString(opts.configDir);
}

function validateExplicitConfigDirOption(invocationArgv: string[]): void {
  const configDir = resolveExplicitConfigDirOption();
  if (!configDir) {
    return;
  }

  const resolvedConfigDir = path.resolve(configDir);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedConfigDir);
  } catch {
    if (allowsMissingExplicitConfigDir(invocationArgv)) {
      return;
    }
    throw new Error(`Invalid --config-dir value: ${configDir}. Directory does not exist: ${resolvedConfigDir}.`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Invalid --config-dir value: ${configDir}. Path is not a directory: ${resolvedConfigDir}.`);
  }
}

function allowsMissingExplicitConfigDir(argv: string[]): boolean {
  return resolveInvocationCommand(argv) === "init";
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
      validateExplicitConfigDirOption(cliInvocationArgv ?? process.argv.slice(2));
      if (!app) {
        app = createAppForInvocation(cliInvocationArgv ?? process.argv.slice(2));
      }
      getLockReleaseState().app = app;
      const exitCode = await action(...args);
      terminate(exitCode);
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      emitCliFatalError(err);
      terminate(1);
    }
  };
}

function resolveLogCommandHandler(appInstance: ReturnType<typeof createApp>): LogCommandHandler {
  const maybeLogHandlers = appInstance as ReturnType<typeof createApp> & {
    logTask?: LogCommandHandler;
    logRuns?: LogCommandHandler;
  };

  if (typeof maybeLogHandlers.logTask === "function") {
    return maybeLogHandlers.logTask;
  }

  if (typeof maybeLogHandlers.logRuns === "function") {
    return maybeLogHandlers.logRuns;
  }

  throw new Error("The `log` command is not available in this build.");
}

export async function parseCliArgs(argv: string[]): Promise<void> {
  const rewrittenArgv = rewriteRunallAlias(argv);
  const { rundownArgs, workerFromSeparator: workerCommandArgs } = splitWorkerFromSeparator(rewrittenArgv);
  app = undefined;
  cliInvocationArgv = rewrittenArgv;
  cliInvocationLogState = createCliInvocationLogState(rewrittenArgv);
  getLockReleaseState().app = undefined;
  if (shouldInitializeAppBeforeParse(rundownArgs)) {
    app = createAppForInvocation(rewrittenArgv);
    getLockReleaseState().app = app;
  }
  registerLockReleaseSignalHandlers();
  workerFromSeparator = workerCommandArgs;
  await program.parseAsync(rundownArgs, { from: "user" });
}

function shouldInitializeAppBeforeParse(argv: string[]): boolean {
  if (argv.length === 0) {
    return true;
  }

  const command = resolveInvocationCommand(argv);
  return command === "rundown";
}

if (process.env.RUNDOWN_DISABLE_AUTO_PARSE !== "1") {
  parseCliArgs(process.argv.slice(2)).catch((err) => {
    if (isCliExitSignal(err)) {
      process.exit(err.code);
    }
    emitCliFatalError(err);
    process.exit(1);
  });
}

function createCliInvocationLogState(argv: string[]): CliInvocationLogState {
  const invocationArgv = [...argv];
  const context: LoggedOutputContext = {
    command: resolveInvocationCommand(invocationArgv),
    argv: invocationArgv,
    cwd: process.cwd(),
    pid: process.pid,
    version: cliVersion,
    sessionId: createSessionId(),
  };
  const resolvedConfigDir = resolveConfigDirPathForInvocation(invocationArgv, context.cwd);

  return {
    writer: createGlobalOutputLogWriter(
      globalOutputLogFilePath(resolvedConfigDir),
      createNodeFileSystem(),
    ),
    context,
  };
}

function resolveConfigDirPathForInvocation(argv: string[], cwd: string): string {
  const resolvedConfigDir = resolveConfigDirForInvocation(argv, cwd)?.configDir;
  return resolvedConfigDir ?? path.join(cwd, CONFIG_DIR_NAME);
}

function emitCliFatalError(error: unknown): void {
  const message = String(error);
  console.error(pc.red("✖") + " " + message);
  appendCliFatalErrorToGlobalLog(message);
}

function appendCliFatalErrorToGlobalLog(message: string): void {
  const state = cliInvocationLogState;
  if (!state) {
    return;
  }

  try {
    state.writer.write({
      ts: new Date().toISOString(),
      level: "error",
      stream: "stderr",
      kind: "cli-fatal",
      message,
      command: state.context.command,
      argv: state.context.argv,
      cwd: state.context.cwd,
      pid: state.context.pid,
      version: state.context.version,
      session_id: state.context.sessionId,
    });
  } catch {
    // best-effort logging: never interrupt command flow on log write failures
  }
}

function configureCommanderOutputHandlers(command: Command): void {
  command.configureOutput({
    writeOut(output: string) {
      process.stdout.write(output);
      appendCommanderFrameworkOutputToGlobalLog(output, "stdout");
    },
    writeErr(output: string) {
      process.stderr.write(output);
      appendCommanderFrameworkOutputToGlobalLog(output, "stderr");
    },
  });
}

function appendCommanderFrameworkOutputToGlobalLog(message: string, stream: "stdout" | "stderr"): void {
  if (message.length === 0) {
    return;
  }

  const state = cliInvocationLogState;
  if (!state) {
    return;
  }

  try {
    state.writer.write({
      ts: new Date().toISOString(),
      level: stream === "stderr" ? "error" : "info",
      stream,
      kind: "commander",
      message,
      command: state.context.command,
      argv: state.context.argv,
      cwd: state.context.cwd,
      pid: state.context.pid,
      version: state.context.version,
      session_id: state.context.sessionId,
    });
  } catch {
    // best-effort logging: never interrupt command flow on log write failures
  }
}

function splitWorkerFromSeparator(argv: string[]): { rundownArgs: string[]; workerFromSeparator: string[] } {
  const sepIndex = argv.indexOf("--");
  return {
    rundownArgs: sepIndex !== -1 ? argv.slice(0, sepIndex) : argv,
    workerFromSeparator: sepIndex !== -1 ? argv.slice(sepIndex + 1) : [],
  };
}

function rewriteRunallAlias(argv: string[]): string[] {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      break;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (token === "runall") {
      return [...argv.slice(0, i), "run", "--all", ...argv.slice(i + 1)];
    }

    break;
  }

  return argv;
}

function resolveInvocationCommand(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === "--config-dir") {
      index += 1;
      continue;
    }

    if (token.startsWith("--config-dir=")) {
      continue;
    }

    if (!token.startsWith("-")) {
      return token;
    }
  }

  return "rundown";
}

function terminate(code: number): never {
  if (process.env[EXIT_TEST_MODE_ENV] === "1") {
    throw new CliExitSignal(code);
  }
  process.exit(code);
}

function isCliExitSignal(error: unknown): error is CliExitSignal {
  if (error instanceof CliExitSignal) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  const maybeMessage = (error as { message?: unknown }).message;
  return typeof maybeCode === "number"
    && Number.isInteger(maybeCode)
    && typeof maybeMessage === "string"
    && maybeMessage.startsWith("CLI exited with code ");
}
