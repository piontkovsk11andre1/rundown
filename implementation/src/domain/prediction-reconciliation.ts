import { createHash } from "node:crypto";
import path from "node:path";
import {
  formatMigrationFilename,
  formatSnapshotFilename,
} from "./migration-parser.js";
import type { FileSystem } from "./ports/index.js";

export type PredictionTrackedFileKind = "file";

export interface PredictionTrackedMigration {
  number: number;
  name: string;
  isApplied: boolean;
}

export interface PredictionTrackedFile {
  relativePath: string;
  migrationNumber: number;
  kind: PredictionTrackedFileKind;
  content: string;
}

export interface PredictionInputs {
  migrations: readonly PredictionTrackedMigration[];
  files: readonly PredictionTrackedFile[];
}

export interface PredictionFileFingerprint {
  relativePath: string;
  migrationNumber: number;
  kind: PredictionTrackedFileKind;
  semanticHash: string;
}

export interface PredictionBaseline {
  lastCompletedMigrationNumber: number;
  firstPendingMigrationNumber: number | null;
  pendingPredictionMigrationNumbers: number[];
  migrationSequenceHash: string;
  fileFingerprints: PredictionFileFingerprint[];
}

export type PredictionStaleReason =
  | "sequence_changed"
  | "task_text_changed"
  | "context_changed"
  | "pending_manual_edit";

export interface PredictionStalenessResult {
  isStale: boolean;
  staleReasons: PredictionStaleReason[];
  earliestAffectedMigrationNumber: number | null;
  staleFromMigrationNumber: number | null;
  stalePendingMigrationNumbers: number[];
}

export interface PredictionReconciliationEntryPoint {
  lastCompletedMigrationNumber: number;
  reconciliationStartMigrationNumber: number | null;
  preservedCompletedMigrationNumbers: number[];
  pendingPredictionMigrationNumbers: number[];
  latestExecutedMigration: PredictionTrackedFile | null;
}

export interface ReResolvedPredictionItem {
  migrationNumber: number;
  migrationName: string;
  migrationContent: string;
  snapshotContent: string;
}

export interface ReResolvedPredictionPlan {
  startMigrationNumber: number;
  pendingMigrationNumbers: number[];
  items: ReResolvedPredictionItem[];
  fallback: PredictionReconciliationFallback | null;
}

export type PredictionReconciliationConflictReason =
  | "partial_output"
  | "invalid_ordering"
  | "schema_mismatch";

export interface PredictionReconciliationFallback {
  reason: PredictionReconciliationConflictReason;
  message: string;
  attemptedPendingMigrationNumbers: number[];
}

export interface PendingPredictionAtomicPatch {
  removeRelativePaths: string[];
  writeFiles: PredictionTrackedFile[];
}

export interface ReconciledPendingPredictionState {
  migrations: PredictionTrackedMigration[];
  files: PredictionTrackedFile[];
  preservedCompletedMigrationNumbers: number[];
  reconciledPendingMigrationNumbers: number[];
  patch: PendingPredictionAtomicPatch;
}

export function readPredictionTreeAsTrackedFiles(input: {
  fileSystem: FileSystem;
  predictionDir: string;
}): PredictionTrackedFile[] {
  const { fileSystem, predictionDir } = input;
  if (!fileSystem.exists(predictionDir)) {
    return [];
  }

  const pendingDirectories = [predictionDir];
  const files: Array<{ absolutePath: string; relativePath: string }> = [];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }

    for (const entry of fileSystem.readdir(currentDirectory)) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }

      files.push({
        absolutePath: entryPath,
        relativePath: path.relative(predictionDir, entryPath).replace(/\\/g, "/"),
      });
    }
  }

  return files
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => ({
      relativePath: normalizeRelativePath(file.relativePath),
      migrationNumber: 0,
      kind: "file",
      content: fileSystem.readText(file.absolutePath),
    }));
}

