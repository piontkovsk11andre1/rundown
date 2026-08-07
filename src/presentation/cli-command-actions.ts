import type { ProcessRunMode } from "../domain/ports/index.js";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { createWorkerConfigAdapter } from "../infrastructure/adapters/worker-config-adapter.js";
import { resolveConfigDirForInvocation } from "./cli-app-init.js";
import {
  normalizeOptionalString,
  parseCliBlockTimeout,
  parseQueryOutputFormat,
  parseForceAttempts,
  parseLastCount,
  parseLimitCount,
  parseLoopCooldownSeconds,
  parseLoopIterations,
  parseLoopTimeLimitSeconds,
  parseMaxItems,
  parseRepairAttempts,
  parseResolveRepairAttempts,
  parseRevertMethod,
  parseRounds,
  parseRunnerMode,
  parseCommitMode,
  parsePlanDeep,
  parseScanCount,
  parseSortMode,
  resolveSharedWorkerRuntimeOptions,
  resolveShowAgentOutputOption,
  resolveVerboseOption,
  resolveIgnoreCliBlockFlag,
  resolveNoRepairFlag,
  resolveAddMarkdownFile,
  resolveDiscussMarkdownFile,
  resolvePlanMarkdownFile,
  resolveResearchMarkdownFile,
  resolveMakeMarkdownFile,
  resolveTranslateMarkdownFiles,
  resolveVerifyFlag,
} from "./cli-options.js";
import type { RunDefaultsConfig } from "../domain/worker-config.js";
import { cancellableSleep } from "../infrastructure/cancellable-sleep.js";
import { resolveInvocationCommand } from "./cli-argv.js";
import {
  inferWorkerPatternFromCommand,
  parseWorkerPattern,
  type ParsedWorkerPattern,
} from "../domain/worker-pattern.js";
import { parsePrefixChain, type PrefixChain } from "../domain/prefix-chain.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type { CliApp } from "./cli-app-init.js";
import type {
  PlanCommandInvocationOptions,
  QueryCommandInvocationOptions,
  ResearchCommandInvocationOptions,
  TranslateCommandInvocationOptions,
} from "./cli-invocation-types.js";
import { resolveInvocationWorkspaceContext } from "./invocation-workspace-context.js";
import {
  createNodeFileSystem,
  createNodePathOperationsAdapter,
  createToolResolverAdapter,
} from "../infrastructure/adapters/index.js";
import type {
  WithTaskConfiguredKeyResult,
  WithTaskResult,
} from "../application/with-task.js";
import { hasWithTaskInteractiveWorker } from "../application/with-task.js";
import { runRootTui } from "./tui/index.js";

type CliActionResult = number | Promise<number>;
type CliOpts = Record<string, string | string[] | boolean>;

interface LogCommandOptions {
  revertable: boolean;
  commandName?: string;
  limit?: number;
  json: boolean;
}

type LogCommandHandler = (options: LogCommandOptions) => CliActionResult;

interface WorkerActionDependencies {
  getApp: () => CliApp;
  getWorkerFromSeparator: () => string[] | undefined;
  getInvocationArgv?: () => string[];
}

interface WorkerWorkspaceRuntimeOptions {
  cwd: string;
  invocationDir: string;
  workspaceDir: string;
  workspaceLinkPath: string;
  isLinkedWorkspace: boolean;
}

interface HelpActionDependencies extends WorkerActionDependencies {
  outputHelp: () => void;
  cliVersion: string;
  isInteractiveTerminal?: () => boolean;
  getInvocationArgv?: () => string[];
}

function emitCliInfo(app: CliApp, message: string): void {
  app.emitOutput?.({ kind: "info", message });
}

function resolveInvocationArgv(getInvocationArgv: (() => string[]) | undefined): string[] {
  return getInvocationArgv?.() ?? process.argv.slice(2);
}

function hasCliOption(argv: string[], optionName: string): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === optionName || token.startsWith(optionName + "=")) {
      return true;
    }
  }

  return false;
}

function resolveCliOptionValue(argv: string[], optionName: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === optionName) {
      const next = argv[index + 1];
      if (typeof next === "string" && next !== "--") {
        return next;
      }
      continue;
    }

    if (token.startsWith(optionName + "=")) {
      return token.slice((optionName + "=").length);
    }
  }

  return undefined;
}

function hasCliFlag(argv: string[], optionName: string): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === optionName) {
      return true;
    }
  }

  return false;
}

function hasShortCliFlag(argv: string[], shortFlag: string): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (!token.startsWith("-") || token.startsWith("--") || token.length <= 2) {
      continue;
    }

    const flagSegment = token.slice(1).split("=", 1)[0] ?? "";
    if (/^[A-Za-z]+$/.test(flagSegment) && flagSegment.includes(shortFlag)) {
      return true;
    }
  }

  return false;
}

function resolveRunCommandNameOption(value: string | string[] | boolean | undefined): "run" | "materialize" {
  return value === "materialize" ? "materialize" : "run";
}

function hasRootContinueFlag(argv: string[]): boolean {
  return hasCliOption(argv, "--continue") || hasCliFlag(argv, "-c") || hasShortCliFlag(argv, "c");
}

function isContinueFlagToken(token: string): boolean {
  return token === "-c" || token === "--continue" || token.startsWith("--continue=");
}

function appendCanonicalContinueFlag(workerCommand: string[]): string[] {
  if (workerCommand.some((token) => isContinueFlagToken(token))) {
    return [...workerCommand];
  }

  return [...workerCommand, "--continue"];
}

function loadRunDefaultsFromConfig(invocationArgv: string[]): RunDefaultsConfig | undefined {
  const configDir = resolveConfigDirForInvocation(invocationArgv)?.configDir;
  if (!configDir) {
    return undefined;
  }

  const loadedConfig = createWorkerConfigAdapter().load(configDir);
  return loadedConfig?.run;
}

function loadAutoCompactDefaultsFromConfig(invocationArgv: string[]): AutoCompactCliOptions | undefined {
  const configDir = resolveConfigDirForInvocation(invocationArgv)?.configDir;
  if (!configDir) {
    return undefined;
  }

  const loadedConfig = createWorkerConfigAdapter().load(configDir);
  return {
    beforeExit: loadedConfig?.autoCompact?.beforeExit === true,
  };
}

function resolveWorkerWorkspaceRuntimeOptions(): WorkerWorkspaceRuntimeOptions {
  const workspaceContext = resolveInvocationWorkspaceContext();
  return {
    cwd: workspaceContext.workspaceDir,
    invocationDir: workspaceContext.invocationDir,
    workspaceDir: workspaceContext.workspaceDir,
    workspaceLinkPath: workspaceContext.workspaceLinkPath,
    isLinkedWorkspace: workspaceContext.isLinkedWorkspace,
  };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stderr.isTTY);
}

function isInteractiveHelpInvocationCommand(command: string): boolean {
  return command === "rundown" || command === "agent";
}

/**
 * Creates the root no-args action handler.
 *
 * The returned action starts interactive help when the terminal supports TTY and
 * a help worker is available; otherwise it falls back to static Commander help.
 */
