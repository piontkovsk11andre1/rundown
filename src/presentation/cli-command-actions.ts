import type { ProcessRunMode } from "../domain/ports/index.js";
import {
  normalizeOptionalString,
  parseCliBlockTimeout,
  parseLastCount,
  parseLimitCount,
  parsePromptTransport,
  parseRepairAttempts,
  parseRevertMethod,
  parseRunnerMode,
  parseScanCount,
  parseSortMode,
  resolveIgnoreCliBlockFlag,
  resolveNoRepairFlag,
  resolvePlanMarkdownFile,
  resolveVerifyFlag,
} from "./cli-options.js";
import type { CliApp } from "./cli-app-init.js";

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
  getWorkerFromSeparator: () => string[];
}

interface RunActionDependencies extends WorkerActionDependencies {
  runnerModes: readonly ProcessRunMode[];
}

interface DiscussActionDependencies extends WorkerActionDependencies {
  discussModes: readonly ProcessRunMode[];
}

interface PlanActionDependencies extends WorkerActionDependencies {
  plannerModes: readonly ProcessRunMode[];
}

/**
 * Resolves worker command arguments from either parsed CLI options or the `--` separator payload.
 *
 * Accepts string, string-array, and boolean option shapes produced by the argument parser and always
 * normalizes to a string array consumed by worker-oriented application commands.
 */
function resolveWorkerCommand(
  worker: string | string[] | boolean | undefined,
  getWorkerFromSeparator: () => string[],
): string[] {
  // Preserve repeated `--worker` inputs exactly as provided.
  if (Array.isArray(worker)) {
    return worker;
  }

  // Normalize single `--worker` values into the expected list shape.
  if (typeof worker === "string") {
    return [worker];
  }

  // Fall back to downstream worker arguments passed after `--`.
  return getWorkerFromSeparator();
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
    // Resolve all execution-mode options before building the run request payload.
    const mode = parseRunnerMode(opts.mode as string | undefined, runnerModes);
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
    const workerCommand = resolveWorkerCommand(opts.worker, getWorkerFromSeparator);
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
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);

    // Pass a normalized set of options to the domain application layer.
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
      cliBlockTimeoutMs,
      ignoreCliBlock,
    });
  };
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
}: DiscussActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return (source: string, opts: CliOpts) => {
    // Parse and normalize discuss-specific option values.
    const mode = parseRunnerMode(opts.mode as string | undefined, discussModes);
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
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const workerCommand = resolveWorkerCommand(opts.worker, getWorkerFromSeparator);

    // Delegate to the discuss application flow with normalized arguments.
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
      ignoreCliBlock,
      cliBlockTimeoutMs,
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
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const workerCommand = resolveWorkerCommand(opts.worker, getWorkerFromSeparator);

    // Execute the re-verification workflow in the application layer.
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
      ignoreCliBlock,
      cliBlockTimeoutMs,
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
    // Resolve planning input and execution controls from CLI options.
    const markdownFile = resolvePlanMarkdownFile(markdownFiles);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);
    const mode = parseRunnerMode(opts.mode as string | undefined, plannerModes);
    const transport = parsePromptTransport(opts.transport as string | undefined);
    const dryRun = opts.dryRun as boolean;
    const printPrompt = opts.printPrompt as boolean;
    const keepArtifacts = opts.keepArtifacts as boolean;
    const trace = opts.trace as boolean;
    const forceUnlock = Boolean(opts.forceUnlock as boolean | undefined);
    const ignoreCliBlock = resolveIgnoreCliBlockFlag(opts);
    const cliBlockTimeoutMs = parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined);
    const varsFileOption = opts.varsFile as string | boolean | undefined;
    const cliTemplateVarArgs = (opts.var as string[] | undefined) ?? [];
    const workerCommand = resolveWorkerCommand(opts.worker, getWorkerFromSeparator);

    // Trigger planning in the app layer with a normalized payload.
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
      ignoreCliBlock,
      cliBlockTimeoutMs,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
    });
  };
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
}: Pick<WorkerActionDependencies, "getApp">): () => CliActionResult {
  // Initialization has no runtime options beyond command invocation.
  return () => getApp().initProject();
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
