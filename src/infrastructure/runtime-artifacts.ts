import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";

/**
 * Identifies the runtime stage that produced a captured artifact.
 */
export type RuntimePhase =
  | "execute"
  | "verify"
  | "repair"
  | "plan"
  | "discuss"
  | "inline-cli"
  | "rundown-delegate"
  | "worker";

/**
 * Represents the final lifecycle state recorded for a runtime artifact run.
 */
export type RuntimeArtifactStatus =
  | "running"
  | "completed"
  | "discuss-completed"
  | "discuss-cancelled"
  | "discuss-finished-completed"
  | "discuss-finished-cancelled"
  | "failed"
  | "detached"
  | "execution-failed"
  | "verification-failed"
  | "reverify-completed"
  | "reverify-failed"
  | "reverted"
  | "revert-failed"
  | "metadata-missing";

/**
 * Stores source information for the task currently being executed.
 */
export interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

/**
 * Carries mutable and immutable context required while recording artifacts.
 */
export interface RuntimeArtifactsContext {
  readonly runId: string;
  readonly rootDir: string;
  readonly cwd: string;
  readonly configDir: string;
  readonly keepArtifacts: boolean;
  readonly commandName: string;
  readonly workerCommand?: string[];
  readonly mode?: string;
  readonly transport?: string;
  readonly task?: RuntimeTaskMetadata;
  sequence: number;
}

interface RuntimeArtifactsMetadata {
  runId: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  task?: RuntimeTaskMetadata;
  keepArtifacts: boolean;
  startedAt: string;
  completedAt?: string;
  status?: RuntimeArtifactStatus;
  extra?: Record<string, unknown>;
}

/**
 * Describes a persisted runtime artifact run discovered on disk.
 */
export interface SavedRuntimeArtifactRun {
  runId: string;
  rootDir: string;
  relativePath: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  task?: RuntimeTaskMetadata;
  keepArtifacts: boolean;
  startedAt: string;
  completedAt?: string;
  status?: RuntimeArtifactStatus;
  extra?: Record<string, unknown>;
}

interface PhaseMetadata {
  runId: string;
  sequence: number;
  phase: RuntimePhase;
  phaseLabel?: string;
  command?: string[];
  mode?: string;
  transport?: string;
  task?: RuntimeTaskMetadata;
  promptFile?: string | null;
  stdoutFile?: string | null;
  stderrFile?: string | null;
  verificationResult?: string;
  exitCode?: number | null;
  outputCaptured: boolean;
  startedAt: string;
  completedAt?: string;
  notes?: string;
  extra?: Record<string, unknown>;
}

/**
 * Describes a persisted phase discovered within a run directory.
 */
export interface ScannedRuntimePhase {
  sequence: number;
  phaseLabel: string;
  phase: "execute" | "verify" | "repair";
  dir: string;
  metadataFile: string;
  exitCode?: number | null;
  verificationResult?: string;
  stdoutPresent: boolean;
  stderrPresent: boolean;
  promptFilePath: string | null;
}

/**
 * Groups scanned run phases by type while preserving timeline ordering.
 */
export interface ScannedRuntimePhases {
  execute: ScannedRuntimePhase[];
  verify: ScannedRuntimePhase[];
  repair: ScannedRuntimePhase[];
  all: ScannedRuntimePhase[];
}

/**
 * Defines inputs used when starting a new runtime phase.
 */
export interface BeginRuntimePhaseOptions {
  phase: RuntimePhase;
  phaseLabel?: string;
  prompt?: string;
  command?: string[];
  mode?: string;
  transport?: string;
  notes?: string;
  extra?: Record<string, unknown>;
}

/**
 * Exposes phase-specific file locations and mutable metadata during execution.
 */
export interface RuntimePhaseHandle {
  readonly context: RuntimeArtifactsContext;
  readonly phase: RuntimePhase;
  readonly sequence: number;
  readonly dir: string;
  readonly promptFile: string | null;
  readonly metadataFile: string;
  metadata: PhaseMetadata;
}

/**
 * Defines fields captured when completing a runtime phase.
 */
