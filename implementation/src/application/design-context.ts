import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";

export interface DesignContextResolution {
  design: string;
  sourcePaths: string[];
  isLowContext: boolean;
  lowContextGuidance: string;
}

export interface DesignContextSourceReferencesResolution {
  sourceReferences: string[];
  hasManagedDocs: boolean;
}

export interface DesignRevisionDirectory {
  index: number;
  name: string;
  absolutePath: string;
  metadata: DesignRevisionMetadata;
  metadataPath: string;
}

export type RevisionDescriptor = DesignRevisionDirectory;

export interface DesignRevisionMetadata {
  createdAt: string;
  label: string;
  plannedAt: string | null;
  migrations: string[];
}

export interface SavedDesignRevision {
  index: number;
  name: string;
  absolutePath: string;
  sourcePath: string;
  copiedFileCount: number;
  metadata: DesignRevisionMetadata;
  metadataPath: string;
}

export type DesignRevisionDiffChangeKind = "added" | "removed" | "modified";

export interface DesignRevisionDiffFileChange {
  relativePath: string;
  kind: DesignRevisionDiffChangeKind;
  fromPath: string;
  toPath: string;
}

export interface DesignRevisionDiffContext {
  fromRevision: DesignRevisionDirectory | null;
  toTarget: {
    kind: "current" | "revision";
    name: string;
    absolutePath: string;
    metadata: DesignRevisionMetadata;
    metadataPath: string;
  };
  hasComparison: boolean;
  summary: string;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  changes: DesignRevisionDiffFileChange[];
  sourceReferences: string[];
}

export type SaveDesignRevisionSnapshotResult =
  | {
    kind: "saved";
    revision: SavedDesignRevision;
  }
  | {
    kind: "unchanged";
    sourcePath: string;
    latestRevision: DesignRevisionDirectory;
  };

interface DesignRevisionMetadataRecord {
  revision: string;
  index: number;
  createdAt: string;
  label?: string;
  plannedAt?: string | null;
  migrations?: string[];
}

const REVISION_DIRECTORY_PATTERN = /^rev\.(\d+)$/i;
const REVISION_METADATA_FILE_SUFFIX = ".meta.json";

const LEGACY_WORKSPACE_DIR = "docs";
const CANONICAL_PRIMARY_FILE = "Target.md";
const LEGACY_PRIMARY_FILE = "Design.md";

export function formatRevisionDesignContext(
  fileSystem: FileSystem,
  revisionAbsolutePath: string,
  primaryFileName: string = CANONICAL_PRIMARY_FILE,
): string {
  const designFiles = collectDesignFiles(fileSystem, revisionAbsolutePath);
  return formatDesignWorkspaceContext(fileSystem, revisionAbsolutePath, designFiles, primaryFileName);
}

export function formatDesignRevisionUnifiedDiff(
  fileSystem: FileSystem,
  diff: DesignRevisionDiffContext,
): string {
  const fromFiles = diff.fromRevision && isDirectory(fileSystem, diff.fromRevision.absolutePath)
    ? collectDirectoryFileMap(fileSystem, diff.fromRevision.absolutePath)
    : new Map<string, { absolutePath: string; content: string }>();
  const toFiles = isDirectory(fileSystem, diff.toTarget.absolutePath)
    ? collectDirectoryFileMap(fileSystem, diff.toTarget.absolutePath)
    : new Map<string, { absolutePath: string; content: string }>();

  const sections = diff.changes.map((change) => {
    const fromContent = fromFiles.get(change.relativePath)?.content ?? "";
    const toContent = toFiles.get(change.relativePath)?.content ?? "";
    const diffBody = formatUnifiedDiffBodyForChange(change.kind, fromContent, toContent);

    return [
      `#### ${change.relativePath} (${change.kind})`,
      "",
      "```diff",
      diffBody,
      "```",
    ].join("\n");
  });

  return sections.join("\n\n");
}

export function resolveDesignContext(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: { invocationRoot?: string },
): DesignContextResolution {
  const configuredWorkspace = resolveConfiguredDesignWorkspace(fileSystem, workspaceRoot, options?.invocationRoot);
  const managedCurrentCandidates = getManagedCurrentWorkspaceCandidates(
    workspaceRoot,
    configuredWorkspace.workspaceDir,
    configuredWorkspace.workspacePath,
  );
  let firstEmptyManagedCandidate: {
    currentDir: string;
    relativeCurrentDir: string;
    primaryFileName: string;
  } | null = null;

  for (const candidate of managedCurrentCandidates) {
    const hasManagedCurrentDraft = isDirectory(fileSystem, candidate.currentDir);
    const managedCurrentFiles = collectDesignFiles(fileSystem, candidate.currentDir);
    if (managedCurrentFiles.length > 0) {
      return {
        design: formatDesignWorkspaceContext(
          fileSystem,
          candidate.currentDir,
          managedCurrentFiles,
          candidate.primaryFileName,
        ),
        sourcePaths: managedCurrentFiles,
        isLowContext: false,
        lowContextGuidance: "",
      };
    }

    if (hasManagedCurrentDraft) {
      firstEmptyManagedCandidate ??= candidate;
    }
  }

  const canonicalRootPath = path.join(workspaceRoot, CANONICAL_PRIMARY_FILE);
  if (isFile(fileSystem, canonicalRootPath)) {
    return {
      design: fileSystem.readText(canonicalRootPath),
      sourcePaths: [canonicalRootPath],
      isLowContext: false,
      lowContextGuidance: "",
    };
  }

  const legacyDesignPath = path.join(workspaceRoot, LEGACY_PRIMARY_FILE);
  if (isFile(fileSystem, legacyDesignPath)) {
    return {
      design: fileSystem.readText(legacyDesignPath),
      sourcePaths: [legacyDesignPath],
      isLowContext: false,
      lowContextGuidance: "",
    };
  }

  if (firstEmptyManagedCandidate) {
    return {
      design: "",
      sourcePaths: [firstEmptyManagedCandidate.currentDir],
      isLowContext: true,
      lowContextGuidance:
        "Design draft is empty: "
        + firstEmptyManagedCandidate.relativeCurrentDir
        + "/ has no files. Add "
        + firstEmptyManagedCandidate.relativeCurrentDir
        + "/"
        + firstEmptyManagedCandidate.primaryFileName
        + " (and supporting docs) for richer migrate/test context.",
    };
  }

  return {
    design: "",
    sourcePaths: [],
    isLowContext: true,
    lowContextGuidance:
      "No design context found. Add "
       + configuredWorkspace.workspaceDir
      + "/current/"
      + CANONICAL_PRIMARY_FILE
      + " (preferred), "
      + "or use legacy docs/current/Design.md and root Design.md only as compatibility-only fallbacks for legacy projects.",
  };
}

