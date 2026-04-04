import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { ProcessRunMode } from "../domain/ports/index.js";
import { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "../domain/ports/command-executor.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import { collectOption } from "./cli-options.js";
import { registerLockReleaseSignalHandlers } from "./cli-lock-handlers.js";
import {
  configureCommanderOutputHandlers,
  createCliInvocationLogState,
  emitCliFatalError,
} from "./cli-invocation-log.js";
import type { CliInvocationLogState } from "./cli-invocation-types.js";
import {
  createAppForInvocation,
  resolveConfigDirForInvocation,
  type CliApp,
  validateExplicitConfigDirOption,
} from "./cli-app-init.js";
import {
  createSessionId,
  isCliExitSignal,
  readCliVersion,
  resolveInvocationCommand,
  rewriteAllAlias,
  splitWorkerFromSeparator,
  terminate,
} from "./cli-argv.js";
import {
  createArtifactsCommandAction,
  createCallCommandAction,
  createDiscussCommandAction,
  createDoCommandAction,
  createInitCommandAction,
  createIntroCommandAction,
  createListCommandAction,
  createLogCommandAction,
  createMakeCommandAction,
  createNextCommandAction,
  createPlanCommandAction,
  createResearchCommandAction,
  createReverifyCommandAction,
  createRevertCommandAction,
  createRunCommandAction,
  createUnlockCommandAction,
} from "./cli-command-actions.js";

const RUNNER_MODES: readonly ProcessRunMode[] = ["wait", "tui", "detached"];
const PLANNER_MODES: readonly ProcessRunMode[] = ["wait"];
const DISCUSS_MODES: readonly ProcessRunMode[] = ["wait", "tui"];
const RESEARCH_MODES: readonly ProcessRunMode[] = ["wait", "tui"];
const MAKE_MODES: readonly ProcessRunMode[] = ["wait"];
const DO_MODES: readonly ProcessRunMode[] = ["wait"];
const DEFAULT_PLAN_SCAN_COUNT = 3;
const DEFAULT_PLAN_DEEP = 0;
const DEFAULT_VARS_FILE_HELP = "Load extra template variables from a JSON file (default: <config-dir>/vars.json)";
const STALE_CALL_CLI_CACHE_RELATIVE_PATH = path.join("cache", "cli-blocks");

type CliActionResult = number | Promise<number>;

interface CliRuntimeState {
  workerFromSeparator: string[];
  invocationLogState: CliInvocationLogState | undefined;
  invocationArgv: string[] | undefined;
  app: CliApp | undefined;
}

// Shared mutable runtime state for the current CLI process invocation.
const runtimeState: CliRuntimeState = {
  workerFromSeparator: [],
  invocationLogState: undefined,
  invocationArgv: undefined,
  app: undefined,
};

const program = new Command();
const cliVersion = readCliVersion();

/**
 * Returns the initialized CLI app instance for command actions.
 *
 * Throws when command execution is attempted before invocation setup completes.
 */
function getApp(): CliApp {
  if (!runtimeState.app) {
    throw new Error("CLI app is not initialized. Call parseCliArgs(...) before invoking commands.");
  }
  return runtimeState.app;
}

// Route commander framework output through invocation-aware logging handlers.
configureCommanderOutputHandlers(program, () => runtimeState.invocationLogState);

program
  .name("rundown")
  .description("A Markdown-native task runtime for agentic workflows.")
  .version(cliVersion)
  .option(
    "--config-dir <path>",
    "Explicit path to the .rundown configuration directory (bypasses upward discovery)",
  );

const runCommand = program
  .command("run")
  .description("Find the next unchecked TODO and execute it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .configureHelp({ showGlobalOptions: true });

configureRunLikeCommandOptions(runCommand)
  .allowUnknownOption(false)
  .action(withCliAction(createRunCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    runnerModes: RUNNER_MODES,
  })));

const callCommand = program
  .command("call")
  .description("Run a full clean pass across all tasks with CLI block caching enabled.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .configureHelp({ showGlobalOptions: true });

configureRunLikeCommandOptions(callCommand)
  .allowUnknownOption(false)
  .action(withCliAction(createCallCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    runnerModes: RUNNER_MODES,
  })));

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
  .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring discuss locks", false)
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createDiscussCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    discussModes: DISCUSS_MODES,
  })));

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
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createReverifyCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
  })));

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
  .action(withCliAction(createRevertCommandAction({ getApp })));

