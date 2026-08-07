import path from "node:path";
import { EXIT_CODE_FAILURE, EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { InteractiveInputPort } from "../domain/ports/interactive-input-port.js";
import type { PathOperationsPort } from "../domain/ports/path-operations-port.js";
import type { WorkingDirectoryPort } from "../domain/ports/working-directory-port.js";
import {
  parseWorkspaceLinkSchema,
  serializeWorkspaceLinkSchema,
  type CanonicalWorkspaceLinkRecord,
} from "../domain/workspace-link.js";

export interface WorkspaceUnlinkOptions {
  workspace?: string;
  all: boolean;
  dryRun: boolean;
}

export interface WorkspaceRemoveOptions {
  workspace?: string;
  all: boolean;
  deleteFiles: boolean;
  dryRun: boolean;
  force: boolean;
}

interface WorkspaceLifecycleDependencies {
  output: ApplicationOutputPort;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  workingDirectory: WorkingDirectoryPort;
  interactiveInput?: InteractiveInputPort;
}

type WorkspaceRecordHealth = "ok" | "target-missing" | "target-not-directory";

interface WorkspaceRecordStatus {
  record: CanonicalWorkspaceLinkRecord;
  absolutePath: string;
  health: WorkspaceRecordHealth;
}

interface WorkspaceCleanupOutcome {
  targetPath: string;
  status: "deleted" | "missing" | "failed";
  errorMessage?: string;
}

export function createWorkspaceUnlinkTask(
  dependencies: WorkspaceLifecycleDependencies,
): (options: WorkspaceUnlinkOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async (options: WorkspaceUnlinkOptions): Promise<number> => {
    if (options.all && typeof options.workspace === "string") {
      emit({
        kind: "error",
        message: "Cannot combine --workspace with --all for workspace unlink.",
      });
      return EXIT_CODE_FAILURE;
    }

    const invocationDir = dependencies.pathOperations.resolve(dependencies.workingDirectory.cwd());
    const workspaceLinkPath = dependencies.pathOperations.join(invocationDir, ".rundown", "workspace.link");
    const workspaceLinkStats = dependencies.fileSystem.stat(workspaceLinkPath);
    if (workspaceLinkStats === null || !workspaceLinkStats.isFile) {
      emit({
        kind: "info",
        message: `No workspace.link found in invocation directory: ${invocationDir}`,
      });
      return EXIT_CODE_NO_WORK;
    }

    const parsedSchema = parseWorkspaceLinkSchema(dependencies.fileSystem.readText(workspaceLinkPath));
    if (parsedSchema.status !== "ok") {
      emit({
        kind: "error",
        message: `workspace.link is invalid: ${workspaceLinkPath}. ${parsedSchema.message}`,
      });
      return EXIT_CODE_FAILURE;
    }

    const recordStatuses = mapWorkspaceRecordStatuses({
      invocationDir,
      records: parsedSchema.schema.records,
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
    });

    const selectedRecords = resolveRecordsToOperate({
      invocationDir,
      workspaceLinkPath,
      records: parsedSchema.schema.records,
      recordStatuses,
      workspaceOption: options.workspace,
      all: options.all,
      commandName: "workspace unlink",
    });
    if (selectedRecords.status === "error") {
      emit({ kind: "error", message: selectedRecords.message });
      return EXIT_CODE_FAILURE;
    }

    const selectedRecordIds = new Set(selectedRecords.records.map((record) => record.id));
    const remainingRecords = parsedSchema.schema.records.filter((record) => !selectedRecordIds.has(record.id));

    emit({ kind: "text", text: `Invocation directory: ${invocationDir}` });
    emit({ kind: "text", text: `Workspace link file: ${workspaceLinkPath}` });
    emit({ kind: "text", text: "Selected workspace record(s):" });
    for (const record of selectedRecords.records) {
      const status = recordStatuses.get(record.id);
      emit({
        kind: "text",
        text: `  - ${formatWorkspaceRecordSelectionText(record, status)}`,
      });
    }

    const selectedStaleStatuses = selectedRecords.records
      .map((record) => recordStatuses.get(record.id))
      .filter((recordStatus): recordStatus is WorkspaceRecordStatus => {
        return recordStatus !== undefined && recordStatus.health !== "ok";
      });
    emitStaleWorkspaceRecordWarnings({
      emit,
      commandName: "workspace unlink",
      selectedStaleStatuses,
    });

    if (options.dryRun) {
      emit({
        kind: "info",
        message: `Dry run: ${selectedRecords.records.length} workspace record(s) would be unlinked (metadata only).`,
      });
      emit({ kind: "text", text: "Dry-run metadata impact:" });
      emit({ kind: "text", text: "  - Records to unlink:" });
      for (const record of selectedRecords.records) {
        const status = recordStatuses.get(record.id);
        emit({
          kind: "text",
          text: `    - ${formatWorkspaceRecordSelectionText(record, status)}`,
        });
      }
      emit({
        kind: "text",
        text: remainingRecords.length === 0
          ? `  - workspace.link: remove ${workspaceLinkPath}`
          : `  - workspace.link: rewrite ${workspaceLinkPath} with ${remainingRecords.length} remaining record(s)`,
      });
      emit({ kind: "text", text: "  - File/directory deletions: none (unlink is metadata-only)" });
      emit({
        kind: "info",
        message: "Linked workspace files/directories are not deleted by workspace unlink.",
      });
      return EXIT_CODE_SUCCESS;
    }

    if (remainingRecords.length === 0) {
      try {
        dependencies.fileSystem.rm(workspaceLinkPath, { force: true });
      } catch (error: unknown) {
        emit({
          kind: "error",
          message: buildFileOperationErrorMessage({
            action: "remove workspace.link metadata file",
            targetPath: workspaceLinkPath,
            error,
          }),
        });
        return EXIT_CODE_FAILURE;
      }
      emit({
        kind: "success",
        message: `Unlinked ${selectedRecords.records.length} workspace record(s) and removed empty workspace.link metadata file.`,
      });
      emit({
        kind: "info",
        message: "Linked workspace files/directories were preserved.",
      });
      return EXIT_CODE_SUCCESS;
    }

    const remainingRecordIds = new Set(remainingRecords.map((record) => record.id));
    const nextDefaultRecordId = parsedSchema.schema.defaultRecordId !== undefined
      && remainingRecordIds.has(parsedSchema.schema.defaultRecordId)
      ? parsedSchema.schema.defaultRecordId
      : undefined;
    const serialized = serializeWorkspaceLinkSchema({
      sourceFormat: "multi-record-v1",
      records: remainingRecords.map((record) => ({
        id: record.id,
        workspacePath: record.workspacePath,
        isDefault: nextDefaultRecordId !== undefined && record.id === nextDefaultRecordId,
      })),
      defaultRecordId: nextDefaultRecordId,
    });
    try {
      dependencies.fileSystem.writeText(workspaceLinkPath, serialized);
    } catch (error: unknown) {
      emit({
        kind: "error",
        message: buildFileOperationErrorMessage({
          action: "rewrite workspace.link metadata file",
          targetPath: workspaceLinkPath,
          error,
        }),
      });
      return EXIT_CODE_FAILURE;
    }

    emit({
      kind: "success",
      message: `Unlinked ${selectedRecords.records.length} workspace record(s). ${remainingRecords.length} record(s) remain in workspace.link.`,
    });
    emit({
      kind: "info",
      message: "Linked workspace files/directories were preserved.",
    });
    return EXIT_CODE_SUCCESS;
  };
}

function resolveRecordsToOperate(input: {
  invocationDir: string;
  workspaceLinkPath: string;
  records: CanonicalWorkspaceLinkRecord[];
  recordStatuses: Map<string, WorkspaceRecordStatus>;
  workspaceOption?: string;
  all: boolean;
  commandName: string;
}):
  | { status: "ok"; records: CanonicalWorkspaceLinkRecord[] }
  | { status: "error"; message: string } {
  if (input.all) {
    return {
      status: "ok",
      records: input.records,
    };
  }

  const workspaceOption = normalizeOptionalString(input.workspaceOption);
  if (workspaceOption !== undefined) {
    const selectedRecord = pickWorkspaceRecordDeterministically({
      invocationDir: input.invocationDir,
      records: input.records,
      workspaceOption,
    });
    if (!selectedRecord) {
      return {
        status: "error",
        message: buildMissingSelectorMessage({
          invocationDir: input.invocationDir,
          workspaceLinkPath: input.workspaceLinkPath,
          workspaceOption,
          records: input.records,
          recordStatuses: input.recordStatuses,
        }),
      };
    }

    return {
      status: "ok",
      records: [selectedRecord],
    };
  }

  if (input.records.length > 1) {
    return {
      status: "error",
      message: buildAmbiguousSelectionMessage({
        invocationDir: input.invocationDir,
        workspaceLinkPath: input.workspaceLinkPath,
        records: input.records,
        recordStatuses: input.recordStatuses,
        commandName: input.commandName,
      }),
    };
  }

  return {
    status: "ok",
    records: input.records,
  };
}

function pickWorkspaceRecordDeterministically(input: {
  invocationDir: string;
  records: CanonicalWorkspaceLinkRecord[];
  workspaceOption: string;
}): CanonicalWorkspaceLinkRecord | undefined {
  const recordById = input.records.find((record) => record.id === input.workspaceOption);
  if (recordById) {
    return recordById;
  }

  const selectedWorkspacePath = path.resolve(input.invocationDir, input.workspaceOption);
  return input.records.find((record) => path.resolve(input.invocationDir, record.workspacePath) === selectedWorkspacePath);
}

function buildAmbiguousSelectionMessage(input: {
  invocationDir: string;
  workspaceLinkPath: string;
  records: CanonicalWorkspaceLinkRecord[];
  recordStatuses: Map<string, WorkspaceRecordStatus>;
  commandName: string;
}): string {
  const staleCount = input.records.filter((record) => {
    const status = input.recordStatuses.get(record.id);
    return status !== undefined && status.health !== "ok";
  }).length;

  const staleGuidance = staleCount > 0
    ? [
      `Detected ${staleCount} stale/orphan workspace record(s) among candidates.`,
      "Use --workspace <dir|id> (or --all) with workspace unlink/remove to clean stale metadata records safely.",
    ]
    : [];

  return [
    `${input.commandName} selection is ambiguous for ${input.invocationDir}.`,
    `Multiple workspace records are configured in ${input.workspaceLinkPath}.`,
    "Re-run with --workspace <dir|id> to select a specific record, or use --all to target every record.",
    ...staleGuidance,
    "Candidates:",
    ...input.records.map((record) => {
      const status = input.recordStatuses.get(record.id);
      return `- ${formatWorkspaceRecordSelectionText(record, status)} (use --workspace ${record.workspacePath})`;
    }),
  ].join("\n");
}

function buildMissingSelectorMessage(input: {
  invocationDir: string;
  workspaceLinkPath: string;
  workspaceOption: string;
  records: CanonicalWorkspaceLinkRecord[];
  recordStatuses: Map<string, WorkspaceRecordStatus>;
}): string {
  const staleCount = input.records.filter((record) => {
    const status = input.recordStatuses.get(record.id);
    return status !== undefined && status.health !== "ok";
  }).length;

  const staleGuidance = staleCount > 0
    ? [
      `Detected ${staleCount} stale/orphan workspace record(s) among candidates.`,
      "Use --workspace <dir|id> (or --all) with workspace unlink/remove to clean stale metadata records safely.",
    ]
    : [];

  return [
    `No workspace record matches selector "${input.workspaceOption}" in ${input.workspaceLinkPath}.`,
    "Selection is deterministic: record id is matched first, then workspace path.",
    ...staleGuidance,
    "Candidates:",
    ...input.records.map((record) => {
      const status = input.recordStatuses.get(record.id);
      return `- ${formatWorkspaceRecordSelectionText(record, status)} (use --workspace ${record.workspacePath})`;
    }),
  ].join("\n");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function createWorkspaceRemoveTask(
  dependencies: WorkspaceLifecycleDependencies,
): (options: WorkspaceRemoveOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async (options: WorkspaceRemoveOptions): Promise<number> => {
    if (options.all && typeof options.workspace === "string") {
      emit({
        kind: "error",
        message: "Cannot combine --workspace with --all for workspace remove.",
      });
      return EXIT_CODE_FAILURE;
    }

    const invocationDir = dependencies.pathOperations.resolve(dependencies.workingDirectory.cwd());
    const workspaceLinkPath = dependencies.pathOperations.join(invocationDir, ".rundown", "workspace.link");
    const workspaceLinkStats = dependencies.fileSystem.stat(workspaceLinkPath);
    if (workspaceLinkStats === null || !workspaceLinkStats.isFile) {
      emit({
        kind: "info",
        message: `No workspace.link found in invocation directory: ${invocationDir}`,
      });
      return EXIT_CODE_NO_WORK;
    }

    const parsedSchema = parseWorkspaceLinkSchema(dependencies.fileSystem.readText(workspaceLinkPath));
    if (parsedSchema.status !== "ok") {
      emit({
        kind: "error",
        message: `workspace.link is invalid: ${workspaceLinkPath}. ${parsedSchema.message}`,
      });
      return EXIT_CODE_FAILURE;
    }

    const recordStatuses = mapWorkspaceRecordStatuses({
      invocationDir,
      records: parsedSchema.schema.records,
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
    });

    const selectedRecords = resolveRecordsToOperate({
      invocationDir,
      workspaceLinkPath,
      records: parsedSchema.schema.records,
      recordStatuses,
      workspaceOption: options.workspace,
      all: options.all,
      commandName: "workspace remove",
    });
    if (selectedRecords.status === "error") {
      emit({ kind: "error", message: selectedRecords.message });
      return EXIT_CODE_FAILURE;
    }

    const selectedRecordIds = new Set(selectedRecords.records.map((record) => record.id));
    const remainingRecords = parsedSchema.schema.records.filter((record) => !selectedRecordIds.has(record.id));
    const configuredWorkspaceRoots = parsedSchema.schema.records
      .map((record) => dependencies.pathOperations.resolve(invocationDir, record.workspacePath));
    const selectedWorkspaceTargets = selectedRecords.records
      .map((record) => dependencies.pathOperations.resolve(invocationDir, record.workspacePath));

    if (options.deleteFiles) {
      const deletionBoundaryValidation = validateWorkspaceDeletionTargets({
        pathOperations: dependencies.pathOperations,
        targets: selectedWorkspaceTargets,
        configuredWorkspaceRoots,
      });
      if (!deletionBoundaryValidation.ok) {
        emit({
          kind: "error",
          message: buildDeletionBoundaryViolationMessage(deletionBoundaryValidation),
        });
        return EXIT_CODE_FAILURE;
      }
    }

    emit({ kind: "text", text: `Invocation directory: ${invocationDir}` });
    emit({ kind: "text", text: `Workspace link file: ${workspaceLinkPath}` });
    emit({ kind: "text", text: "Selected workspace record(s):" });
    for (const record of selectedRecords.records) {
      const status = recordStatuses.get(record.id);
      emit({
        kind: "text",
        text: `  - ${formatWorkspaceRecordSelectionText(record, status)}`,
      });
    }

    const selectedStaleStatuses = selectedRecords.records
      .map((record) => recordStatuses.get(record.id))
      .filter((recordStatus): recordStatus is WorkspaceRecordStatus => {
        return recordStatus !== undefined && recordStatus.health !== "ok";
      });
    emitStaleWorkspaceRecordWarnings({
      emit,
      commandName: "workspace remove",
      selectedStaleStatuses,
    });

    if (options.deleteFiles) {
      emit({ kind: "text", text: "Selected workspace file/directory cleanup target(s):" });
      for (const target of selectedWorkspaceTargets) {
        emit({ kind: "text", text: `  - ${target}` });
      }
    }

    if (options.dryRun) {
      emit({
        kind: "info",
        message: `Dry run: ${selectedRecords.records.length} workspace record(s) would be removed.`,
      });
      emit({ kind: "text", text: "Dry-run impact preview:" });
      emit({ kind: "text", text: "  - Records to remove:" });
      for (const record of selectedRecords.records) {
        const status = recordStatuses.get(record.id);
        emit({
          kind: "text",
          text: `    - ${formatWorkspaceRecordSelectionText(record, status)}`,
        });
      }
      emit({
        kind: "text",
        text: remainingRecords.length === 0
          ? `  - workspace.link: remove ${workspaceLinkPath}`
          : `  - workspace.link: rewrite ${workspaceLinkPath} with ${remainingRecords.length} remaining record(s)`,
      });
      if (options.deleteFiles) {
        emit({
          kind: "info",
          message: `Dry run: ${selectedWorkspaceTargets.length} workspace file/directory target(s) would be deleted.`,
        });
        emit({ kind: "text", text: "  - File/directory targets:" });
        for (const targetPath of selectedWorkspaceTargets) {
          const targetStats = dependencies.fileSystem.stat(targetPath);
          const targetKind = targetStats === null
            ? "missing (would be skipped)"
            : targetStats.isDirectory
              ? "directory"
              : "file";
          emit({ kind: "text", text: `    - ${targetPath} (${targetKind})` });
        }
      } else {
        emit({ kind: "text", text: "  - File/directory deletions: none (--delete-files not set)" });
        emit({
          kind: "info",
          message: "Workspace remove ran in metadata-only mode (no file deletion).",
        });
      }
      return EXIT_CODE_SUCCESS;
    }

    if (options.deleteFiles) {
      if (!options.force) {
        const interactiveInput = dependencies.interactiveInput;
        if (!interactiveInput) {
          emit({
            kind: "error",
            message: "Destructive cleanup requires interactive confirmation support. Re-run with --force to proceed non-interactively.",
          });
          return EXIT_CODE_FAILURE;
        }

        if (interactiveInput.prepareForPrompt) {
          await interactiveInput.prepareForPrompt();
        }

        const confirmation = await interactiveInput.prompt({
          kind: "confirm",
          message: `Delete ${selectedWorkspaceTargets.length} selected linked workspace file/directory target(s)?`,
          defaultValue: false,
        });
        const approved = confirmation.value.trim().toLowerCase() === "true";
        if (!approved) {
          emit({
            kind: "info",
            message: "Cancelled workspace remove before destructive cleanup. No metadata or files were changed.",
          });
          return EXIT_CODE_NO_WORK;
        }
      }

      const cleanupOutcomes: WorkspaceCleanupOutcome[] = [];
      for (const targetPath of selectedWorkspaceTargets) {
        let targetStats: ReturnType<FileSystem["stat"]>;
        try {
          targetStats = dependencies.fileSystem.stat(targetPath);
        } catch (error: unknown) {
          const errorMessage = buildFileOperationErrorMessage({
            action: "inspect workspace cleanup target",
            targetPath,
            error,
          });
          cleanupOutcomes.push({
            targetPath,
            status: "failed",
            errorMessage,
          });
          emit({ kind: "error", message: errorMessage });
          continue;
        }

        if (targetStats === null) {
          cleanupOutcomes.push({
            targetPath,
            status: "missing",
          });
          emit({
            kind: "warn",
            message: `Skipping workspace cleanup target because path is missing: ${targetPath}`,
          });
          continue;
        }

        try {
          if (targetStats.isDirectory) {
            dependencies.fileSystem.rm(targetPath, { recursive: true, force: true });
          } else {
            dependencies.fileSystem.rm(targetPath, { force: true });
          }
          cleanupOutcomes.push({
            targetPath,
            status: "deleted",
          });
        } catch (error: unknown) {
          const errorMessage = buildFileOperationErrorMessage({
            action: "delete workspace cleanup target",
            targetPath,
            error,
          });
          cleanupOutcomes.push({
            targetPath,
            status: "failed",
            errorMessage,
          });
          emit({ kind: "error", message: errorMessage });
        }
      }

      const failedCleanupOutcomes = cleanupOutcomes.filter((outcome) => outcome.status === "failed");
      if (failedCleanupOutcomes.length > 0) {
        emit({
          kind: "error",
          message: buildPartialCleanupFailureMessage(cleanupOutcomes),
        });
        emit({
          kind: "info",
          message: "workspace.link metadata was preserved because workspace file cleanup did not fully succeed.",
        });
        return EXIT_CODE_FAILURE;
      }

      const missingCleanupOutcomes = cleanupOutcomes.filter((outcome) => outcome.status === "missing");
      if (missingCleanupOutcomes.length > 0) {
        emit({
          kind: "warn",
          message: `Skipped ${missingCleanupOutcomes.length} workspace cleanup target(s) because paths were missing.`,
        });
      }
    }

    if (remainingRecords.length === 0) {
      try {
        dependencies.fileSystem.rm(workspaceLinkPath, { force: true });
      } catch (error: unknown) {
        emit({
          kind: "error",
          message: buildFileOperationErrorMessage({
            action: "remove workspace.link metadata file",
            targetPath: workspaceLinkPath,
            error,
          }),
        });
        return EXIT_CODE_FAILURE;
      }
      emit({
        kind: "success",
        message: `Removed ${selectedRecords.records.length} workspace record(s) and removed empty workspace.link metadata file.`,
      });
      emit({
        kind: "info",
        message: options.deleteFiles
          ? "Selected linked workspace files/directories were deleted."
          : "Workspace remove preserved linked workspace files/directories (metadata-only mode).",
      });
      return EXIT_CODE_SUCCESS;
    }

    const remainingRecordIds = new Set(remainingRecords.map((record) => record.id));
    const nextDefaultRecordId = parsedSchema.schema.defaultRecordId !== undefined
      && remainingRecordIds.has(parsedSchema.schema.defaultRecordId)
      ? parsedSchema.schema.defaultRecordId
      : undefined;
    const serialized = serializeWorkspaceLinkSchema({
      sourceFormat: "multi-record-v1",
      records: remainingRecords.map((record) => ({
        id: record.id,
        workspacePath: record.workspacePath,
        isDefault: nextDefaultRecordId !== undefined && record.id === nextDefaultRecordId,
      })),
      defaultRecordId: nextDefaultRecordId,
    });
    try {
      dependencies.fileSystem.writeText(workspaceLinkPath, serialized);
    } catch (error: unknown) {
      emit({
        kind: "error",
        message: buildFileOperationErrorMessage({
          action: "rewrite workspace.link metadata file",
          targetPath: workspaceLinkPath,
          error,
        }),
      });
      return EXIT_CODE_FAILURE;
    }

    emit({
      kind: "success",
      message: `Removed ${selectedRecords.records.length} workspace record(s). ${remainingRecords.length} record(s) remain in workspace.link.`,
    });
    emit({
      kind: "info",
      message: options.deleteFiles
        ? "Selected linked workspace files/directories were deleted."
        : "Workspace remove preserved linked workspace files/directories (metadata-only mode).",
    });
    return EXIT_CODE_SUCCESS;
  };
}

function validateWorkspaceDeletionTargets(input: {
  pathOperations: PathOperationsPort;
  targets: string[];
  configuredWorkspaceRoots: string[];
}):
  | { ok: true }
  | {
    ok: false;
    blockedTargets: string[];
    configuredWorkspaceRoots: string[];
    reason: "outside-roots" | "filesystem-root";
  } {
  const uniqueConfiguredRoots = [...new Set(input.configuredWorkspaceRoots
    .map((workspaceRoot) => input.pathOperations.resolve(workspaceRoot)))];
  const normalizedTargets = input.targets
    .map((target) => input.pathOperations.resolve(target));

  const fileSystemRootTargets = normalizedTargets.filter((target) => {
    const root = path.parse(target).root;
    return root.length > 0 && target === root;
  });
  if (fileSystemRootTargets.length > 0) {
    return {
      ok: false,
      blockedTargets: [...new Set(fileSystemRootTargets)],
      configuredWorkspaceRoots: uniqueConfiguredRoots,
      reason: "filesystem-root",
    };
  }

  const blockedTargets = normalizedTargets.filter((target) => !isWithinConfiguredWorkspaceRoots({
    pathOperations: input.pathOperations,
    target,
    configuredWorkspaceRoots: uniqueConfiguredRoots,
  }));

  if (blockedTargets.length > 0) {
    return {
      ok: false,
      blockedTargets: [...new Set(blockedTargets)],
      configuredWorkspaceRoots: uniqueConfiguredRoots,
      reason: "outside-roots",
    };
  }

  return { ok: true };
}

function isWithinConfiguredWorkspaceRoots(input: {
  pathOperations: PathOperationsPort;
  target: string;
  configuredWorkspaceRoots: string[];
}): boolean {
  return input.configuredWorkspaceRoots.some((workspaceRoot) => {
    const relative = input.pathOperations.relative(workspaceRoot, input.target);
    return relative.length === 0
      || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function buildDeletionBoundaryViolationMessage(input: {
  blockedTargets: string[];
  configuredWorkspaceRoots: string[];
  reason: "outside-roots" | "filesystem-root";
}): string {
  const messageLines = [
    input.reason === "filesystem-root"
      ? "Refusing to delete filesystem root paths."
      : "Refusing to delete workspace targets outside configured/linked workspace roots.",
    "Blocked target(s):",
    ...input.blockedTargets.map((target) => `- ${target}`),
    "Configured/linked workspace root(s):",
    ...input.configuredWorkspaceRoots.map((workspaceRoot) => `- ${workspaceRoot}`),
  ];
  return messageLines.join("\n");
}

function mapWorkspaceRecordStatuses(input: {
  invocationDir: string;
  records: CanonicalWorkspaceLinkRecord[];
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}): Map<string, WorkspaceRecordStatus> {
  const statuses = new Map<string, WorkspaceRecordStatus>();
  for (const record of input.records) {
    const absolutePath = input.pathOperations.resolve(input.invocationDir, record.workspacePath);
    const targetStats = input.fileSystem.stat(absolutePath);
    const health: WorkspaceRecordHealth = targetStats === null
      ? "target-missing"
      : targetStats.isDirectory
        ? "ok"
        : "target-not-directory";
    statuses.set(record.id, {
      record,
      absolutePath,
      health,
    });
  }
  return statuses;
}

function formatWorkspaceRecordSelectionText(
  record: CanonicalWorkspaceLinkRecord,
  status: WorkspaceRecordStatus | undefined,
): string {
  const absolutePath = status?.absolutePath ?? record.workspacePath;
  if (!status || status.health === "ok") {
    return `${record.id}: ${absolutePath}`;
  }

  return `${record.id}: ${absolutePath} (${describeWorkspaceRecordHealth(status.health)})`;
}

function describeWorkspaceRecordHealth(health: WorkspaceRecordHealth): string {
  if (health === "target-missing") {
    return "stale: target missing";
  }
  if (health === "target-not-directory") {
    return "stale: target is not a directory";
  }
  return "active";
}

function emitStaleWorkspaceRecordWarnings(input: {
  emit: (event: { kind: "warn"; message: string }) => void;
  commandName: "workspace unlink" | "workspace remove";
  selectedStaleStatuses: WorkspaceRecordStatus[];
}): void {
  if (input.selectedStaleStatuses.length === 0) {
    return;
  }

  input.emit({
    kind: "warn",
    message: `Detected ${input.selectedStaleStatuses.length} selected stale/orphan workspace record(s). ${input.commandName} will clean metadata records even when workspace targets are missing or invalid.`,
  });
  for (const status of input.selectedStaleStatuses) {
    input.emit({
      kind: "warn",
      message: `Stale workspace record: ${status.record.id} -> ${status.absolutePath} (${describeWorkspaceRecordHealth(status.health)})`,
    });
  }
}

function buildPartialCleanupFailureMessage(cleanupOutcomes: WorkspaceCleanupOutcome[]): string {
  const deletedCount = cleanupOutcomes.filter((outcome) => outcome.status === "deleted").length;
  const missingCount = cleanupOutcomes.filter((outcome) => outcome.status === "missing").length;
  const failedOutcomes = cleanupOutcomes.filter((outcome) => outcome.status === "failed");

  const lines = [
    `Workspace cleanup completed partially: deleted ${deletedCount}, missing ${missingCount}, failed ${failedOutcomes.length}.`,
    "Failed cleanup targets:",
    ...failedOutcomes.map((outcome) => {
      const detail = typeof outcome.errorMessage === "string" ? outcome.errorMessage : "unknown error";
      return `- ${outcome.targetPath}: ${detail}`;
    }),
  ];

  return lines.join("\n");
}

function buildFileOperationErrorMessage(input: {
  action: string;
  targetPath: string;
  error: unknown;
}): string {
  const errorDetails = toFileSystemErrorDetails(input.error);
  if (errorDetails.code === "ENOENT") {
    return `Unable to ${input.action}: path does not exist: ${input.targetPath}.`;
  }
  if (errorDetails.code === "EACCES" || errorDetails.code === "EPERM") {
    return `Unable to ${input.action}: permission denied for ${input.targetPath}.`;
  }
  const codePrefix = errorDetails.code !== undefined ? `${errorDetails.code}: ` : "";
  return `Unable to ${input.action}: ${codePrefix}${errorDetails.message}`;
}

function toFileSystemErrorDetails(error: unknown): {
  code?: string;
  message: string;
} {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    const code = typeof withCode.code === "string" ? withCode.code : undefined;
    return {
      code,
      message: error.message,
    };
  }
  if (typeof error === "string") {
    return { message: error };
  }
  return {
    message: "unknown filesystem error",
  };
}
