import { type Task } from "../domain/parser.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { msg, type LocaleMessages } from "../domain/locale.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

/**
 * Parameters that determine whether execution should short-circuit for
 * print-prompt or dry-run modes, and how that decision is reported.
 */
export interface HandleDryRunOrPrintPromptParams {
  emit: EmitFn;
  localeMessages?: LocaleMessages;
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
}

/**
 * Emits a dry-run note describing skipped `cli` fenced block expansion when
 * the current mode suppresses real CLI execution.
 */
function emitDryRunCliExpansionNote(params: {
  emit: EmitFn;
  localeMessages: LocaleMessages;
  dryRunSuppressesCliExpansion: boolean;
  dryRunCliBlockCount: number;
}): void {
  const { emit, localeMessages, dryRunSuppressesCliExpansion, dryRunCliBlockCount } = params;
  if (!dryRunSuppressesCliExpansion) {
    // Nothing was suppressed, so there is no expansion note to show.
    return;
  }

  emit({
    kind: "info",
    message: msg("dry.cli-skipped", { count: String(dryRunCliBlockCount) }, localeMessages),
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
    localeMessages: localeMessagesInput,
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
  } = params;
  const localeMessages = localeMessagesInput ?? {};

  if (printPrompt && onlyVerify) {
    // Verification-only print mode renders the verification prompt directly.
    emit({ kind: "text", text: verificationPrompt });
    return 0;
  }

  if (dryRun && onlyVerify) {
    // Verification-only dry run reports the command and prompt size.
    emitDryRunCliExpansionNote({
      emit,
      localeMessages,
      dryRunSuppressesCliExpansion,
      dryRunCliBlockCount,
    });
    emit({
      kind: "info",
      message: msg("dry.would-verify", { command: automationCommand.join(" ") }, localeMessages),
    });
    emit({
      kind: "info",
      message: msg("dry.prompt-length", { length: String(verificationPrompt.length) }, localeMessages),
    });
    return 0;
  }

  if (!onlyVerify && !task.isInlineCli) {
    if (printPrompt) {
      // Standard worker task print mode emits the final prompt text.
      emit({ kind: "text", text: prompt });
      return 0;
    }

    if (dryRun) {
      // Standard worker task dry run reports command and prompt size.
      emitDryRunCliExpansionNote({
        emit,
        localeMessages,
        dryRunSuppressesCliExpansion,
        dryRunCliBlockCount,
      });
      emit({ kind: "info", message: msg("dry.would-run", { command: resolvedWorkerCommand.join(" ") }, localeMessages) });
      emit({ kind: "info", message: msg("dry.prompt-length", { length: String(prompt.length) }, localeMessages) });
      return 0;
    }
  }

  if (!onlyVerify && task.isInlineCli && printPrompt) {
    // Inline CLI tasks do not generate worker prompts; show the CLI command.
    const inlineCliCommand = resolveInlineCliCommand(task);
    emit({ kind: "info", message: msg("dry.inline-cli-task", {}, localeMessages) });
    emit({ kind: "text", text: "cli: " + inlineCliCommand });
    return 0;
  }

  if (!onlyVerify && task.isInlineCli && dryRun) {
    // Inline CLI dry run reports the command that would be executed.
    const inlineCliCommand = resolveInlineCliCommand(task);
    emitDryRunCliExpansionNote({
      emit,
      localeMessages,
      dryRunSuppressesCliExpansion,
      dryRunCliBlockCount,
    });
    emit({
      kind: "info",
      message: msg("dry.would-inline-cli", { command: inlineCliCommand }, localeMessages),
    });
    return 0;
  }

  // Returning null signals the caller to continue with normal execution.
  return null;
}

function resolveInlineCliCommand(task: Task): string {
  const command = task.cliCommand?.trim() ?? "";
  const directiveCliArgs = task.directiveCliArgs?.trim();
  if (!directiveCliArgs) {
    return command;
  }

  if (command.endsWith(directiveCliArgs)) {
    return command;
  }

  return [command, directiveCliArgs].filter(Boolean).join(" ");
}
