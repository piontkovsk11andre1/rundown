import path from "node:path";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { resolveWorkspaceLink } from "../domain/workspace-link.js";
import { saveDesignRevisionSnapshot } from "./design-context.js";

type DocsAction = "publish";

export interface DocsTaskOptions {
  action?: DocsAction;
  dir?: string;
  label?: string;
}

export interface DocsTaskDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
}

export function createDocsTask(
  dependencies: DocsTaskDependencies,
): (options: DocsTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function docsTask(options: DocsTaskOptions): Promise<number> {
    const action = options.action ?? "publish";
    if (action !== "publish") {
      throw new Error("Invalid docs action: " + action + ". Allowed: publish.");
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
      emit({
        kind: "info",
        message:
          "No design changes detected in docs/current/ since "
          + saveResult.latestRevision.name
          + "; skipped creating a new revision snapshot.",
      });
      return EXIT_CODE_SUCCESS;
    }

    const savedRevision = saveResult.revision;
    emit({
      kind: "success",
      message:
        "Saved design revision "
        + savedRevision.name
        + " from docs/current/ to "
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
          "Saved empty design revision from docs/current/. "
          + "Add docs/current/Design.md (and supporting docs) for richer migrate/test context.",
      });
    }

    return EXIT_CODE_SUCCESS;
  };
}

function ensureManagedDesignWorkspaceForRevisionCommands(
  fileSystem: FileSystem,
  projectRoot: string,
  emit: ApplicationOutputPort["emit"],
): { ok: true } | { ok: false; message: string } {
  const docsCurrentDir = path.join(projectRoot, "docs", "current");
  if (isDirectory(fileSystem, docsCurrentDir)) {
    return { ok: true };
  }

  const legacyDesignPath = path.join(projectRoot, "Design.md");
  if (isFile(fileSystem, legacyDesignPath)) {
    fileSystem.mkdir(docsCurrentDir, { recursive: true });
    const bootstrappedDesignPath = path.join(docsCurrentDir, "Design.md");
    if (!isFile(fileSystem, bootstrappedDesignPath)) {
      fileSystem.writeText(bootstrappedDesignPath, fileSystem.readText(legacyDesignPath));
    }

    emit({
      kind: "info",
      message:
        "Bootstrapped docs/current/ from legacy Design.md to initialize revision workflow.",
    });
    return { ok: true };
  }

  return {
    ok: false,
    message:
      "Design working directory is missing: "
      + docsCurrentDir
      + ". Create docs/current/ (or run `rundown start ...`) before using revision commands.",
  };
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
