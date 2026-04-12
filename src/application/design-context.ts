import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

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

export interface DesignRevisionMetadata {
  createdAt: string;
  label: string;
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
}

const REVISION_DIRECTORY_PATTERN = /^rev\.(\d+)$/i;
const REVISION_METADATA_FILE_SUFFIX = ".meta.json";

export function resolveDesignContext(fileSystem: FileSystem, projectRoot: string): DesignContextResolution {
  const docsCurrentDir = path.join(projectRoot, "docs", "current");
  const hasManagedCurrentDraft = isDirectory(fileSystem, docsCurrentDir);
  const docsCurrentFiles = collectDesignFiles(fileSystem, docsCurrentDir);

  if (docsCurrentFiles.length > 0) {
    return {
      design: formatDesignWorkspaceContext(fileSystem, docsCurrentDir, docsCurrentFiles),
      sourcePaths: docsCurrentFiles,
      isLowContext: false,
      lowContextGuidance: "",
    };
  }

  if (hasManagedCurrentDraft) {
    return {
      design: "",
      sourcePaths: [docsCurrentDir],
      isLowContext: true,
      lowContextGuidance:
        "Design draft is empty: docs/current/ has no files. "
        + "Add docs/current/Design.md (and supporting docs) for richer migrate/test context.",
    };
  }

  const legacyDesignPath = path.join(projectRoot, "Design.md");
  if (!isFile(fileSystem, legacyDesignPath)) {
    return {
      design: "",
      sourcePaths: [],
      isLowContext: true,
      lowContextGuidance:
        "No design context found. Add docs/current/Design.md (preferred) "
        + "or root Design.md (legacy fallback) for richer migrate/test context.",
    };
  }

  return {
    design: fileSystem.readText(legacyDesignPath),
    sourcePaths: [legacyDesignPath],
    isLowContext: false,
    lowContextGuidance: "",
  };
}

export function resolveDesignContextSourceReferences(
  fileSystem: FileSystem,
  projectRoot: string,
): DesignContextSourceReferencesResolution {
  const docsCurrentDir = path.join(projectRoot, "docs", "current");
  const revisions = discoverDesignRevisionDirectories(fileSystem, projectRoot);
  const sourceReferences: string[] = [];

  if (isDirectory(fileSystem, docsCurrentDir)) {
    sourceReferences.push(docsCurrentDir);
  }

  for (const revision of revisions) {
    sourceReferences.push(revision.absolutePath);
  }

  if (sourceReferences.length > 0) {
    return {
      sourceReferences,
      hasManagedDocs: true,
    };
  }

  const legacyDesignPath = path.join(projectRoot, "Design.md");
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
  projectRoot: string,
): DesignRevisionDirectory[] {
  const docsDir = path.join(projectRoot, "docs");
  if (!isDirectory(fileSystem, docsDir)) {
    return [];
  }

  const revisions: DesignRevisionDirectory[] = [];
  const entries = fileSystem.readdir(docsDir)
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
      absolutePath: path.join(docsDir, entry.name),
      metadata: readDesignRevisionMetadata(fileSystem, docsDir, entry.name, parsed.index),
      metadataPath: getDesignRevisionMetadataPath(docsDir, entry.name),
    });
  }

  return revisions.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
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
  if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 1) {
    return null;
  }

  return { index: parsedIndex };
}