program
  .command("next")
  .description("Show the next unchecked task without executing it.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .action(withCliAction(createNextCommandAction({ getApp })));

program
  .command("list")
  .description("List all unchecked tasks across the source.")
  .argument("<source>", "File, directory, or glob to scan for Markdown tasks")
  .option("--sort <sort>", "File sort mode: name-sort, none, old-first, new-first", "name-sort")
  .option("--all", "Show all tasks including checked ones", false)
  .action(withCliAction(createListCommandAction({ getApp })));

program
  .command("artifacts")
  .description("List or clean saved runtime artifact runs under <config-dir>/runs.")
  .option("--clean", "Remove all saved runtime artifact runs", false)
  .option("--json", "Print saved runtime artifacts as JSON", false)
  .option("--failed", "Show only failed runtime artifact runs", false)
  .option("--open <runId>", "Open a saved runtime artifact folder by run id, unique prefix, or 'latest'")
  .action(withCliAction(createArtifactsCommandAction({ getApp })));

program
  .command("log")
  .description("Show completed run history in a compact log view.")
  .option("--revertable", "Show only runs that can be reverted", false)
  .option("--command <name>", "Filter runs by command name")
  .option("--limit <n>", "Show only the first N matching runs")
  .option("--json", "Print matching runs as JSON", false)
  .allowUnknownOption(false)
  .action(withCliAction(createLogCommandAction({ getApp })));

program
  .command("plan")
  .description("Synthesize actionable TODOs for a Markdown document.")
  .argument("[markdown-file...]", "Markdown document to plan")
  .option(
    "--scan-count <n>",
    "Max clean-session TODO coverage scans (default: 3)",
    String(DEFAULT_PLAN_SCAN_COUNT),
  )
  .option(
    "--deep <n>",
    "Additional nested planning depth passes after top-level scans (default: 0)",
    String(DEFAULT_PLAN_DEEP),
  )
  .option("--mode <mode>", "Planner mode: wait", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--dry-run", "Show what would be planned without executing", false)
  .option("--print-prompt", "Print the rendered plan prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
  .option("--no-show-agent-output", "Hide worker stdout/stderr during execution.")
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring plan lock", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createPlanCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    plannerModes: PLANNER_MODES,
  })));

program
  .command("make")
  .description("Create a Markdown task doc from seed text, then run research and plan.")
  .argument("<seed-text>", "Initial text content to write into the Markdown file")
  .argument("<markdown-file>", "Markdown file path to create")
  .option("--mode <mode>", "Make mode: wait", "wait")
  .option(
    "--scan-count <n>",
    "Max clean-session TODO coverage scans for the plan phase (default: 3)",
    String(DEFAULT_PLAN_SCAN_COUNT),
  )
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--dry-run", "Show what would run for research and plan without executing workers", false)
  .option("--print-prompt", "Print rendered research/plan prompts and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring phase locks", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createMakeCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    makeModes: MAKE_MODES,
  })));