export function createHelpCommandAction({
  getApp,
  getWorkerFromSeparator,
  outputHelp,
  cliVersion,
  isInteractiveTerminal: isInteractiveTerminalOverride,
  getInvocationArgv,
}: HelpActionDependencies): () => CliActionResult {
  return async () => {
    const invocationArgv = getInvocationArgv?.() ?? process.argv.slice(2);
    const continueSession = hasRootContinueFlag(invocationArgv);
    const workerOption = resolveCliOptionValue(invocationArgv, "--worker");
    if (!isInteractiveHelpInvocationCommand(resolveInvocationCommand(invocationArgv))) {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    if (!(isInteractiveTerminalOverride ?? isInteractiveTerminal)()) {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    try {
      const workerFromSeparator = getWorkerFromSeparator();
      const workerOverride = workerOption
        ?? (continueSession && Array.isArray(workerFromSeparator)
          ? appendCanonicalContinueFlag(workerFromSeparator)
          : undefined);
      const workerPattern = resolveWorkerPattern(
        workerOverride,
        getWorkerFromSeparator,
      );
      const exitCode = await getApp().helpTask({
        workerPattern,
        keepArtifacts: false,
        trace: hasTraceFlag(invocationArgv),
        cliVersion,
        continueSession,
      });

      if (exitCode === EXIT_CODE_NO_WORK) {
        outputHelp();
        return EXIT_CODE_SUCCESS;
      }

      return exitCode;
    } catch {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }
  };
}

/**
 * Creates the root no-args action handler that launches the TUI scaffold.
 *
 * The returned action keeps static help behavior for non-root/non-interactive
 * invocations.
 */
export function createRootTuiAction({
  getApp,
  getWorkerFromSeparator,
  outputHelp,
  cliVersion,
  isInteractiveTerminal: isInteractiveTerminalOverride,
  getInvocationArgv,
}: HelpActionDependencies): () => CliActionResult {
  return async () => {
    const invocationArgv = resolveInvocationArgv(getInvocationArgv);
    if (resolveInvocationCommand(invocationArgv) !== "rundown") {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    if (!(isInteractiveTerminalOverride ?? isInteractiveTerminal)()) {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    return runRootTui({
      app: getApp(),
      workerPattern: resolveWorkerPattern(undefined, getWorkerFromSeparator),
      cliVersion,
      argv: invocationArgv,
    });
  };
}

function hasTraceFlag(argv: string[]): boolean {
  for (const token of argv) {
    if (token === "--") {
      break;
    }

    if (token === "--trace") {
      return true;
    }
  }

  return false;
}

function resolveTraceFlag(opts: CliOpts, getInvocationArgv?: () => string[]): boolean {
  if (Boolean(opts.trace as boolean | undefined)) {
    return true;
  }

  const invocationArgv = getInvocationArgv
    ? resolveInvocationArgv(getInvocationArgv)
    : process.argv.slice(2);

  return hasTraceFlag(invocationArgv);
}

function resolveSharedRuntimeOptionsWithTrace(
  opts: CliOpts,
  getWorkerFromSeparator: () => string[] | undefined,
  getInvocationArgv?: () => string[],
): ReturnType<typeof resolveSharedWorkerRuntimeOptions> {
  return {
    ...resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator),
    trace: resolveTraceFlag(opts, getInvocationArgv),
  };
}

interface RunActionDependencies extends WorkerActionDependencies {
  runnerModes: readonly ProcessRunMode[];
}

type CallActionDependencies = RunActionDependencies;
type MaterializeActionDependencies = RunActionDependencies;

interface LoopActionDependencies extends WorkerActionDependencies {
  runnerModes: readonly ProcessRunMode[];
  setLoopSignalExitCode?: (code: number) => void;
}

interface DiscussActionDependencies extends WorkerActionDependencies {
  discussModes: readonly ProcessRunMode[];
}

interface PlanActionDependencies extends WorkerActionDependencies {
  plannerModes: readonly ProcessRunMode[];
}

interface ResearchActionDependencies extends WorkerActionDependencies {
  researchModes: readonly ProcessRunMode[];
}

interface MakeActionDependencies extends WorkerActionDependencies {
  makeModes: readonly ProcessRunMode[];
}

interface TranslateActionDependencies extends WorkerActionDependencies {
  translateModes: readonly ProcessRunMode[];
}

interface AddActionDependencies extends WorkerActionDependencies {
  addModes: readonly ProcessRunMode[];
}

interface ExploreActionDependencies extends WorkerActionDependencies {
  exploreModes: readonly ProcessRunMode[];
}

interface DoActionDependencies extends WorkerActionDependencies {
  makeModes: readonly ProcessRunMode[];
}

interface QueryActionDependencies extends WorkerActionDependencies {
  queryModes: readonly ProcessRunMode[];
}

type TestAction = "now" | "future" | "new";

type MigrateSourceMode = "design" | "implementation" | "prediction";

interface MigrateCommandOptions {
  action?: "new";
  title?: string;
  dir?: string;
  workspace?: string;
  sourceMode?: MigrateSourceMode;
  fromFile?: string;
  autoCompact: AutoCompactCliOptions;
  confirm: boolean;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern?: ParsedWorkerPattern;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
}

interface PredictCommandOptions {
  dir?: string;
  workspace?: string;
  workerPattern: ParsedWorkerPattern;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
}

interface SnapshotCommandOptions {
  workspace?: string;
}

interface AutoCompactCliOptions {
  beforeExit: boolean;
}

type MigrateCommandHandler = (options: MigrateCommandOptions) => CliActionResult;
type PredictCommandHandler = (options: PredictCommandOptions) => CliActionResult;
type SnapshotCommandHandler = (options: SnapshotCommandOptions) => CliActionResult;

interface TestCommandOptions {
  action?: TestAction;
  prompt?: string;
  run: boolean;
  dir?: string;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput: boolean;
}

type TestCommandHandler = (options: TestCommandOptions) => CliActionResult;
type TranslateCommandHandler = (options: TranslateCommandInvocationOptions) => CliActionResult;
type WithCommandHandler = (options: { harness: string }) => Promise<WithTaskResult>;

type ConfigMutationScope = "local" | "global";
type ConfigReadScope = "effective" | "local" | "global";
type ConfigValueType = "auto" | "string" | "number" | "boolean" | "json";

function resolveAutoCompactCliOptions(
  opts: CliOpts,
  getInvocationArgv?: () => string[],
): AutoCompactCliOptions {
  const invocationArgv = getInvocationArgv
    ? resolveInvocationArgv(getInvocationArgv)
    : process.argv.slice(2);
  if (hasCliOption(invocationArgv, "--compact-before-exit")) {
    return {
      beforeExit: true,
    };
  }

  const configDefaults = loadAutoCompactDefaultsFromConfig(invocationArgv);
  return {
    beforeExit: configDefaults?.beforeExit === true || Boolean(opts.compactBeforeExit as boolean | undefined),
  };
}

function resolveWorkerPattern(
  worker: string | string[] | boolean | undefined,
  getWorkerFromSeparator: () => string[] | undefined,
): ParsedWorkerPattern {
  if (typeof worker === "string") {
    return parseWorkerPattern(worker);
  }

  if (Array.isArray(worker)) {
    return inferWorkerPatternFromCommand(worker);
  }

  const workerFromSeparator = getWorkerFromSeparator();
  if (Array.isArray(workerFromSeparator)) {
    return inferWorkerPatternFromCommand(workerFromSeparator);
  }

  return inferWorkerPatternFromCommand([]);
}

/**
 * Creates the `run` command action handler.
 *
 * The returned action parses CLI options, applies normalization/default rules, and delegates execution
 * to the application `runTask` use case with a fully shaped request object.
 */
export function createRunCommandAction({
  getApp,
  getWorkerFromSeparator,
  runnerModes,
  getInvocationArgv,
}: RunActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return async (source: string, opts: CliOpts) => {
    const invocationArgv = resolveInvocationArgv(getInvocationArgv);
    const runDefaults = loadRunDefaultsFromConfig(invocationArgv);
    const hasCommitFlag = hasCliOption(invocationArgv, "--commit");
    const hasRevertableFlag = hasCliOption(invocationArgv, "--revertable");
    const hasCommitMessageFlag = hasCliOption(invocationArgv, "--commit-message");
    const hasCommitModeFlag = hasCliOption(invocationArgv, "--commit-mode");

    const workerWorkspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    // Resolve all execution-mode options before building the run request payload.
    const mode = parseRunnerMode(opts.mode as string | undefined, runnerModes);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean(opts.onlyVerify as boolean);
    const forceExecute = Boolean(opts.forceExecute as boolean);
    const forceAttempts = parseForceAttempts(opts.forceAttempts as string | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const resolveRepairAttempts = parseResolveRepairAttempts(opts.resolveRepairAttempts as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const revertable = hasRevertableFlag
      ? Boolean(opts.revertable as boolean | undefined)
      : Boolean(runDefaults?.revertable);
    const keepArtifacts = (opts.keepArtifacts as boolean) || revertable;
    const trace = resolveTraceFlag(opts, getInvocationArgv);
    const traceStats = Boolean(opts.traceStats as boolean | undefined);
    const traceOnly = opts.traceOnly as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const commitAfterComplete = (hasCommitFlag
      ? Boolean(opts.commit as boolean | undefined)
      : Boolean(runDefaults?.commit)) || revertable;
    const commitMode = parseCommitMode(
      hasCommitModeFlag
        ? opts.commitMode as string | undefined
        : runDefaults?.commitMode,
    );
    const commitMessageTemplate = hasCommitMessageFlag
      ? normalizeOptionalString(opts.commitMessage)
      : normalizeOptionalString(runDefaults?.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const runAll = Boolean(opts.all as boolean | undefined);
    const clean = Boolean(opts.clean as boolean | undefined);
    const redo = Boolean(opts.redo as boolean | undefined) || clean;
    const resetAfter = Boolean(opts.resetAfter as boolean | undefined) || clean;
    const effectiveRunAll = runAll || redo || clean;
    if (commitMode === "file-done" && !effectiveRunAll) {
      throw new Error(
        "Invalid --commit-mode usage: file-done is only supported with effective run-all (`run --all`, `all`, or implicit `--redo`/`--clean`).",
      );
    }
    const roundsArg = opts.rounds as string | undefined;
    const rounds = parseRounds(roundsArg);
    if (roundsArg !== undefined && !(clean || (redo && resetAfter))) {
      throw new Error("--rounds requires --clean or both --redo and --reset-after.");
    }
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const cacheCliBlocks = Boolean(opts.cacheCliBlocks as boolean | undefined);
    const verbose = resolveVerboseOption(opts);

    // Pass a normalized set of options to the domain application layer.
    return getApp().runTask({
      commandName: resolveRunCommandNameOption(opts.commandName),
      source,
      ...workerWorkspaceRuntimeOptions,
      autoCompact: resolveAutoCompactCliOptions(opts, getInvocationArgv),
      mode,
      workerPattern,
      sortMode,
      verify,
      onlyVerify,
      forceExecute,
      forceAttempts,
      noRepair,
      repairAttempts,
      resolveRepairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts,
      trace,
      traceStats,
      traceOnly,
      varsFileOption,
      cliTemplateVarArgs,
      commitAfterComplete,
      commitMode,
      commitMessageTemplate,
      onCompleteCommand,
      onFailCommand,
      showAgentOutput,
      runAll,
      redo,
      resetAfter,
      clean,
      rounds,
      forceUnlock,
      cliBlockTimeoutMs,
      ignoreCliBlock,
      cacheCliBlocks,
      verbose,
    });
  };
}

/**
 * Creates the `call` command action handler.
 *
 * The returned action mirrors `run` options but enforces a clean all-task session
 * with CLI block caching enabled.
 */
export function createCallCommandAction({
  getApp,
  getWorkerFromSeparator,
  runnerModes,
  getInvocationArgv,
}: CallActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  const runAction = createRunCommandAction({
    getApp,
    getWorkerFromSeparator,
    runnerModes,
    getInvocationArgv,
  });

  return (source: string, opts: CliOpts) => runAction(source, {
    ...opts,
    all: true,
    clean: true,
    cacheCliBlocks: true,
  });
}

/**
 * Creates the `materialize` command action handler.
 *
 * The returned action mirrors `run` options while forcing a full run, then
 * records implementation snapshot history for restore workflows.
 */
export function createMaterializeCommandAction({
  getApp,
  getWorkerFromSeparator,
  runnerModes,
  getInvocationArgv,
}: MaterializeActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  const runAction = createRunCommandAction({
    getApp,
    getWorkerFromSeparator,
    runnerModes,
    getInvocationArgv,
  });

  return async (source: string, opts: CliOpts) => {
    const runExitCode = await runAction(source, {
      ...opts,
      commandName: "materialize",
      all: true,
    });

    if (runExitCode !== EXIT_CODE_SUCCESS) {
      return runExitCode;
    }

    const snapshotExitCode = await resolveSnapshotCommandHandler(getApp())({
      workspace: normalizeOptionalString(opts.workspace),
    });
    if (snapshotExitCode === EXIT_CODE_SUCCESS || snapshotExitCode === EXIT_CODE_NO_WORK) {
      return EXIT_CODE_SUCCESS;
    }

    return snapshotExitCode;
  };
}

/**
 * Creates the `loop` command action handler.
 *
 * The returned action repeatedly runs `call` semantics with optional bounds,
 * cooldown delay, and configurable failure handling.
 */
export function createLoopCommandAction({
  getApp,
  getWorkerFromSeparator,
  runnerModes,
  setLoopSignalExitCode,
  getInvocationArgv,
}: LoopActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return async (source: string, opts: CliOpts) => {
    const invocationArgv = resolveInvocationArgv(getInvocationArgv);
    const runDefaults = loadRunDefaultsFromConfig(invocationArgv);
    const hasCommitFlag = hasCliOption(invocationArgv, "--commit");
    const hasRevertableFlag = hasCliOption(invocationArgv, "--revertable");
    const hasCommitMessageFlag = hasCliOption(invocationArgv, "--commit-message");
    const hasCommitModeFlag = hasCliOption(invocationArgv, "--commit-mode");

    const app = getApp();
    const workerWorkspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const mode = parseRunnerMode(opts.mode as string | undefined, runnerModes);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean(opts.onlyVerify as boolean | undefined);
    const forceExecute = Boolean(opts.forceExecute as boolean | undefined);
    const forceAttempts = parseForceAttempts(opts.forceAttempts as string | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const resolveRepairAttempts = parseResolveRepairAttempts(opts.resolveRepairAttempts as string | undefined);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const printPrompt = Boolean(opts.printPrompt as boolean | undefined);
    const traceOnly = Boolean(opts.traceOnly as boolean | undefined);
    const traceStats = Boolean(opts.traceStats as boolean | undefined);
    const sharedRuntimeOptions = resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator, getInvocationArgv);
    const revertable = hasRevertableFlag
      ? Boolean(opts.revertable as boolean | undefined)
      : Boolean(runDefaults?.revertable);
    const commitAfterComplete = (hasCommitFlag
      ? Boolean(opts.commit as boolean | undefined)
      : Boolean(runDefaults?.commit)) || revertable;
    const commitMode = parseCommitMode(
      hasCommitModeFlag
        ? opts.commitMode as string | undefined
        : runDefaults?.commitMode,
    );
    const commitMessageTemplate = hasCommitMessageFlag
      ? normalizeOptionalString(opts.commitMessage)
      : normalizeOptionalString(runDefaults?.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const rounds = parseRounds(opts.rounds as string | undefined);
    const verbose = resolveVerboseOption(opts);
    const iterations = parseLoopIterations(opts.iterations as string | undefined);
    const timeLimitSeconds = parseLoopTimeLimitSeconds(opts.timeLimit as string | undefined);
    const timeLimitMs = typeof timeLimitSeconds === "number" ? timeLimitSeconds * 1000 : undefined;
    const loopStartMs = Date.now();
    const cooldownSeconds = parseLoopCooldownSeconds(opts.cooldown as string | undefined);
    const cooldownMs = cooldownSeconds * 1000;
    const continueOnError = Boolean(opts.continueOnError as boolean | undefined);
    const hasBoundedIterations = typeof iterations === "number";
    const configuredTimeLimitLabel = typeof timeLimitSeconds === "number" ? `${timeLimitSeconds}s` : "none";
    let iteration = 0;
    let succeededIterations = 0;
    let failedIterations = 0;
    let loopExitCode = 0;
    let terminalStopRequested = false;
    let timedOut = false;
    let timeoutElapsedSeconds = 0;
    let cancelActiveCooldown: (() => void) | undefined;

    const cancelLoopCooldownOnShutdown = () => {
      cancelActiveCooldown?.();
    };

    process.prependListener("SIGINT", cancelLoopCooldownOnShutdown);
    process.prependListener("SIGTERM", cancelLoopCooldownOnShutdown);

    try {
      emitCliInfo(
        app,
        `Loop starting: iterations=${hasBoundedIterations ? iterations : "unlimited"}, cooldown=${cooldownSeconds}s, time-limit=${configuredTimeLimitLabel}.`,
      );

      while (!hasBoundedIterations || iteration < iterations) {
        if (typeof timeLimitMs === "number" && Date.now() - loopStartMs >= timeLimitMs) {
          timedOut = true;
          timeoutElapsedSeconds = Math.floor((Date.now() - loopStartMs) / 1000);
          break;
        }

        iteration += 1;
        emitCliInfo(app, `Loop iteration ${iteration} starting...`);

        let iterationExitCode = 1;
        try {
          iterationExitCode = normalizeLoopIterationExitCode(await app.runTask({
            source,
            ...workerWorkspaceRuntimeOptions,
            mode,
            workerPattern: sharedRuntimeOptions.workerPattern,
            sortMode,
            verify,
            onlyVerify,
            forceExecute,
            forceAttempts,
            noRepair,
            repairAttempts,
            resolveRepairAttempts,
            dryRun,
            printPrompt,
            keepArtifacts: sharedRuntimeOptions.keepArtifacts || revertable,
            trace: sharedRuntimeOptions.trace,
            traceStats,
            traceOnly,
            varsFileOption: sharedRuntimeOptions.varsFileOption,
            cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
            commitAfterComplete,
            commitMode,
            commitMessageTemplate,
            onCompleteCommand,
            onFailCommand,
            showAgentOutput: sharedRuntimeOptions.showAgentOutput,
            runAll: true,
            redo: true,
            resetAfter: true,
            clean: true,
            rounds,
            forceUnlock: sharedRuntimeOptions.forceUnlock,
            cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
            ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
            cacheCliBlocks: true,
            verbose,
            onTerminalStop: (signal) => {
              if (signal.stopRun || signal.stopLoop) {
                terminalStopRequested = true;
                loopExitCode = normalizeLoopIterationExitCode(signal.exitCode);
                setLoopSignalExitCode?.(loopExitCode);
              }
            },
          }));
        } finally {
          releaseLoopHeldLocks(app);
        }
        const isSuccess = iterationExitCode === 0;
        if (terminalStopRequested) {
          emitCliInfo(app, `Loop iteration ${iteration} requested terminal stop; ending loop.`);
          break;
        }
        const reachedIterationLimit = hasBoundedIterations && iteration >= iterations;

        if (!isSuccess) {
          failedIterations += 1;
          if (!continueOnError) {
            app.emitOutput?.({
              kind: "warn",
              message: `Loop iteration ${iteration} failed with exit code ${iterationExitCode}; stopping loop.`,
            });
            loopExitCode = iterationExitCode;
            break;
          }

          if (reachedIterationLimit) {
            emitCliInfo(app, `Loop iteration ${iteration} failed with exit code ${iterationExitCode}; reached iteration limit, stopping.`);
            break;
          }

          if (cooldownMs > 0) {
            app.emitOutput?.({
              kind: "warn",
              message: `Loop iteration ${iteration} failed with exit code ${iterationExitCode}; cooling down for ${cooldownSeconds}s before retry.`,
            });
            const cooldownInterruptedBy = await emitLoopCooldownCountdown({
              app,
              cooldownSeconds,
              nextIteration: iteration + 1,
              loopStartMs,
              timeLimitMs,
              onInterrupt: (signal) => {
                if (signal === "SIGINT") {
                  setLoopSignalExitCode?.(0);
                }
              },
              setActiveCooldownCanceller: (cancel) => {
                cancelActiveCooldown = cancel;
              },
            });
            if (cooldownInterruptedBy === "SIGINT") {
              break;
            }
            if (cooldownInterruptedBy === "TIME_LIMIT") {
              timedOut = true;
              timeoutElapsedSeconds = Math.floor((Date.now() - loopStartMs) / 1000);
              break;
            }
          } else {
            app.emitOutput?.({
              kind: "warn",
              message: `Loop iteration ${iteration} failed with exit code ${iterationExitCode}; starting next iteration immediately.`,
            });
          }
          continue;
        }

        succeededIterations += 1;

        if (reachedIterationLimit) {
          emitCliInfo(app, `Loop iteration ${iteration} completed - reached iteration limit; stopping.`);
          break;
        }

        if (cooldownMs > 0) {
          emitCliInfo(app, `Loop iteration ${iteration} completed - cooling down for ${cooldownSeconds}s...`);
          const cooldownInterruptedBy = await emitLoopCooldownCountdown({
            app,
            cooldownSeconds,
            nextIteration: iteration + 1,
            loopStartMs,
            timeLimitMs,
            onInterrupt: (signal) => {
              if (signal === "SIGINT") {
                setLoopSignalExitCode?.(0);
              }
            },
            setActiveCooldownCanceller: (cancel) => {
              cancelActiveCooldown = cancel;
            },
          });
          if (cooldownInterruptedBy === "SIGINT") {
            break;
          }
          if (cooldownInterruptedBy === "TIME_LIMIT") {
            timedOut = true;
            timeoutElapsedSeconds = Math.floor((Date.now() - loopStartMs) / 1000);
            break;
          }
        } else {
          emitCliInfo(app, `Loop iteration ${iteration} completed - starting next iteration immediately.`);
        }
      }

      if (timedOut && typeof timeLimitSeconds === "number") {
        emitCliInfo(
          app,
          `Loop completed: time limit reached (elapsed=${timeoutElapsedSeconds}s, limit=${timeLimitSeconds}s).`,
        );
      }

      emitCliInfo(
        app,
        `Loop summary: total iterations=${iteration}, succeeded=${succeededIterations}, failed=${failedIterations}.`,
      );

      return loopExitCode;
    } finally {
      cancelActiveCooldown = undefined;
      process.off("SIGINT", cancelLoopCooldownOnShutdown);
      process.off("SIGTERM", cancelLoopCooldownOnShutdown);
    }
  };
}

function releaseLoopHeldLocks(app: CliApp): void {
  try {
    app.releaseAllLocks?.();
  } catch (error) {
    app.emitOutput?.({
      kind: "warn",
      message: "Loop failed to release file locks between iterations: " + String(error),
    });
  }
}

/**
 * Creates the `discuss` command action handler.
 *
 * The returned action maps parsed CLI options into the application `discussTask` request contract.
 */
export function createDiscussCommandAction({
  getApp,
  getWorkerFromSeparator,
  discussModes,
  getInvocationArgv,
}: DiscussActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    // Parse and normalize discuss-specific option values.
    const mode = parseRunnerMode(opts.mode as string | undefined, discussModes);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const trace = resolveTraceFlag(opts, getInvocationArgv);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const verbose = resolveVerboseOption(opts);
    const normalizedSource = resolveDiscussMarkdownFile([source]);

    // Delegate to the discuss application flow with normalized arguments.
    return getApp().discussTask({
      source: normalizedSource,
      mode,
      workerPattern,
      sortMode,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      showAgentOutput,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      verbose,
    });
  };
}

/**
 * Creates the `reverify` command action handler.
 *
 * The returned action builds re-verification options and forwards them to the application `reverifyTask`
 * use case, including run-target and repair controls.
 */
export function createReverifyCommandAction({
  getApp,
  getWorkerFromSeparator,
  getInvocationArgv,
}: WorkerActionDependencies): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    // Parse run-selection and behavior flags for re-verification.
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const oldestFirst = Boolean(opts.oldestFirst as boolean | undefined);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const resolveRepairAttempts = parseResolveRepairAttempts(opts.resolveRepairAttempts as string | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = resolveTraceFlag(opts, getInvocationArgv);
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const verbose = resolveVerboseOption(opts);

    // Execute the re-verification workflow in the application layer.
    return getApp().reverifyTask({
      runId: targetRun,
      last,
      all,
      oldestFirst,
      workerPattern,
      repairAttempts,
      resolveRepairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      showAgentOutput,
      varsFileOption,
      cliTemplateVarArgs,
      trace,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      verbose,
    });
  };
}

/**
 * Creates the `revert` command action handler.
 *
 * The returned action resolves rollback targeting and method options before invoking the application
 * `revertTask` use case.
 */
export function createRevertCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    // Determine which run(s) should be reverted and how to apply the rollback.
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";
    const last = parseLastCount(opts.last as string | undefined);
    const all = Boolean(opts.all as boolean | undefined);
    const method = parseRevertMethod(opts.method as string | undefined);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const force = Boolean(opts.force as boolean | undefined);
    const keepArtifacts = Boolean(opts.keepArtifacts as boolean | undefined);

    // Delegate revert execution to the application boundary.
    return getApp().revertTask({
      runId: targetRun,
      last,
      all,
      method,
      dryRun,
      force,
      keepArtifacts,
    });
  };
}

/**
 * Creates the `next` command action handler.
 *
 * The returned action asks the application to resolve the next runnable task from a source document.
 */
export function createNextCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    // Forward source and sorting preferences for next-task selection.
    return getApp().nextTask({
      source,
      sortMode: parseSortMode(opts.sort as string | undefined),
    });
  };
}

/**
 * Creates the `list` command action handler.
 *
 * The returned action requests task listing from the application layer using source and filter options.
 */
export function createListCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    // Include sort and visibility controls when listing tasks.
    return getApp().listTasks({
      source,
      sortMode: parseSortMode(opts.sort as string | undefined),
      includeAll: opts.all as boolean,
    });
  };
}

