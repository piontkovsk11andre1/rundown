import { type Task } from "../domain/parser.js";
import { type PromptTransport } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  buildDelegatedRundownArgs,
  parseRundownTaskArgs,
} from "./rundown-delegation.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

/**
 * Parameters that determine whether execution should short-circuit for
 * print-prompt or dry-run modes, and how that decision is reported.
 */
export interface HandleDryRunOrPrintPromptParams {
  emit: EmitFn;
  printPrompt: boolean;
  dryRun: boolean;
  dryRunSuppressesCliExpansion: boolean;
  dryRunCliBlockCount: number;
  onlyVerify: boolean;
  task: Task;
  prompt: string;
  verificationPrompt: string;
  automationCommand: string[];
  resolvedWorkerCommand: string[];
  transport: PromptTransport;
  keepArtifacts: boolean;
  hideAgentOutput: boolean;
  ignoreCliBlock: boolean;
  verify: boolean;
  noRepair: boolean;
  repairAttempts: number;
}

/**
 * Emits a dry-run note describing skipped `cli` fenced block expansion when
 * the current mode suppresses real CLI execution.
 */
function emitDryRunCliExpansionNote(params: {
  emit: EmitFn;
  dryRunSuppressesCliExpansion: boolean;
  dryRunCliBlockCount: number;
}): void {
  const { emit, dryRunSuppressesCliExpansion, dryRunCliBlockCount } = params;
  if (!dryRunSuppressesCliExpansion) {
    // Nothing was suppressed, so there is no expansion note to show.
    return;
  }

  emit({
    kind: "info",
    message: "Dry run - skipped `cli` fenced block execution; would execute "
      + dryRunCliBlockCount
      + " block"
      + (dryRunCliBlockCount === 1 ? "" : "s")
      + ".",
  });
}

/**
 * Handles print-prompt and dry-run behavior for all task modes.
 *
 * Returns `0` when a dry-run/print action was handled and execution should
 * stop, or `null` when normal execution should continue.
 */
export function handleDryRunOrPrintPrompt(params: HandleDryRunOrPrintPromptParams): number | null {
  const {
    emit,
    printPrompt,
    dryRun,
    dryRunSuppressesCliExpansion,
    dryRunCliBlockCount,
    onlyVerify,
    task,
    prompt,
    verificationPrompt,
    automationCommand,
    resolvedWorkerCommand,
    transport,
    keepArtifacts,
    hideAgentOutput,
    ignoreCliBlock,
    verify,
    noRepair,
    repairAttempts,
  } = params;

  if (printPrompt && onlyVerify) {
    // Verification-only print mode renders the verification prompt directly.
    emit({ kind: "text", text: verificationPrompt });
    return 0;
  }

  if (dryRun && onlyVerify) {
    // Verification-only dry run reports the command and prompt size.
    emitDryRunCliExpansionNote({ emit, dryRunSuppressesCliExpansion, dryRunCliBlockCount });
    emit({ kind: "info", message: "Dry run — would run verification with: " + automationCommand.join(" ") });
    emit({ kind: "info", message: "Prompt length: " + verificationPrompt.length + " chars" });
    return 0;
  }

  if (!onlyVerify && !task.isInlineCli && !task.isRundownTask) {
    if (printPrompt) {
      // Standard worker task print mode emits the final prompt text.
      emit({ kind: "text", text: prompt });
      return 0;
    }

    if (dryRun) {
      // Standard worker task dry run reports command and prompt size.
      emitDryRunCliExpansionNote({ emit, dryRunSuppressesCliExpansion, dryRunCliBlockCount });
      emit({ kind: "info", message: "Dry run — would run: " + resolvedWorkerCommand.join(" ") });
      emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
      return 0;
    }
  }

  if (!onlyVerify && task.isInlineCli && printPrompt) {
    // Inline CLI tasks do not generate worker prompts; show the CLI command.
    emit({ kind: "info", message: "Selected task is inline CLI; no worker prompt is rendered." });
    emit({ kind: "text", text: "cli: " + task.cliCommand! });
    return 0;
  }

  if (!onlyVerify && task.isInlineCli && dryRun) {
    // Inline CLI dry run reports the command that would be executed.
    emitDryRunCliExpansionNote({ emit, dryRunSuppressesCliExpansion, dryRunCliBlockCount });
    emit({ kind: "info", message: "Dry run — would execute inline CLI: " + task.cliCommand! });
    return 0;
  }

  if (!onlyVerify && task.isRundownTask && printPrompt) {
    // Delegated rundown tasks print their delegation arguments instead of a prompt.
    emit({ kind: "info", message: "Selected task is rundown delegate; no worker prompt is rendered." });
    emit({ kind: "text", text: "rundown: " + (task.rundownArgs ?? "") });
    return 0;
  }

  if (!onlyVerify && task.isRundownTask && dryRun) {
    // Delegated rundown dry run builds inherited args and reports invocation.
    emitDryRunCliExpansionNote({ emit, dryRunSuppressesCliExpansion, dryRunCliBlockCount });
    const args = parseRundownTaskArgs(task.rundownArgs);
    const delegatedArgs = buildDelegatedRundownArgs(args, {
      parentWorkerCommand: resolvedWorkerCommand,
      parentTransport: transport,
      parentKeepArtifacts: keepArtifacts,
      parentHideAgentOutput: hideAgentOutput,
      parentIgnoreCliBlock: ignoreCliBlock,
      parentVerify: verify,
      parentNoRepair: noRepair,
      parentRepairAttempts: repairAttempts,
    });
    emit({ kind: "info", message: "Dry run — would execute rundown task: rundown run " + delegatedArgs.join(" ") });
    return 0;
  }

  // Returning null signals the caller to continue with normal execution.
  return null;
}