export function resolveDesignContextSourceReferences(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: { invocationRoot?: string },
): DesignContextSourceReferencesResolution {
  const configuredWorkspace = resolveConfiguredDesignWorkspace(fileSystem, workspaceRoot, options?.invocationRoot);
  const canonicalSourceReferences = collectManagedSourceReferencesForWorkspace(
    fileSystem,
    workspaceRoot,
    configuredWorkspace.workspaceDir,
    configuredWorkspace.workspacePath,
  );
  if (canonicalSourceReferences.length > 0) {
    return {
      sourceReferences: canonicalSourceReferences,
      hasManagedDocs: true,
    };
  }

  const legacySourceReferences = collectManagedSourceReferencesForWorkspace(
    fileSystem,
    workspaceRoot,
    LEGACY_WORKSPACE_DIR,
  );
  if (legacySourceReferences.length > 0) {
    return {
      sourceReferences: legacySourceReferences,
      hasManagedDocs: true,
    };
  }

  const canonicalRootPath = path.join(workspaceRoot, CANONICAL_PRIMARY_FILE);
  if (isFile(fileSystem, canonicalRootPath)) {
    return {
      sourceReferences: [canonicalRootPath],
      hasManagedDocs: false,
    };
  }

  const legacyDesignPath = path.join(workspaceRoot, LEGACY_PRIMARY_FILE);
  if (!isFile(fileSystem, legacyDesignPath)) {
    return {
      sourceReferences: [],
      hasManagedDocs: false,
    };
  }

  return {
    sourceReferences: [legacyDesignPath],
    hasManagedDocs: false,
  };
}

export function discoverDesignRevisionDirectories(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: { invocationRoot?: string },
): DesignRevisionDirectory[] {
  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot, options?.invocationRoot);
  if (!isDirectory(fileSystem, workspace.rootDir)) {
    return [];
  }

  const revisions: DesignRevisionDirectory[] = [];
  const entries = fileSystem.readdir(workspace.rootDir)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }

    const parsed = parseDesignRevisionDirectoryName(entry.name);
    if (!parsed) {
      continue;
    }

    revisions.push({
      index: parsed.index,
      name: entry.name,
      absolutePath: path.join(workspace.rootDir, entry.name),
      metadata: readDesignRevisionMetadata(fileSystem, workspace.rootDir, entry.name, parsed.index),
      metadataPath: getDesignRevisionMetadataPath(workspace.rootDir, entry.name),
    });
  }

  return revisions.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

export function findLowestUnplannedRevision(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: { invocationRoot?: string },
): RevisionDescriptor | null {
  const revisions = discoverDesignRevisionDirectories(fileSystem, workspaceRoot, {
    invocationRoot: options?.invocationRoot,
  });

  for (const revision of revisions) {
    if (revision.index < 1) {
      continue;
    }

    if (revision.metadata.plannedAt === null) {
      return revision;
    }
  }

  return null;
}

export function markRevisionPlanned(
  fileSystem: FileSystem,
  workspaceRoot: string,
  revisionName: string,
  migrations: readonly string[],
): void {
  const parsedRevision = parseDesignRevisionDirectoryName(revisionName);
  if (!parsedRevision) {
    throw new Error("Invalid revision name: " + revisionName + ". Expected format rev.N.");
  }

  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot);
  const metadataPath = getDesignRevisionMetadataPath(workspace.rootDir, revisionName);
  const nowIso = new Date().toISOString();
  const existingMetadata = readRevisionMetadataRecord(fileSystem, metadataPath);

  const metadata: Record<string, unknown> = {
    ...(existingMetadata ?? {}),
    revision: revisionName,
    index: parsedRevision.index,
    plannedAt: nowIso,
    migrations: [...migrations],
  };
  if (typeof metadata.createdAt !== "string" || metadata.createdAt.trim().length === 0) {
    metadata.createdAt = nowIso;
  }

  const serializedMetadata = JSON.stringify(metadata, null, 2) + "\n";
  writeTextAtomically(fileSystem, metadataPath, serializedMetadata);
}