export function createPredictionBaseline(inputs: PredictionInputs): PredictionBaseline {
  const migrations = sortMigrations(inputs.migrations);
  const lastCompletedMigrationNumber = migrations
    .filter((migration) => migration.isApplied)
    .reduce((max, migration) => Math.max(max, migration.number), 0);
  const pendingPredictionMigrationNumbers = uniqueSorted(
    migrations
      .filter((migration) => !migration.isApplied)
      .map((migration) => migration.number),
  );
  const firstPendingMigrationNumber = pendingPredictionMigrationNumbers[0] ?? null;

  return {
    lastCompletedMigrationNumber,
    firstPendingMigrationNumber,
    pendingPredictionMigrationNumbers,
    migrationSequenceHash: hashMigrationSequence(migrations),
    fileFingerprints: toFingerprints(inputs.files),
  };
}

export function detectStalePendingPredictions(input: {
  baseline: PredictionBaseline;
  current: PredictionInputs;
}): PredictionStalenessResult {
  const baseline = input.baseline;
  const firstPending = baseline.firstPendingMigrationNumber;

  if (firstPending === null || baseline.pendingPredictionMigrationNumbers.length === 0) {
    return {
      isStale: false,
      staleReasons: [],
      earliestAffectedMigrationNumber: null,
      staleFromMigrationNumber: null,
      stalePendingMigrationNumbers: [],
    };
  }

  const candidates: Array<{ reason: PredictionStaleReason; affectedMigrationNumber: number }> = [];
  const currentMigrations = sortMigrations(input.current.migrations);

  if (baseline.migrationSequenceHash !== hashMigrationSequence(currentMigrations)) {
    const sequenceAffectedMigration = getEarliestSequenceDifference(
      baseline.pendingPredictionMigrationNumbers,
      currentMigrations,
      firstPending,
    );
    candidates.push({ reason: "sequence_changed", affectedMigrationNumber: sequenceAffectedMigration });
  }

  const baselineFiles = new Map(
    baseline.fileFingerprints.map((fingerprint) => [normalizeRelativePath(fingerprint.relativePath), fingerprint]),
  );
  const currentFingerprints = toFingerprints(input.current.files);
  const currentFiles = new Map(
    currentFingerprints.map((fingerprint) => [normalizeRelativePath(fingerprint.relativePath), fingerprint]),
  );

  for (const [relativePath, fingerprint] of baselineFiles.entries()) {
    const currentFingerprint = currentFiles.get(relativePath);
    if (!currentFingerprint) {
      candidates.push(buildFileChangeCandidate(fingerprint, firstPending));
      continue;
    }

    if (fingerprint.semanticHash !== currentFingerprint.semanticHash) {
      candidates.push(buildFileChangeCandidate(fingerprint, firstPending));
    }
  }

  for (const [relativePath, currentFingerprint] of currentFiles.entries()) {
    if (baselineFiles.has(relativePath)) {
      continue;
    }

    candidates.push(buildFileChangeCandidate(currentFingerprint, firstPending));
  }

  if (candidates.length === 0) {
    return {
      isStale: false,
      staleReasons: [],
      earliestAffectedMigrationNumber: null,
      staleFromMigrationNumber: null,
      stalePendingMigrationNumbers: [],
    };
  }

  const earliestAffectedMigrationNumber = candidates.reduce(
    (min, candidate) => Math.min(min, candidate.affectedMigrationNumber),
    Number.POSITIVE_INFINITY,
  );
  const staleFromMigrationNumber = Math.max(firstPending, earliestAffectedMigrationNumber);
  const stalePendingMigrationNumbers = baseline.pendingPredictionMigrationNumbers
    .filter((migrationNumber) => migrationNumber >= staleFromMigrationNumber);

  if (stalePendingMigrationNumbers.length === 0) {
    return {
      isStale: false,
      staleReasons: [],
      earliestAffectedMigrationNumber: null,
      staleFromMigrationNumber: null,
      stalePendingMigrationNumbers: [],
    };
  }

  const staleReasons = Array.from(new Set(
    candidates
      .filter((candidate) => candidate.affectedMigrationNumber <= staleFromMigrationNumber)
      .map((candidate) => candidate.reason),
  ));

  return {
    isStale: true,
    staleReasons,
    earliestAffectedMigrationNumber,
    staleFromMigrationNumber,
    stalePendingMigrationNumbers,
  };
}

