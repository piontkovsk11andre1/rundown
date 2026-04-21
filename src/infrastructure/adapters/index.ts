/**
 * Infrastructure adapter exports.
 *
 * This module centralizes adapter factory exports so composition roots can
 * import infrastructure implementations from a single location.
 */

// Filesystem and locking adapters.
/**
 * Creates the Node.js-backed filesystem adapter.
 */
export { createNodeFileSystem } from "./fs-file-system.js";
/**
 * Creates the filesystem-backed file lock adapter.
 */
export { createFsFileLock } from "./fs-file-lock.js";

// Process and git execution adapters.
/**
 * Creates the cross-spawn process runner adapter.
 */
export { createCrossSpawnProcessRunner } from "./crossspawn-process-runner.js";
/**
 * Creates the execFile-based git client adapter.
 */
export { createExecFileGitClient } from "./execfile-git-client.js";

// Template and artifact persistence adapters.
/**
 * Creates the filesystem-backed template loader adapter.
 */
export { createFsTemplateLoader } from "./fs-template-loader.js";
/**
 * Creates the filesystem-backed verification store adapter.
 */
export { createFsVerificationStore } from "./fs-verification-store.js";
/**
 * Creates the filesystem-backed worker health store adapter.
 */
export { createFsWorkerHealthStore } from "./fs-worker-health-store.js";
/**
 * Creates the artifact-based verification store adapter.
 */
export { createArtifactVerificationStore } from "./artifact-verification-store.js";
/**
 * Creates the filesystem-backed runtime artifact store adapter.
 */
export { createFsArtifactStore } from "./fs-artifact-store.js";

// Time and task orchestration adapters.
/**
 * Creates the system clock adapter.
 */
export { createSystemClock } from "./system-clock.js";
/**
 * Creates the source resolver adapter for runnable task inputs.
 */
export { createSourceResolverAdapter } from "./source-resolver-adapter.js";
/**
 * Creates the task selector adapter.
 */
export { createTaskSelectorAdapter } from "./task-selector-adapter.js";
/**
 * Creates the worker executor adapter for task execution.
 */
export { createWorkerExecutorAdapter } from "./worker-executor-adapter.js";
/**
 * Creates the task verification adapter.
 */
export { createTaskVerificationAdapter } from "./task-verification-adapter.js";
/**
 * Creates the task repair adapter.
 */
export { createTaskRepairAdapter } from "./task-repair-adapter.js";

// Environment and path adapters.
/**
 * Creates the working directory resolution adapter.
 */
export { createWorkingDirectoryAdapter } from "./working-directory-adapter.js";
/**
 * Creates the operating-system directory opener adapter.
 */
export { createDirectoryOpenerAdapter } from "./directory-opener-adapter.js";
/**
 * Creates the Node.js path operations adapter.
 */
export { createNodePathOperationsAdapter } from "./node-path-operations-adapter.js";
/**
 * Creates the source-local memory resolver adapter.
 */
export { createMemoryResolverAdapter } from "./memory-resolver-adapter.js";
/**
 * Creates the source-local memory writer adapter.
 */
export { createMemoryWriterAdapter } from "./memory-writer-adapter.js";
/**
 * Creates the source-local memory reader adapter.
 */
export { createMemoryReaderAdapter } from "./memory-reader-adapter.js";
/**
 * Creates the project tool template resolver adapter.
 */
export { createToolResolverAdapter } from "./tool-resolver-adapter.js";
/**
 * Creates the terminal-backed interactive input adapter.
 */
export { createTerminalInteractiveInputAdapter } from "./interactive-input-adapter.js";
/**
 * Creates the configuration directory adapter.
 */
export { createConfigDirAdapter } from "./config-dir-adapter.js";
/**
 * Creates the locale configuration adapter.
 */
export { createLocaleConfigAdapter } from "./locale-adapter.js";
/**
 * Resolves user-level global config path candidates.
 */
export { resolveGlobalConfigPath } from "./global-config-path-adapter.js";
/**
 * Creates the template variables loader adapter.
 */
export { createFsTemplateVarsLoaderAdapter } from "./fs-template-vars-loader-adapter.js";

// Trace and output adapters.
/**
 * Creates the JSON Lines trace writer adapter.
 */
export { createJsonlTraceWriter } from "./jsonl-trace-writer.js";
/**
 * Creates a fanout trace writer that delegates to multiple writers.
 */
export { createFanoutTraceWriter } from "./fanout-trace-writer.js";
/**
 * Creates a no-operation trace writer adapter.
 */
export { createNoopTraceWriter } from "./noop-trace-writer.js";
/**
 * Creates the global output log writer adapter.
 */
export { createGlobalOutputLogWriter } from "./global-output-log-writer.js";

// Worker runtime configuration and CLI adapters.
/**
 * Creates the worker configuration adapter.
 */
export { createWorkerConfigAdapter } from "./worker-config-adapter.js";
/**
 * Creates the CLI block executor used by the worker runtime.
 */
export { createCliBlockExecutor } from "../cli-block-executor.js";