export function markRevisionUnplanned(
  fileSystem: FileSystem,
  workspaceRoot: string,
  revisionName: string,
): void {
  const parsedRevision = parseDesignRevisionDirectoryName(revisionName);
  if (!parsedRevision) {
    throw new Error("Invalid revision name: " + revisionName + ". Expected format rev.N.");
  }

  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot);
  const metadataPath = getDesignRevisionMetadataPath(workspace.rootDir, revisionName);
  const nowIso = new Date().toISOString();
  const existingMetadata = readRevisionMetadataRecord(fileSystem, metadataPath);

  const metadata: Record<string, unknown> = {
    ...(existingMetadata ?? {}),
    revision: revisionName,
    index: parsedRevision.index,
    plannedAt: null,
    migrations: [],
  };
  if (typeof metadata.createdAt !== "string" || metadata.createdAt.trim().length === 0) {
    metadata.createdAt = nowIso;
  }

  const serializedMetadata = JSON.stringify(metadata, null, 2) + "\n";
  writeTextAtomically(fileSystem, metadataPath, serializedMetadata);
}

export function markRevisionUnmigrated(
  fileSystem: FileSystem,
  workspaceRoot: string,
  revisionName: string,
): void {
  const parsedRevision = parseDesignRevisionDirectoryName(revisionName);
  if (!parsedRevision) {
    throw new Error("Invalid revision name: " + revisionName + ". Expected format rev.N.");
  }

  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot);
  const metadataPath = getDesignRevisionMetadataPath(workspace.rootDir, revisionName);
  if (!isFile(fileSystem, metadataPath)) {
    return;
  }

  const existingMetadata = readRevisionMetadataRecord(fileSystem, metadataPath);
  if (!existingMetadata) {
    return;
  }

  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    migratedAt: null,
  };

  const serializedMetadata = JSON.stringify(metadata, null, 2) + "\n";
  writeTextAtomically(fileSystem, metadataPath, serializedMetadata);
}

export function markRevisionMigrated(
  fileSystem: FileSystem,
  workspaceRoot: string,
  revisionName: string,
): void {
  const parsedRevision = parseDesignRevisionDirectoryName(revisionName);
  if (!parsedRevision) {
    throw new Error("Invalid revision name: " + revisionName + ". Expected format rev.N.");
  }

  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot);
  const metadataPath = getDesignRevisionMetadataPath(workspace.rootDir, revisionName);
  if (!isFile(fileSystem, metadataPath)) {
    return;
  }

  const existingMetadata = readRevisionMetadataRecord(fileSystem, metadataPath);
  if (!existingMetadata) {
    return;
  }

  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    migratedAt: new Date().toISOString(),
  };

  const serializedMetadata = JSON.stringify(metadata, null, 2) + "\n";
  writeTextAtomically(fileSystem, metadataPath, serializedMetadata);
}

export function parseDesignRevisionDirectoryName(name: string): { index: number } | null {
  const match = REVISION_DIRECTORY_PATTERN.exec(name.trim());
  if (!match) {
    return null;
  }

  const indexText = match[1];
  if (!indexText) {
    return null;
  }

  const parsedIndex = Number.parseInt(indexText, 10);
  if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 0) {
    return null;
  }

  return { index: parsedIndex };
}

export function saveDesignRevisionSnapshot(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: {
    invocationRoot?: string;
    label?: string;
    now?: Date;
  },
): SaveDesignRevisionSnapshotResult {
  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot, options?.invocationRoot);

  if (!isDirectory(fileSystem, workspace.currentDir)) {
    throw new Error(
      "Design working directory is missing: "
      + workspace.currentDir
      + ". Create "
      + workspace.relativeCurrentDir
      + "/ first (or run `rundown start ...`).",
    );
  }

  const revisions = discoverDesignRevisionDirectories(fileSystem, workspaceRoot, {
    invocationRoot: options?.invocationRoot,
  });
  let nextIndex = 0;
  for (const revision of revisions) {
    if (revision.index >= nextIndex) {
      nextIndex = revision.index + 1;
    }
  }

  const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  if (latestRevision && directoryTreesAreEqual(fileSystem, workspace.currentDir, latestRevision.absolutePath)) {
    return {
      kind: "unchanged",
      sourcePath: workspace.currentDir,
      latestRevision,
    };
  }

  const revisionName = `rev.${nextIndex}`;
  const revisionDir = path.join(workspace.rootDir, revisionName);
  if (fileSystem.exists(revisionDir)) {
    throw new Error(
      "Cannot save design revision: target snapshot already exists and revisions are immutable ("
      + revisionDir
      + "). Resolve the conflicting "
      + workspace.relativeRootDir
      + "/rev.* entry before retrying.",
    );
  }

  const metadataPath = getDesignRevisionMetadataPath(workspace.rootDir, revisionName);
  if (fileSystem.exists(metadataPath)) {
    throw new Error(
      "Cannot save design revision: metadata sidecar already exists for immutable snapshot "
      + revisionName
      + " ("
      + metadataPath
      + "). Resolve the conflict before retrying.",
    );
  }

  fileSystem.mkdir(revisionDir, { recursive: true });
  const copiedFileCount = copyDirectoryContents(fileSystem, workspace.currentDir, revisionDir);
  const metadata = createDesignRevisionMetadata(revisionName, nextIndex, options);
  fileSystem.writeText(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

  return {
    kind: "saved",
    revision: {
        index: nextIndex,
        name: revisionName,
        absolutePath: revisionDir,
        sourcePath: workspace.currentDir,
        copiedFileCount,
        metadata: toTemplateRevisionMetadata(metadata),
        metadataPath,
    },
  };
}

