import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
  normalizeExitCode,
} from "../domain/exit-codes.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { CompactTaskOptions } from "./compact-task.js";

export interface AutoCompactCommandOptions {
  beforeExit?: boolean;
}

export interface PostCommandAutoCompactInput {
  primaryExitCode: number;
  autoCompact?: AutoCompactCommandOptions;
  workspace?: string;
  compactTask: (options: CompactTaskOptions) => Promise<number>;
  output: ApplicationOutputPort;
}

/**
 * Exit-code contract for post-success auto-compaction:
 * - preserve non-success primary outcomes without running compaction,
 * - preserve primary success when compaction succeeds or reports no-work,
 * - return failure when requested compaction fails after a successful primary command.
 */
export async function runPostCommandAutoCompact(
  input: PostCommandAutoCompactInput,
): Promise<number> {
  const primaryExitCode = normalizeExitCode(input.primaryExitCode);
  if (primaryExitCode !== EXIT_CODE_SUCCESS) {
    return primaryExitCode;
  }

  if (input.autoCompact?.beforeExit !== true) {
    return primaryExitCode;
  }

  const compactOptions: CompactTaskOptions = {
    workspace: input.workspace,
    target: "all",
    dryRun: false,
  };

  try {
    const compactExitCode = normalizeExitCode(await input.compactTask(compactOptions));
    if (compactExitCode === EXIT_CODE_SUCCESS || compactExitCode === EXIT_CODE_NO_WORK) {
      return primaryExitCode;
    }

    input.output.emit({
      kind: "error",
      message: "Primary command succeeded, but --compact-before-exit failed (target=all).",
    });
    return EXIT_CODE_FAILURE;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    input.output.emit({
      kind: "error",
      message: "Primary command succeeded, but --compact-before-exit failed (target=all): " + errorMessage,
    });
    return EXIT_CODE_FAILURE;
  }
}