/**
 * Creates the `artifacts` command action handler.
 *
 * The returned action maps CLI maintenance flags to the application `manageArtifacts` use case.
 */
export function createArtifactsCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    // Route artifact cleanup, filtering, and open operations through the app.
    return getApp().manageArtifacts({
      clean: opts.clean as boolean,
      json: opts.json as boolean,
      failed: opts.failed as boolean,
      open: typeof opts.open === "string" ? opts.open : "",
    });
  };
}

/**
 * Creates the `log` command action handler.
 *
 * The returned action resolves the available log implementation and forwards normalized log options.
 */
export function createLogCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    // Resolve compatibility between legacy and current log command handlers.
    return resolveLogCommandHandler(getApp())({
      revertable: Boolean(opts.revertable as boolean | undefined),
      commandName: normalizeOptionalString(opts.command),
      limit: parseLimitCount(opts.limit as string | undefined),
      json: Boolean(opts.json as boolean | undefined),
    });
  };
}

/**
 * Creates the `plan` command action handler.
 *
 * The returned action resolves the target markdown source and option set before invoking the application
 * `planTask` workflow.
 */
export function createPlanCommandAction({
  getApp,
  getWorkerFromSeparator,
  plannerModes,
  getInvocationArgv,
}: PlanActionDependencies): (markdownFiles: string[], opts: CliOpts) => CliActionResult {
  return (markdownFiles: string[], opts: CliOpts) => {
    const workerWorkspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    // Resolve planning input and execution controls from CLI options.
    const markdownFile = resolvePlanMarkdownFile(markdownFiles);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);
    const maxItems = parseMaxItems(opts.maxItems as string | undefined);
    const deep = parsePlanDeep(opts.deep as string | undefined);
    const mode = parseRunnerMode(opts.mode as string | undefined, plannerModes);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = resolveTraceFlag(opts, getInvocationArgv);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const loop = Boolean(opts.loop as boolean | undefined);
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const verbose = resolveVerboseOption(opts);

    const request: PlanCommandInvocationOptions = {
      source: markdownFile,
      ...workerWorkspaceRuntimeOptions,
      scanCount,
      maxItems,
      deep,
      loop,
      mode,
      workerPattern,
      showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      varsFileOption,
      cliTemplateVarArgs,
      verbose,
    };

    // Trigger planning in the app layer with a normalized payload.
    return getApp().planTask(request);
  };
}