export interface CompleteRuntimePhaseOptions {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  verificationResult?: string;
  outputCaptured: boolean;
  notes?: string;
  extra?: Record<string, unknown>;
}

/**
 * Controls final status and retention behavior for a runtime artifact run.
 */
export interface FinalizeRuntimeArtifactsOptions {
  status: RuntimeArtifactStatus;
  preserve?: boolean;
  extra?: Record<string, unknown>;
}

/**
 * Relative path for the shared JSONL log used by runtime output capture.
 */
export const GLOBAL_OUTPUT_LOG_RELATIVE_PATH = "logs/output.jsonl";

/**
 * Creates a new runtime artifact context and initializes run-level metadata.
 *
 * The context owns a run directory and sequence counter used by subsequent
 * phase operations.
 */
export function createRuntimeArtifactsContext(options: {
  cwd?: string;
  configDir?: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  task?: RuntimeTaskMetadata;
  keepArtifacts?: boolean;
}): RuntimeArtifactsContext {
  const cwd = options.cwd ?? process.cwd();
  const configDir = options.configDir ?? resolveRuntimeConfigDir(cwd);
  const rootBase = path.join(configDir, "runs");
  fs.mkdirSync(rootBase, { recursive: true });

  // Generate a unique run directory for this execution.
  const runId = buildRunId();
  const rootDir = path.join(rootBase, runId);
  fs.mkdirSync(rootDir, { recursive: true });

  const context: RuntimeArtifactsContext = {
    runId,
    rootDir,
    cwd,
    configDir,
    keepArtifacts: options.keepArtifacts ?? false,
    commandName: options.commandName,
    workerCommand: options.workerCommand,
    mode: options.mode,
    transport: options.transport,
    task: options.task,
    sequence: 0,
  };

  const metadata: RuntimeArtifactsMetadata = {
    runId,
    commandName: options.commandName,
    workerCommand: options.workerCommand,
    mode: options.mode,
    transport: options.transport,
    source: options.source,
    task: options.task,
    keepArtifacts: context.keepArtifacts,
    startedAt: new Date().toISOString(),
  };

  writeJson(path.join(rootDir, "run.json"), metadata);
  return context;
}

/**
 * Returns the directory that stores all runtime artifact runs.
 */
export function runtimeArtifactsRootDir(
  startDir: string = process.cwd(),
): string {
  const configDir = resolveRuntimeConfigDir(startDir);
  return path.join(configDir, "runs");
}

/**
 * Returns the absolute path to the global runtime output log file.
 */
export function globalOutputLogFilePath(
  startDir: string = process.cwd(),
): string {
  const configDir = resolveRuntimeConfigDir(startDir);
  return path.join(configDir, GLOBAL_OUTPUT_LOG_RELATIVE_PATH);
}

/**
 * Lists saved runtime artifact runs sorted by newest first.
 *
 * If a run is missing `run.json`, a best-effort fallback entry is returned so
 * callers can still inspect and clean orphaned directories.
 */
export function listSavedRuntimeArtifacts(
  startDir: string = process.cwd(),
): SavedRuntimeArtifactRun[] {
  const configDir = resolveRuntimeConfigDir(startDir);
  const rootDir = runtimeArtifactsRootDir(configDir);
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const runs: SavedRuntimeArtifactRun[] = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDir = path.join(rootDir, entry.name);
    const metadata = readJson<RuntimeArtifactsMetadata>(path.join(runDir, "run.json"));
    if (!metadata) {
      // Fall back to filesystem timestamps when structured metadata is unavailable.
      const stats = fs.statSync(runDir);
      const fallbackStartedAt = (stats.birthtime ?? stats.mtime).toISOString();

      runs.push({
        runId: entry.name,
        rootDir: runDir,
        relativePath: path.relative(path.dirname(configDir), runDir).split(path.sep).join("/"),
        commandName: "unknown",
        workerCommand: undefined,
        mode: undefined,
        transport: undefined,
        source: undefined,
        task: undefined,
        keepArtifacts: true,
        startedAt: fallbackStartedAt,
        completedAt: undefined,
        status: "metadata-missing",
        extra: undefined,
      });
      continue;
    }

    runs.push({
      runId: metadata.runId,
      rootDir: runDir,
      relativePath: path.relative(path.dirname(configDir), runDir).split(path.sep).join("/"),
      commandName: metadata.commandName,
      workerCommand: metadata.workerCommand,
      mode: metadata.mode,
      transport: metadata.transport,
      source: metadata.source,
      task: metadata.task,
      keepArtifacts: metadata.keepArtifacts,
      startedAt: metadata.startedAt,
      completedAt: metadata.completedAt,
      status: metadata.status,
      extra: metadata.extra,
    });
  }

  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