export function prepareDesignRevisionDiffContext(
  fileSystem: FileSystem,
  workspaceRoot: string,
  options?: {
    invocationRoot?: string;
    target?: "current" | string | number;
  },
): DesignRevisionDiffContext {
  const workspace = resolveDesignWorkspaceForRevisions(fileSystem, workspaceRoot, options?.invocationRoot);
  const revisions = discoverDesignRevisionDirectories(fileSystem, workspaceRoot, {
    invocationRoot: options?.invocationRoot,
  });

  const target = resolveDesignDiffTarget(fileSystem, workspace, revisions, options?.target);
  const sourceReferences = [target.absolutePath];

  if (!isDirectory(fileSystem, target.absolutePath)) {
    return {
      fromRevision: null,
      toTarget: target,
      hasComparison: false,
      summary: "Design diff unavailable: target directory does not exist for " + target.name + ".",
      addedCount: 0,
      removedCount: 0,
      modifiedCount: 0,
      changes: [],
      sourceReferences,
    };
  }

  const previousRevision = findPreviousRevisionForTarget(revisions, target);
  if (!previousRevision) {
    const initialDiff = computeInitialDirectoryDiff(fileSystem, target.absolutePath);
    return {
      fromRevision: null,
      toTarget: target,
      hasComparison: true,
      summary: formatInitialDesignDiffSummary(target.name, initialDiff.addedCount),
      addedCount: initialDiff.addedCount,
      removedCount: 0,
      modifiedCount: 0,
      changes: initialDiff.changes,
      sourceReferences,
    };
  }
  sourceReferences.unshift(previousRevision.absolutePath);

  const diff = computeDirectoryFileDiff(fileSystem, previousRevision.absolutePath, target.absolutePath);

  return {
    fromRevision: previousRevision,
    toTarget: target,
    hasComparison: true,
    summary: formatDesignDiffSummary(previousRevision.name, target.name, diff),
    addedCount: diff.addedCount,
    removedCount: diff.removedCount,
    modifiedCount: diff.modifiedCount,
    changes: diff.changes,
    sourceReferences,
  };
}

function collectDesignFiles(fileSystem: FileSystem, directoryPath: string): string[] {
  if (!isDirectory(fileSystem, directoryPath)) {
    return [];
  }

  const collected: string[] = [];
  const queue: string[] = [directoryPath];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const entries = fileSystem.readdir(currentDir)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory) {
        queue.push(absolutePath);
      } else if (entry.isFile) {
        collected.push(absolutePath);
      }
    }
  }

  return collected.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function resolveDesignDiffTarget(
  fileSystem: FileSystem,
  workspace: {
    rootDir: string;
    currentDir: string;
  },
  revisions: DesignRevisionDirectory[],
  target: "current" | string | number | undefined,
): {
  kind: "current" | "revision";
  name: string;
  absolutePath: string;
  metadata: DesignRevisionMetadata;
  metadataPath: string;
  revisionIndex?: number;
} {
  if (target === undefined || target === "current") {
    return {
      kind: "current",
      name: "current",
      absolutePath: workspace.currentDir,
      metadata: {
        createdAt: "",
        label: "",
        plannedAt: null,
        migrations: [],
      },
      metadataPath: getDesignRevisionMetadataPath(workspace.rootDir, "current"),
    };
  }

  const byNumericTarget = typeof target === "number"
    ? revisions.find((revision) => revision.index === target)
    : null;
  if (byNumericTarget) {
    return {
      kind: "revision",
      name: byNumericTarget.name,
      absolutePath: byNumericTarget.absolutePath,
      metadata: byNumericTarget.metadata,
      metadataPath: byNumericTarget.metadataPath,
      revisionIndex: byNumericTarget.index,
    };
  }

  if (typeof target === "string") {
    const trimmedTarget = target.trim();
    for (const revision of revisions) {
      if (revision.name.toLowerCase() !== trimmedTarget.toLowerCase()) {
        continue;
      }

      return {
        kind: "revision",
        name: revision.name,
        absolutePath: revision.absolutePath,
        metadata: revision.metadata,
        metadataPath: revision.metadataPath,
        revisionIndex: revision.index,
      };
    }

    const parsedTarget = parseDesignRevisionDirectoryName(trimmedTarget);
    if (parsedTarget) {
      const matchedByIndex = revisions.find((revision) => revision.index === parsedTarget.index);
      if (matchedByIndex) {
        return {
          kind: "revision",
          name: matchedByIndex.name,
          absolutePath: matchedByIndex.absolutePath,
          metadata: matchedByIndex.metadata,
          metadataPath: matchedByIndex.metadataPath,
          revisionIndex: matchedByIndex.index,
        };
      }
    }

    return {
      kind: "revision",
      name: trimmedTarget,
      absolutePath: path.join(workspace.rootDir, trimmedTarget),
      metadata: {
        createdAt: "",
        label: "",
        plannedAt: null,
        migrations: [],
      },
      metadataPath: getDesignRevisionMetadataPath(workspace.rootDir, trimmedTarget),
      revisionIndex: parsedTarget?.index,
    };
  }

  return {
    kind: "current",
    name: "current",
    absolutePath: workspace.currentDir,
    metadata: {
      createdAt: "",
      label: "",
      plannedAt: null,
      migrations: [],
    },
    metadataPath: getDesignRevisionMetadataPath(workspace.rootDir, "current"),
  };
}

function getDesignRevisionMetadataPath(docsDir: string, revisionName: string): string {
  return path.join(docsDir, revisionName + REVISION_METADATA_FILE_SUFFIX);
}