/**
 * Creates the `research` command action handler.
 *
 * The returned action resolves the target markdown source and option set before invoking the application
 * `researchTask` workflow.
 */
export function createResearchCommandAction({
  getApp,
  getWorkerFromSeparator,
  researchModes,
  getInvocationArgv,
}: ResearchActionDependencies): (markdownFiles: string[], opts: CliOpts) => CliActionResult {
  return (markdownFiles: string[], opts: CliOpts) => {
    const workerWorkspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const markdownFile = resolveResearchMarkdownFile(markdownFiles);
    const mode = parseRunnerMode(opts.mode as string | undefined, researchModes);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = resolveTraceFlag(opts, getInvocationArgv);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);

    const verbose = resolveVerboseOption(opts);
    const request: ResearchCommandInvocationOptions = {
      source: markdownFile,
      ...workerWorkspaceRuntimeOptions,
      mode,
      workerPattern,
      showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      configDirOption: normalizeOptionalString(opts.configDir),
      varsFileOption,
      cliTemplateVarArgs,
      verbose,
    };

    return getApp().researchTask(request);
  };
}

/**
 * Creates the `translate` command action handler.
 *
 * The returned action resolves `<what>`, `<how>`, and `<output>` markdown paths
 * and shared worker runtime options before invoking the application
 * `translateTask` workflow.
 */
export function createTranslateCommandAction({
  getApp,
  getWorkerFromSeparator,
  translateModes,
  getInvocationArgv,
}: TranslateActionDependencies): (
  whatMarkdownFile: string,
  howMarkdownFile: string,
  outputMarkdownFile: string,
  opts: CliOpts,
) => CliActionResult {
  return (
    whatMarkdownFile: string,
    howMarkdownFile: string,
    outputMarkdownFile: string,
    opts: CliOpts,
  ) => {
    const workspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const resolvedMarkdownFiles = resolveTranslateMarkdownFiles(
      whatMarkdownFile,
      howMarkdownFile,
      outputMarkdownFile,
    );
    const mode = parseRunnerMode(opts.mode as string | undefined, translateModes);
    const sharedRuntimeOptions = resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator, getInvocationArgv);

    const request: TranslateCommandInvocationOptions = {
      what: resolvedMarkdownFiles.whatMarkdownFile,
      how: resolvedMarkdownFiles.howMarkdownFile,
      output: resolvedMarkdownFiles.outputMarkdownFile,
      ...workspaceRuntimeOptions,
      mode,
      workerPattern: sharedRuntimeOptions.workerPattern,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      dryRun: Boolean(opts.dryRun as boolean | undefined),
      printPrompt: Boolean(opts.printPrompt as boolean | undefined),
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      trace: sharedRuntimeOptions.trace,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      configDirOption: sharedRuntimeOptions.configDirOption,
      verbose: resolveVerboseOption(opts),
    };

    return resolveTranslateCommandHandler(getApp())(request);
  };
}

/**
 * Creates the `explore` command action handler.
 *
 * The returned action composes `research` and `plan` over the same Markdown source,
 * forwarding shared runtime options to both phases and plan-specific options to planning.
 */
export function createExploreCommandAction({
  getApp,
  getWorkerFromSeparator,
  exploreModes,
  getInvocationArgv,
}: ExploreActionDependencies): (markdownFiles: string[], opts: CliOpts) => CliActionResult {
  return async (markdownFiles: string[], opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveResearchMarkdownFile(markdownFiles);
    const {
      workspaceRuntimeOptions,
      mode,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      deep,
      maxItems,
      verbose,
    } = parseExploreCliOptions(opts, exploreModes, getWorkerFromSeparator, getInvocationArgv);

    return app.exploreTask({
      source: targetMarkdownFile,
      ...workspaceRuntimeOptions,
      mode,
      workerPattern: sharedRuntimeOptions.workerPattern,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
      trace: sharedRuntimeOptions.trace,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      configDirOption: sharedRuntimeOptions.configDirOption,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      scanCount,
      deep,
      maxItems,
      verbose,
      emitPhaseMessages: true,
    });
  };
}

/**
 * Creates the `undo` command action handler.
 *
 * The returned action resolves run selection and safety options before invoking
 * the application `undoTask` use case.
 */
export function createUndoCommandAction({
  getApp,
  getWorkerFromSeparator,
}: WorkerActionDependencies): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    const targetRun = normalizeOptionalString(opts.run) ?? "latest";
    const last = parseLastCount(opts.last as string | undefined);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const keepArtifacts = Boolean(opts.keepArtifacts as boolean | undefined);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const force = Boolean(opts.force as boolean | undefined);
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);

    return getApp().undoTask({
      runId: targetRun,
      last,
      workerPattern,
      force,
      dryRun,
      keepArtifacts,
      showAgentOutput,
    });
  };
}

/**
 * Creates the `start` command action handler.
 *
 * The returned action maps positional design/workspace directories into
 * start-project adoption inputs.
 */
export function createStartCommandAction({
  getApp,
  getWorkerFromSeparator,
}: Pick<WorkerActionDependencies, "getApp" | "getWorkerFromSeparator">): (
  designDir: string | undefined,
  workdirOrOpts: string | CliOpts | undefined,
  maybeOpts?: CliOpts,
) => CliActionResult {
  return (
    designDir: string | undefined,
    workdirOrOpts: string | CliOpts | undefined,
    maybeOpts?: CliOpts,
  ) => {
    const opts: CliOpts = (typeof workdirOrOpts === "object" && workdirOrOpts !== null)
      ? workdirOrOpts
      : maybeOpts ?? {};
    const positionalDesignDir = normalizeOptionalString(designDir);
    const positionalWorkdir = typeof workdirOrOpts === "string"
      ? normalizeOptionalString(workdirOrOpts)
      : undefined;
    const mountOption = opts.mount;
    const mounts = Array.isArray(mountOption)
      ? mountOption
      : typeof mountOption === "string"
        ? [mountOption]
        : [];
    let resolvedFromDesign = normalizeOptionalString(opts.fromDesign);
    let resolvedWorkspaceDir = normalizeOptionalString(opts.dir);

    if (positionalWorkdir && !resolvedWorkspaceDir) {
      resolvedWorkspaceDir = positionalWorkdir;
    }
    if (positionalDesignDir && !resolvedFromDesign) {
      resolvedFromDesign = positionalDesignDir;
    }
    const migrateWorkerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const keepArtifacts = Boolean(opts.keepArtifacts as boolean | undefined);
    const showAgentOutput = resolveShowAgentOutputOption(opts);

    return getApp().startProject({
      dir: resolvedWorkspaceDir,
      mounts,
      designDir: normalizeOptionalString(opts.designDir),
      designPlacement: normalizeOptionalString(opts.designPlacement),
      specsDir: normalizeOptionalString(opts.specsDir),
      specsPlacement: normalizeOptionalString(opts.specsPlacement),
      migrationsDir: normalizeOptionalString(opts.migrationsDir),
      migrationsPlacement: normalizeOptionalString(opts.migrationsPlacement),
      fromDesign: resolvedFromDesign,
      migrateWorkerPattern,
      migrateKeepArtifacts: keepArtifacts,
      migrateShowAgentOutput: showAgentOutput,
    });
  };
}

/**
 * Creates the `migrate` command action handler.
 *
 * The returned action validates migrate action routing and forwards the request
 * to the application `migrateTask` use case.
 */
