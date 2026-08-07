import path from "node:path";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { parseMigrationFilename } from "../domain/migration-parser.js";
import { discoverDesignRevisionDirectories } from "./design-context.js";
import {
  upsertArchiveManifestEntries,
  type ArchiveManifestEntry,
} from "./archive-manifest.js";
import {
  resolveArchiveWorkspacePaths,
  resolveWorkspaceMountPath,
  resolveWorkspaceMounts,
  resolveWorkspacePath,
} from "./workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";

export type CompactTarget = "revisions" | "migrations" | "all";

export interface CompactTaskOptions {
  workspace?: string;
  target?: CompactTarget;
  dryRun?: boolean;
  keepCount?: number;
  keepRevisions?: number;
  keepMigrationsRoot?: number;
  keepMigrationsThreads?: number;
}

export interface CompactTaskDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
}

const DEFAULT_KEEP_COUNT = 5;

interface CompactResult {
  movedEntries: ArchiveManifestEntry[];
  plannedMoves: Array<{ fromPath: string; toPath: string }>;
}

export function createCompactTask(
  dependencies: CompactTaskDependencies,
): (options: CompactTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function compactTask(options: CompactTaskOptions): Promise<number> {
    const invocationDir = process.cwd();
    const workspaceSelection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: dependencies.fileSystem,
      invocationDir,
      workspaceOption: options.workspace,
    });
    if (!workspaceSelection.ok) {
      emit({ kind: "error", message: workspaceSelection.message });
      return EXIT_CODE_FAILURE;
    }

    const workspaceRoot = workspaceSelection.workspaceRoot;
    const invocationRoot = workspaceSelection.executionContext.invocationDir;
    const target = options.target ?? "all";
    if (target !== "all" && target !== "revisions" && target !== "migrations") {
      emit({ kind: "error", message: `Invalid compact target: ${target}. Use revisions, migrations, or all.` });
      return EXIT_CODE_FAILURE;
    }

    const keepCount = normalizeKeepCount(options.keepCount, DEFAULT_KEEP_COUNT);
    const keepRevisions = normalizeKeepCount(options.keepRevisions, keepCount);
    const keepMigrationsRoot = normalizeKeepCount(options.keepMigrationsRoot, keepCount);
    const keepMigrationsThreads = normalizeKeepCount(options.keepMigrationsThreads, keepCount);
    const dryRun = Boolean(options.dryRun);

    emit({
      kind: "info",
      message: `Compacting history (target=${target}, dryRun=${dryRun ? "true" : "false"}, keep=${keepCount}).`,
    });

    const compacted: CompactResult[] = [];
    if (target === "all" || target === "revisions") {
      compacted.push(compactRevisions({
        fileSystem: dependencies.fileSystem,
        workspaceRoot,
        invocationRoot,
        keepHotCount: keepRevisions,
        dryRun,
      }));
    }

    if (target === "all" || target === "migrations") {
      compacted.push(compactMigrations({
        fileSystem: dependencies.fileSystem,
        workspaceRoot,
        invocationRoot,
        keepRootCount: keepMigrationsRoot,
        keepThreadCount: keepMigrationsThreads,
        dryRun,
      }));
    }

    const plannedMoves = compacted.flatMap((slice) => slice.plannedMoves);
    const movedEntries = compacted.flatMap((slice) => slice.movedEntries);

    for (const plannedMove of plannedMoves) {
      const verb = dryRun ? "would move" : "moved";
      emit({
        kind: "text",
        text: `${verb}: ${toWorkspaceRelativePath(workspaceRoot, plannedMove.fromPath)} -> ${toWorkspaceRelativePath(workspaceRoot, plannedMove.toPath)}`,
      });
    }

    if (movedEntries.length > 0 && !dryRun) {
      upsertArchiveManifestEntries(dependencies.fileSystem, workspaceRoot, movedEntries);
    }

    if (plannedMoves.length === 0) {
      emit({ kind: "info", message: "No history payloads eligible for compaction." });
      return EXIT_CODE_NO_WORK;
    }

    emit({
      kind: "success",
      message: dryRun
        ? `Dry-run complete: ${plannedMoves.length} payload(s) eligible for archive relocation.`
        : `Compaction complete: ${plannedMoves.length} payload(s) moved to archive roots${movedEntries.length > 0 ? " and indexed" : ""}.`,
    });
    return EXIT_CODE_SUCCESS;
  };
}