export function saveDesignRevisionSnapshot(
  fileSystem: FileSystem,
  projectRoot: string,
  options?: {
    label?: string;
    now?: Date;
  },
): SaveDesignRevisionSnapshotResult {
  const docsDir = path.join(projectRoot, "docs");
  const docsCurrentDir = path.join(docsDir, "current");

  if (!isDirectory(fileSystem, docsCurrentDir)) {
    throw new Error(
      "Design working directory is missing: "
      + docsCurrentDir
      + ". Create docs/current/ first (or run `rundown start ...`).",
    );
  }

  const revisions = discoverDesignRevisionDirectories(fileSystem, projectRoot);
  let nextIndex = 1;
  for (const revision of revisions) {
    if (revision.index >= nextIndex) {
      nextIndex = revision.index + 1;
    }
  }

  const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  if (latestRevision && directoryTreesAreEqual(fileSystem, docsCurrentDir, latestRevision.absolutePath)) {
    return {
      kind: "unchanged",
      sourcePath: docsCurrentDir,
      latestRevision,
    };
  }

  const revisionName = `rev.${nextIndex}`;
  const revisionDir = path.join(docsDir, revisionName);
  if (fileSystem.exists(revisionDir)) {
    throw new Error("Design revision directory already exists: " + revisionDir);
  }

  fileSystem.mkdir(revisionDir, { recursive: true });
  const copiedFileCount = copyDirectoryContents(fileSystem, docsCurrentDir, revisionDir);
  const metadataPath = getDesignRevisionMetadataPath(docsDir, revisionName);
  const metadata = createDesignRevisionMetadata(revisionName, nextIndex, options);
  fileSystem.writeText(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

  return {
    kind: "saved",
    revision: {
      index: nextIndex,
      name: revisionName,
      absolutePath: revisionDir,
      sourcePath: docsCurrentDir,
      copiedFileCount,
      metadata: toTemplateRevisionMetadata(metadata),
      metadataPath,
    },
  };
}

export function prepareDesignRevisionDiffContext(
  fileSystem: FileSystem,
  projectRoot: string,
  options?: {
    target?: "current" | string | number;
  },
): DesignRevisionDiffContext {
  const docsDir = path.join(projectRoot, "docs");
  const docsCurrentDir = path.join(docsDir, "current");
  const revisions = discoverDesignRevisionDirectories(fileSystem, projectRoot);

  const target = resolveDesignDiffTarget(fileSystem, docsCurrentDir, revisions, options?.target);
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
    return {
      fromRevision: null,
      toTarget: target,
      hasComparison: false,
      summary: "No previous design revision found; cannot compute a revision diff yet.",
      addedCount: 0,
      removedCount: 0,
      modifiedCount: 0,
      changes: [],
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
  docsCurrentDir: string,
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
    const docsDir = path.dirname(docsCurrentDir);
    return {
      kind: "current",
      name: "current",
      absolutePath: docsCurrentDir,
      metadata: {
        createdAt: "",
        label: "",
      },
      metadataPath: getDesignRevisionMetadataPath(docsDir, "current"),
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

    const docsDir = path.dirname(docsCurrentDir);
    return {
      kind: "revision",
      name: trimmedTarget,
      absolutePath: path.join(docsDir, trimmedTarget),
      metadata: {
        createdAt: "",
        label: "",
      },
      metadataPath: getDesignRevisionMetadataPath(docsDir, trimmedTarget),
      revisionIndex: parsedTarget?.index,
    };
  }

  const docsDir = path.dirname(docsCurrentDir);
  return {
    kind: "current",
    name: "current",
    absolutePath: docsCurrentDir,
    metadata: {
      createdAt: "",
      label: "",
    },
    metadataPath: getDesignRevisionMetadataPath(docsDir, "current"),
  };
}

function getDesignRevisionMetadataPath(docsDir: string, revisionName: string): string {
  return path.join(docsDir, revisionName + REVISION_METADATA_FILE_SUFFIX);
}

function createDesignRevisionMetadata(
  revisionName: string,
  index: number,
  options?: {
    label?: string;
    now?: Date;
  },
): DesignRevisionMetadataRecord {
  const createdAt = (options?.now ?? new Date()).toISOString();
  const label = options?.label?.trim() ?? "";

  if (label.length > 0) {
    return {
      revision: revisionName,
      index,
      createdAt,
      label,
    };
  }

  return {
    revision: revisionName,
    index,
    createdAt,
  };
}

function toTemplateRevisionMetadata(metadata: { createdAt: string; label?: string }): DesignRevisionMetadata {
  return {
    createdAt: metadata.createdAt,
    label: metadata.label ?? "",
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
    return revisions.length > 0 ? revisions[revisions.length - 1] ?? null : null;
  }

  if (target.revisionIndex === undefined) {
    return null;
  }

  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    if (!revision) {
      continue;
    }

    if (revision.index < target.revisionIndex) {
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

function formatDesignWorkspaceContext(fileSystem: FileSystem, docsCurrentDir: string, filePaths: string[]): string {
  const primaryDesignPath = findPrimaryDesignPath(filePaths);
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
        fileSystem.mkdir(destinationPath, { recursive: true });
        queue.push({ fromDir: sourcePath, toDir: destinationPath });
        continue;
      }

      if (!entry.isFile) {
        continue;
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

function findPrimaryDesignPath(filePaths: string[]): string | null {
  for (const filePath of filePaths) {
    if (path.basename(filePath).toLowerCase() === "design.md") {
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