export function createMigrateCommandAction({
  getApp,
  getWorkerFromSeparator,
  getInvocationArgv,
}: WorkerActionDependencies): (
  actionOrOpts: string | CliOpts | undefined,
  countOrOpts?: string | CliOpts,
  maybeOpts?: CliOpts,
  ) => CliActionResult {
  return (actionOrOpts: string | CliOpts | undefined, countOrOpts?: string | CliOpts, maybeOpts?: CliOpts) => {
    const app = getApp();
    const normalizedAction = typeof actionOrOpts === "string"
      ? normalizeOptionalString(actionOrOpts)
      : undefined;

    if (normalizedAction !== undefined && normalizedAction.toLowerCase() === "new") {
      const title = typeof countOrOpts === "string"
        ? normalizeOptionalString(countOrOpts)
        : undefined;
      if (!title) {
        throw new Error("Missing required title for `migrate new <title>`.");
      }

      const opts = (maybeOpts ?? {}) as CliOpts;
      return resolveMigrateCommandHandler(app)({
        action: "new",
        title,
        dir: normalizeOptionalString(opts.dir),
        workspace: normalizeOptionalString(opts.workspace),
        autoCompact: resolveAutoCompactCliOptions(opts, getInvocationArgv),
        confirm: Boolean(opts.confirm as boolean | undefined),
        workerPattern: resolveWorkerPattern(opts.worker, getWorkerFromSeparator),
        keepArtifacts: Boolean(opts.keepArtifacts as boolean | undefined),
        showAgentOutput: resolveShowAgentOutputOption(opts),
      });
    }

    if (typeof actionOrOpts === "string") {
      throw new Error(`unknown action: ${actionOrOpts}`);
    }

    if (typeof countOrOpts === "string") {
      throw new Error(`unknown action: ${countOrOpts}`);
    }

    const opts = maybeOpts ?? (countOrOpts ?? actionOrOpts ?? {}) as CliOpts;
    const fromValue = normalizeOptionalString(opts.from);
    const fromFile = normalizeOptionalString(opts.fromFile);
    validateMigrateInputModeExclusivity(fromValue, fromFile);
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const slugWorkerPattern = typeof opts.slugWorker === "string"
      ? resolveWorkerPattern(opts.slugWorker, getWorkerFromSeparator)
      : undefined;

    return resolveMigrateCommandHandler(app)({
      dir: normalizeOptionalString(opts.dir),
      workspace: normalizeOptionalString(opts.workspace),
      sourceMode: parseMigrateSourceMode(fromValue),
      ...(fromFile !== undefined ? { fromFile } : {}),
      autoCompact: resolveAutoCompactCliOptions(opts, getInvocationArgv),
      confirm: Boolean(opts.confirm as boolean | undefined),
      workerPattern,
      ...(slugWorkerPattern ? { slugWorkerPattern } : {}),
      keepArtifacts: Boolean(opts.keepArtifacts as boolean | undefined),
      showAgentOutput: resolveShowAgentOutputOption(opts),
    });
  };
}

function validateMigrateInputModeExclusivity(
  fromValue: string | undefined,
  fromFile: string | undefined,
): void {
  if (fromValue !== undefined && fromFile !== undefined) {
    throw new Error("Invalid migrate options: --from-file cannot be combined with --from.");
  }
}

/**
 * Creates the `predict` command action handler.
 *
 * The returned action delegates prediction execution to a dedicated
 * application `predictTask` use case.
 */
export function createPredictCommandAction({
  getApp,
  getWorkerFromSeparator,
}: WorkerActionDependencies): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return resolvePredictCommandHandler(getApp())({
      dir: normalizeOptionalString(opts.dir),
      workspace: normalizeOptionalString(opts.workspace),
      workerPattern: resolveWorkerPattern(opts.worker, getWorkerFromSeparator),
      keepArtifacts: Boolean(opts.keepArtifacts as boolean | undefined),
      showAgentOutput: resolveShowAgentOutputOption(opts),
    });
  };
}

/**
 * Creates the `snapshot` command action handler.
 *
 * The returned action delegates implementation snapshot persistence to the
 * application `snapshotTask` use case.
 */
export function createSnapshotCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return resolveSnapshotCommandHandler(getApp())({
      workspace: normalizeOptionalString(opts.workspace),
    });
  };
}

/**
 * Creates the `compact` command action handler.
 *
 * The returned action normalizes target/retention options and forwards them to
 * the application `compactTask` use case.
 */
export function createCompactCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    const target = parseCompactTarget(opts.target);
    validateCompactScopeCombination(target ?? "all", opts);
    return getApp().compactTask({
      workspace: normalizeOptionalString(opts.workspace),
      target,
      dryRun: Boolean(opts.dryRun as boolean | undefined),
      keepCount: parseCompactKeepCount(opts.keep, "keep"),
      keepRevisions: parseCompactKeepCount(opts.keepRevisions, "keep-revisions"),
      keepMigrationsRoot: parseCompactKeepCount(opts.keepMigrationsRoot, "keep-migrations-root"),
      keepMigrationsThreads: parseCompactKeepCount(opts.keepMigrationsThreads, "keep-migrations-threads"),
    });
  };
}

