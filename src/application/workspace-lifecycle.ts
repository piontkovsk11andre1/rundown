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

    const selectedRecords = resolveRecordsToOperate({
      invocationDir,
      workspaceLinkPath,
      records: parsedSchema.schema.records,
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
      emit({
        kind: "text",
        text: `  - ${record.id}: ${dependencies.pathOperations.resolve(invocationDir, record.workspacePath)}`,
      });
    }

    if (options.dryRun) {
      emit({
        kind: "info",
        message: `Dry run: ${selectedRecords.records.length} workspace record(s) would be unlinked (metadata only).`,
      });
      emit({
        kind: "info",
        message: "Linked workspace files/directories are not deleted by workspace unlink.",
      });
      return EXIT_CODE_SUCCESS;
    }

    if (remainingRecords.length === 0) {
      dependencies.fileSystem.rm(workspaceLinkPath, { force: true });
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
    dependencies.fileSystem.writeText(workspaceLinkPath, serialized);

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
  commandName: string;
}): string {
  return [
    `${input.commandName} selection is ambiguous for ${input.invocationDir}.`,
    `Multiple workspace records are configured in ${input.workspaceLinkPath}.`,
    "Re-run with --workspace <dir|id> to select a specific record, or use --all to target every record.",
    "Candidates:",
    ...input.records.map((record) => `- ${record.id}: ${path.resolve(input.invocationDir, record.workspacePath)} (use --workspace ${record.workspacePath})`),
  ].join("\n");
}

function buildMissingSelectorMessage(input: {
  invocationDir: string;
  workspaceLinkPath: string;
  workspaceOption: string;
  records: CanonicalWorkspaceLinkRecord[];
}): string {
  return [
    `No workspace record matches selector "${input.workspaceOption}" in ${input.workspaceLinkPath}.`,
    "Selection is deterministic: record id is matched first, then workspace path.",
    "Candidates:",
    ...input.records.map((record) => `- ${record.id}: ${path.resolve(input.invocationDir, record.workspacePath)} (use --workspace ${record.workspacePath})`),
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

    const selectedRecords = resolveRecordsToOperate({
      invocationDir,
      workspaceLinkPath,
      records: parsedSchema.schema.records,
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
    const selectedWorkspaceTargets = selectedRecords.records
      .map((record) => dependencies.pathOperations.resolve(invocationDir, record.workspacePath));

    emit({ kind: "text", text: `Invocation directory: ${invocationDir}` });
    emit({ kind: "text", text: `Workspace link file: ${workspaceLinkPath}` });
    emit({ kind: "text", text: "Selected workspace record(s):" });
    for (const record of selectedRecords.records) {
      emit({
        kind: "text",
        text: `  - ${record.id}: ${dependencies.pathOperations.resolve(invocationDir, record.workspacePath)}`,
      });
    }

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
      if (options.deleteFiles) {
        emit({
          kind: "info",
          message: `Dry run: ${selectedWorkspaceTargets.length} workspace file/directory target(s) would be deleted.`,
        });
      } else {
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

      for (const targetPath of selectedWorkspaceTargets) {
        const targetStats = dependencies.fileSystem.stat(targetPath);
        if (targetStats === null) {
          emit({
            kind: "warn",
            message: `Skipping file cleanup target because it does not exist: ${targetPath}`,
          });
          continue;
        }

        if (targetStats.isDirectory) {
          dependencies.fileSystem.rm(targetPath, { recursive: true, force: true });
          continue;
        }

        dependencies.fileSystem.rm(targetPath, { force: true });
      }
    }

    if (remainingRecords.length === 0) {
      dependencies.fileSystem.rm(workspaceLinkPath, { force: true });
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
    dependencies.fileSystem.writeText(workspaceLinkPath, serialized);

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
