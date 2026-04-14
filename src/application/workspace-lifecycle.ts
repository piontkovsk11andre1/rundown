import { EXIT_CODE_NO_WORK } from "../domain/exit-codes.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

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
}

export function createWorkspaceUnlinkTask(
  dependencies: WorkspaceLifecycleDependencies,
): (options: WorkspaceUnlinkOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async (options: WorkspaceUnlinkOptions): Promise<number> => {
    emit({
      kind: "info",
      message: "Workspace unlink command surface is available; unlink execution will be implemented in a follow-up migration task.",
    });
    emit({
      kind: "text",
      text: [
        "Requested options:",
        `  workspace: ${options.workspace ?? "(auto)"}`,
        `  all: ${String(options.all)}`,
        `  dryRun: ${String(options.dryRun)}`,
      ].join("\n"),
    });
    return EXIT_CODE_NO_WORK;
  };
}

export function createWorkspaceRemoveTask(
  dependencies: WorkspaceLifecycleDependencies,
): (options: WorkspaceRemoveOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async (options: WorkspaceRemoveOptions): Promise<number> => {
    emit({
      kind: "info",
      message: "Workspace remove command surface is available; remove execution will be implemented in a follow-up migration task.",
    });
    emit({
      kind: "text",
      text: [
        "Requested options:",
        `  workspace: ${options.workspace ?? "(auto)"}`,
        `  all: ${String(options.all)}`,
        `  deleteFiles: ${String(options.deleteFiles)}`,
        `  dryRun: ${String(options.dryRun)}`,
        `  force: ${String(options.force)}`,
      ].join("\n"),
    });
    return EXIT_CODE_NO_WORK;
  };
}