program
  .command("do")
  .description("Bootstrap with make, then execute all tasks against the same Markdown file.")
  .argument("<seed-text>", "Initial text content to write into the Markdown file")
  .argument("<markdown-file>", "Markdown file path to create")
  .option("--mode <mode>", "Do mode: wait", "wait")
  .option(
    "--scan-count <n>",
    "Max clean-session TODO coverage scans for the plan phase (default: 3)",
    String(DEFAULT_PLAN_SCAN_COUNT),
  )
  .option("--sort <sort>", "File sort mode for execution phase: name-sort, none, old-first, new-first", "name-sort")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--verify", "Run verification after task execution (default)")
  .option("--no-verify", "Disable verification after task execution")
  .option("--only-verify", "Skip execution and run verification directly", false)
  .option("--force-execute", "Force execute phase even for verify-only task text", false)
  .option("--repair-attempts <n>", "Max repair attempts on verification failure", "1")
  .option("--no-repair", "Disable repair even when repair attempts are set")
  .option("--dry-run", "Show what would run for bootstrap and execution without executing workers", false)
  .option("--print-prompt", "Print rendered prompts and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--trace-only", "Skip task execution and run only trace enrichment on the latest completed artifact run", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring phase locks", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--commit", "Auto-commit checked task file after successful completion", false)
  .option("--commit-message <template>", "Commit message template (supports {{task}} and {{file}})")
  .option("--on-complete <command>", "Run a shell command after successful task completion")
  .option("--on-fail <command>", "Run a shell command when a task fails (execution or verification failure)")
  .option("--redo", "Reset all checkboxes in the source file before running", false)
  .option("--reset-after", "Reset all checkboxes in the source file after the run completes", false)
  .option("--clean", "Shorthand for --redo --reset-after", false)
  .option("--rounds <n>", "Repeat clean cycles N times (default: 1)")
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option("--cache-cli-blocks", "Cache `cli` fenced block command output for the duration of this run", false)
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createDoCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    makeModes: DO_MODES,
  })));

program
  .command("research")
  .description("Enrich a Markdown document with implementation context and planning scaffolding.")
  .argument("[markdown-file...]", "Markdown document to enrich")
  .option("--mode <mode>", "Research mode: wait, tui", "wait")
  .option("--transport <transport>", "Prompt transport: file, arg", "file")
  .option("--dry-run", "Show what would be researched without executing", false)
  .option("--print-prompt", "Print the rendered research prompt and exit", false)
  .option("--keep-artifacts", "Preserve runtime prompts, logs, and metadata under <config-dir>/runs", false)
  .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
  .option("--trace", "Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl", false)
  .option("--force-unlock", "Break stale source lockfiles before acquiring research lock", false)
  .option("--vars-file [path]", DEFAULT_VARS_FILE_HELP)
  .option("--var <key=value>", "Template variable to inject into prompts (repeatable)", collectOption, [])
  .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
  .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
  .option(
    "--cli-block-timeout <ms>",
    "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
    String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
  )
  .allowUnknownOption(false)
  .action(withCliAction(createResearchCommandAction({
    getApp,
    getWorkerFromSeparator: () => runtimeState.workerFromSeparator,
    researchModes: RESEARCH_MODES,
  })));

program
  .command("unlock")
  .description("Manually release a stale source lockfile.")
  .argument("<source>", "Markdown source file path used to derive <config-dir>/locks/<basename>.lock")
  .allowUnknownOption(false)
  .action(withCliAction(createUnlockCommandAction({ getApp })));

program
  .command("init")
  .description("Create a .rundown/ directory with default templates (plan, execute, verify, repair, trace) plus vars.json/config.json initialized as empty JSON objects. Use --config-dir to control where it is created.")
  .action(withCliAction(createInitCommandAction({ getApp })));

program
  .command("intro")
  .description("Display an animated introduction to rundown — concepts, workflow, and commands.")
  .action(async () => {
    try {
      const exitCode = await createIntroCommandAction({ version: cliVersion })();
      terminate(exitCode);
    } catch (err) {
      if (isCliExitSignal(err)) {
        throw err;
      }
      emitCliFatalError(err, runtimeState.invocationLogState);
      terminate(1);
    }
  });

/**
 * Wraps a command action with shared CLI initialization and fatal error handling.
 *
 * The wrapper ensures config validation and app/log initialization occur once per
 * invocation before command-specific behavior executes.
 */
function withCliAction<Args extends unknown[]>(
  action: (...args: Args) => CliActionResult,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      // Validate explicit config-dir input early so command actions receive a valid app context.
      validateExplicitConfigDirOption(
        runtimeState.invocationArgv ?? process.argv.slice(2),
        program.opts<{ configDir?: unknown }>().configDir,
      );
      if (!runtimeState.app) {
        // Lazily construct the app so parse-time commands can avoid unnecessary setup.
        const initResult = createAppForInvocation(runtimeState.invocationArgv ?? process.argv.slice(2), {
          cliVersion,
          createSessionId,
          resolveInvocationCommand,
          logState: runtimeState.invocationLogState,
        });
        runtimeState.app = initResult.app;
        runtimeState.invocationLogState = initResult.logState;
      }

      // Command actions return an exit code that is normalized through terminate().
      const exitCode = await action(...args);
      terminate(exitCode);
    } catch (err) {
      // Preserve intentional process termination behavior used in tests and command flow control.
      if (isCliExitSignal(err)) {
        throw err;
      }

      // Emit a structured fatal error and exit with a non-zero code for unexpected failures.
      emitCliFatalError(err, runtimeState.invocationLogState);
      terminate(1);
    }
  };
}

