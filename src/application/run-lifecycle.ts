import type { Task } from "../domain/parser.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ArtifactStoreStatus,
  ConfigDirResult,
  GitClient,
  PathOperationsPort,
  ProcessRunner,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  buildCommitMessage,
  commitCheckedTaskWithGitClient,
  isGitRepoWithGitClient,
} from "./git-operations.js";

export interface RunLifecycleDependencies {
  // Provides the current working directory where task hooks execute.
  workingDirectory: WorkingDirectoryPort;
  // Emits user-visible lifecycle messages and hook output.
  output: ApplicationOutputPort;
  // Runs shell commands for lifecycle hooks.
  processRunner: ProcessRunner;
  // Resolves and normalizes task file paths for hook environment variables.
  pathOperations: PathOperationsPort;
  // Executes git commands used by post-completion commit flow.
  gitClient: GitClient;
  // Supplies optional repository-level configuration for commit behavior.
  configDir: ConfigDirResult | undefined;
}

/**
 * Executes the optional failure hook after a task iteration fails.
 *
 * The hook receives task context through environment variables so downstream
 * scripts can react to the exact task source and position.
 */
export async function afterTaskFailed(
  dependencies: RunLifecycleDependencies,
  task: Task,
  source: string,
  onFailCommand: string | undefined,
  hideHookOutput: boolean,
): Promise<void> {
  if (!onFailCommand) {
    return;
  }

  const cwd = dependencies.workingDirectory.cwd();
  const emit = dependencies.output.emit.bind(dependencies.output);

  try {
    // Run the hook in the same directory as the active rundown command.
    const result = await runHookWithProcessRunner(
      dependencies.processRunner,
      onFailCommand,
      task,
      source,
      cwd,
      dependencies.pathOperations,
    );

    if (!hideHookOutput && result.stdout) {
      emit({ kind: "text", text: result.stdout });
    }

    if (!hideHookOutput && result.stderr) {
      emit({ kind: "stderr", text: result.stderr });
    }

    // Warn when the hook runs but returns a non-zero exit code.
    if (!result.success) {
      emit({ kind: "warn", message: "--on-fail hook exited with code " + result.exitCode });
    }
  } catch (error) {
    emit({ kind: "warn", message: "--on-fail hook failed: " + String(error) });
  }
}

/**
 * Handles post-completion lifecycle actions for a successful task iteration.
 *
 * This includes optional git commit creation and optional on-complete hook
 * execution. When a commit is created, commit metadata is returned so callers
 * can persist it in runtime artifacts.
 */
export async function afterTaskComplete(
  dependencies: RunLifecycleDependencies,
  task: Task,
  source: string,
  commit: boolean,
  commitMessageTemplate: string | undefined,
  onCompleteCommand: string | undefined,
  hideHookOutput: boolean,
): Promise<Record<string, unknown> | undefined> {
  const cwd = dependencies.workingDirectory.cwd();
  const emit = dependencies.output.emit.bind(dependencies.output);
  let artifactExtra: Record<string, unknown> | undefined;

  if (commit) {
    try {
      // Skip commit flow when the current directory is not a git repository.
      const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
      if (!inGitRepo) {
        emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
      } else {
        // Build and create a commit tied to the completed task.
        const message = buildCommitMessage(task, cwd, commitMessageTemplate, dependencies.pathOperations);
        await commitCheckedTaskWithGitClient(
          dependencies.gitClient,
          task,
          cwd,
          message,
          dependencies.configDir,
          dependencies.pathOperations,
        );
        // Capture commit details so they can be attached to preserved artifacts.
        const commitSha = (await dependencies.gitClient.run(["rev-parse", "HEAD"], cwd)).trim();
        artifactExtra = {
          commitSha,
          commitMessage: message,
        };
        emit({ kind: "success", message: "Committed: " + message });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--commit failed: " + String(error) });
    }
  }

  if (onCompleteCommand) {
    try {
      // Run post-completion hook with task metadata exposed via environment.
      const result = await runHookWithProcessRunner(
        dependencies.processRunner,
        onCompleteCommand,
        task,
        source,
        cwd,
        dependencies.pathOperations,
      );

      if (!hideHookOutput && result.stdout) {
        emit({ kind: "text", text: result.stdout });
      }

      if (!hideHookOutput && result.stderr) {
        emit({ kind: "stderr", text: result.stderr });
      }

      if (!result.success) {
        emit({ kind: "warn", message: "--on-complete hook exited with code " + result.exitCode });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--on-complete hook failed: " + String(error) });
    }
  }

  return artifactExtra;
}

/**
 * Finalizes and optionally preserves runtime artifacts for a task run.
 */
export function finalizeRunArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactRunContext,
  preserve: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
  extra?: Record<string, unknown>,
): void {
  artifactStore.finalize(artifactContext, {
    status,
    preserve,
    ...(extra ? { extra } : {}),
  });

  if (preserve) {
    emit({ kind: "info", message: "Runtime artifacts saved at " + artifactStore.displayPath(artifactContext) + "." });
  }
}

/**
 * Runs a lifecycle hook command and enriches its environment with task fields.
 *
 * The runner always resolves to a normalized result object so callers can
 * report failures consistently without duplicating error handling logic.
 */
async function runHookWithProcessRunner(
  processRunner: ProcessRunner,
  command: string,
  task: Task,
  source: string,
  cwd: string,
  pathOperations: PathOperationsPort,
): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  try {
    // Execute through the shell to support full user-provided command strings.
    const result = await processRunner.run({
      command,
      args: [],
      cwd,
      mode: "wait",
      shell: true,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        RUNDOWN_TASK: task.text,
        RUNDOWN_FILE: pathOperations.resolve(task.file),
        RUNDOWN_LINE: String(task.line),
        RUNDOWN_INDEX: String(task.index),
        RUNDOWN_SOURCE: source,
      },
    });

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    // Convert runner errors into hook-like failure output for unified handling.
    return {
      success: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