/**
 * Lists only runs whose status indicates a failure condition.
 */
export function listFailedRuntimeArtifacts(
  startDir: string = process.cwd(),
): SavedRuntimeArtifactRun[] {
  const configDir = resolveRuntimeConfigDir(startDir);
  return listSavedRuntimeArtifacts(configDir).filter((run) => isFailedRuntimeArtifactStatus(run.status));
}

/**
 * Returns the most recently started saved runtime artifact run.
 */
export function latestSavedRuntimeArtifact(
  startDir: string = process.cwd(),
): SavedRuntimeArtifactRun | null {
  const configDir = resolveRuntimeConfigDir(startDir);
  return listSavedRuntimeArtifacts(configDir)[0] ?? null;
}

/**
 * Finds a saved run by exact id, or by unique id prefix.
 */
export function findSavedRuntimeArtifact(
  runId: string,
  startDir: string = process.cwd(),
): SavedRuntimeArtifactRun | null {
  const configDir = resolveRuntimeConfigDir(startDir);
  const runs = listSavedRuntimeArtifacts(configDir);
  const exact = runs.find((run) => run.runId === runId);
  if (exact) {
    return exact;
  }

  // Support shorthand lookup when the run-id prefix resolves unambiguously.
  const prefixMatches = runs.filter((run) => run.runId.startsWith(runId));
  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }

  return null;
}

/**
 * Scans a run directory and returns categorized execute/verify/repair phases.
 */
export function scanRuntimeArtifactPhases(runDir: string): ScannedRuntimePhases {
  const discovered: ScannedRuntimePhase[] = [];

  if (!fs.existsSync(runDir)) {
    return { execute: [], verify: [], repair: [], all: [] };
  }

  const phaseDirs = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      sequence: Number.parseInt(entry.name.split("-", 1)[0] ?? "", 10),
    }))
    .filter((entry) => Number.isFinite(entry.sequence))
    .sort((a, b) => a.sequence - b.sequence);

  for (const phaseDir of phaseDirs) {
    const absolutePhaseDir = path.join(runDir, phaseDir.name);
    const metadataFile = path.join(absolutePhaseDir, "metadata.json");
    const metadata = readJson<PhaseMetadata>(metadataFile);
    if (!metadata) {
      continue;
    }

    if (metadata.phase !== "execute" && metadata.phase !== "verify" && metadata.phase !== "repair") {
      continue;
    }

    const stdoutPath = resolvePhaseArtifactPath(absolutePhaseDir, metadata.stdoutFile ?? null);
    const stderrPath = resolvePhaseArtifactPath(absolutePhaseDir, metadata.stderrFile ?? null);
    const promptPath = resolvePhaseArtifactPath(absolutePhaseDir, metadata.promptFile ?? null);

    discovered.push({
      sequence: metadata.sequence,
      phaseLabel: metadata.phaseLabel ?? metadata.phase,
      phase: metadata.phase,
      dir: absolutePhaseDir,
      metadataFile,
      exitCode: metadata.exitCode,
      verificationResult: metadata.verificationResult,
      stdoutPresent: stdoutPath !== null,
      stderrPresent: stderrPath !== null,
      promptFilePath: promptPath,
    });
  }

  return {
    execute: discovered.filter((phase) => phase.phase === "execute"),
    verify: discovered.filter((phase) => phase.phase === "verify"),
    repair: discovered.filter((phase) => phase.phase === "repair"),
    all: discovered,
  };
}