/**
 * Parses CLI arguments, prepares invocation context, and executes the selected command.
 *
 * This is the primary presentation entry point used by both production runtime and tests.
 */
export async function parseCliArgs(argv: string[]): Promise<void> {
  // Normalize legacy aliases before any option parsing occurs.
  const rewrittenArgv = rewriteAllAlias(argv);
  // Split rundown-owned arguments from downstream worker arguments after `--`.
  const { rundownArgs, workerFromSeparator: workerCommandArgs } = splitWorkerFromSeparator(rewrittenArgv);

  // Reset invocation-scoped state so each parse call starts from a clean baseline.
  runtimeState.app = undefined;
  runtimeState.invocationArgv = rewrittenArgv;
  runtimeState.invocationLogState = createCliInvocationLogState(rewrittenArgv, {
    cliVersion,
    createSessionId,
    resolveInvocationCommand,
    resolveConfigDirForInvocation,
  });

  cleanupCallCliCacheArtifactAtStartup(rewrittenArgv);

  // Pre-initialize the app only for the root command path where parse-time access is required.
  if (shouldInitializeAppBeforeParse(rundownArgs)) {
    const initResult = createAppForInvocation(rewrittenArgv, {
      cliVersion,
      createSessionId,
      resolveInvocationCommand,
      logState: runtimeState.invocationLogState,
    });
    runtimeState.app = initResult.app;
    runtimeState.invocationLogState = initResult.logState;
  }

  // Register cleanup handlers once invocation state has been prepared.
  registerLockReleaseSignalHandlers({
    terminate,
    getAppForCleanup: () => runtimeState.app,
  });
  runtimeState.workerFromSeparator = workerCommandArgs;

  try {
    // Keep research as a strict single-pass workflow for this iteration.
    validateUnsupportedResearchScanCount(rundownArgs);
    validateUnsupportedMakeMode(rundownArgs);
    validateUnsupportedDoMode(rundownArgs);
  } catch (error) {
    emitCliFatalError(error, runtimeState.invocationLogState);
    terminate(1);
    return;
  }

  try {
    // Delegate command dispatch and argument validation to commander.
    await program.parseAsync(rundownArgs, { from: "user" });
  } finally {
    cleanupCallCliCacheArtifactAtTeardown(rewrittenArgv, runtimeState.invocationLogState);
  }
}

/**
 * Removes stale call-session CLI cache artifacts from disk before command execution.
 */
function cleanupCallCliCacheArtifactAtStartup(argv: string[]): void {
  if (resolveInvocationCommand(argv) !== "call") {
    return;
  }

  const resolvedConfigDir = resolveConfigDirForInvocation(argv)?.configDir
    ?? path.join(process.cwd(), CONFIG_DIR_NAME);
  const cacheArtifactPath = path.join(resolvedConfigDir, STALE_CALL_CLI_CACHE_RELATIVE_PATH);

  try {
    fs.rmSync(cacheArtifactPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      "Failed to clean stale CLI cache artifact before `call`: "
      + cacheArtifactPath
      + ". "
      + String(error),
    );
  }
}

/**
 * Removes call-session CLI cache artifacts from disk during command teardown.
 */
function cleanupCallCliCacheArtifactAtTeardown(
  argv: string[],
  logState: CliInvocationLogState | undefined,
): void {
  if (resolveInvocationCommand(argv) !== "call") {
    return;
  }

  const resolvedConfigDir = resolveConfigDirForInvocation(argv)?.configDir
    ?? path.join(process.cwd(), CONFIG_DIR_NAME);
  const cacheArtifactPath = path.join(resolvedConfigDir, STALE_CALL_CLI_CACHE_RELATIVE_PATH);

  try {
    fs.rmSync(cacheArtifactPath, { recursive: true, force: true });
  } catch (error) {
    emitCliFatalError(
      new Error(
        "Failed to tear down CLI cache artifact after `call`: "
        + cacheArtifactPath
        + ". "
        + String(error),
      ),
      logState,
    );
  }
}