export function createPredictionReconciliationEntryPoint(input: {
  baseline: PredictionBaseline;
  current: PredictionInputs;
  staleness: PredictionStalenessResult;
}): PredictionReconciliationEntryPoint {
  const lastCompletedMigrationNumber = input.current.migrations
    .filter((migration) => migration.isApplied)
    .reduce((max, migration) => Math.max(max, migration.number), 0);
  const pendingPredictionMigrationNumbers = uniqueSorted(
    input.baseline.pendingPredictionMigrationNumbers
      .filter((migrationNumber) => migrationNumber > lastCompletedMigrationNumber),
  );

  const reconciliationStartMigrationNumber = input.staleness.isStale
    ? input.staleness.staleFromMigrationNumber
    : (pendingPredictionMigrationNumbers[0] ?? null);

  return {
    lastCompletedMigrationNumber,
    reconciliationStartMigrationNumber,
    preservedCompletedMigrationNumbers: uniqueSorted(
      input.current.migrations
        .filter((migration) => migration.isApplied)
        .map((migration) => migration.number),
    ),
    pendingPredictionMigrationNumbers,
    latestExecutedMigration: findLatestFileAtOrBefore({
      files: input.current.files,
      migrationNumber: lastCompletedMigrationNumber,
      matches: (file) => isMigrationTrackedFile(file),
    }),
  };
}

