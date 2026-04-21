/**
 * Domain port barrel for runtime-facing abstractions.
 *
 * This module centralizes type and symbol re-exports so callers can depend on
 * `src/domain/ports` instead of importing each port from individual files.
 */

// File-system access and stat primitives.
export type { FileSystem, FileSystemDirent, FileSystemStat } from "./file-system.js";

/** Concurrency-safe file lock contracts and metadata types. */
export type { FileLock, FileLockMetadata, FileLockHolder } from "./file-lock.js";
// Runtime error class used by lock implementations and consumers.
export { FileLockError } from "./file-lock.js";

/** Process execution abstraction and result envelopes. */
export type { ProcessRunner, ProcessRunOptions, ProcessRunResult, ProcessRunMode } from "./process-runner.js";

/** Command execution adapter contracts used by CLI block expansion. */
export type {
  CommandExecutor,
  CommandExecutionOptions,
  CommandResult,
} from "./command-executor.js";
// Default timeout constant for command execution safety.
export { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "./command-executor.js";

/** Git operations gateway used by domain orchestration logic. */
export type { GitClient } from "./git-client.js";

/** Template loading contract for prompt/template resolution. */
export type { TemplateLoader } from "./template-loader.js";

/** Verification state persistence abstraction. */
export type { VerificationStore } from "./verification-store.js";

/** Artifact storage contracts for run and phase outputs. */
export type {
  ArtifactStore,
  ArtifactStoreStatus,
  ArtifactStorePhase,
  ArtifactTaskMetadata,
  ArtifactRunContext,
  ArtifactPhaseHandle,
  ArtifactRunMetadata,
} from "./artifact-store.js";

/** Time source abstraction for deterministic and testable clock access. */
export type { Clock } from "./clock.js";

/** Application-level output event sink contracts. */
export type { ApplicationOutputEvent, ApplicationOutputPort } from "./output-port.js";

/** Source file resolution contract used for task loading. */
export type { SourceResolverPort } from "./source-resolver-port.js";

/** Source-local memory metadata resolution contract. */
export type { MemoryMetadata, MemoryResolverPort } from "./memory-resolver-port.js";

/** Source-local memory body and index read contracts. */
export type { MemoryFileInfo, MemoryReaderPort } from "./memory-reader-port.js";

/** Source-local memory cleanup result contract. */
export type { MemoryCleanResult } from "./memory-clean-port.js";

/** Source-local memory validation issue and result contracts. */
export type {
  MemoryIssue,
  MemoryIssueSeverity,
  MemoryValidationResult,
} from "./memory-validation-port.js";

/** Source-local memory persistence contract for body and index writes. */
export type {
  MemoryIndexEntry,
  MemoryIndexOrigin,
  MemoryWriteFailure,
  MemoryWriteInput,
  MemoryWriteSuccess,
  MemoryWriterPort,
} from "./memory-writer-port.js";

/** Task-selection result and selector port contracts. */
export type { TaskSelectionResult, TaskSelectorPort } from "./task-selector-port.js";

/** Worker execution and option contracts. */
export type {
  WorkerRunResult,
  WorkerExecutionOptions,
  InlineCliExecutionOptions,
  RundownTaskExecutionOptions,
  WorkerExecutorPort,
} from "./worker-executor-port.js";

/** Verification options and execution contract for task validation. */
export type { TaskVerificationOptions, TaskVerificationPort, TaskVerificationResult } from "./task-verification-port.js";

/** Repair flow options, result payload, and adapter contract. */
export type {
  TaskRepairOptions,
  TaskResolveAttemptRecord,
  TaskResolveOptions,
  TaskResolveResult,
  TaskRepairResult,
  TaskRepairPort,
} from "./task-repair-port.js";

/** Working-directory access contract for runtime context resolution. */
export type { WorkingDirectoryPort } from "./working-directory-port.js";

/** Directory opener contract for editor/OS integration paths. */
export type { DirectoryOpenerPort } from "./directory-opener-port.js";

/** Path operation abstraction for normalization and composition. */
export type { PathOperationsPort } from "./path-operations-port.js";

/** Configuration directory discovery contracts and result type. */
export type { ConfigDirPort, ConfigDirResult } from "./config-dir-port.js";

/** Locale configuration persistence contracts and schema. */
export type { LocaleConfig, LocaleConfigPort } from "./locale-config-port.js";

/** Worker configuration loading abstraction. */
export type { WorkerConfigPort } from "./worker-config-port.js";

/** Worker health state persistence abstraction. */
export type { WorkerHealthSnapshot, WorkerHealthStore } from "./worker-health-store.js";

/** Template variable loader abstraction for prompt rendering context. */
export type { TemplateVarsLoaderPort } from "./template-vars-loader-port.js";

/** Tool template resolution contracts for prefix-driven expansions. */
export type { ToolDefinition, ToolResolverPort } from "./tool-resolver-port.js";

/** Tool handler types for unified prefix-chain execution. */
export type {
  ToolKind,
  ToolFrontmatter,
  ToolContextModifications,
  ToolHandlerResult,
  ToolHandlerContext,
  ToolHandlerFn,
} from "./tool-handler-port.js";

/** Interactive prompting contracts for question-style tools. */
export type {
  InteractiveChoice,
  InteractiveTextPromptRequest,
  InteractiveSelectPromptRequest,
  InteractiveConfirmPromptRequest,
  InteractivePromptRequest,
  InteractivePromptResult,
  InteractiveInputPort,
} from "./interactive-input-port.js";

/** Trace writer contract used for structured execution telemetry. */
export type { TraceWriterPort } from "./trace-writer-port.js";
