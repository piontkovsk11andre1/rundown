/**
 * Enumerates terminal and intermediate statuses persisted for a run.
 */
export type ArtifactStoreStatus =
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
  | "metadata-missing"
  | "discuss-completed"
  | "discuss-cancelled"
  | "discuss-finished-completed"
  | "discuss-finished-cancelled"
  | "help-completed"
  | "help-cancelled";

/**
 * Identifies logical execution phases that can emit artifacts.
 */
export type ArtifactStorePhase =
  | "execute"
  | "verify"
  | "repair"
  | "resolve"
  | "plan"
  | "discuss"
  | "translate"
  | "help"
  | "inline-cli"
  | "rundown-delegate"
  | "worker";

/**
 * Describes task metadata captured alongside artifact records.
 */
export interface ArtifactTaskMetadata {
  // Original task text selected for execution.
  text: string;
  // Source file path that contains the task definition.
  file: string;
  // 1-based line number where the task appears in source.
  line: number;
  // 0-based task index within the parsed source document.
  index: number;
  // Full source markdown content that produced this task metadata.
  source: string;
}

/**
 * Represents immutable context for a single artifact-aware run.
 */
export interface ArtifactRunContext {
  // Unique identifier for the active run.
  runId: string;
  // Root directory where run artifacts are persisted.
  rootDir: string;
  // Working directory used while executing the run.
  cwd: string;
  // Optional configuration directory associated with the run.
  configDir?: string;
  // Controls whether artifacts are retained after successful completion.
  keepArtifacts: boolean;
  // Top-level command name that initiated the run.
  commandName: string;
  // Optional worker command used for execution.
  workerCommand?: string[];
  // Optional process run mode used for worker invocation.
  mode?: string;
  // Optional prompt transport mechanism used for worker invocation.
  transport?: string;
  // Optional task metadata bound to this run.
  task?: ArtifactTaskMetadata;
}

/**
 * Tracks metadata for an individual persisted phase directory.
 */
export interface ArtifactPhaseHandle {
  // Run context associated with this phase.
  context: ArtifactRunContext;
  // Logical phase represented by this handle.
  phase: ArtifactStorePhase;
  // Monotonic sequence number used for phase ordering.
  sequence: number;
  // Absolute path to the phase artifact directory.
  dir: string;
  // Prompt file path when persisted, otherwise null.
  promptFile: string | null;
}

/**
 * Defines serialized metadata stored for completed or failed runs.
 */
export interface ArtifactRunMetadata {
  // Unique identifier for the persisted run.
  runId: string;
  // Root directory where this run was stored.
  rootDir: string;
  // Relative path from root to the run directory.
  relativePath: string;
  // Top-level command name that started this run.
  commandName: string;
  // Optional worker command captured at run start.
  workerCommand?: string[];
  // Optional run mode captured for diagnostics.
  mode?: string;
  // Optional prompt transport captured for diagnostics.
  transport?: string;
  // Optional source path associated with the selected task.
  source?: string;
  // Optional task metadata captured at run start.
  task?: ArtifactTaskMetadata;
  // Indicates whether artifacts were configured to be retained.
  keepArtifacts: boolean;
  // ISO timestamp marking when the run started.
  startedAt: string;
  // ISO timestamp marking when the run completed.
  completedAt?: string;
  // Final status assigned when the run was finalized.
  status?: ArtifactStoreStatus;
  // Optional extension object for implementation-specific metadata.
  extra?: Record<string, unknown>;
}

/**
 * Defines artifact lifecycle operations used by orchestration flows.
 */
export interface ArtifactStore {
  /** Creates a run context and initializes run-level metadata. */
  createContext(options: {
    // Optional working directory for command execution.
    cwd?: string;
    // Optional configuration directory for runtime data.
    configDir?: string;
    // Top-level command name associated with the run.
    commandName: string;
    // Optional worker command executed for this run.
    workerCommand?: string[];
    // Optional execution mode recorded for diagnostics.
    mode?: string;
    // Optional prompt transport recorded for diagnostics.
    transport?: string;
    // Optional source path containing the selected task.
    source?: string;
    // Optional task metadata bound to the run context.
    task?: ArtifactTaskMetadata;
    // Retains artifacts even when cleanup would normally occur.
    keepArtifacts?: boolean;
  }): ArtifactRunContext;
  /** Begins a new phase and persists initial phase metadata. */
  beginPhase(
    context: ArtifactRunContext,
    options: {
      // Logical phase being started.
      phase: ArtifactStorePhase;
      // Optional prompt text to persist for inspection.
      prompt?: string;
      // Optional command snapshot associated with this phase.
      command?: string[];
      // Optional mode override captured for this phase.
      mode?: string;
      // Optional transport override captured for this phase.
      transport?: string;
      // Optional human-readable note describing phase intent.
      notes?: string;
      // Optional implementation-specific metadata extension.
      extra?: Record<string, unknown>;
    },
  ): ArtifactPhaseHandle;
  /** Completes a phase and records process and output details. */
  completePhase(
    handle: ArtifactPhaseHandle,
    options: {
      // Process exit code, or null when unavailable.
      exitCode: number | null;
      // Captured standard output for the phase command.
      stdout?: string;
      // Captured standard error for the phase command.
      stderr?: string;
      // Indicates whether stdout/stderr capture was enabled.
      outputCaptured: boolean;
      // Optional completion note for operator context.
      notes?: string;
      // Optional implementation-specific metadata extension.
      extra?: Record<string, unknown>;
    },
  ): void;
  /** Finalizes a run and optionally performs cleanup behavior. */
  finalize(
    context: ArtifactRunContext,
    // Final status and optional persistence overrides.
    options: { status: ArtifactStoreStatus; preserve?: boolean; extra?: Record<string, unknown> },
  ): void;
  /** Returns a display-friendly path for the run artifacts. */
  displayPath(context: ArtifactRunContext): string;
  /** Resolves the root artifacts directory for a configuration directory. */
  rootDir(configDir?: string): string;
  /** Lists all saved run metadata records. */
  listSaved(configDir?: string): ArtifactRunMetadata[];
  /** Lists run metadata records considered failed. */
  listFailed(configDir?: string): ArtifactRunMetadata[];
  /** Returns the newest saved run metadata record. */
  latest(configDir?: string): ArtifactRunMetadata | null;
  /** Finds a saved run record by run identifier. */
  find(runId: string, configDir?: string): ArtifactRunMetadata | null;
  /** Removes persisted non-failed runs and returns deletion count. */
  removeSaved(configDir?: string): number;
  /** Removes persisted failed runs and returns deletion count. */
  removeFailed(configDir?: string): number;
  /** Determines whether a run status is treated as failed. */
  isFailedStatus(status: ArtifactStoreStatus | undefined): boolean;
}
