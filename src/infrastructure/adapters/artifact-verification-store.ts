import fs from "node:fs";
import path from "node:path";
import type { Task } from "../../domain/parser.js";
import type { VerificationStore } from "../../domain/ports/verification-store.js";

const DEFAULT_FAILURE = "Verification failed (no details).";

interface VerifyPhaseMetadata {
  phase?: string;
  task?: {
    file?: string;
    index?: number;
  };
  verificationResult?: string;
}

interface RunMetadata {
  completedAt?: string;
  status?: string;
}

/**
 * Creates a verification store backed by run metadata artifacts when
 * available, with in-memory fallback storage for transient writes.
 *
 * The adapter prefers persisting verification output into the latest matching
 * active verify phase metadata file so downstream phases can consume the same
 * result from artifacts. When no matching artifact is found, values are kept
 * in memory for the current process lifetime.
 */
export function createArtifactVerificationStore(configDir?: string): VerificationStore {
  // Keep ephemeral values when no writable artifact metadata exists.
  const inMemoryResults = new Map<string, string>();

  return {
    write(task, content) {
      const key = taskStoreKey(task);
      const normalized = normalizeVerificationResult(content);
      // Prefer persisting to the active run's verify metadata when available.
      const metadataPath = findLatestVerifyPhaseMetadataPath(task, configDir, { activeOnly: true });
      if (!metadataPath) {
        inMemoryResults.set(key, normalized);
        return;
      }

      const metadata = readJson<VerifyPhaseMetadata>(metadataPath);
      if (!metadata) {
        inMemoryResults.set(key, normalized);
        return;
      }

      metadata.verificationResult = normalized;
      writeJson(metadataPath, metadata);
      // Remove stale fallback value once persistence succeeds.
      inMemoryResults.delete(key);
    },
    read(task) {
      const key = taskStoreKey(task);
      // Read process-local fallback first when no artifact write occurred.
      const inMemory = inMemoryResults.get(key);
      if (inMemory) {
        return inMemory;
      }

      // Read from the latest matching verify phase metadata across runs.
      const metadataPath = findLatestVerifyPhaseMetadataPath(task, configDir);
      if (!metadataPath) {
        return null;
      }

      const metadata = readJson<VerifyPhaseMetadata>(metadataPath);
      const value = typeof metadata?.verificationResult === "string"
        ? metadata.verificationResult.trim()
        : "";

      if (value === "") {
        return null;
      }

      return value;
    },
    remove(task) {
      const key = taskStoreKey(task);
      // Removal only applies to in-memory fallback values.
      inMemoryResults.delete(key);
    },
  };
}

/**
 * Finds the newest verify-phase metadata file that corresponds to a task.
 *
 * Run and phase directories are scanned in descending lexical order so the
 * first match represents the latest artifact location. When `activeOnly` is
 * enabled, completed runs are skipped to avoid mutating historical artifacts.
 */
function findLatestVerifyPhaseMetadataPath(
  task: Task,
  configDir: string | undefined,
  options: { activeOnly?: boolean } = {},
): string | null {
  if (!configDir) {
    return null;
  }

  const runsDir = path.join(configDir, "runs");
  if (!fs.existsSync(runsDir)) {
    return null;
  }

  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const runDirName of runDirs) {
    const runDir = path.join(runsDir, runDirName);
    if (options.activeOnly) {
      const runMetadata = readJson<RunMetadata>(path.join(runDir, "run.json"));
      // Treat runs with completion markers as immutable historical artifacts.
      if (runMetadata && (runMetadata.completedAt !== undefined || runMetadata.status !== undefined)) {
        continue;
      }
    }

    const phaseDirs = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));

    for (const phaseDirName of phaseDirs) {
      const metadataPath = path.join(runDir, phaseDirName, "metadata.json");
      const metadata = readJson<VerifyPhaseMetadata>(metadataPath);
      if (!metadata || metadata.phase !== "verify") {
        continue;
      }

      // Match metadata task identity by normalized file path and index.
      if (isTaskMatch(metadata.task, task)) {
        return metadataPath;
      }
    }
  }

  return null;
}

/**
 * Builds a stable storage key for a task from its normalized file path and
 * markdown task index.
 */
function taskStoreKey(task: Task): string {
  return `${path.resolve(task.file)}::${String(task.index)}`;
}

/**
 * Determines whether metadata task coordinates refer to the same task.
 */
function isTaskMatch(
  metadataTask: VerifyPhaseMetadata["task"],
  task: Task,
): boolean {
  if (!metadataTask || typeof metadataTask.file !== "string" || typeof metadataTask.index !== "number") {
    return false;
  }

  const metadataPath = path.resolve(metadataTask.file);
  const taskPath = path.resolve(task.file);

  return metadataPath === taskPath && metadataTask.index === task.index;
}

/**
 * Normalizes verification output before persistence.
 *
 * Empty or whitespace-only values are converted to a default failure message
 * so downstream readers always receive an actionable result string.
 */
function normalizeVerificationResult(content: string): string {
  const trimmed = content.trim();
  return trimmed === "" ? DEFAULT_FAILURE : trimmed;
}

/**
 * Reads and parses a JSON file, returning `null` when the file is absent,
 * unreadable, or contains invalid JSON.
 */
function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON value to disk using stable indentation and a trailing newline.
 */
function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
