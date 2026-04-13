import path from "node:path";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { resolveWorkspaceLink } from "../domain/workspace-link.js";
import {
  prepareDesignRevisionDiffContext,
  saveDesignRevisionSnapshot,
} from "./design-context.js";

type DocsRevisionAction = "publish" | "diff";
type DocsRevisionDiffTarget = "current" | "preview";

const CANONICAL_WORKSPACE_DIR = "design";
const LEGACY_WORKSPACE_DIR = "docs";
const CANONICAL_PRIMARY_FILE = "Target.md";
const LEGACY_PRIMARY_FILE = "Design.md";

export interface DocsRevisionTaskOptions {
  action?: DocsRevisionAction;
  dir?: string;
  label?: string;
  target?: DocsRevisionDiffTarget;
}

export interface DocsRevisionTaskDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
}

export function createDocsRevisionTask(
  dependencies: DocsRevisionTaskDependencies,
): (options: DocsRevisionTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function docsRevisionTask(options: DocsRevisionTaskOptions): Promise<number> {
    const action = options.action ?? "publish";
    if (action !== "publish" && action !== "diff") {
      throw new Error("Invalid docs action: " + action + ". Allowed: publish, diff.");
    }

    const invocationDir = process.cwd();
    const workspaceRoot = resolveWorkspaceRootFromCurrentDir(dependencies.fileSystem, invocationDir);
    const migrationsDir = path.resolve(workspaceRoot, options.dir ?? "migrations");

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      emit({ kind: "error", message: "Migrations directory does not exist: " + migrationsDir });
      return EXIT_CODE_FAILURE;
    }

    const projectRoot = path.dirname(migrationsDir);
    const workspaceReady = ensureManagedDesignWorkspaceForRevisionCommands(
      dependencies.fileSystem,
      projectRoot,
      emit,
    );
    if (!workspaceReady.ok) {
      emit({ kind: "error", message: workspaceReady.message });
      return EXIT_CODE_FAILURE;
    }

    if (action === "diff") {
      const target = options.target ?? "current";
      if (target !== "current" && target !== "preview") {
        throw new Error("Invalid docs diff target: " + target + ". Allowed: current, preview.");
      }

      emitDesignRevisionDiffPreview({
        fileSystem: dependencies.fileSystem,
        projectRoot,
        emit,
        includeSourceReferences: target === "preview",
      });
      return EXIT_CODE_SUCCESS;
    }

    let saveResult;
    try {
      saveResult = saveDesignRevisionSnapshot(dependencies.fileSystem, projectRoot, {
        label: options.label,
      });
    } catch (error) {
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return EXIT_CODE_FAILURE;
    }

    if (saveResult.kind === "unchanged") {
      const relativeSourcePath = formatRelativeWorkspacePath(projectRoot, saveResult.sourcePath);
      emit({
        kind: "info",
        message:
          "No design changes detected in "
          + relativeSourcePath
          + " since "
          + saveResult.latestRevision.name
          + "; skipped creating a new revision snapshot.",
      });
      return EXIT_CODE_SUCCESS;
    }

    const savedRevision = saveResult.revision;
    const relativeSourcePath = formatRelativeWorkspacePath(projectRoot, savedRevision.sourcePath);
    emit({
      kind: "success",
      message:
        "Saved design revision "
        + savedRevision.name
        + " from "
        + relativeSourcePath
        + " to "
        + savedRevision.absolutePath
        + (savedRevision.metadata.label.length > 0 ? " [label: " + savedRevision.metadata.label + "]" : "")
        + " ("
        + String(savedRevision.copiedFileCount)
        + " file"
        + (savedRevision.copiedFileCount === 1 ? "" : "s")
        + ").",
    });
    if (savedRevision.copiedFileCount === 0) {
      emit({
        kind: "warn",
        message:
          "Saved empty design revision from "
          + relativeSourcePath
          + ". Add "
          + relativeSourcePath
          + "/"
          + (relativeSourcePath === LEGACY_WORKSPACE_DIR + "/current" ? LEGACY_PRIMARY_FILE : CANONICAL_PRIMARY_FILE)
          + " (and supporting docs) for richer migrate/test context.",
      });
    }

    return EXIT_CODE_SUCCESS;
  };
}