function validateCompactScopeCombination(
  target: "revisions" | "migrations" | "all",
  opts: CliOpts,
): void {
  const hasKeepRevisions = normalizeOptionalString(opts.keepRevisions) !== undefined;
  const hasKeepMigrationsRoot = normalizeOptionalString(opts.keepMigrationsRoot) !== undefined;
  const hasKeepMigrationsThreads = normalizeOptionalString(opts.keepMigrationsThreads) !== undefined;

  if (target === "revisions") {
    const migrationFlags = [
      hasKeepMigrationsRoot ? "--keep-migrations-root" : undefined,
      hasKeepMigrationsThreads ? "--keep-migrations-threads" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (migrationFlags.length > 0) {
      throw new Error(
        `Invalid compact option combination: --target revisions cannot include migration retention flags (${migrationFlags.join(", ")}).`,
      );
    }
  }

  if (target === "migrations" && hasKeepRevisions) {
    throw new Error(
      "Invalid compact option combination: --target migrations cannot include --keep-revisions.",
    );
  }
}

function parseCompactKeepCount(value: string | string[] | boolean | undefined, optionName: string): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid --${optionName} value: ${normalized}. Must be a non-negative integer.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --${optionName} value: ${normalized}. Must be a safe non-negative integer.`);
  }

  return parsed;
}

function parseCompactTarget(
  value: string | string[] | boolean | undefined,
): "revisions" | "migrations" | "all" | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }

  if (normalized === "revisions" || normalized === "migrations" || normalized === "all") {
    return normalized;
  }

  throw new Error(`Invalid --target value: ${normalized}. Allowed: revisions, migrations, all.`);
}

/**
 * Creates the `test` command action handler.
 *
 * The returned action validates `test` action routing and forwards the request
 * to the application `testSpecs` use case.
 */
export function createTestCommandAction({
  getApp,
  getWorkerFromSeparator,
}: WorkerActionDependencies): (
  action: string | undefined,
  prompt: string | undefined,
  opts: CliOpts,
) => CliActionResult {
  return (action: string | undefined, prompt: string | undefined, opts: CliOpts) => {
    const normalizedAction = normalizeOptionalString(action);
    const resolvedAction = parseTestAction(normalizedAction);

    if (prompt !== undefined && resolvedAction !== "new") {
      throw new Error("The optional [prompt] argument is only supported for `test new <prompt>`.");
    }

    return resolveTestCommandHandler(getApp())({
      action: resolvedAction,
      prompt: normalizeOptionalString(prompt),
      run: Boolean(opts.run as boolean | undefined),
      dir: normalizeOptionalString(opts.dir),
      workerPattern: resolveWorkerPattern(opts.worker, getWorkerFromSeparator),
      showAgentOutput: resolveShowAgentOutputOption(opts),
    });
  };
}

function parseTestAction(value: string | undefined): TestAction {
  if (value === undefined) {
    return "now";
  }

  const resolved = value.trim().toLowerCase();
  if (resolved === "now" || resolved === "future" || resolved === "new") {
    return resolved;
  }

  throw new Error(
    `Invalid test action: ${value}. Allowed actions: now, future, new. Use --dir <path> to target a non-default specs directory.`,
  );
}

/**
 * Creates the `query` command action handler.
 */
export function createQueryCommandAction({
  getApp,
  getWorkerFromSeparator,
  queryModes,
}: QueryActionDependencies): (queryText: string, opts: CliOpts) => CliActionResult {
  return (queryText: string, opts: CliOpts) => {
    const workspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const mode = parseRunnerMode(opts.mode as string | undefined, queryModes);
    const sharedRuntimeOptions = resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator);
    const format = parseQueryOutputFormat(opts.format as string | undefined);
    const output = normalizeOptionalString(opts.output);
    const dir = path.resolve(normalizeOptionalString(opts.dir) ?? process.cwd());

    const request: QueryCommandInvocationOptions = {
      queryText,
      dir,
      ...workspaceRuntimeOptions,
      format,
      output,
      skipResearch: Boolean(opts.skipResearch as boolean | undefined),
      mode,
      workerPattern: sharedRuntimeOptions.workerPattern,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      dryRun: Boolean(opts.dryRun as boolean | undefined),
      printPrompt: Boolean(opts.printPrompt as boolean | undefined),
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      trace: sharedRuntimeOptions.trace,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      scanCount: parseScanCount(opts.scanCount as string | undefined),
      maxItems: parseMaxItems(opts.maxItems as string | undefined),
      deep: parsePlanDeep(opts.deep as string | undefined),
      verbose: resolveVerboseOption(opts),
      configDirOption: sharedRuntimeOptions.configDirOption,
    };

    return getApp().queryTask(request);
  };
}

interface ParsedExploreCliOptions {
  workspaceRuntimeOptions: WorkerWorkspaceRuntimeOptions;
  mode: ProcessRunMode;
  sharedRuntimeOptions: ReturnType<typeof resolveSharedWorkerRuntimeOptions>;
  dryRun: boolean;
  printPrompt: boolean;
  scanCount: number | undefined;
  deep: number;
  maxItems: number | undefined;
  verbose: boolean;
}

function parseExploreCliOptions(
  opts: CliOpts,
  exploreModes: readonly ProcessRunMode[],
  getWorkerFromSeparator: () => string[] | undefined,
  getInvocationArgv?: () => string[],
): ParsedExploreCliOptions {
  return {
    workspaceRuntimeOptions: resolveWorkerWorkspaceRuntimeOptions(),
    mode: parseRunnerMode(opts.mode as string | undefined, exploreModes),
    sharedRuntimeOptions: resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator, getInvocationArgv),
    dryRun: Boolean(opts.dryRun as boolean | undefined),
    printPrompt: Boolean(opts.printPrompt as boolean | undefined),
    scanCount: parseScanCount(opts.scanCount as string | undefined),
    deep: parsePlanDeep(opts.deep as string | undefined),
    maxItems: parseMaxItems(opts.maxItems as string | undefined),
    verbose: resolveVerboseOption(opts),
  };
}

/**
 * Creates the `make` command action handler.
 *
 * The returned action creates a new Markdown file from seed text, then runs `research` and `plan`
 * in strict sequence against that same file.
 */
export function createMakeCommandAction({
  getApp,
  getWorkerFromSeparator,
  makeModes,
  getInvocationArgv,
}: MakeActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveMakeMarkdownFile(markdownFile);
    const {
      workspaceRuntimeOptions,
      mode,
      skipResearch,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    } = parseMakeBootstrapCliOptions(opts, makeModes, getWorkerFromSeparator, getInvocationArgv);

    return runMakeBootstrapPhases({
      app,
      seedText,
      targetMarkdownFile,
      workspaceRuntimeOptions,
      mode,
      skipResearch,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    });
  };
}

/**
 * Creates the `add` command action handler.
 *
 * The returned action appends seed text to an existing Markdown file, then runs
 * `plan` in strict sequence against that same file.
 */
export function createAddCommandAction({
  getApp,
  getWorkerFromSeparator,
  addModes,
}: AddActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveAddMarkdownFile(markdownFile);
    const workspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const mode = parseRunnerMode(opts.mode as string | undefined, addModes);
    const sharedRuntimeOptions = resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator);
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const printPrompt = Boolean(opts.printPrompt as boolean | undefined);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);
    const maxItems = parseMaxItems(opts.maxItems as string | undefined);
    const deep = parsePlanDeep(opts.deep as string | undefined);
    const verbose = resolveVerboseOption(opts);
    const resolvedSeedText = resolveBootstrapSeedText(seedText, sharedRuntimeOptions.configDirOption);

    appendSeedMarkdownFile(targetMarkdownFile, resolvedSeedText);

    emitCliInfo(app, "Add phase 1/1: plan");

    return normalizeMakePhaseExitCode(await app.planTask({
      source: targetMarkdownFile,
      ...workspaceRuntimeOptions,
      scanCount,
      maxItems,
      deep,
      mode,
      workerPattern: sharedRuntimeOptions.workerPattern,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
      trace: sharedRuntimeOptions.trace,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      verbose,
    }));
  };
}

interface RunMakeBootstrapPhasesOptions {
  app: CliApp;
  seedText: string;
  targetMarkdownFile: string;
  workspaceRuntimeOptions: WorkerWorkspaceRuntimeOptions;
  mode: ProcessRunMode;
  skipResearch: boolean;
  sharedRuntimeOptions: ReturnType<typeof resolveSharedWorkerRuntimeOptions>;
  dryRun: boolean;
  printPrompt: boolean;
  scanCount: number | undefined;
  maxItems: number | undefined;
  verbose: boolean;
}

interface ParsedMakeBootstrapCliOptions {
  workspaceRuntimeOptions: WorkerWorkspaceRuntimeOptions;
  mode: ProcessRunMode;
  skipResearch: boolean;
  sharedRuntimeOptions: ReturnType<typeof resolveSharedWorkerRuntimeOptions>;
  dryRun: boolean;
  printPrompt: boolean;
  scanCount: number | undefined;
  maxItems: number | undefined;
  verbose: boolean;
}

function parseMakeBootstrapCliOptions(
  opts: CliOpts,
  makeModes: readonly ProcessRunMode[],
  getWorkerFromSeparator: () => string[] | undefined,
  getInvocationArgv?: () => string[],
): ParsedMakeBootstrapCliOptions {
  return {
    workspaceRuntimeOptions: resolveWorkerWorkspaceRuntimeOptions(),
    mode: parseRunnerMode(opts.mode as string | undefined, makeModes),
    skipResearch: Boolean((opts.skipResearch as boolean | undefined) || (opts.raw as boolean | undefined)),
    sharedRuntimeOptions: resolveSharedRuntimeOptionsWithTrace(opts, getWorkerFromSeparator, getInvocationArgv),
    dryRun: Boolean(opts.dryRun as boolean | undefined),
    printPrompt: Boolean(opts.printPrompt as boolean | undefined),
    scanCount: parseScanCount(opts.scanCount as string | undefined),
    maxItems: parseMaxItems(opts.maxItems as string | undefined),
    verbose: resolveVerboseOption(opts),
  };
}

async function runMakeBootstrapPhases({
  app,
  seedText,
  targetMarkdownFile,
  workspaceRuntimeOptions,
  mode,
  skipResearch,
  sharedRuntimeOptions,
  dryRun,
  printPrompt,
  scanCount,
  maxItems,
  verbose,
}: RunMakeBootstrapPhasesOptions): Promise<number> {
  const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;
  const resolvedSeedText = resolveBootstrapSeedText(seedText, sharedRuntimeOptions.configDirOption);

  createSeedMarkdownFile(targetMarkdownFile, resolvedSeedText);

  if (skipResearch) {
    emitCliInfo(app, "Make phase 1/2 skipped: research");
    emitCliInfo(app, "Make transition: start from planning (--skip-research/--raw)");
    emitCliInfo(app, "Make phase 2/2: plan");

    return normalizeMakePhaseExitCode(await app.planTask({
      source: targetMarkdownFile,
      ...workspaceRuntimeOptions,
      scanCount,
      maxItems,
      mode,
      workerPattern: sharedWorkerPattern,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
      trace: sharedRuntimeOptions.trace,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      verbose,
    }));
  }

  emitCliInfo(app, "Make phase 1/2: research");

  const researchCode = normalizeMakePhaseExitCode(await app.researchTask({
    source: targetMarkdownFile,
    ...workspaceRuntimeOptions,
    mode,
    workerPattern: sharedWorkerPattern,
    showAgentOutput: sharedRuntimeOptions.showAgentOutput,
    dryRun,
    printPrompt,
    keepArtifacts: sharedRuntimeOptions.keepArtifacts,
    trace: sharedRuntimeOptions.trace,
    forceUnlock: sharedRuntimeOptions.forceUnlock,
    ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
    cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
    configDirOption: sharedRuntimeOptions.configDirOption,
    varsFileOption: sharedRuntimeOptions.varsFileOption,
    cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
    verbose,
  }));

  if (researchCode !== 0) {
    return researchCode;
  }

  emitCliInfo(app, "Make transition: research -> plan");
  emitCliInfo(app, "Make phase 2/2: plan");

  return normalizeMakePhaseExitCode(await app.planTask({
    source: targetMarkdownFile,
    ...workspaceRuntimeOptions,
    scanCount,
    maxItems,
    mode,
    workerPattern: sharedWorkerPattern,
    showAgentOutput: sharedRuntimeOptions.showAgentOutput,
    dryRun,
    printPrompt,
    keepArtifacts: sharedRuntimeOptions.keepArtifacts,
    trace: sharedRuntimeOptions.trace,
    forceUnlock: sharedRuntimeOptions.forceUnlock,
    ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
    cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
    varsFileOption: sharedRuntimeOptions.varsFileOption,
    cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
    verbose,
  }));
}

/**
 * Creates the `do` command action handler.
 *
 * The returned action composes bootstrap (`make`) and execution (`run --all`)
 * against the same Markdown file with fail-fast phase boundaries.
 */
export function createDoCommandAction({
  getApp,
  getWorkerFromSeparator,
  makeModes,
  getInvocationArgv,
}: DoActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const invocationArgv = resolveInvocationArgv(getInvocationArgv);
    const runDefaults = loadRunDefaultsFromConfig(invocationArgv);
    const hasCommitFlag = hasCliOption(invocationArgv, "--commit");
    const hasRevertableFlag = hasCliOption(invocationArgv, "--revertable");
    const hasCommitMessageFlag = hasCliOption(invocationArgv, "--commit-message");
    const hasCommitModeFlag = hasCliOption(invocationArgv, "--commit-mode");

    const app = getApp();
    const targetMarkdownFile = resolveMakeMarkdownFile(markdownFile);
    const {
      workspaceRuntimeOptions,
      mode,
      skipResearch,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    } = parseMakeBootstrapCliOptions(opts, makeModes, getWorkerFromSeparator);
    const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;

    const runSortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean(opts.onlyVerify as boolean | undefined);
    const forceExecute = Boolean(opts.forceExecute as boolean | undefined);
    const forceAttempts = parseForceAttempts(opts.forceAttempts as string | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const resolveRepairAttempts = parseResolveRepairAttempts(opts.resolveRepairAttempts as string | undefined);
    const traceOnly = Boolean(opts.traceOnly as boolean | undefined);
    const revertable = hasRevertableFlag
      ? Boolean(opts.revertable as boolean | undefined)
      : Boolean(runDefaults?.revertable);
    const commitAfterComplete = (hasCommitFlag
      ? Boolean(opts.commit as boolean | undefined)
      : Boolean(runDefaults?.commit)) || revertable;
    const commitMode = parseCommitMode(
      hasCommitModeFlag
        ? opts.commitMode as string | undefined
        : runDefaults?.commitMode,
    );
    const commitMessageTemplate = hasCommitMessageFlag
      ? normalizeOptionalString(opts.commitMessage)
      : normalizeOptionalString(runDefaults?.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const clean = Boolean(opts.clean as boolean | undefined);
    const redo = Boolean(opts.redo as boolean | undefined) || clean;
    const resetAfter = Boolean(opts.resetAfter as boolean | undefined) || clean;
    const roundsArg = opts.rounds as string | undefined;
    const rounds = parseRounds(roundsArg);
    if (roundsArg !== undefined && !(clean || (redo && resetAfter))) {
      throw new Error("--rounds requires --clean or both --redo and --reset-after.");
    }
    const cacheCliBlocks = Boolean(opts.cacheCliBlocks as boolean | undefined);

    emitCliInfo(app, "Do phase 1/2: bootstrap (make)");

    const bootstrapCode = await runMakeBootstrapPhases({
      app,
      seedText,
      targetMarkdownFile,
      workspaceRuntimeOptions,
      mode,
      skipResearch,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    });

    if (bootstrapCode !== 0) {
      return bootstrapCode;
    }

    emitCliInfo(app, "Do transition: bootstrap -> execution");
    emitCliInfo(app, "Do phase 2/2: execution (run --all)");
    if (rounds > 1) {
      emitCliInfo(app, `Execution rounds: 1/${rounds} -> ${rounds}/${rounds}`);
    }

    return app.runTask({
      source: targetMarkdownFile,
      ...workspaceRuntimeOptions,
      autoCompact: resolveAutoCompactCliOptions(opts, getInvocationArgv),
      mode,
      workerPattern: sharedWorkerPattern,
      sortMode: runSortMode,
      verify,
      onlyVerify,
      forceExecute,
      forceAttempts,
      noRepair,
      repairAttempts,
      resolveRepairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts: sharedRuntimeOptions.keepArtifacts || revertable,
      trace: sharedRuntimeOptions.trace,
      traceOnly,
      varsFileOption: sharedRuntimeOptions.varsFileOption,
      cliTemplateVarArgs: sharedRuntimeOptions.cliTemplateVarArgs,
      commitAfterComplete,
      commitMode,
      commitMessageTemplate,
      onCompleteCommand,
      onFailCommand,
      showAgentOutput: sharedRuntimeOptions.showAgentOutput,
      runAll: true,
      redo,
      resetAfter,
      clean,
      rounds,
      forceUnlock: sharedRuntimeOptions.forceUnlock,
      cliBlockTimeoutMs: sharedRuntimeOptions.cliBlockTimeoutMs,
      ignoreCliBlock: sharedRuntimeOptions.ignoreCliBlock,
      cacheCliBlocks,
      verbose,
    });
  };
}

/**
 * Creates a new Markdown file with seed text and validates collision/parent-directory constraints.
 */
function createSeedMarkdownFile(markdownFile: string, seedText: string): void {
  const parentDirectory = path.dirname(markdownFile);
  let parentDirectoryStats: fs.Stats;
  try {
    parentDirectoryStats = fs.statSync(parentDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Cannot create make document: ${markdownFile}. Parent directory does not exist: ${parentDirectory}.`);
    }
    throw new Error(`Cannot create make document: ${markdownFile}. Cannot access parent directory: ${parentDirectory}.`);
  }

  if (!parentDirectoryStats.isDirectory()) {
    throw new Error(`Cannot create make document: ${markdownFile}. Parent path is not a directory: ${parentDirectory}.`);
  }

  try {
    fs.writeFileSync(markdownFile, seedText, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Cannot create make document: ${markdownFile}. File already exists.`);
    }
    if (code === "ENOENT") {
      throw new Error(`Cannot create make document: ${markdownFile}. Parent directory does not exist: ${parentDirectory}.`);
    }
    if (code === "ENOTDIR") {
      throw new Error(`Cannot create make document: ${markdownFile}. Parent path is not a directory: ${parentDirectory}.`);
    }
    throw error;
  }
}

/**
 * Appends seed text to an existing Markdown file with an extra newline boundary.
 */
function appendSeedMarkdownFile(markdownFile: string, seedText: string): void {
  const existingContent = readAddDocumentForAppend(markdownFile);
  const appendPayload = buildAddAppendPayload(existingContent, seedText);
  try {
    fs.appendFileSync(markdownFile, appendPayload, { encoding: "utf8" });
  } catch (error) {
    throw mapAddDocumentAppendError(markdownFile, error);
  }
}

function readAddDocumentForAppend(markdownFile: string): string {
  try {
    return fs.readFileSync(markdownFile, "utf8");
  } catch (error) {
    throw mapAddDocumentAppendError(markdownFile, error);
  }
}

function buildAddAppendPayload(existingContent: string, seedText: string): string {
  if (existingContent.length === 0) {
    return seedText;
  }

  if (/(?:\r?\n){2}$/.test(existingContent)) {
    return seedText;
  }

  const lineBreak = /\r\n$/.test(existingContent) ? "\r\n" : "\n";
  const separator = /\r?\n$/.test(existingContent)
    ? lineBreak
    : `${lineBreak}${lineBreak}`;

  return `${separator}${seedText}`;
}

function mapAddDocumentAppendError(markdownFile: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new Error(`Cannot append add document: ${markdownFile}. File does not exist.`);
  }
  if (code === "ENOTDIR") {
    return new Error(`Cannot append add document: ${markdownFile}. A path segment is not a directory.`);
  }
  if (code === "EISDIR") {
    return new Error(`Cannot append add document: ${markdownFile}. Path is a directory.`);
  }

  return error instanceof Error
    ? error
    : new Error(`Cannot append add document: ${markdownFile}. Unknown append error.`);
}

/**
 * Preserves valid subcommand exit codes while falling back to a generic execution failure.
 */
function normalizeMakePhaseExitCode(exitCode: number): number {
  if (Number.isSafeInteger(exitCode) && exitCode >= 0) {
    return exitCode;
  }

  return 1;
}

/**
 * Preserves valid loop-iteration exit codes while falling back to a generic execution failure.
 */
function normalizeLoopIterationExitCode(exitCode: number): number {
  if (Number.isSafeInteger(exitCode) && exitCode >= 0) {
    return exitCode;
  }

  return 1;
}

interface LoopCooldownCountdownOptions {
  app: CliApp;
  cooldownSeconds: number;
  nextIteration: number;
  loopStartMs?: number;
  timeLimitMs?: number;
  onInterrupt?: (signal: NodeJS.Signals) => void;
  setActiveCooldownCanceller?: (cancel: (() => void) | undefined) => void;
}

type LoopCooldownInterrupt = NodeJS.Signals | "TIME_LIMIT";

async function emitLoopCooldownCountdown({
  app,
  cooldownSeconds,
  nextIteration,
  loopStartMs,
  timeLimitMs,
  onInterrupt,
  setActiveCooldownCanceller,
}: LoopCooldownCountdownOptions): Promise<LoopCooldownInterrupt | undefined> {
  let interruptedBySignal: LoopCooldownInterrupt | undefined;
  let activeSleep: ReturnType<typeof cancellableSleep> | undefined;
  const hasTimeLimit = typeof timeLimitMs === "number" && typeof loopStartMs === "number";

  const interruptCooldown = (signal: NodeJS.Signals) => {
    interruptedBySignal = signal;
    onInterrupt?.(signal);
    activeSleep?.cancel();
  };

  const sigintListener = () => {
    interruptCooldown("SIGINT");
  };
  const sigtermListener = () => {
    interruptCooldown("SIGTERM");
  };

  process.prependOnceListener("SIGINT", sigintListener);
  process.prependOnceListener("SIGTERM", sigtermListener);

  for (let remainingSeconds = cooldownSeconds; remainingSeconds > 0; remainingSeconds -= 1) {
    if (interruptedBySignal) {
      break;
    }

    if (hasTimeLimit && Date.now() - loopStartMs >= timeLimitMs) {
      interruptedBySignal = "TIME_LIMIT";
      break;
    }

    const shouldEmitTick = remainingSeconds === cooldownSeconds
      || remainingSeconds < 10
      || remainingSeconds % 10 === 0;
    if (shouldEmitTick) {
      emitCliInfo(app, `Loop cooldown: ${remainingSeconds}s remaining before iteration ${nextIteration}.`);
    }

    const sleepDurationMs = hasTimeLimit
      ? Math.min(1000, Math.max(0, timeLimitMs - (Date.now() - loopStartMs)))
      : 1000;
    if (sleepDurationMs <= 0) {
      interruptedBySignal = "TIME_LIMIT";
      break;
    }

    activeSleep = cancellableSleep(sleepDurationMs);
    setActiveCooldownCanceller?.(() => {
      activeSleep?.cancel();
    });
    await activeSleep.promise;
    activeSleep = undefined;
    setActiveCooldownCanceller?.(undefined);
  }

  setActiveCooldownCanceller?.(undefined);
  process.off("SIGINT", sigintListener);
  process.off("SIGTERM", sigtermListener);

  return interruptedBySignal;
}

/**
 * Creates the `unlock` command action handler.
 *
 * The returned action forwards a source path to the application `unlockTask` use case.
 */
export function createUnlockCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string) => CliActionResult {
  // Unlock requests are direct pass-through operations.
  return (source: string) => getApp().unlockTask({ source });
}

const BOOTSTRAP_APPLICABLE_MODIFIERS = new Set(["profile"]);

function resolveBootstrapSeedText(seedText: string, configDirOption: string | undefined): string {
  const rawSeedText = seedText;
  if (rawSeedText.trim().length === 0) {
    return rawSeedText;
  }

  const pathOperations = createNodePathOperationsAdapter();
  const explicitConfigDir = configDirOption
    ? {
      configDir: pathOperations.resolve(process.cwd(), configDirOption),
      isExplicit: true,
    }
    : undefined;
  const configDir = explicitConfigDir ?? resolveConfigDirForInvocation();

  const toolResolver = createToolResolverAdapter({
    fileSystem: createNodeFileSystem(),
    pathOperations,
    configDir,
  });

  let prefixChain: PrefixChain;
  try {
    prefixChain = parsePrefixChain(rawSeedText, toolResolver);
  } catch {
    return rawSeedText;
  }

  if (!isBootstrapApplicablePrefixChain(prefixChain)) {
    return rawSeedText;
  }

  const rendered = renderBootstrapSeedTemplate(prefixChain, rawSeedText);
  return rendered ?? rawSeedText;
}

function isBootstrapApplicablePrefixChain(prefixChain: PrefixChain): boolean {
  if (!prefixChain.handler) {
    return false;
  }

  for (const modifier of prefixChain.modifiers) {
    if (!BOOTSTRAP_APPLICABLE_MODIFIERS.has(modifier.tool.name.toLowerCase())) {
      return false;
    }
  }

  const handlerTool = prefixChain.handler.tool;
  if (handlerTool.kind !== "handler") {
    return false;
  }

  return typeof handlerTool.template === "string";
}

function renderBootstrapSeedTemplate(prefixChain: PrefixChain, rawSeedText: string): string | undefined {
  const handler = prefixChain.handler;
  if (!handler || typeof handler.tool.template !== "string") {
    return undefined;
  }

  const profile = resolveBootstrapProfile(prefixChain);
  const templateVars: TemplateVars = {
    task: rawSeedText,
    payload: handler.payload,
    file: "",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: rawSeedText,
    profile,
    seed: rawSeedText,
  };

  try {
    return renderTemplate(handler.tool.template, templateVars);
  } catch {
    return undefined;
  }
}

function resolveBootstrapProfile(prefixChain: PrefixChain): string | undefined {
  let profile: string | undefined;
  for (const modifier of prefixChain.modifiers) {
    if (modifier.tool.name.toLowerCase() === "profile") {
      const candidate = modifier.payload.trim();
      if (candidate.length > 0) {
        profile = candidate;
      }
    }
  }

  return profile;
}

/**
 * Creates the `workspace unlink` command action handler.
 *
 * The returned action forwards normalized selector and safety flags to the
 * workspace unlink application use case.
 */
export function createWorkspaceUnlinkCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return getApp().workspaceUnlinkTask({
      workspace: normalizeOptionalString(opts.workspace),
      all: Boolean(opts.all as boolean | undefined),
      dryRun: Boolean(opts.dryRun as boolean | undefined),
    });
  };
}

/**
 * Creates the `workspace remove` command action handler.
 *
 * The returned action forwards normalized selector, deletion, and safety flags
 * to the workspace remove application use case.
 */
export function createWorkspaceRemoveCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return getApp().workspaceRemoveTask({
      workspace: normalizeOptionalString(opts.workspace),
      all: Boolean(opts.all as boolean | undefined),
      deleteFiles: Boolean(opts.deleteFiles as boolean | undefined),
      dryRun: Boolean(opts.dryRun as boolean | undefined),
      force: Boolean(opts.force as boolean | undefined),
    });
  };
}

/**
 * Creates the `init` command action handler.
 *
 * The returned action initializes project configuration through the application boundary.
 */
export function createInitCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (
  options: {
    language?: string;
    defaultWorker?: string;
    tuiWorker?: string;
    gitignore?: boolean;
    overwriteConfig?: boolean;
  },
) => CliActionResult {
  return async (options) => {
    const app = getApp();
    const language = normalizeOptionalString(options.language);
    const initExitCode = await app.initProject({
      defaultWorker: options.defaultWorker,
      tuiWorker: options.tuiWorker,
      gitignore: options.gitignore,
      overwriteConfig: options.overwriteConfig,
      silent: Boolean(language),
    });

    if (initExitCode !== EXIT_CODE_SUCCESS) {
      return initExitCode;
    }

    if (!language) {
      return initExitCode;
    }

    const localizeExitCode = await app.localizeProject({ language });
    if (localizeExitCode !== EXIT_CODE_SUCCESS) {
      return localizeExitCode;
    }

    return app.initProject({
      defaultWorker: options.defaultWorker,
      tuiWorker: options.tuiWorker,
      gitignore: options.gitignore,
      overwriteConfig: options.overwriteConfig,
    });
  };
}

/**
 * Creates the `localize` command action handler.
 *
 * The returned action validates `--language` then delegates localization
 * to the application `localizeProject` use case.
 */
export function createLocalizeCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    const language = normalizeOptionalString(opts.language);
    if (!language) {
      throw new Error("Missing required option: --language <lang>.");
    }

    return getApp().localizeProject({ language });
  };
}

/**
 * Creates the `with` command action handler.
 *
 * The returned action forwards the selected harness to the dedicated
 * application `withTask` use case.
 */
export function createWithCommandAction({
  getApp,
  getWorkerFromSeparator,
  getInvocationArgv,
  isInteractiveTerminal: isInteractiveTerminalOverride,
}: Pick<WorkerActionDependencies, "getApp" | "getWorkerFromSeparator" | "getInvocationArgv"> & {
  isInteractiveTerminal?: () => boolean;
}): (harness: string) => CliActionResult {
  return async (harness: string) => {
    const app = getApp();
    const result = await resolveWithCommandHandler(app)({ harness });
    const emit = app.emitOutput;

    if (result.source === "custom") {
      emit?.({
        kind: "warn",
        message: `Harness \"${harness}\" is not in the preset registry. Saved custom invocation mapping.`,
      });
    }

    if (result.cancelled) {
      emit?.({
        kind: "info",
        message: `Cancelled: kept existing worker config unchanged for harness ${result.harnessKey}.`,
      });
      return result.exitCode;
    }

    emit?.({
      kind: result.changed ? "success" : "info",
      message: result.source === "preset"
        ? (result.changed
          ? `Applied harness preset: ${result.harnessKey}`
          : `No change: harness preset ${result.harnessKey} is already configured.`)
        : (result.changed
          ? `Applied custom harness mapping: ${result.harnessKey}`
          : `No change: custom harness mapping ${result.harnessKey} is already configured.`),
    });
    emit?.({ kind: "info", message: `Path: ${result.configPath}` });
    emit?.({ kind: "info", message: "Configured keys:" });

    for (const configuredKey of result.configuredKeys) {
      emit?.({ kind: "info", message: formatWithConfiguredKeyLine(configuredKey) });
    }

    if (
      result.exitCode === EXIT_CODE_SUCCESS
      && hasWithTaskInteractiveWorker(result)
      && (isInteractiveTerminalOverride ?? isInteractiveTerminal)()
    ) {
      emit?.({ kind: "info", message: "Opening Rundown root TUI..." });
      return runRootTui({
        app,
        workerPattern: resolveWorkerPattern(undefined, getWorkerFromSeparator),
        argv: resolveInvocationArgv(getInvocationArgv),
      });
    }

    return result.exitCode;
  };
}