function readRevisionMetadataRecord(fileSystem: FileSystem, metadataPath: string): Record<string, unknown> | null {
  if (!isFile(fileSystem, metadataPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fileSystem.readText(metadataPath));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeTextAtomically(fileSystem: FileSystem, filePath: string, content: string): void {
  const directoryPath = path.dirname(filePath);
  fileSystem.mkdir(directoryPath, { recursive: true });

  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fileSystem.writeText(tempPath, content);

  if (typeof fileSystem.rename === "function") {
    try {
      fileSystem.rename(tempPath, filePath);
      return;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== "EPERM" && errorCode !== "EEXIST") {
        try {
          fileSystem.unlink(tempPath);
        } catch {
          // Ignore cleanup failures while surfacing the original rename error.
        }
        throw error;
      }
    }
  }

  fileSystem.writeText(filePath, content);
  try {
    fileSystem.unlink(tempPath);
  } catch {
    // Ignore temp cleanup failures; target write succeeded.
  }
}

function createDesignRevisionMetadata(
  revisionName: string,
  index: number,
  options?: {
    label?: string;
    plannedAt?: string | null;
    migrations?: readonly string[];
    now?: Date;
  },
): DesignRevisionMetadataRecord {
  const createdAt = (options?.now ?? new Date()).toISOString();
  const label = options?.label?.trim() ?? "";
  const metadata: DesignRevisionMetadataRecord = {
    revision: revisionName,
    index,
    createdAt,
  };

  if (label.length > 0) {
    metadata.label = label;
  }

  if (options?.plannedAt !== undefined) {
    metadata.plannedAt = options.plannedAt;
  }

  if (options?.migrations !== undefined) {
    metadata.migrations = [...options.migrations];
  }

  return metadata;
}

function toTemplateRevisionMetadata(
  metadata: {
    createdAt: string;
    label?: string;
    plannedAt?: string | null;
    migrations?: readonly string[];
  },
): DesignRevisionMetadata {
  return {
    createdAt: metadata.createdAt,
    label: metadata.label ?? "",
    plannedAt: metadata.plannedAt ?? null,
    migrations: metadata.migrations ? [...metadata.migrations] : [],
  };
}

function readDesignRevisionMetadata(
  fileSystem: FileSystem,
  docsDir: string,
  revisionName: string,
  revisionIndex: number,
): DesignRevisionMetadata {
  const metadataPath = getDesignRevisionMetadataPath(docsDir, revisionName);
  const fallbackMetadata: DesignRevisionMetadata = {
    createdAt: "",
    label: "",
    plannedAt: null,
    migrations: [],
  };

  if (!isFile(fileSystem, metadataPath)) {
    return fallbackMetadata;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readText(metadataPath));
  } catch {
    return fallbackMetadata;
  }

  if (!isValidRevisionMetadataRecord(parsed, revisionName, revisionIndex)) {
    return fallbackMetadata;
  }

  return {
    createdAt: parsed.createdAt,
    label: parsed.label ?? "",
    plannedAt: parsed.plannedAt ?? null,
    migrations: parsed.migrations ? [...parsed.migrations] : [],
  };
}

function isValidRevisionMetadataRecord(
  value: unknown,
  expectedRevisionName: string,
  expectedRevisionIndex: number,
): value is DesignRevisionMetadataRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<DesignRevisionMetadataRecord>;
  if (candidate.revision !== expectedRevisionName) {
    return false;
  }
  if (candidate.index !== expectedRevisionIndex) {
    return false;
  }
  if (typeof candidate.createdAt !== "string" || candidate.createdAt.length === 0) {
    return false;
  }
  if (candidate.label !== undefined && typeof candidate.label !== "string") {
    return false;
  }
  if (
    candidate.plannedAt !== undefined
    && candidate.plannedAt !== null
    && typeof candidate.plannedAt !== "string"
  ) {
    return false;
  }
  if (candidate.migrations !== undefined) {
    if (!Array.isArray(candidate.migrations)) {
      return false;
    }

    for (const migration of candidate.migrations) {
      if (typeof migration !== "string") {
        return false;
      }
    }
  }

  return true;
}

function findPreviousRevisionForTarget(
  revisions: DesignRevisionDirectory[],
  target: {
    kind: "current" | "revision";
    revisionIndex?: number;
  },
): DesignRevisionDirectory | null {
  if (target.kind === "current") {
    return findNearestLowerDiscoveredRevision(revisions, Number.POSITIVE_INFINITY);
  }

  if (target.revisionIndex === undefined) {
    return null;
  }

  return findNearestLowerDiscoveredRevision(revisions, target.revisionIndex);
}

function findNearestLowerDiscoveredRevision(
  revisions: DesignRevisionDirectory[],
  targetRevisionIndex: number,
): DesignRevisionDirectory | null {

  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    if (!revision) {
      continue;
    }

    if (revision.index < targetRevisionIndex && revision.index > 0) {
      return revision;
    }
  }

  return null;
}

function computeDirectoryFileDiff(
  fileSystem: FileSystem,
  fromRoot: string,
  toRoot: string,
): {
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  changes: DesignRevisionDiffFileChange[];
} {
  const fromFiles = collectDirectoryFileMap(fileSystem, fromRoot);
  const toFiles = collectDirectoryFileMap(fileSystem, toRoot);
  const allRelativePaths = new Set<string>([...fromFiles.keys(), ...toFiles.keys()]);
  const orderedPaths = [...allRelativePaths].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));

  const changes: DesignRevisionDiffFileChange[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;

  for (const relativePath of orderedPaths) {
    const fromEntry = fromFiles.get(relativePath);
    const toEntry = toFiles.get(relativePath);

    if (!fromEntry && toEntry) {
      addedCount += 1;
      changes.push({
        relativePath,
        kind: "added",
        fromPath: fromRoot,
        toPath: toEntry.absolutePath,
      });
      continue;
    }

    if (fromEntry && !toEntry) {
      removedCount += 1;
      changes.push({
        relativePath,
        kind: "removed",
        fromPath: fromEntry.absolutePath,
        toPath: toRoot,
      });
      continue;
    }

    if (fromEntry && toEntry && fromEntry.content !== toEntry.content) {
      modifiedCount += 1;
      changes.push({
        relativePath,
        kind: "modified",
        fromPath: fromEntry.absolutePath,
        toPath: toEntry.absolutePath,
      });
    }
  }

  return {
    addedCount,
    removedCount,
    modifiedCount,
    changes,
  };
}