function compactRevisions(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  keepHotCount: number;
  dryRun: boolean;
}): CompactResult {
  const { fileSystem, workspaceRoot, invocationRoot, keepHotCount, dryRun } = input;
  const mounts = resolveWorkspaceMounts({
    fileSystem,
    workspaceRoot,
    invocationRoot,
  });
  const hotRevisionsRoot = resolveWorkspaceMountPath({
    mounts,
    logicalPath: "design/revisions",
  }).absolutePath;
  const archivePaths = resolveArchiveWorkspacePaths({
    fileSystem,
    workspaceRoot,
    invocationRoot,
  });

  const revisions = discoverDesignRevisionDirectories(fileSystem, workspaceRoot, { invocationRoot })
    .filter((revision) => revision.metadata.plannedAt !== null)
    .filter((revision) => isDirectory(fileSystem, path.join(hotRevisionsRoot, revision.name)))
    .sort((left, right) => left.index - right.index);

  const keepSet = new Set(
    revisions.slice(Math.max(0, revisions.length - keepHotCount)).map((revision) => revision.name),
  );

  const plannedMoves: Array<{ fromPath: string; toPath: string }> = [];
  const movedEntries: ArchiveManifestEntry[] = [];
  for (const revision of revisions) {
    if (keepSet.has(revision.name)) {
      continue;
    }

    const fromPath = path.join(hotRevisionsRoot, revision.name);
    const toPath = path.join(archivePaths.designRevisionPayloads, revision.name);
    if (fileSystem.exists(toPath)) {
      continue;
    }

    plannedMoves.push({ fromPath, toPath });
    if (!dryRun) {
      movePath(fileSystem, fromPath, toPath);
      movedEntries.push({
        kind: "revision-payload",
        originalLogicalPath: toWorkspaceRelativePath(workspaceRoot, fromPath),
        archiveLogicalPath: toWorkspaceRelativePath(workspaceRoot, toPath),
        archivedAt: new Date().toISOString(),
      });
    }
  }

  return {
    movedEntries,
    plannedMoves,
  };
}

function compactMigrations(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  keepRootCount: number;
  keepThreadCount: number;
  dryRun: boolean;
}): CompactResult {
  const {
    fileSystem,
    workspaceRoot,
    invocationRoot,
    keepRootCount,
    keepThreadCount,
    dryRun,
  } = input;
  const migrationsDir = resolveWorkspacePath({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    bucket: "migrations",
  });
  const archivePaths = resolveArchiveWorkspacePaths({
    fileSystem,
    workspaceRoot,
    invocationRoot,
  });

  const rootResult = compactMigrationLane({
    fileSystem,
    workspaceRoot,
    hotDir: migrationsDir,
    archiveDir: archivePaths.migrationRootLane,
    keepHotCount: keepRootCount,
    dryRun,
    lane: "root",
  });

  const hotThreadsDir = path.join(migrationsDir, "threads");
  const archivedThreadsDir = archivePaths.migrationThreads;
  const threadSlugs = new Set([
    ...listSubdirectories(fileSystem, hotThreadsDir),
    ...listSubdirectories(fileSystem, archivedThreadsDir),
  ]);

  const threadResults: CompactResult[] = [];
  for (const threadSlug of [...threadSlugs].sort((left, right) => left.localeCompare(right))) {
    threadResults.push(compactMigrationLane({
      fileSystem,
      workspaceRoot,
      hotDir: path.join(hotThreadsDir, threadSlug),
      archiveDir: path.join(archivedThreadsDir, threadSlug),
      keepHotCount: keepThreadCount,
      dryRun,
      lane: "thread",
      threadSlug,
    }));
  }

  return {
    movedEntries: [rootResult, ...threadResults].flatMap((slice) => slice.movedEntries),
    plannedMoves: [rootResult, ...threadResults].flatMap((slice) => slice.plannedMoves),
  };
}