export async function reResolvePendingPredictionSequence(input: {
  entryPoint: PredictionReconciliationEntryPoint;
  current: PredictionInputs;
  invokeWorker: (prompt: string) => Promise<string>;
}): Promise<ReResolvedPredictionPlan> {
  const startMigrationNumber = input.entryPoint.reconciliationStartMigrationNumber;
  if (startMigrationNumber === null) {
    return {
      startMigrationNumber: 0,
      pendingMigrationNumbers: [],
      items: [],
      fallback: null,
    };
  }

  const pendingMigrationNumbers = uniqueSorted(
    input.entryPoint.pendingPredictionMigrationNumbers
      .filter((migrationNumber) => migrationNumber >= startMigrationNumber),
  );

  if (pendingMigrationNumbers.length === 0) {
    return {
      startMigrationNumber,
      pendingMigrationNumbers,
      items: [],
      fallback: null,
    };
  }

  const prompt = buildPendingReResolutionPrompt({
    entryPoint: input.entryPoint,
    current: input.current,
    pendingMigrationNumbers,
    startMigrationNumber,
  });
  const output = await input.invokeWorker(prompt);
  let items: ReResolvedPredictionItem[];
  let validatedItems: ReResolvedPredictionItem[];
  try {
    items = parseReResolvedPlanItems(output);
    validatedItems = validateReResolvedItems(items, pendingMigrationNumbers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconciliation error.";
    return {
      startMigrationNumber,
      pendingMigrationNumbers: [],
      items: [],
      fallback: {
        reason: classifyReconciliationConflict({ message, output }),
        message,
        attemptedPendingMigrationNumbers: pendingMigrationNumbers,
      },
    };
  }

  return {
    startMigrationNumber,
    pendingMigrationNumbers,
    items: validatedItems,
    fallback: null,
  };
}

export function reconcilePendingPredictedItemsAtomically(input: {
  current: PredictionInputs;
  plan: ReResolvedPredictionPlan;
}): ReconciledPendingPredictionState {
  const currentMigrations = sortMigrations(input.current.migrations);
  const currentFiles = [...input.current.files];
  const lastCompletedMigrationNumber = currentMigrations
    .filter((migration) => migration.isApplied)
    .reduce((max, migration) => Math.max(max, migration.number), 0);
  const preservedCompletedMigrationNumbers = uniqueSorted(
    currentMigrations
      .filter((migration) => migration.isApplied)
      .map((migration) => migration.number),
  );

  const targetPendingMigrationNumbers = uniqueSorted(input.plan.pendingMigrationNumbers);
  if (targetPendingMigrationNumbers.length === 0) {
    return {
      migrations: currentMigrations,
      files: sortTrackedFiles(currentFiles),
      preservedCompletedMigrationNumbers,
      reconciledPendingMigrationNumbers: [],
      patch: {
        removeRelativePaths: [],
        writeFiles: [],
      },
    };
  }

  const itemByMigrationNumber = new Map<number, ReResolvedPredictionItem>(
    input.plan.items.map((item) => [item.migrationNumber, item]),
  );
  for (const migrationNumber of targetPendingMigrationNumbers) {
    if (migrationNumber <= lastCompletedMigrationNumber) {
      throw new Error(
        `Reconciliation cannot rewrite completed migration ${String(migrationNumber)}.`,
      );
    }
    if (!itemByMigrationNumber.has(migrationNumber)) {
      throw new Error(
        `Reconciliation plan is missing migration ${String(migrationNumber)}.`,
      );
    }
  }

  const targetSet = new Set(targetPendingMigrationNumbers);
  const filesToReplace = currentFiles.filter(
    (file) => targetSet.has(file.migrationNumber) && (isMigrationTrackedFile(file) || isSnapshotTrackedFile(file)),
  );
  const removeRelativePaths = uniqueSortedStrings(filesToReplace.map((file) => normalizeRelativePath(file.relativePath)));
  const preservedFiles = currentFiles.filter(
    (file) => !(targetSet.has(file.migrationNumber) && (isMigrationTrackedFile(file) || isSnapshotTrackedFile(file))),
  );

  const defaultPrefix = inferMigrationPrefix(currentFiles);
  const writeFiles: PredictionTrackedFile[] = [];
  for (const migrationNumber of targetPendingMigrationNumbers) {
    const item = itemByMigrationNumber.get(migrationNumber)!;
    const stableMigrationName = getStablePendingMigrationName(currentMigrations, migrationNumber, item.migrationName);
    const migrationPrefix = getPreferredPrefixForMigration(currentFiles, migrationNumber, "migration") ?? defaultPrefix;
    const snapshotPrefix = getPreferredPrefixForMigration(currentFiles, migrationNumber, "snapshot") ?? defaultPrefix;
    const existingMigrationPath = getExistingPathForMigrationAndKind(currentFiles, migrationNumber, "migration");
    const existingSnapshotPath = getExistingPathForMigrationAndKind(currentFiles, migrationNumber, "snapshot");
    const migrationPath = existingMigrationPath
      ?? joinPrefixAndFileName(migrationPrefix, formatMigrationFilename(migrationNumber, stableMigrationName));
    const snapshotPath = existingSnapshotPath
      ?? joinPrefixAndFileName(snapshotPrefix, formatSnapshotFilename(migrationNumber));

    writeFiles.push({
      relativePath: migrationPath,
      migrationNumber,
      kind: "file",
      content: item.migrationContent,
    });
    writeFiles.push({
      relativePath: snapshotPath,
      migrationNumber,
      kind: "file",
      content: item.snapshotContent,
    });
  }

  const migrationByNumber = new Map<number, PredictionTrackedMigration>(
    currentMigrations.map((migration) => [migration.number, migration]),
  );
  for (const migrationNumber of targetPendingMigrationNumbers) {
    const item = itemByMigrationNumber.get(migrationNumber)!;
    const stableMigrationName = getStablePendingMigrationName(currentMigrations, migrationNumber, item.migrationName);
    const existing = migrationByNumber.get(migrationNumber);
    if (existing?.isApplied) {
      throw new Error(
        `Reconciliation cannot rewrite completed migration ${String(migrationNumber)}.`,
      );
    }

    migrationByNumber.set(migrationNumber, {
      number: migrationNumber,
      name: stableMigrationName,
      isApplied: false,
    });
  }

  return {
    migrations: sortMigrations([...migrationByNumber.values()]),
    files: sortTrackedFiles([...preservedFiles, ...writeFiles]),
    preservedCompletedMigrationNumbers,
    reconciledPendingMigrationNumbers: targetPendingMigrationNumbers,
    patch: {
      removeRelativePaths,
      writeFiles: sortTrackedFiles(writeFiles),
    },
  };
}

function getStablePendingMigrationName(
  currentMigrations: readonly PredictionTrackedMigration[],
  migrationNumber: number,
  fallbackName: string,
): string {
  const existing = currentMigrations.find((migration) => migration.number === migrationNumber);
  if (existing && !existing.isApplied && existing.name.trim().length > 0) {
    return existing.name;
  }

  return fallbackName;
}

function buildFileChangeCandidate(
  fingerprint: Pick<PredictionFileFingerprint, "migrationNumber" | "relativePath">,
  firstPendingMigrationNumber: number,
): { reason: PredictionStaleReason; affectedMigrationNumber: number } {
  if (isMigrationPath(fingerprint.relativePath)) {
    if (fingerprint.migrationNumber >= firstPendingMigrationNumber) {
      return {
        reason: "pending_manual_edit",
        affectedMigrationNumber: fingerprint.migrationNumber,
      };
    }

    return {
      reason: "task_text_changed",
      affectedMigrationNumber: firstPendingMigrationNumber,
    };
  }

  if (fingerprint.migrationNumber <= firstPendingMigrationNumber) {
    return {
      reason: "context_changed",
      affectedMigrationNumber: firstPendingMigrationNumber,
    };
  }

  return {
    reason: "context_changed",
    affectedMigrationNumber: Math.max(firstPendingMigrationNumber, fingerprint.migrationNumber),
  };
}

function buildPendingReResolutionPrompt(input: {
  entryPoint: PredictionReconciliationEntryPoint;
  current: PredictionInputs;
  pendingMigrationNumbers: readonly number[];
  startMigrationNumber: number;
}): string {
  const currentPendingMigrations = input.current.files
    .filter((file) => isMigrationTrackedFile(file) && input.pendingMigrationNumbers.includes(file.migrationNumber))
    .sort((left, right) => left.migrationNumber - right.migrationNumber)
    .map((file) => {
      const normalizedPath = normalizeRelativePath(file.relativePath);
      return [
        `### ${String(file.migrationNumber).padStart(4, "0")} ${normalizedPath}`,
        file.content,
      ].join("\n");
    })
    .join("\n\n");

  const latestExecutedMigration = input.entryPoint.latestExecutedMigration?.content ?? "";
  const latestContext = input.entryPoint.latestContext?.content ?? "";
  const latestSnapshot = input.entryPoint.latestSnapshot?.content ?? "";
  const latestBacklog = input.entryPoint.latestBacklog?.content ?? "";

  return [
    "Re-resolve the remaining pending migration prediction sequence.",
    "",
    "Rules:",
    "- Preserve completed migrations as immutable history.",
    "- Re-resolve ONLY pending migrations from the reconciliation start onward.",
    "- Use the latest executed migration/context/snapshot/backlog as the source of truth.",
    "- Return JSON only.",
    "",
    "Reconciliation state:",
    `- lastCompletedMigrationNumber: ${String(input.entryPoint.lastCompletedMigrationNumber)}`,
    `- reconciliationStartMigrationNumber: ${String(input.startMigrationNumber)}`,
    `- pendingMigrationNumbers: [${input.pendingMigrationNumbers.join(", ")}]`,
    "",
    "Latest executed migration:",
    latestExecutedMigration || "(none)",
    "",
    "Latest context:",
    latestContext || "(none)",
    "",
    "Latest snapshot:",
    latestSnapshot || "(none)",
    "",
    "Latest backlog:",
    latestBacklog || "(none)",
    "",
    "Current pending migration drafts to reconcile:",
    currentPendingMigrations || "(none)",
    "",
    "Output schema:",
    "{",
    '  "migrations": [',
    "    {",
    '      "number": <number from pendingMigrationNumbers>,',
    '      "name": "<kebab-case-name>",',
    '      "migration": "<markdown>",',
    '      "snapshot": "<markdown>"',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

function parseReResolvedPlanItems(output: string): ReResolvedPredictionItem[] {
  const jsonBlock = extractJsonObject(output);
  const parsed = JSON.parse(jsonBlock) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Worker output must be a JSON object.");
  }

  const migrations = parsed.migrations;
  if (!Array.isArray(migrations)) {
    throw new Error("Worker output must include a 'migrations' array.");
  }

  const items: ReResolvedPredictionItem[] = [];
  for (const migration of migrations) {
    if (!isRecord(migration)) {
      throw new Error("Each migration item must be an object.");
    }

    const number = toInteger(migration.number);
    const name = toStringValue(migration.name);
    const migrationContent = toStringValue(migration.migration);
    const snapshotContent = toStringValue(migration.snapshot);

    if (number === null || !name || !migrationContent || !snapshotContent) {
      throw new Error("Each migration item requires number, name, migration, and snapshot.");
    }

    items.push({
      migrationNumber: number,
      migrationName: toKebabCase(name),
      migrationContent,
      snapshotContent,
    });
  }

  return items;
}

function validateReResolvedItems(
  items: readonly ReResolvedPredictionItem[],
  pendingMigrationNumbers: readonly number[],
): ReResolvedPredictionItem[] {
  const pendingSet = new Set(pendingMigrationNumbers);
  const seen = new Set<number>();
  for (const item of items) {
    if (!pendingSet.has(item.migrationNumber)) {
      throw new Error(`Worker returned non-pending migration ${String(item.migrationNumber)}.`);
    }
    if (seen.has(item.migrationNumber)) {
      throw new Error(`Worker returned duplicate migration ${String(item.migrationNumber)}.`);
    }
    seen.add(item.migrationNumber);
  }

  for (const migrationNumber of pendingMigrationNumbers) {
    if (!seen.has(migrationNumber)) {
      throw new Error(`Worker output is missing pending migration ${String(migrationNumber)}.`);
    }
  }

  const actualOrdering = items.map((item) => item.migrationNumber);
  if (actualOrdering.length !== pendingMigrationNumbers.length) {
    throw new Error("Worker returned invalid ordering for pending migrations.");
  }
  for (let index = 0; index < pendingMigrationNumbers.length; index += 1) {
    if (actualOrdering[index] !== pendingMigrationNumbers[index]) {
      throw new Error(
        `Worker returned invalid ordering for pending migrations at index ${String(index)}.`,
      );
    }
  }

  return [...items].sort((left, right) => left.migrationNumber - right.migrationNumber);
}

function classifyReconciliationConflict(input: {
  message: string;
  output: string;
}): PredictionReconciliationConflictReason {
  const message = input.message.toLowerCase();
  const output = input.output.trim();

  if (message.includes("missing pending migration") || looksLikePartialOutput(output)) {
    return "partial_output";
  }

  if (
    message.includes("invalid ordering")
    || message.includes("duplicate migration")
    || message.includes("non-pending migration")
  ) {
    return "invalid_ordering";
  }

  return "schema_mismatch";
}

function looksLikePartialOutput(output: string): boolean {
  if (output.length === 0) {
    return true;
  }

  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace < firstBrace) {
    return true;
  }

  return false;
}

function toFingerprints(files: readonly PredictionTrackedFile[]): PredictionFileFingerprint[] {
  return files
    .map((file) => ({
      relativePath: normalizeRelativePath(file.relativePath),
      migrationNumber: file.migrationNumber,
      kind: file.kind,
      semanticHash: hashContent(file.content),
    }))
    .sort((left, right) => {
      if (left.migrationNumber !== right.migrationNumber) {
        return left.migrationNumber - right.migrationNumber;
      }

      if (left.relativePath !== right.relativePath) {
        return left.relativePath.localeCompare(right.relativePath);
      }

      return 0;
    });
}

function sortMigrations(migrations: readonly PredictionTrackedMigration[]): PredictionTrackedMigration[] {
  return [...migrations].sort((left, right) => {
    if (left.number !== right.number) {
      return left.number - right.number;
    }
    return left.name.localeCompare(right.name);
  });
}

function uniqueSorted(values: readonly number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function sortTrackedFiles(files: readonly PredictionTrackedFile[]): PredictionTrackedFile[] {
  return [...files].sort((left, right) => {
    if (left.migrationNumber !== right.migrationNumber) {
      return left.migrationNumber - right.migrationNumber;
    }

    const leftPath = normalizeRelativePath(left.relativePath);
    const rightPath = normalizeRelativePath(right.relativePath);
    if (leftPath !== rightPath) {
      return leftPath.localeCompare(rightPath);
    }

    return 0;
  });
}

function inferMigrationPrefix(files: readonly PredictionTrackedFile[]): string {
  for (const file of files) {
    const normalizedPath = normalizeRelativePath(file.relativePath);
    if (!isMigrationTrackedFile(file) && !isSnapshotTrackedFile(file)) {
      continue;
    }
    return getPathPrefix(normalizedPath);
  }

  return "migrations";
}

function getPreferredPrefixForMigration(
  files: readonly PredictionTrackedFile[],
  migrationNumber: number,
  fileType: "migration" | "snapshot",
): string | null {
  const candidates = files
    .filter((file) => file.migrationNumber === migrationNumber && matchesPredictedFileType(file, fileType))
    .map((file) => normalizeRelativePath(file.relativePath))
    .sort((left, right) => left.localeCompare(right));
  const first = candidates[0];
  return first ? getPathPrefix(first) : null;
}

function getExistingPathForMigrationAndKind(
  files: readonly PredictionTrackedFile[],
  migrationNumber: number,
  fileType: "migration" | "snapshot",
): string | null {
  const candidates = files
    .filter((file) => file.migrationNumber === migrationNumber && matchesPredictedFileType(file, fileType))
    .map((file) => normalizeRelativePath(file.relativePath))
    .sort((left, right) => left.localeCompare(right));
  return candidates[0] ?? null;
}

function matchesPredictedFileType(
  file: Pick<PredictionTrackedFile, "relativePath">,
  fileType: "migration" | "snapshot",
): boolean {
  return fileType === "migration" ? isMigrationTrackedFile(file) : isSnapshotTrackedFile(file);
}

function getPathPrefix(relativePath: string): string {
  const normalizedPath = normalizeRelativePath(relativePath);
  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }
  return normalizedPath.slice(0, lastSlash);
}

function joinPrefixAndFileName(prefix: string, fileName: string): string {
  if (!prefix) {
    return fileName;
  }
  return `${prefix}/${fileName}`;
}

function hashMigrationSequence(migrations: readonly PredictionTrackedMigration[]): string {
  const sequence = migrations
    .map((migration) => `${String(migration.number).padStart(4, "0")}:${migration.name}`)
    .join("\n");
  return createHash("sha256").update(sequence).digest("hex");
}

function getEarliestSequenceDifference(
  baselinePendingMigrationNumbers: readonly number[],
  currentMigrations: readonly PredictionTrackedMigration[],
  firstPendingMigrationNumber: number,
): number {
  const baselinePendingSet = new Set(baselinePendingMigrationNumbers);
  const baselinePending = uniqueSorted(baselinePendingMigrationNumbers);
  const currentPending = uniqueSorted(
    currentMigrations
      .map((migration) => migration.number)
      .filter((migrationNumber) => baselinePendingSet.has(migrationNumber) || migrationNumber >= firstPendingMigrationNumber),
  );

  const maxLength = Math.max(baselinePending.length, currentPending.length);
  for (let index = 0; index < maxLength; index += 1) {
    const baselineNumber = baselinePending[index];
    const currentNumber = currentPending[index];
    if (baselineNumber === currentNumber) {
      continue;
    }

    return Math.min(
      baselineNumber ?? Number.POSITIVE_INFINITY,
      currentNumber ?? Number.POSITIVE_INFINITY,
      firstPendingMigrationNumber,
    );
  }

  return firstPendingMigrationNumber;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isMigrationTrackedFile(file: Pick<PredictionTrackedFile, "relativePath">): boolean {
  return isMigrationPath(file.relativePath);
}

function isMigrationPath(relativePath: string): boolean {
  const baseName = path.basename(normalizeRelativePath(relativePath));
  if (/^(\d+)\.(\d+)\s+.+\.md$/i.test(baseName)) {
    return false;
  }

  return /^(\d+)\.\s+.+\.md$/i.test(baseName) || /^\d{4}-(?!-).+\.md$/i.test(baseName);
}

function isSnapshotTrackedFile(file: Pick<PredictionTrackedFile, "relativePath">): boolean {
  const normalized = normalizeRelativePath(file.relativePath);
  return /\.(?:snapshot|review)\.md$/i.test(normalized);
}

function extractJsonObject(output: string): string {
  const fencedMatches = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const trimmed = output.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return output.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("Worker output does not contain a JSON object.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toKebabCase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`'".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized : "migration";
}

function hashContent(content: string): string {
  const normalized = normalizeContent(content);
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeContent(content: string): string {
  const normalizedNewlines = content.replace(/\r\n?/g, "\n");
  const lines = normalizedNewlines
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .filter((line) => !isRuntimeResidueLine(line));

  const collapsedBlankLines: string[] = [];
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    const last = collapsedBlankLines[collapsedBlankLines.length - 1];
    if (isBlank && (!last || last.trim().length === 0)) {
      continue;
    }

    collapsedBlankLines.push(line);
  }

  while (collapsedBlankLines.length > 0 && collapsedBlankLines[collapsedBlankLines.length - 1]!.trim().length === 0) {
    collapsedBlankLines.pop();
  }

  return collapsedBlankLines.join("\n");
}

function isRuntimeResidueLine(line: string): boolean {
  const normalized = line.trim();
  return /^<!--\s*rundown:(trace|fix|skipped)\b[^>]*-->$/i.test(normalized)
    || /^<!--\s*(trace|fix|skipped)\b[^>]*-->$/i.test(normalized);
}

function findLatestFileAtOrBefore(input: {
  files: readonly PredictionTrackedFile[];
  migrationNumber: number;
  matches: (file: PredictionTrackedFile) => boolean;
}): PredictionTrackedFile | null {
  if (input.migrationNumber <= 0) {
    return null;
  }

  let candidate: PredictionTrackedFile | null = null;
  for (const file of input.files) {
    if (!input.matches(file)) {
      continue;
    }
    if (file.migrationNumber > input.migrationNumber) {
      continue;
    }

    if (!candidate || file.migrationNumber > candidate.migrationNumber) {
      candidate = file;
      continue;
    }

    if (candidate && file.migrationNumber === candidate.migrationNumber) {
      const currentPath = normalizeRelativePath(file.relativePath);
      const bestPath = normalizeRelativePath(candidate.relativePath);
      if (currentPath.localeCompare(bestPath) > 0) {
        candidate = file;
      }
    }
  }

  return candidate;
}