function collectDirectoryFileMap(
  fileSystem: FileSystem,
  rootDirectory: string,
): Map<string, { absolutePath: string; content: string }> {
  const collected = new Map<string, { absolutePath: string; content: string }>();
  const queue: string[] = [rootDirectory];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const entries = fileSystem.readdir(currentDir)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, "/");

      if (entry.isDirectory) {
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile) {
        continue;
      }

      collected.set(relativePath, {
        absolutePath,
        content: fileSystem.readText(absolutePath),
      });
    }
  }

  return collected;
}

type UnifiedDiffOperation =
  | { kind: "context"; line: string }
  | { kind: "removed"; line: string }
  | { kind: "added"; line: string };

function formatUnifiedDiffBodyForChange(
  kind: DesignRevisionDiffChangeKind,
  fromContent: string,
  toContent: string,
): string {
  if (kind === "added") {
    return toLineArray(toContent).map((line) => "+" + line).join("\n");
  }

  if (kind === "removed") {
    return toLineArray(fromContent).map((line) => "-" + line).join("\n");
  }

  return buildUnifiedDiffBody(toLineArray(fromContent), toLineArray(toContent), 3);
}

function toLineArray(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function buildUnifiedDiffBody(fromLines: string[], toLines: string[], contextLineCount: number): string {
  const operations = computeUnifiedDiffOperations(fromLines, toLines);
  let hasChanges = false;
  for (const operation of operations) {
    if (operation.kind !== "context") {
      hasChanges = true;
      break;
    }
  }

  if (!hasChanges) {
    return "";
  }

  const oldPrefixCounts = new Array<number>(operations.length + 1).fill(0);
  const newPrefixCounts = new Array<number>(operations.length + 1).fill(0);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    oldPrefixCounts[index + 1] = oldPrefixCounts[index] + (operation?.kind !== "added" ? 1 : 0);
    newPrefixCounts[index + 1] = newPrefixCounts[index] + (operation?.kind !== "removed" ? 1 : 0);
  }

  const lines: string[] = [];
  let index = 0;

  while (index < operations.length) {
    while (index < operations.length && operations[index]?.kind === "context") {
      index += 1;
    }

    if (index >= operations.length) {
      break;
    }

    const hunkStart = Math.max(0, index - contextLineCount);
    let hunkEnd = Math.min(operations.length, index + contextLineCount + 1);

    let scan = index + 1;
    while (scan < operations.length) {
      const operation = operations[scan];
      if (operation?.kind !== "context") {
        if (scan <= hunkEnd + contextLineCount) {
          hunkEnd = Math.min(operations.length, scan + contextLineCount + 1);
        } else {
          break;
        }
      }
      scan += 1;
    }

    const hunkOperations = operations.slice(hunkStart, hunkEnd);
    const oldStart = oldPrefixCounts[hunkStart] + 1;
    const newStart = newPrefixCounts[hunkStart] + 1;

    let oldCount = 0;
    let newCount = 0;
    for (const operation of hunkOperations) {
      if (operation.kind !== "added") {
        oldCount += 1;
      }
      if (operation.kind !== "removed") {
        newCount += 1;
      }
    }

    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of hunkOperations) {
      if (operation.kind === "context") {
        lines.push(" " + operation.line);
      } else if (operation.kind === "removed") {
        lines.push("-" + operation.line);
      } else {
        lines.push("+" + operation.line);
      }
    }

    index = hunkEnd;
  }

  return lines.join("\n");
}

function computeUnifiedDiffOperations(fromLines: string[], toLines: string[]): UnifiedDiffOperation[] {
  const lcsLengths = buildLcsLengthTable(fromLines, toLines);
  const operations: UnifiedDiffOperation[] = [];

  let fromIndex = 0;
  let toIndex = 0;

  while (fromIndex < fromLines.length && toIndex < toLines.length) {
    const fromLine = fromLines[fromIndex];
    const toLine = toLines[toIndex];

    if (fromLine === toLine) {
      operations.push({ kind: "context", line: fromLine ?? "" });
      fromIndex += 1;
      toIndex += 1;
      continue;
    }

    const removeScore = lcsLengths[fromIndex + 1]?.[toIndex] ?? 0;
    const addScore = lcsLengths[fromIndex]?.[toIndex + 1] ?? 0;
    if (removeScore >= addScore) {
      operations.push({ kind: "removed", line: fromLine ?? "" });
      fromIndex += 1;
    } else {
      operations.push({ kind: "added", line: toLine ?? "" });
      toIndex += 1;
    }
  }

  while (fromIndex < fromLines.length) {
    operations.push({ kind: "removed", line: fromLines[fromIndex] ?? "" });
    fromIndex += 1;
  }

  while (toIndex < toLines.length) {
    operations.push({ kind: "added", line: toLines[toIndex] ?? "" });
    toIndex += 1;
  }

  return operations;
}