/**
 * Creates the `memory-validate` command action handler.
 *
 * The returned action maps CLI flags to the application `validateMemory` use case.
 */
export function createMemoryValidateCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    return getApp().validateMemory({
      source,
      fix: Boolean(opts.fix as boolean | undefined),
      json: Boolean(opts.json as boolean | undefined),
    });
  };
}

/**
 * Creates the `memory-view` command action handler.
 *
 * The returned action maps CLI flags to the application `viewMemory` use case.
 */
export function createMemoryViewCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    return getApp().viewMemory({
      source,
      json: Boolean(opts.json as boolean | undefined),
      summary: Boolean(opts.summary as boolean | undefined),
      all: Boolean(opts.all as boolean | undefined),
    });
  };
}

/**
 * Creates the `memory-clean` command action handler.
 *
 * The returned action maps CLI flags to the application `cleanMemory` use case.
 */
export function createMemoryCleanCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    return getApp().cleanMemory({
      source,
      dryRun: Boolean(opts.dryRun as boolean | undefined),
      orphans: Boolean(opts.orphans as boolean | undefined),
      outdated: Boolean(opts.outdated as boolean | undefined),
      olderThan: typeof opts.olderThan === "string" && opts.olderThan.trim().length > 0
        ? opts.olderThan
        : "90d",
      all: Boolean(opts.all as boolean | undefined),
      force: Boolean(opts.force as boolean | undefined),
    });
  };
}