/**
 * Removes all saved runtime artifact runs and returns the number deleted.
 */
export function removeSavedRuntimeArtifacts(
  startDir: string = process.cwd(),
): number {
  const configDir = resolveRuntimeConfigDir(startDir);
  return removeRuntimeArtifactsMatching(() => true, configDir);
}

/**
 * Removes failed saved runs and returns the number deleted.
 */
export function removeFailedRuntimeArtifacts(
  startDir: string = process.cwd(),
): number {
  const configDir = resolveRuntimeConfigDir(startDir);
  return removeRuntimeArtifactsMatching((run) => isFailedRuntimeArtifactStatus(run.status), configDir);
}

/**
 * Deletes saved run directories that satisfy the provided predicate.
 */
function removeRuntimeArtifactsMatching(
  predicate: (run: SavedRuntimeArtifactRun) => boolean,
  configDir: string,
): number {
  const rootDir = runtimeArtifactsRootDir(configDir);
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  const runs = listSavedRuntimeArtifacts(configDir);
  let removed = 0;
  for (const run of runs) {
    if (!predicate(run)) {
      continue;
    }

    // Force removal because artifact directories may contain nested logs.
    fs.rmSync(run.rootDir, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}

/**
 * Returns whether a status value represents a failed artifact outcome.
 */
export function isFailedRuntimeArtifactStatus(status: RuntimeArtifactStatus | undefined): boolean {
  if (!status) {
    return false;
  }

  return status.includes("failed");
}

/**
 * Starts a new phase directory and records initial phase metadata.
 */
export function beginRuntimePhase(
  context: RuntimeArtifactsContext,
  options: BeginRuntimePhaseOptions,
): RuntimePhaseHandle {
  context.sequence += 1;
  const sequence = context.sequence;
  const resolvedPhaseLabel = resolvePhaseLabel(options.phase, options.phaseLabel);
  const dirName = `${String(sequence).padStart(2, "0")}-${resolvedPhaseLabel}`;
  const dir = path.join(context.rootDir, dirName);
  fs.mkdirSync(dir, { recursive: true });

  // Prompt files are optional because not every phase is prompt-driven.
  const promptFile = options.prompt === undefined
    ? null
    : path.join(dir, "prompt.md");

  if (promptFile) {
    fs.writeFileSync(promptFile, options.prompt ?? "", "utf-8");
  }

  const metadata: PhaseMetadata = {
    runId: context.runId,
    sequence,
    phase: options.phase,
    phaseLabel: resolvedPhaseLabel,
    command: options.command,
    mode: options.mode,
    transport: options.transport,
    task: context.task,
    promptFile: promptFile ? "prompt.md" : null,
    stdoutFile: null,
    stderrFile: null,
    outputCaptured: false,
    startedAt: new Date().toISOString(),
    notes: options.notes,
    extra: options.extra,
  };

  const metadataFile = path.join(dir, "metadata.json");
  writeJson(metadataFile, metadata);

  return {
    context,
    phase: options.phase,
    sequence,
    dir,
    promptFile,
    metadataFile,
    metadata,
  };
}

/**
 * Completes a phase by recording outputs, timestamps, and optional diagnostics.
 */
export function completeRuntimePhase(
  handle: RuntimePhaseHandle,
  options: CompleteRuntimePhaseOptions,
): void {
  handle.metadata.exitCode = options.exitCode;
  handle.metadata.outputCaptured = options.outputCaptured;
  handle.metadata.completedAt = new Date().toISOString();

  // Persist streams only when non-empty to avoid creating redundant files.
  if (options.stdout !== undefined && options.stdout.length > 0) {
    const stdoutFile = path.join(handle.dir, "stdout.log");
    ensureParentDir(stdoutFile);
    fs.writeFileSync(stdoutFile, options.stdout, "utf-8");
    handle.metadata.stdoutFile = "stdout.log";
  }

  if (options.stderr !== undefined && options.stderr.length > 0) {
    const stderrFile = path.join(handle.dir, "stderr.log");
    ensureParentDir(stderrFile);
    fs.writeFileSync(stderrFile, options.stderr, "utf-8");
    handle.metadata.stderrFile = "stderr.log";
  }

  if (options.verificationResult !== undefined) {
    handle.metadata.verificationResult = options.verificationResult;
  }

  if (options.notes !== undefined) {
    handle.metadata.notes = options.notes;
  }

  if (options.extra !== undefined) {
    // Merge extra values so callers can append metadata incrementally.
    handle.metadata.extra = {
      ...(handle.metadata.extra ?? {}),
      ...options.extra,
    };
  }

  writeJson(handle.metadataFile, handle.metadata);
}

/**
 * Finalizes run-level metadata and optionally removes the run directory.
 */
export function finalizeRuntimeArtifacts(
  context: RuntimeArtifactsContext,
  options: FinalizeRuntimeArtifactsOptions,
): void {
  const rootDirMissing = !fs.existsSync(context.rootDir);
  if (rootDirMissing && !options.preserve) {
    return;
  }

  if (rootDirMissing && options.preserve) {
    fs.mkdirSync(context.rootDir, { recursive: true });
  }

  const metadataFile = path.join(context.rootDir, "run.json");
  const metadata = readJson<RuntimeArtifactsMetadata>(metadataFile) ?? {
    runId: context.runId,
    commandName: context.commandName,
    workerCommand: context.workerCommand,
    mode: context.mode,
    transport: context.transport,
    task: context.task,
    keepArtifacts: context.keepArtifacts,
    startedAt: new Date().toISOString(),
  };

  metadata.completedAt = new Date().toISOString();
  metadata.status = options.status;
  if (options.extra !== undefined) {
    // Preserve previously recorded extra fields while applying updates.
    metadata.extra = {
      ...(metadata.extra ?? {}),
      ...options.extra,
    };
  }
  try {
    writeJson(metadataFile, metadata);
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }

    if (!options.preserve) {
      return;
    }

    // Recreate the directory when retention was requested but files were removed.
    fs.mkdirSync(context.rootDir, { recursive: true });
    writeJson(metadataFile, metadata);
  }

  if (!options.preserve) {
    fs.rmSync(context.rootDir, { recursive: true, force: true });
  }
}

/**
 * Returns a user-friendly artifact path relative to the original working directory.
 */
export function displayArtifactsPath(context: RuntimeArtifactsContext): string {
  const relative = path.relative(context.cwd, context.rootDir);
  return relative === "" ? path.basename(context.rootDir) : relative.split(path.sep).join("/");
}

/**
 * Resolves a safe phase label for directory naming.
 */
function resolvePhaseLabel(phase: RuntimePhase, phaseLabel: string | undefined): string {
  const normalized = (phaseLabel ?? "").trim().toLowerCase();
  if (!normalized) {
    return phase;
  }

  const sanitized = normalized
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return sanitized.length > 0 ? sanitized : phase;
}

/**
 * Builds a unique run id using an ISO timestamp and random suffix.
 */
function buildRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  const suffix = randomBytes(4).toString("hex");
  return `run-${timestamp}-${suffix}`;
}

/**
 * Writes JSON to disk with stable indentation and a trailing newline.
 */
function writeJson(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * Reads JSON from disk and returns `null` when parsing fails.
 */
function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Returns whether an unknown error is an ENOENT filesystem error.
 */
function isEnoentError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Ensures the parent directory for a file path exists.
 */
function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
}

/**
 * Resolves a phase artifact path and returns null when unavailable.
 */
function resolvePhaseArtifactPath(phaseDir: string, relativePath: string | null): string | null {
  if (!relativePath) {
    return null;
  }

  const resolved = path.join(phaseDir, relativePath);
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Resolves the runtime config directory from either a project root or config path.
 */
function resolveRuntimeConfigDir(startDir: string): string {
  const resolved = path.resolve(startDir);
  return path.basename(resolved) === CONFIG_DIR_NAME
    ? resolved
    : path.join(resolved, CONFIG_DIR_NAME);
}