function buildLcsLengthTable(fromLines: string[], toLines: string[]): number[][] {
  const table = new Array<number[]>(fromLines.length + 1);
  for (let fromIndex = 0; fromIndex <= fromLines.length; fromIndex += 1) {
    table[fromIndex] = new Array<number>(toLines.length + 1).fill(0);
  }

  for (let fromIndex = fromLines.length - 1; fromIndex >= 0; fromIndex -= 1) {
    for (let toIndex = toLines.length - 1; toIndex >= 0; toIndex -= 1) {
      if (fromLines[fromIndex] === toLines[toIndex]) {
        table[fromIndex]![toIndex] = (table[fromIndex + 1]![toIndex + 1] ?? 0) + 1;
      } else {
        table[fromIndex]![toIndex] = Math.max(
          table[fromIndex + 1]![toIndex] ?? 0,
          table[fromIndex]![toIndex + 1] ?? 0,
        );
      }
    }
  }

  return table;
}

function formatDesignDiffSummary(
  fromRevisionName: string,
  targetName: string,
  diff: { addedCount: number; removedCount: number; modifiedCount: number },
): string {
  const totalChanges = diff.addedCount + diff.removedCount + diff.modifiedCount;
  if (totalChanges === 0) {
    return "No design file changes between " + fromRevisionName + " and " + targetName + ".";
  }

  return [
    "Compared " + fromRevisionName + " -> " + targetName + ":",
    String(diff.addedCount) + " added",
    String(diff.modifiedCount) + " modified",
    String(diff.removedCount) + " removed",
  ].join(" ");
}

function computeInitialDirectoryDiff(
  fileSystem: FileSystem,
  targetRoot: string,
): {
  addedCount: number;
  changes: DesignRevisionDiffFileChange[];
} {
  const files = collectDirectoryFileMap(fileSystem, targetRoot);
  const orderedPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  const changes: DesignRevisionDiffFileChange[] = orderedPaths.map((relativePath) => {
    const toEntry = files.get(relativePath)!;
    return {
      relativePath,
      kind: "added",
      fromPath: "",
      toPath: toEntry.absolutePath,
    };
  });

  return {
    addedCount: changes.length,
    changes,
  };
}

function formatInitialDesignDiffSummary(targetName: string, addedCount: number): string {
  return "Compared nothing -> " + targetName + ": "
    + String(addedCount)
    + " added 0 modified 0 removed";
}

function formatDesignWorkspaceContext(
  fileSystem: FileSystem,
  docsCurrentDir: string,
  filePaths: string[],
  primaryFileName: string,
): string {
  const primaryDesignPath = findPrimaryDesignPath(filePaths, primaryFileName);
  const orderedPaths = primaryDesignPath
    ? [primaryDesignPath, ...filePaths.filter((candidate) => candidate !== primaryDesignPath)]
    : filePaths;

  const sections: string[] = [];
  for (const filePath of orderedPaths) {
    const content = fileSystem.readText(filePath);
    const relativePath = path.relative(docsCurrentDir, filePath).replace(/\\/g, "/");

    if (sections.length === 0 && primaryDesignPath === filePath) {
      sections.push(content);
      continue;
    }

    sections.push(["", "---", "", `### ${relativePath}`, "", content].join("\n"));
  }

  return sections.join("\n").trim();
}

function copyDirectoryContents(fileSystem: FileSystem, fromDirectory: string, toDirectory: string): number {
  let copiedFileCount = 0;
  const queue: Array<{ fromDir: string; toDir: string }> = [{ fromDir: fromDirectory, toDir: toDirectory }];

  while (queue.length > 0) {
    const pair = queue.shift();
    if (!pair) {
      continue;
    }

    const entries = fileSystem.readdir(pair.fromDir)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    for (const entry of entries) {
      const sourcePath = path.join(pair.fromDir, entry.name);
      const destinationPath = path.join(pair.toDir, entry.name);

      if (entry.isDirectory) {
        if (fileSystem.exists(destinationPath)) {
          throw new Error(
            "Cannot save design revision: immutable snapshot path already exists ("
            + destinationPath
            + ").",
          );
        }
        fileSystem.mkdir(destinationPath, { recursive: true });
        queue.push({ fromDir: sourcePath, toDir: destinationPath });
        continue;
      }

      if (!entry.isFile) {
        continue;
      }

      if (fileSystem.exists(destinationPath)) {
        throw new Error(
          "Cannot save design revision: immutable snapshot file already exists ("
          + destinationPath
          + ").",
        );
      }

      fileSystem.writeText(destinationPath, fileSystem.readText(sourcePath));
      copiedFileCount += 1;
    }
  }

  return copiedFileCount;
}

function directoryTreesAreEqual(fileSystem: FileSystem, leftRoot: string, rightRoot: string): boolean {
  const leftEntries = collectDirectoryTreeEntries(fileSystem, leftRoot);
  const rightEntries = collectDirectoryTreeEntries(fileSystem, rightRoot);

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    const left = leftEntries[index];
    const right = rightEntries[index];
    if (!left || !right) {
      return false;
    }

    if (left.relativePath !== right.relativePath || left.kind !== right.kind) {
      return false;
    }

    if (left.kind === "file" && left.content !== right.content) {
      return false;
    }
  }

  return true;
}

function collectDirectoryTreeEntries(
  fileSystem: FileSystem,
  rootDirectory: string,
): Array<{ relativePath: string; kind: "directory" | "file"; content?: string }> {
  const collected: Array<{ relativePath: string; kind: "directory" | "file"; content?: string }> = [];
  const queue: string[] = [rootDirectory];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const entries = fileSystem.readdir(currentDir)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, "/");

      if (entry.isDirectory) {
        collected.push({ relativePath, kind: "directory" });
        queue.push(absolutePath);
        continue;
      }

      if (entry.isFile) {
        collected.push({
          relativePath,
          kind: "file",
          content: fileSystem.readText(absolutePath),
        });
      }
    }
  }

  return collected.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: "base" }));
}

