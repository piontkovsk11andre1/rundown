import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

export interface DesignContextResolution {
  design: string;
  sourcePaths: string[];
}

export interface DesignRevisionDirectory {
  index: number;
  name: string;
  absolutePath: string;
}

export interface SavedDesignRevision {
  index: number;
  name: string;
  absolutePath: string;
  sourcePath: string;
  copiedFileCount: number;
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

export function resolveDesignContext(fileSystem: FileSystem, projectRoot: string): DesignContextResolution {
  const docsCurrentDir = path.join(projectRoot, "docs", "current");
  const docsCurrentFiles = collectDesignFiles(fileSystem, docsCurrentDir);

  if (docsCurrentFiles.length > 0) {
    return {
      design: formatDesignWorkspaceContext(fileSystem, docsCurrentDir, docsCurrentFiles),
      sourcePaths: docsCurrentFiles,
    };
  }

  const legacyDesignPath = path.join(projectRoot, "Design.md");
  if (!isFile(fileSystem, legacyDesignPath)) {
    return {
      design: "",
      sourcePaths: [],
    };
  }

  return {
    design: fileSystem.readText(legacyDesignPath),
    sourcePaths: [legacyDesignPath],
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
  const match = /^rev\.(\d+)$/i.exec(name.trim());
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

  return {
    kind: "saved",
    revision: {
      index: nextIndex,
      name: revisionName,
      absolutePath: revisionDir,
      sourcePath: docsCurrentDir,
      copiedFileCount,
    },
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
