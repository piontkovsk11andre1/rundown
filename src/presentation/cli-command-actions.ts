import type { ProcessRunMode } from "../domain/ports/index.js";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import {
  normalizeOptionalString,
  parseCliBlockTimeout,
  parseQueryOutputFormat,
  parseForceAttempts,
  parseLastCount,
  parseLimitCount,
  parseLoopCooldownSeconds,
  parseLoopIterations,
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
  resolvePlanMarkdownFile,
  resolveResearchMarkdownFile,
  resolveMakeMarkdownFile,
  resolveVerifyFlag,
} from "./cli-options.js";
import { cancellableSleep } from "../infrastructure/cancellable-sleep.js";
import { resolveInvocationCommand } from "./cli-argv.js";
import {
  inferWorkerPatternFromCommand,
  parseWorkerPattern,
  type ParsedWorkerPattern,
} from "../domain/worker-pattern.js";
import type { CliApp } from "./cli-app-init.js";
import type {
  QueryCommandInvocationOptions,
  ResearchCommandInvocationOptions,
} from "./cli-invocation-types.js";
import { resolveInvocationWorkspaceContext } from "./invocation-workspace-context.js";

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
    if (resolveInvocationCommand(invocationArgv) !== "rundown") {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    if (!(isInteractiveTerminalOverride ?? isInteractiveTerminal)()) {
      outputHelp();
      return EXIT_CODE_SUCCESS;
    }

    try {
      const exitCode = await getApp().helpTask({
        workerPattern: resolveWorkerPattern(undefined, getWorkerFromSeparator),
        keepArtifacts: false,
        trace: hasTraceFlag(invocationArgv),
        cliVersion,
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

interface RunActionDependencies extends WorkerActionDependencies {
  runnerModes: readonly ProcessRunMode[];
}

type CallActionDependencies = RunActionDependencies;

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

interface ExploreActionDependencies extends WorkerActionDependencies {
  exploreModes: readonly ProcessRunMode[];
}

interface DoActionDependencies extends WorkerActionDependencies {
  makeModes: readonly ProcessRunMode[];
}

interface QueryActionDependencies extends WorkerActionDependencies {
  queryModes: readonly ProcessRunMode[];
}

type MigrateAction =
  | "up"
  | "down"
  | "snapshot"
  | "backlog"
  | "context"
  | "review"
  | "user-experience"
  | "user-session";

type TestAction = "new";

interface MigrateCommandOptions {
  action?: MigrateAction;
  downCount?: number;
  dir?: string;
  confirm: boolean;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern?: ParsedWorkerPattern;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  runId?: string;
}

interface DocsCommandOptions {
  action?: "publish" | "diff";
  dir?: string;
  label?: string;
  target?: "current" | "preview";
}

type DocsCommandHandler = (options: DocsCommandOptions) => CliActionResult;

type MigrateCommandHandler = (options: MigrateCommandOptions) => CliActionResult;

interface TestCommandOptions {
  action?: TestAction;
  prompt?: string;
  run: boolean;
  dir?: string;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput: boolean;
}

type TestCommandHandler = (options: TestCommandOptions) => CliActionResult;

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
}: RunActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return async (source: string, opts: CliOpts) => {
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
    const revertable = Boolean(opts.revertable as boolean | undefined);
    const keepArtifacts = (opts.keepArtifacts as boolean) || revertable;
    const trace = opts.trace as boolean;
    const traceStats = Boolean(opts.traceStats as boolean | undefined);
    const traceOnly = opts.traceOnly as boolean;
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined) || revertable;
    const commitMode = parseCommitMode(opts.commitMode as string | undefined);
    const commitMessageTemplate = normalizeOptionalString(opts.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const runAll = Boolean(opts.all as boolean | undefined);
    const clean = Boolean(opts.clean as boolean | undefined);
    const redo = Boolean(opts.redo as boolean | undefined) || clean;
    const resetAfter = Boolean(opts.resetAfter as boolean | undefined) || clean;
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
      source,
      ...workerWorkspaceRuntimeOptions,
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
}: CallActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  const runAction = createRunCommandAction({
    getApp,
    getWorkerFromSeparator,
    runnerModes,
  });

  return (source: string, opts: CliOpts) => runAction(source, {
    ...opts,
    all: true,
    clean: true,
    cacheCliBlocks: true,
  });
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
}: LoopActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return async (source: string, opts: CliOpts) => {
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
    const sharedRuntimeOptions = resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator);
    const revertable = Boolean(opts.revertable as boolean | undefined);
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined) || revertable;
    const commitMode = parseCommitMode(opts.commitMode as string | undefined);
    const commitMessageTemplate = normalizeOptionalString(opts.commitMessage);
    const onCompleteCommand = normalizeOptionalString(opts.onComplete);
    const onFailCommand = normalizeOptionalString(opts.onFail);
    const rounds = parseRounds(opts.rounds as string | undefined);
    const verbose = resolveVerboseOption(opts);
    const iterations = parseLoopIterations(opts.iterations as string | undefined);
    const cooldownSeconds = parseLoopCooldownSeconds(opts.cooldown as string | undefined);
    const cooldownMs = cooldownSeconds * 1000;
    const continueOnError = Boolean(opts.continueOnError as boolean | undefined);
    const hasBoundedIterations = typeof iterations === "number";
    let iteration = 0;
    let succeededIterations = 0;
    let failedIterations = 0;
    let loopExitCode = 0;
    let cancelActiveCooldown: (() => void) | undefined;

    const cancelLoopCooldownOnShutdown = () => {
      cancelActiveCooldown?.();
    };

    process.prependListener("SIGINT", cancelLoopCooldownOnShutdown);
    process.prependListener("SIGTERM", cancelLoopCooldownOnShutdown);

    try {

      while (!hasBoundedIterations || iteration < iterations) {
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
          }));
        } finally {
          releaseLoopHeldLocks(app);
        }
        const isSuccess = iterationExitCode === 0;
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
        } else {
          emitCliInfo(app, `Loop iteration ${iteration} completed - starting next iteration immediately.`);
        }
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
}: DiscussActionDependencies): (source: string | undefined, opts: CliOpts) => CliActionResult {
  return (source: string | undefined, opts: CliOpts) => {
    // Parse and normalize discuss-specific option values.
    const mode = parseRunnerMode(opts.mode as string | undefined, discussModes);
    const sortMode = parseSortMode(opts.sort as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const runId = normalizeOptionalString(opts.run);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const trace = Boolean(opts.trace as boolean | undefined);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const verbose = resolveVerboseOption(opts);
    const normalizedSource = typeof source === "string" && source.trim().length > 0
      ? source
      : "";

    if (runId === undefined && normalizedSource === "") {
      throw new Error("Missing required argument: <source>. Provide a Markdown source, or pass --run <id|prefix|latest> to discuss a finished run.");
    }

    // Delegate to the discuss application flow with normalized arguments.
    return getApp().discussTask({
      source: normalizedSource,
      runId,
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
    const trace = opts.trace as boolean;
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
    const trace = opts.trace as boolean;
    const showAgentOutput = resolveShowAgentOutputOption(opts);
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const verbose = resolveVerboseOption(opts);

    // Trigger planning in the app layer with a normalized payload.
    return getApp().planTask({
      source: markdownFile,
      ...workerWorkspaceRuntimeOptions,
      scanCount,
      maxItems,
      deep,
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
    });
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
}: ResearchActionDependencies): (markdownFiles: string[], opts: CliOpts) => CliActionResult {
  return (markdownFiles: string[], opts: CliOpts) => {
    const workerWorkspaceRuntimeOptions = resolveWorkerWorkspaceRuntimeOptions();
    const markdownFile = resolveResearchMarkdownFile(markdownFiles);
    const mode = parseRunnerMode(opts.mode as string | undefined, researchModes);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
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
 * Creates the `explore` command action handler.
 *
 * The returned action composes `research` and `plan` over the same Markdown source,
 * forwarding shared runtime options to both phases and plan-specific options to planning.
 */
export function createExploreCommandAction({
  getApp,
  getWorkerFromSeparator,
  exploreModes,
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
    } = parseExploreCliOptions(opts, exploreModes, getWorkerFromSeparator);

    return runExplorePhases({
      app,
      targetMarkdownFile,
      workspaceRuntimeOptions,
      mode,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      deep,
      maxItems,
      verbose,
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
 * The returned action initializes a scaffold project directory from a description.
 */
export function createStartCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (description: string, opts: CliOpts) => CliActionResult {
  return (description: string, opts: CliOpts) => {
    return getApp().startProject({
      description,
      dir: normalizeOptionalString(opts.dir),
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
}: WorkerActionDependencies): (
  action: string | undefined,
  count: string | undefined,
  opts: CliOpts,
  ) => CliActionResult {
  return (action: string | undefined, count: string | undefined, opts: CliOpts) => {
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const slugWorkerPattern = typeof opts.slugWorker === "string"
      ? resolveWorkerPattern(opts.slugWorker, getWorkerFromSeparator)
      : undefined;

    const normalizedAction = normalizeOptionalString(action);
    if (normalizedAction !== undefined && !isMigrateAction(normalizedAction)) {
      throw new Error(
        "Invalid migrate action: "
          + normalizedAction
          + ". Allowed: up, down, snapshot, backlog, context, review, user-experience, user-session.",
      );
    }

    if (count !== undefined && normalizedAction !== "down") {
      throw new Error("The optional [count] argument is only supported for `migrate down [n]`.");
    }

    return resolveMigrateCommandHandler(getApp())({
      action: normalizedAction,
      downCount: parseLastCount(count),
      dir: normalizeOptionalString(opts.dir),
      confirm: Boolean(opts.confirm as boolean | undefined),
      workerPattern,
      ...(slugWorkerPattern ? { slugWorkerPattern } : {}),
      keepArtifacts: Boolean(opts.keepArtifacts as boolean | undefined),
      showAgentOutput: resolveShowAgentOutputOption(opts),
      runId: normalizeOptionalString(opts.run),
    });
  };
}

/**
 * Creates the `docs publish` command action handler.
 *
 * The returned action reuses the revision snapshot flow currently implemented by
 * the migrate use case and forwards docs-specific options.
 */
export function createDocsPublishCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (opts: CliOpts) => CliActionResult {
  return (opts: CliOpts) => {
    return resolveDocsCommandHandler(getApp())({
      action: "publish",
      dir: normalizeOptionalString(opts.dir),
      label: normalizeOptionalString(opts.label),
    });
  };
}

/**
 * Creates the `docs diff` command action handler.
 *
 * The returned action maps docs diff selectors and shorthand target form to the
 * current revision diff behavior while preserving deterministic defaults.
 */
export function createDocsDiffCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (target: string | undefined, opts: CliOpts) => CliActionResult {
  return (target: string | undefined, opts: CliOpts) => {
    const resolvedDiffMode = resolveDocsDiffMode({
      target: normalizeOptionalString(target),
      from: normalizeOptionalString(opts.from),
      to: normalizeOptionalString(opts.to),
    });

    return resolveDocsCommandHandler(getApp())({
      action: "diff",
      dir: normalizeOptionalString(opts.dir),
      target: resolvedDiffMode,
    });
  };
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
    if (normalizedAction !== undefined && !isTestAction(normalizedAction)) {
      throw new Error("Invalid test action: " + normalizedAction + ". Allowed: new.");
    }

    if (prompt !== undefined && normalizedAction !== "new") {
      throw new Error("The optional [prompt] argument is only supported for `test new <prompt>`.");
    }

    return resolveTestCommandHandler(getApp())({
      action: normalizedAction,
      prompt: normalizeOptionalString(prompt),
      run: Boolean(opts.run as boolean | undefined),
      dir: normalizeOptionalString(opts.dir),
      workerPattern: resolveWorkerPattern(opts.worker, getWorkerFromSeparator),
      showAgentOutput: resolveShowAgentOutputOption(opts),
    });
  };
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
    const sharedRuntimeOptions = resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator);
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

interface RunExplorePhasesOptions {
  app: CliApp;
  targetMarkdownFile: string;
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
): ParsedExploreCliOptions {
  return {
    workspaceRuntimeOptions: resolveWorkerWorkspaceRuntimeOptions(),
    mode: parseRunnerMode(opts.mode as string | undefined, exploreModes),
    sharedRuntimeOptions: resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator),
    dryRun: Boolean(opts.dryRun as boolean | undefined),
    printPrompt: Boolean(opts.printPrompt as boolean | undefined),
    scanCount: parseScanCount(opts.scanCount as string | undefined),
    deep: parsePlanDeep(opts.deep as string | undefined),
    maxItems: parseMaxItems(opts.maxItems as string | undefined),
    verbose: resolveVerboseOption(opts),
  };
}

async function runExplorePhases({
  app,
  targetMarkdownFile,
  workspaceRuntimeOptions,
  mode,
  sharedRuntimeOptions,
  dryRun,
  printPrompt,
  scanCount,
  deep,
  maxItems,
  verbose,
}: RunExplorePhasesOptions): Promise<number> {
  const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;

  emitCliInfo(app, "Explore phase 1/2: research");

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

  emitCliInfo(app, "Explore transition: research -> plan");
  emitCliInfo(app, "Explore phase 2/2: plan");

  return normalizeMakePhaseExitCode(await app.planTask({
    source: targetMarkdownFile,
    ...workspaceRuntimeOptions,
    scanCount,
    maxItems,
    deep,
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
 * Creates the `make` command action handler.
 *
 * The returned action creates a new Markdown file from seed text, then runs `research` and `plan`
 * in strict sequence against that same file.
 */
export function createMakeCommandAction({
  getApp,
  getWorkerFromSeparator,
  makeModes,
}: MakeActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveMakeMarkdownFile(markdownFile);
    const {
      workspaceRuntimeOptions,
      mode,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    } = parseMakeBootstrapCliOptions(opts, makeModes, getWorkerFromSeparator);

    return runMakeBootstrapPhases({
      app,
      seedText,
      targetMarkdownFile,
      workspaceRuntimeOptions,
      mode,
      sharedRuntimeOptions,
      dryRun,
      printPrompt,
      scanCount,
      maxItems,
      verbose,
    });
  };
}

interface RunMakeBootstrapPhasesOptions {
  app: CliApp;
  seedText: string;
  targetMarkdownFile: string;
  workspaceRuntimeOptions: WorkerWorkspaceRuntimeOptions;
  mode: ProcessRunMode;
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
): ParsedMakeBootstrapCliOptions {
  return {
    workspaceRuntimeOptions: resolveWorkerWorkspaceRuntimeOptions(),
    mode: parseRunnerMode(opts.mode as string | undefined, makeModes),
    sharedRuntimeOptions: resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator),
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
  sharedRuntimeOptions,
  dryRun,
  printPrompt,
  scanCount,
  maxItems,
  verbose,
}: RunMakeBootstrapPhasesOptions): Promise<number> {
  const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;

  createSeedMarkdownFile(targetMarkdownFile, seedText);

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
}: DoActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveMakeMarkdownFile(markdownFile);
    const {
      workspaceRuntimeOptions,
      mode,
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
    const revertable = Boolean(opts.revertable as boolean | undefined);
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined) || revertable;
    const commitMode = "per-task" as const;
    const commitMessageTemplate = normalizeOptionalString(opts.commitMessage);
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
  onInterrupt?: (signal: NodeJS.Signals) => void;
  setActiveCooldownCanceller?: (cancel: (() => void) | undefined) => void;
}

async function emitLoopCooldownCountdown({
  app,
  cooldownSeconds,
  nextIteration,
  onInterrupt,
  setActiveCooldownCanceller,
}: LoopCooldownCountdownOptions): Promise<NodeJS.Signals | undefined> {
  let interruptedBySignal: NodeJS.Signals | undefined;
  let activeSleep: ReturnType<typeof cancellableSleep> | undefined;

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
    emitCliInfo(app, `Loop cooldown: ${remainingSeconds}s remaining before iteration ${nextIteration}.`);
    activeSleep = cancellableSleep(1000);
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

/**
 * Creates the `init` command action handler.
 *
 * The returned action initializes project configuration through the application boundary.
 */
export function createInitCommandAction({
  getApp,
}: Pick<WorkerActionDependencies, "getApp">): (options: { defaultWorker?: string; tuiWorker?: string; gitignore?: boolean }) => CliActionResult {
  return (options) => getApp().initProject({ defaultWorker: options.defaultWorker, tuiWorker: options.tuiWorker, gitignore: options.gitignore });
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

/**
 * Creates the `intro` command action handler.
 *
 * The returned action renders an animated CLI presentation introducing rundown.
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
 * Resolves the active docs command implementation for the current app build.
 */
function resolveDocsCommandHandler(appInstance: CliApp): DocsCommandHandler {
  const maybeDocsHandler = appInstance as CliApp & {
    docsTask?: DocsCommandHandler;
  };

  if (typeof maybeDocsHandler.docsTask === "function") {
    return maybeDocsHandler.docsTask;
  }

  throw new Error("The `docs` command is not available in this build.");
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

function isMigrateAction(value: string): value is MigrateAction {
  return value === "up"
    || value === "down"
    || value === "snapshot"
    || value === "backlog"
    || value === "context"
    || value === "review"
    || value === "user-experience"
    || value === "user-session";
}

function isTestAction(value: string): value is TestAction {
  return value === "new";
}

function resolveDocsDiffMigrateAction(target: string | undefined): "current" | "preview" {
  if (target === undefined || target === "current") {
    return "current";
  }

  if (target === "preview") {
    return "preview";
  }

  throw new Error("Invalid docs diff target: " + target + ". Allowed: current, preview.");
}

function resolveDocsDiffMode(input: {
  target: string | undefined;
  from: string | undefined;
  to: string | undefined;
}): "current" | "preview" {
  const { target, from, to } = input;
  const hasExplicitSelectors = from !== undefined || to !== undefined;

  if (!hasExplicitSelectors) {
    return resolveDocsDiffMigrateAction(target);
  }

  if (target !== undefined) {
    throw new Error("Invalid docs diff selector usage: [target] shorthand cannot be combined with --from/--to.");
  }

  if (from === undefined || to === undefined) {
    throw new Error("Invalid docs diff selector usage: --from and --to must be provided together.");
  }

  parseDocsDiffRevisionSelector(from, "from");
  const toSelector = parseDocsDiffRevisionSelector(to, "to");

  if (toSelector !== "current") {
    throw new Error(
      "Unsupported docs diff selector combination in this build: --to "
      + to
      + ". Use --to current, or use shorthand `rundown docs diff [current|preview]`.",
    );
  }

  return "current";
}

function parseDocsDiffRevisionSelector(value: string, optionName: "from" | "to"): "current" | `rev.${number}` {
  const normalized = value.trim().toLowerCase();
  if (normalized === "current") {
    return "current";
  }

  const revisionMatch = /^rev\.([1-9][0-9]*)$/i.exec(normalized);
  if (!revisionMatch) {
    throw new Error(
      "Invalid docs diff --"
      + optionName
      + " selector: "
      + value
      + ". Allowed: current, rev.<n> (for example: rev.1).",
    );
  }

  const index = Number.parseInt(revisionMatch[1] ?? "", 10);
  return `rev.${index}`;
}
