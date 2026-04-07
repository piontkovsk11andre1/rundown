import type { ProcessRunMode } from "../domain/ports/index.js";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeOptionalString,
  parseCliBlockTimeout,
  parseLastCount,
  parseLimitCount,
  parseRepairAttempts,
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
import {
  inferWorkerPatternFromCommand,
  parseWorkerPattern,
  type ParsedWorkerPattern,
} from "../domain/worker-pattern.js";
import type { CliApp } from "./cli-app-init.js";
import type { ResearchCommandInvocationOptions } from "./cli-invocation-types.js";

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

function emitCliInfo(app: CliApp, message: string): void {
  app.emitOutput?.({ kind: "info", message });
}

interface RunActionDependencies extends WorkerActionDependencies {
  runnerModes: readonly ProcessRunMode[];
}

type CallActionDependencies = RunActionDependencies;

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

interface DoActionDependencies extends WorkerActionDependencies {
  makeModes: readonly ProcessRunMode[];
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
}: RunActionDependencies): (source: string, opts: CliOpts) => CliActionResult {
  return async (source: string, opts: CliOpts) => {
    // Resolve all execution-mode options before building the run request payload.
    const mode = parseRunnerMode(opts.mode as string | undefined, runnerModes);
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
    const workerPattern = resolveWorkerPattern(opts.worker, getWorkerFromSeparator);
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined);
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
      mode,
      workerPattern,
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

    // Execute the re-verification workflow in the application layer.
    return getApp().reverifyTask({
      runId: targetRun,
      last,
      all,
      oldestFirst,
      workerPattern,
      repairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
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

    // Trigger planning in the app layer with a normalized payload.
    return getApp().planTask({
      source: markdownFile,
      scanCount,
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

    const request: ResearchCommandInvocationOptions = {
      source: markdownFile,
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
    };

    return getApp().researchTask(request);
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
}: MakeActionDependencies): (seedText: string, markdownFile: string, opts: CliOpts) => CliActionResult {
  return async (seedText: string, markdownFile: string, opts: CliOpts) => {
    const app = getApp();
    const targetMarkdownFile = resolveMakeMarkdownFile(markdownFile);
    const mode = parseRunnerMode(opts.mode as string | undefined, makeModes);
    const sharedRuntimeOptions = resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator);
    const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const printPrompt = Boolean(opts.printPrompt as boolean | undefined);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);

    createSeedMarkdownFile(targetMarkdownFile, seedText);

    emitCliInfo(app, "Make phase 1/2: research");

    const researchCode = normalizeMakePhaseExitCode(await app.researchTask({
      source: targetMarkdownFile,
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
    }));

    if (researchCode !== 0) {
      return researchCode;
    }

    emitCliInfo(app, "Make transition: research -> plan");
    emitCliInfo(app, "Make phase 2/2: plan");

    return normalizeMakePhaseExitCode(await app.planTask({
      source: targetMarkdownFile,
      scanCount,
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
    }));
  };
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
    const mode = parseRunnerMode(opts.mode as string | undefined, makeModes);
    const sharedRuntimeOptions = resolveSharedWorkerRuntimeOptions(opts, getWorkerFromSeparator);
    const sharedWorkerPattern = sharedRuntimeOptions.workerPattern;
    const dryRun = Boolean(opts.dryRun as boolean | undefined);
    const printPrompt = Boolean(opts.printPrompt as boolean | undefined);
    const scanCount = parseScanCount(opts.scanCount as string | undefined);

    const runSortMode = parseSortMode(opts.sort as string | undefined);
    const verify = resolveVerifyFlag(opts);
    const onlyVerify = Boolean(opts.onlyVerify as boolean | undefined);
    const forceExecute = Boolean(opts.forceExecute as boolean | undefined);
    const noRepair = resolveNoRepairFlag(opts);
    const repairAttempts = parseRepairAttempts(opts.repairAttempts as string | undefined);
    const traceOnly = Boolean(opts.traceOnly as boolean | undefined);
    const commitAfterComplete = Boolean(opts.commit as boolean | undefined);
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
    const verbose = resolveVerboseOption(opts);

    emitCliInfo(app, "Do phase 1/2: bootstrap (make)");

    const bootstrapCode = normalizeMakePhaseExitCode(await createMakeCommandAction({
      getApp,
      getWorkerFromSeparator,
      makeModes,
    })(seedText, targetMarkdownFile, opts));

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
      mode,
      workerPattern: sharedWorkerPattern,
      sortMode: runSortMode,
      verify,
      onlyVerify,
      forceExecute,
      noRepair,
      repairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts: sharedRuntimeOptions.keepArtifacts,
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
 * Creates the `intro` command action handler.
 *
 * The returned action renders an animated CLI presentation introducing rundown.
 * This command has no app dependencies — it only needs the CLI version string.
 */
export function createIntroCommandAction({
  version,
}: {
  version: string;
}): () => CliActionResult {
  return async () => {
    const { renderIntro } = await import("./intro.js");
    return renderIntro(version);
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