function emitDesignRevisionDiffPreview(input: {
  fileSystem: FileSystem;
  projectRoot: string;
  emit: ApplicationOutputPort["emit"];
  includeSourceReferences: boolean;
}): void {
  const { fileSystem, projectRoot, emit, includeSourceReferences } = input;
  const diff = prepareDesignRevisionDiffContext(fileSystem, projectRoot, { target: "current" });

  emit({
    kind: "info",
    message: includeSourceReferences ? "Design revision diff preview:" : "Design revision diff:",
  });
  emit({ kind: "info", message: diff.summary });

  if (includeSourceReferences) {
    const sourceReferenceLines = diff.sourceReferences.length > 0
      ? diff.sourceReferences.map((sourcePath) => `- ${sourcePath}`).join("\n") + "\n"
      : "- (none)\n";
    emit({ kind: "text", text: "Sources:\n" + sourceReferenceLines });
  }

  if (diff.changes.length === 0) {
    emit({ kind: "info", message: "No file-level design changes detected." });
    return;
  }

  const changeLines = diff.changes
    .map((change) => `- ${change.kind}: ${change.relativePath}`)
    .join("\n");
  emit({ kind: "text", text: "Changes:\n" + changeLines + "\n" });
}

function ensureManagedDesignWorkspaceForRevisionCommands(
  fileSystem: FileSystem,
  projectRoot: string,
  emit: ApplicationOutputPort["emit"],
): { ok: true } | { ok: false; message: string } {
  const canonicalCurrentDir = path.join(projectRoot, CANONICAL_WORKSPACE_DIR, "current");
  if (isDirectory(fileSystem, canonicalCurrentDir)) {
    return { ok: true };
  }

  const legacyCurrentDir = path.join(projectRoot, LEGACY_WORKSPACE_DIR, "current");
  if (isDirectory(fileSystem, legacyCurrentDir)) {
    return { ok: true };
  }

  const canonicalRootDir = path.join(projectRoot, CANONICAL_WORKSPACE_DIR);
  const legacyRootDir = path.join(projectRoot, LEGACY_WORKSPACE_DIR);
  const bootstrapTarget = isDirectory(fileSystem, canonicalRootDir)
    ? {
      currentDir: canonicalCurrentDir,
      primaryFile: CANONICAL_PRIMARY_FILE,
      label: CANONICAL_WORKSPACE_DIR + "/current/" + CANONICAL_PRIMARY_FILE,
    }
    : isDirectory(fileSystem, legacyRootDir)
      ? {
        currentDir: legacyCurrentDir,
        primaryFile: LEGACY_PRIMARY_FILE,
        label: LEGACY_WORKSPACE_DIR + "/current/" + LEGACY_PRIMARY_FILE,
      }
      : {
        currentDir: canonicalCurrentDir,
        primaryFile: CANONICAL_PRIMARY_FILE,
        label: CANONICAL_WORKSPACE_DIR + "/current/" + CANONICAL_PRIMARY_FILE,
      };

  const legacyDesignPath = path.join(projectRoot, LEGACY_PRIMARY_FILE);
  if (isFile(fileSystem, legacyDesignPath)) {
    fileSystem.mkdir(bootstrapTarget.currentDir, { recursive: true });
    const bootstrappedDesignPath = path.join(bootstrapTarget.currentDir, bootstrapTarget.primaryFile);
    if (!isFile(fileSystem, bootstrappedDesignPath)) {
      fileSystem.writeText(bootstrappedDesignPath, fileSystem.readText(legacyDesignPath));
    }

    emit({
      kind: "info",
      message:
        bootstrapTarget.currentDir === legacyCurrentDir
          ? "Bootstrapped docs/current/ from legacy Design.md to initialize revision workflow."
          : "Bootstrapped design/current/Target.md from legacy Design.md to initialize revision workflow.",
    });
    return { ok: true };
  }

  return {
    ok: false,
    message:
      "Design working directory is missing: "
      + canonicalCurrentDir
      + ". Create design/current/Target.md (preferred), or use legacy docs/current/Design.md, before using revision commands.",
  };
}

function formatRelativeWorkspacePath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath).replace(/\\/g, "/");
  return relative.length > 0 ? relative : ".";
}

function resolveWorkspaceRootFromCurrentDir(fileSystem: FileSystem, currentDir: string): string {
  const resolution = resolveWorkspaceLink({
    currentDir,
    fileSystem,
    pathOperations: path,
  });

  return resolution.status === "resolved"
    ? resolution.workspaceRoot
    : path.resolve(currentDir);
}

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
}

function isFile(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isFile === true;
}