/**
 * Creates the `worker-health` command action handler.
 *
 * The returned action maps CLI flags to the application `viewWorkerHealthStatus` use case.
 */
export function createWorkerHealthCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return getApp().viewWorkerHealthStatus({
      json: Boolean(opts.json as boolean | undefined),
    });
  };
}

export function createConfigSetCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (key: string, value: string, opts: CliOpts) => CliActionResult {
  return (key: string, value: string, opts: CliOpts) => {
    return getApp().configSet({
      scope: parseConfigMutationScope(opts.scope as string | undefined),
      key,
      value,
      valueType: parseConfigValueType(opts.type as string | undefined),
    });
  };
}

export function createConfigUnsetCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (key: string, opts: CliOpts) => CliActionResult {
  return (key: string, opts: CliOpts) => {
    return getApp().configUnset({
      scope: parseConfigMutationScope(opts.scope as string | undefined),
      key,
    });
  };
}

export function createConfigGetCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (key: string, opts: CliOpts) => CliActionResult {
  return (key: string, opts: CliOpts) => {
    return getApp().configGet({
      scope: parseConfigReadScope(opts.scope as string | undefined),
      key,
      json: Boolean(opts.json as boolean | undefined),
      showSource: Boolean(opts.showSource as boolean | undefined),
    });
  };
}

export function createConfigListCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return getApp().configList({
      scope: parseConfigReadScope(opts.scope as string | undefined),
      json: Boolean(opts.json as boolean | undefined),
      showSource: Boolean(opts.showSource as boolean | undefined),
    });
  };
}

export function createConfigPathCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return getApp().configPath({
      scope: parseConfigReadScope(opts.scope as string | undefined),
    });
  };
}

/**
 * Creates the `intro` command action handler.
 *
 * The returned action renders a CLI introduction presenting rundown concepts.
 * This command has no app dependencies — it only needs the CLI version string.
 */
export function createIntroCommandAction({
  version,
  getApp,
}: {
  version: string;
  getApp: () => CliApp;
}): () => CliActionResult {
  return async () => {
    const { renderIntro } = await import("./intro.js");
    return renderIntro(version, { emit: (event) => getApp().emitOutput?.(event) });
  };
}

/**
 * Resolves the active log command implementation for the current app build.
 *
 * Supports both `logTask` (current) and `logRuns` (legacy) method names to preserve compatibility.
 */
function resolveLogCommandHandler(appInstance: CliApp): LogCommandHandler {
  const maybeLogHandlers = appInstance as CliApp & {
    logTask?: LogCommandHandler;
    logRuns?: LogCommandHandler;
  };

  // Prefer the current handler name when available.
  if (typeof maybeLogHandlers.logTask === "function") {
    return maybeLogHandlers.logTask;
  }

  // Fall back to legacy naming used by older app builds.
  if (typeof maybeLogHandlers.logRuns === "function") {
    return maybeLogHandlers.logRuns;
  }

  // Surface a clear runtime error when log support is absent.
  throw new Error("The `log` command is not available in this build.");
}

/**
 * Resolves the active migrate command implementation for the current app build.
 */
function resolveMigrateCommandHandler(appInstance: CliApp): MigrateCommandHandler {
  const maybeMigrateHandler = appInstance as CliApp & {
    migrateTask?: MigrateCommandHandler;
  };

  if (typeof maybeMigrateHandler.migrateTask === "function") {
    return maybeMigrateHandler.migrateTask;
  }

  throw new Error("The `migrate` command is not available in this build.");
}

/**
 * Resolves the active predict command implementation for the current app build.
 */
function resolvePredictCommandHandler(appInstance: CliApp): PredictCommandHandler {
  const maybePredictHandler = appInstance as CliApp & {
    predictTask?: PredictCommandHandler;
  };

  if (typeof maybePredictHandler.predictTask === "function") {
    return maybePredictHandler.predictTask;
  }

  throw new Error("The `predict` command is not available in this build.");
}

/**
 * Resolves the active snapshot command implementation for the current app build.
 */
function resolveSnapshotCommandHandler(appInstance: CliApp): SnapshotCommandHandler {
  const maybeSnapshotHandler = appInstance as CliApp & {
    snapshotTask?: SnapshotCommandHandler;
  };

  if (typeof maybeSnapshotHandler.snapshotTask === "function") {
    return maybeSnapshotHandler.snapshotTask;
  }

  throw new Error("The `snapshot` command is not available in this build.");
}

/**
 * Resolves the active test command implementation for the current app build.
 */
function resolveTestCommandHandler(appInstance: CliApp): TestCommandHandler {
  const maybeTestHandler = appInstance as CliApp & {
    testSpecs?: TestCommandHandler;
  };

  if (typeof maybeTestHandler.testSpecs === "function") {
    return maybeTestHandler.testSpecs;
  }

  throw new Error("The `test` command is not available in this build.");
}

/**
 * Resolves the active translate command implementation for the current app build.
 */
function resolveTranslateCommandHandler(appInstance: CliApp): TranslateCommandHandler {
  const maybeTranslateHandler = appInstance as CliApp & {
    translateTask?: TranslateCommandHandler;
  };

  if (typeof maybeTranslateHandler.translateTask === "function") {
    return maybeTranslateHandler.translateTask;
  }

  throw new Error("The `translate` command is not available in this build.");
}

/**
 * Resolves the active with command implementation for the current app build.
 */
function resolveWithCommandHandler(appInstance: CliApp): WithCommandHandler {
  const maybeWithHandler = appInstance as CliApp & {
    withTask?: WithCommandHandler;
  };

  if (typeof maybeWithHandler.withTask === "function") {
    return maybeWithHandler.withTask;
  }

  throw new Error("The `with` command is not available in this build.");
}

function formatWithConfiguredKeyLine(configuredKey: WithTaskConfiguredKeyResult): string {
  if (configuredKey.status === "set") {
    return `- ${configuredKey.keyPath} = ${JSON.stringify(configuredKey.value)}`;
  }

  if (configuredKey.status === "removed") {
    return `- ${configuredKey.keyPath} (removed)`;
  }

  return `- ${configuredKey.keyPath} (preserved)`;
}

function parseConfigMutationScope(value: string | undefined): ConfigMutationScope {
  const resolved = (value ?? "local").trim().toLowerCase();
  if (resolved === "local" || resolved === "global") {
    return resolved;
  }

  throw new Error(`Invalid --scope value: ${value}. Allowed: local, global.`);
}

function parseConfigReadScope(value: string | undefined): ConfigReadScope {
  const resolved = (value ?? "effective").trim().toLowerCase();
  if (resolved === "effective" || resolved === "local" || resolved === "global") {
    return resolved;
  }

  throw new Error(`Invalid --scope value: ${value}. Allowed: effective, local, global.`);
}

function parseConfigValueType(value: string | undefined): ConfigValueType {
  const resolved = (value ?? "auto").trim().toLowerCase();
  if (resolved === "auto" || resolved === "string" || resolved === "number" || resolved === "boolean" || resolved === "json") {
    return resolved;
  }

  throw new Error(`Invalid --type value: ${value}. Allowed: auto, string, number, boolean, json.`);
}

function parseMigrateSourceMode(value: string | undefined): MigrateSourceMode {
  if (value === undefined) {
    return "design";
  }

  const resolved = value.trim().toLowerCase();
  if (resolved === "implementation" || resolved === "prediction") {
    return resolved;
  }

  throw new Error(
    `Invalid --from value: ${value}. Allowed: implementation, prediction. Omit --from for default design-diff mode.`,
  );
}