function compactMigrationLane(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  hotDir: string;
  archiveDir: string;
  keepHotCount: number;
  dryRun: boolean;
  lane: "root" | "thread";
  threadSlug?: string;
}): CompactResult {
  const {
    fileSystem,
    workspaceRoot,
    hotDir,
    archiveDir,
    keepHotCount,
    dryRun,
    lane,
    threadSlug,
  } = input;

  const hotFiles = listMigrationFiles(fileSystem, hotDir);
  const archivedFiles = listMigrationFiles(fileSystem, archiveDir);
  const allParsed = [...hotFiles, ...archivedFiles]
    .map((filePath) => ({
      filePath,
      parsed: parseMigrationFilename(path.basename(filePath)),
    }))
    .filter((entry): entry is { filePath: string; parsed: { number: number; name: string } } => entry.parsed !== null);

  const allNumbers = [...new Set(allParsed.map((entry) => entry.parsed.number))]
    .sort((left, right) => left - right);
  const keepNumbers = new Set(allNumbers.slice(Math.max(0, allNumbers.length - keepHotCount)));

  const hotParsed = hotFiles
    .map((filePath) => ({ filePath, parsed: parseMigrationFilename(path.basename(filePath)) }))
    .filter((entry): entry is { filePath: string; parsed: { number: number; name: string } } => entry.parsed !== null)
    .filter((entry) => !keepNumbers.has(entry.parsed.number));

  const plannedMoves: Array<{ fromPath: string; toPath: string }> = [];
  const movedEntries: ArchiveManifestEntry[] = [];

  for (const entry of hotParsed) {
    const fileName = path.basename(entry.filePath);
    const toPath = path.join(archiveDir, fileName);
    if (fileSystem.exists(toPath)) {
      continue;
    }
    plannedMoves.push({
      fromPath: entry.filePath,
      toPath,
    });

    if (!dryRun) {
      movePath(fileSystem, entry.filePath, toPath);
      movedEntries.push({
        kind: resolveMigrationManifestKind(lane, entry.parsed.name),
        originalLogicalPath: toWorkspaceRelativePath(workspaceRoot, entry.filePath),
        archiveLogicalPath: toWorkspaceRelativePath(workspaceRoot, toPath),
        archivedAt: new Date().toISOString(),
        lane,
        ...(lane === "thread" && threadSlug ? { threadSlug } : {}),
      });
    }
  }

  return {
    movedEntries,
    plannedMoves,
  };
}

function resolveMigrationManifestKind(
  lane: "root" | "thread",
  migrationName: string,
): "migration-primary" | "migration-review" | `migration-thread-${string}` {
  const normalized = migrationName.trim().toLowerCase();
  const isReview = normalized === "review";
  if (lane === "root") {
    return isReview ? "migration-review" : "migration-primary";
  }

  return isReview ? "migration-thread-review" : "migration-thread-primary";
}

function listMigrationFiles(fileSystem: FileSystem, directoryPath: string): string[] {
  if (!isDirectory(fileSystem, directoryPath)) {
    return [];
  }

  return fileSystem.readdir(directoryPath)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function listSubdirectories(fileSystem: FileSystem, directoryPath: string): string[] {
  if (!isDirectory(fileSystem, directoryPath)) {
    return [];
  }

  return fileSystem.readdir(directoryPath)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function movePath(fileSystem: FileSystem, fromPath: string, toPath: string): void {
  if (typeof fileSystem.rename !== "function") {
    throw new Error("Compaction requires filesystem rename support for archive relocation.");
  }
  fileSystem.mkdir(path.dirname(toPath), { recursive: true });
  fileSystem.rename(fromPath, toPath);
}

function normalizeKeepCount(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid keep count: ${String(value)}. Expected a non-negative integer.`);
  }

  return value;
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
}