/**
 * Rejects plan-style scan/convergence options for `research`.
 */
function validateUnsupportedResearchScanCount(argv: string[]): void {
  if (resolveInvocationCommand(argv) !== "research") {
    return;
  }

  const hasScanCountOption = argv.some((token) => token === "--scan-count" || token.startsWith("--scan-count="));
  if (!hasScanCountOption) {
    return;
  }

  throw new Error("Unsupported option for `research`: --scan-count. Research currently runs as a single-pass flow and does not support scan/convergence loops.");
}

/**
 * Rejects interactive or detached execution modes for `make`.
 */
function validateUnsupportedMakeMode(argv: string[]): void {
  if (resolveInvocationCommand(argv) !== "make") {
    return;
  }

  const mode = resolveModeOptionValue(argv);
  if (mode === undefined || mode === "wait") {
    return;
  }

  throw new Error(`Invalid --mode value: ${mode}. Allowed: wait.`);
}

/**
 * Registers the full run-style option set on commands that execute tasks.
 */
function configureRunLikeCommandOptions(command: Command): Command {
  return command
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
    .option("--show-agent-output", "Show worker stdout/stderr during execution (hidden by default).", false)
    .option("--all", "Run all tasks sequentially instead of stopping after one (alias: all)", false)
    .option("--redo", "Reset all checkboxes in the source file before running", false)
    .option("--reset-after", "Reset all checkboxes in the source file after the run completes", false)
    .option("--clean", "Shorthand for --redo --reset-after", false)
    .option("--rounds <n>", "Repeat clean cycles N times (default: 1)")
    .option("--force-unlock", "Break stale source lockfiles before acquiring run locks", false)
    .option("--worker [command...]", "Optional worker command override (alternative to -- <command>)")
    .option("--ignore-cli-block", "Disable execution of `cli` fenced blocks during prompt expansion")
    .option("--cache-cli-blocks", "Cache `cli` fenced block command output for the duration of this run", false)
    .option(
      "--cli-block-timeout <ms>",
      "Timeout in milliseconds for executing `cli` fenced blocks (0 disables timeout)",
      String(DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS),
    );
}

/**
 * Rejects interactive or detached execution modes for `do`.
 */
function validateUnsupportedDoMode(argv: string[]): void {
  if (resolveInvocationCommand(argv) !== "do") {
    return;
  }

  const mode = resolveModeOptionValue(argv);
  if (mode === undefined || mode === "wait") {
    return;
  }

  throw new Error(`Invalid --mode value: ${mode}. Allowed: wait.`);
}

/**
 * Resolves the effective --mode option value from argv tokens.
 */
function resolveModeOptionValue(argv: string[]): string | undefined {
  let mode: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      break;
    }

    if (token === "--mode") {
      const nextToken = argv[index + 1];
      if (nextToken !== undefined && nextToken !== "--") {
        mode = nextToken;
      }
      index += 1;
      continue;
    }

    if (token.startsWith("--mode=")) {
      mode = token.slice("--mode=".length);
    }
  }

  return mode;
}

/**
 * Determines whether app initialization must happen before commander parsing.
 *
 * The root invocation path may require immediate app access prior to action execution.
 */
function shouldInitializeAppBeforeParse(argv: string[]): boolean {
  if (argv.length === 0) {
    return true;
  }

  const command = resolveInvocationCommand(argv);
  return command === "rundown";
}

// Auto-parse process arguments unless explicitly disabled for embedding or tests.
if (process.env.RUNDOWN_DISABLE_AUTO_PARSE !== "1") {
  parseCliArgs(process.argv.slice(2)).catch((err) => {
    if (isCliExitSignal(err)) {
      process.exit(err.code);
    }
    emitCliFatalError(err, runtimeState.invocationLogState);
    process.exit(1);
  });
}
