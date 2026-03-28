import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type RuntimePhase = "execute" | "verify" | "repair" | "plan" | "inline-cli" | "worker";

export type RuntimeArtifactStatus =
  | "running"
  | "completed"
  | "failed"
  | "detached"
  | "execution-failed"
  | "verification-failed"
  | "reverify-completed"
  | "reverify-failed"
  | "reverted"
  | "revert-failed"
  | "metadata-missing";

export interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

export interface RuntimeArtifactsContext {
  readonly runId: string;
  readonly rootDir: string;
  readonly cwd: string;
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
  exitCode?: number | null;
  outputCaptured: boolean;
  startedAt: string;
  completedAt?: string;
  notes?: string;
  extra?: Record<string, unknown>;
}

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

export interface RuntimePhaseHandle {
  readonly context: RuntimeArtifactsContext;
  readonly phase: RuntimePhase;
  readonly sequence: number;
  readonly dir: string;
  readonly promptFile: string | null;
  readonly metadataFile: string;
  metadata: PhaseMetadata;
}

export interface CompleteRuntimePhaseOptions {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  outputCaptured: boolean;
  notes?: string;
  extra?: Record<string, unknown>;
}

export interface FinalizeRuntimeArtifactsOptions {
  status: RuntimeArtifactStatus;
  preserve?: boolean;
  extra?: Record<string, unknown>;
}

export function createRuntimeArtifactsContext(options: {
  cwd?: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  task?: RuntimeTaskMetadata;
  keepArtifacts?: boolean;
}): RuntimeArtifactsContext {
  const cwd = options.cwd ?? process.cwd();
  const rootBase = path.join(cwd, ".rundown", "runs");
  fs.mkdirSync(rootBase, { recursive: true });

  const runId = buildRunId();
  const rootDir = path.join(rootBase, runId);
  fs.mkdirSync(rootDir, { recursive: true });

  const context: RuntimeArtifactsContext = {
    runId,
    rootDir,
    cwd,
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

export function runtimeArtifactsRootDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".rundown", "runs");
}

export function listSavedRuntimeArtifacts(cwd: string = process.cwd()): SavedRuntimeArtifactRun[] {
  const rootDir = runtimeArtifactsRootDir(cwd);
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
      const stats = fs.statSync(runDir);
      const fallbackStartedAt = (stats.birthtime ?? stats.mtime).toISOString();

      runs.push({
        runId: entry.name,
        rootDir: runDir,
        relativePath: path.relative(cwd, runDir).split(path.sep).join("/"),
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
      relativePath: path.relative(cwd, runDir).split(path.sep).join("/"),
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

export function listFailedRuntimeArtifacts(cwd: string = process.cwd()): SavedRuntimeArtifactRun[] {
  return listSavedRuntimeArtifacts(cwd).filter((run) => isFailedRuntimeArtifactStatus(run.status));
}

export function latestSavedRuntimeArtifact(cwd: string = process.cwd()): SavedRuntimeArtifactRun | null {
  return listSavedRuntimeArtifacts(cwd)[0] ?? null;
}

export function findSavedRuntimeArtifact(
  runId: string,
  cwd: string = process.cwd(),
): SavedRuntimeArtifactRun | null {
  const runs = listSavedRuntimeArtifacts(cwd);
  const exact = runs.find((run) => run.runId === runId);
  if (exact) {
    return exact;
  }

  const prefixMatches = runs.filter((run) => run.runId.startsWith(runId));
  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }

  return null;
}

export function removeSavedRuntimeArtifacts(cwd: string = process.cwd()): number {
  return removeRuntimeArtifactsMatching(() => true, cwd);
}

export function removeFailedRuntimeArtifacts(cwd: string = process.cwd()): number {
  return removeRuntimeArtifactsMatching((run) => isFailedRuntimeArtifactStatus(run.status), cwd);
}

function removeRuntimeArtifactsMatching(
  predicate: (run: SavedRuntimeArtifactRun) => boolean,
  cwd: string,
): number {
  const rootDir = runtimeArtifactsRootDir(cwd);
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  const runs = listSavedRuntimeArtifacts(cwd);
  let removed = 0;
  for (const run of runs) {
    if (!predicate(run)) {
      continue;
    }

    fs.rmSync(run.rootDir, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}

export function isFailedRuntimeArtifactStatus(status: RuntimeArtifactStatus | undefined): boolean {
  if (!status) {
    return false;
  }

  return status.includes("failed");
}

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

export function completeRuntimePhase(
  handle: RuntimePhaseHandle,
  options: CompleteRuntimePhaseOptions,
): void {
  handle.metadata.exitCode = options.exitCode;
  handle.metadata.outputCaptured = options.outputCaptured;
  handle.metadata.completedAt = new Date().toISOString();

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

  if (options.notes !== undefined) {
    handle.metadata.notes = options.notes;
  }

  if (options.extra !== undefined) {
    handle.metadata.extra = {
      ...(handle.metadata.extra ?? {}),
      ...options.extra,
    };
  }

  writeJson(handle.metadataFile, handle.metadata);
}

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

    fs.mkdirSync(context.rootDir, { recursive: true });
    writeJson(metadataFile, metadata);
  }

  if (!options.preserve) {
    fs.rmSync(context.rootDir, { recursive: true, force: true });
  }
}

export function displayArtifactsPath(context: RuntimeArtifactsContext): string {
  const relative = path.relative(context.cwd, context.rootDir);
  return relative === "" ? path.basename(context.rootDir) : relative.split(path.sep).join("/");
}

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

function buildRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  const suffix = randomBytes(4).toString("hex");
  return `run-${timestamp}-${suffix}`;
}

function writeJson(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
}