function findPrimaryDesignPath(filePaths: string[], primaryFileName: string): string | null {
  for (const filePath of filePaths) {
    if (path.basename(filePath).toLowerCase() === primaryFileName.toLowerCase()) {
      return filePath;
    }
  }

  for (const filePath of filePaths) {
    if (path.basename(filePath).toLowerCase() === LEGACY_PRIMARY_FILE.toLowerCase()) {
      return filePath;
    }
  }

  return null;
}

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
}

function isFile(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isFile === true;
}

function getManagedCurrentWorkspaceCandidates(
  workspaceRoot: string,
  configuredWorkspaceDir: string,
  configuredWorkspacePath?: string,
): Array<{
  currentDir: string;
  relativeCurrentDir: string;
  primaryFileName: string;
}> {
  return [
    {
      currentDir: path.join(configuredWorkspacePath ?? path.join(workspaceRoot, configuredWorkspaceDir), "current"),
      relativeCurrentDir: configuredWorkspaceDir + "/current",
      primaryFileName: CANONICAL_PRIMARY_FILE,
    },
    {
      currentDir: path.join(workspaceRoot, LEGACY_WORKSPACE_DIR, "current"),
      relativeCurrentDir: LEGACY_WORKSPACE_DIR + "/current",
      primaryFileName: LEGACY_PRIMARY_FILE,
    },
  ];
}

function collectManagedSourceReferencesForWorkspace(
  fileSystem: FileSystem,
  workspaceRoot: string,
  workspaceDirectory: string,
  workspacePath?: string,
): string[] {
  const rootDir = workspacePath ?? path.join(workspaceRoot, workspaceDirectory);
  const currentDir = path.join(rootDir, "current");
  const sourceReferences: string[] = [];

  if (isDirectory(fileSystem, currentDir)) {
    sourceReferences.push(currentDir);
  }

  if (!isDirectory(fileSystem, rootDir)) {
    return sourceReferences;
  }

  const revisions = fileSystem.readdir(rootDir)
    .filter((entry) => entry.isDirectory && parseDesignRevisionDirectoryName(entry.name) !== null)
    .map((entry) => ({
      name: entry.name,
      absolutePath: path.join(rootDir, entry.name),
      parsed: parseDesignRevisionDirectoryName(entry.name),
    }))
    .sort((left, right) => {
      const leftIndex = left.parsed?.index ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.parsed?.index ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  for (const revision of revisions) {
    sourceReferences.push(revision.absolutePath);
  }

  return sourceReferences;
}

function resolveDesignWorkspaceForRevisions(
  fileSystem: FileSystem,
  workspaceRoot: string,
  invocationRoot?: string,
): {
  rootDir: string;
  currentDir: string;
  relativeRootDir: string;
  relativeCurrentDir: string;
} {
  const configuredWorkspace = resolveConfiguredDesignWorkspace(fileSystem, workspaceRoot, invocationRoot);
  const canonicalRootDir = configuredWorkspace.workspacePath;
  const canonicalCurrentDir = path.join(canonicalRootDir, "current");
  if (isDirectory(fileSystem, canonicalCurrentDir)) {
    return {
      rootDir: canonicalRootDir,
      currentDir: canonicalCurrentDir,
      relativeRootDir: configuredWorkspace.workspaceDir,
      relativeCurrentDir: configuredWorkspace.workspaceDir + "/current",
    };
  }

  const legacyRootDir = path.join(workspaceRoot, LEGACY_WORKSPACE_DIR);
  const legacyCurrentDir = path.join(legacyRootDir, "current");
  if (isDirectory(fileSystem, legacyCurrentDir)) {
    return {
      rootDir: legacyRootDir,
      currentDir: legacyCurrentDir,
      relativeRootDir: LEGACY_WORKSPACE_DIR,
      relativeCurrentDir: LEGACY_WORKSPACE_DIR + "/current",
    };
  }

  if (isDirectory(fileSystem, canonicalRootDir)) {
    return {
      rootDir: canonicalRootDir,
      currentDir: canonicalCurrentDir,
      relativeRootDir: configuredWorkspace.workspaceDir,
      relativeCurrentDir: configuredWorkspace.workspaceDir + "/current",
    };
  }

  if (isDirectory(fileSystem, legacyRootDir)) {
    return {
      rootDir: legacyRootDir,
      currentDir: legacyCurrentDir,
      relativeRootDir: LEGACY_WORKSPACE_DIR,
      relativeCurrentDir: LEGACY_WORKSPACE_DIR + "/current",
    };
  }

  return {
    rootDir: canonicalRootDir,
    currentDir: path.join(canonicalRootDir, "current"),
    relativeRootDir: configuredWorkspace.workspaceDir,
    relativeCurrentDir: configuredWorkspace.workspaceDir + "/current",
  };
}

function getConfiguredDesignWorkspaceDir(fileSystem: FileSystem, workspaceRoot: string): string {
  return resolvePredictionWorkspaceDirectories({
    fileSystem,
    workspaceRoot,
  }).design;
}

function resolveConfiguredDesignWorkspace(
  fileSystem: FileSystem,
  workspaceRoot: string,
  invocationRoot?: string,
): {
  workspaceDir: string;
  workspacePath: string;
} {
  const workspaceDir = getConfiguredDesignWorkspaceDir(fileSystem, workspaceRoot);
  const placement = resolvePredictionWorkspacePlacement({
    fileSystem,
    workspaceRoot,
  });
  const workspacePath = path.join(
    placement.design === "workdir" ? (invocationRoot ?? workspaceRoot) : workspaceRoot,
    workspaceDir,
  );

  return {
    workspaceDir,
    workspacePath,
  };
}
