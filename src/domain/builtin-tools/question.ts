import { computeChildIndent } from "../planner.js";
import type {
  InteractiveChoice,
  InteractiveInputPort,
  InteractivePromptRequest,
} from "../ports/interactive-input-port.js";
import type { SubItem } from "../parser.js";
import type { ToolHandlerContext, ToolHandlerFn, ToolHandlerResult } from "../ports/tool-handler-port.js";
import { msg } from "../locale.js";

const OPTION_PREFIX_PATTERN = /^option\s*:\s*(.+)$/i;
const ANSWER_PREFIX_PATTERN = /^answer\s*:\s*(.*)$/i;
const DEFAULT_OPTION_SUFFIX_PATTERN = /\s*\(default\)\s*$/i;

interface ParsedOption {
  value: string;
  isDefault: boolean;
}

/**
 * Creates a built-in question handler.
 *
 * The handler prompts the user for an answer and persists it as
 * `- answer: <value>` beneath the current task in the source Markdown file.
 */
export function createQuestionHandler(interactiveInput?: InteractiveInputPort): ToolHandlerFn {
  return async (context) => {
    const localeMessages = context.localeMessages ?? {};
    const prompt = context.payload.trim();
    if (prompt.length === 0) {
      return {
        exitCode: 1,
        failureMessage: "Question tool requires prompt text payload.",
        failureReason: "Question payload is empty.",
      };
    }

    const existingAnswer = findExistingAnswer(context.task.subItems);
    if (existingAnswer !== undefined) {
      context.emit({
        kind: "info",
        message: msg("tool.question.reusing-answer", {}, localeMessages),
      });
      return {
        skipExecution: true,
        shouldVerify: false,
      };
    }

    const resolvedInteractiveInput = resolveInteractiveInput(context, interactiveInput);
    if (!resolvedInteractiveInput) {
      return {
        exitCode: 1,
        failureMessage: "Question tool requires interactive input adapter.",
        failureReason: "Interactive input adapter is not configured.",
      };
    }

    const options = collectOptions(context.task.subItems);
    const answerResult = await resolveAnswer(prompt, options, resolvedInteractiveInput);
    if (answerResult.kind === "failure") {
      return answerResult.result;
    }

    const source = context.fileSystem.readText(context.task.file);
    const updatedSource = upsertAnswerSubItem(source, context, answerResult.answer);
    if (updatedSource !== source) {
      context.fileSystem.writeText(context.task.file, updatedSource);
    }

    if (answerResult.usedDefault && !answerResult.interactive) {
      context.emit({
        kind: "info",
        message: msg("tool.question.default-selected", { answer: answerResult.answer }, localeMessages),
      });
    }

    return {
      skipExecution: true,
      shouldVerify: false,
    };
  };
}

/**
 * Placeholder static export until composition wiring injects the interactive adapter.
 */
export const questionHandler = createQuestionHandler();

function resolveInteractiveInput(
  context: ToolHandlerContext,
  fallback: InteractiveInputPort | undefined,
): InteractiveInputPort | undefined {
  const fromContext = (context as ToolHandlerContext & { interactiveInput?: InteractiveInputPort }).interactiveInput;
  return fromContext ?? fallback;
}

function collectOptions(subItems: readonly SubItem[]): ParsedOption[] {
  const options: ParsedOption[] = [];
  for (const subItem of subItems) {
    const match = subItem.text.match(OPTION_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    const rawValue = (match[1] ?? "").trim();
    if (rawValue.length === 0) {
      continue;
    }

    const isDefault = DEFAULT_OPTION_SUFFIX_PATTERN.test(rawValue);
    const value = rawValue.replace(DEFAULT_OPTION_SUFFIX_PATTERN, "").trim();
    if (value.length === 0) {
      continue;
    }

    options.push({ value, isDefault });
  }

  return options;
}

function findExistingAnswer(subItems: readonly SubItem[]): string | undefined {
  for (const subItem of subItems) {
    const match = subItem.text.match(ANSWER_PREFIX_PATTERN);
    if (!match) {
      continue;
    }

    return (match[1] ?? "").trim();
  }

  return undefined;
}

async function resolveAnswer(
  prompt: string,
  options: readonly ParsedOption[],
  interactiveInput: InteractiveInputPort,
): Promise<
  | { kind: "success"; answer: string; usedDefault: boolean; interactive: boolean }
  | { kind: "failure"; result: ToolHandlerResult }
> {
  const isInteractive = interactiveInput.isTTY();
  const defaultOption = options.find((option) => option.isDefault);

  if (!isInteractive) {
    if (defaultOption) {
      return {
        kind: "success",
        answer: defaultOption.value,
        usedDefault: true,
        interactive: false,
      };
    }

    if (options.length === 0) {
      return {
        kind: "failure",
        result: {
          exitCode: 1,
          failureMessage: "Question cannot be answered in non-interactive mode because it has no options and no default answer.",
          failureReason: "Question has neither options nor a default answer for non-interactive execution.",
        },
      };
    }

    return {
      kind: "failure",
      result: {
        exitCode: 1,
        failureMessage: "Question cannot be answered in non-interactive mode because no default option is marked.",
        failureReason: "Question options have no default answer for non-interactive execution.",
      },
    };
  }

  const request: InteractivePromptRequest = options.length > 0
    ? {
      kind: "select",
      message: prompt,
      choices: options.map<InteractiveChoice>((option) => ({
        value: option.value,
        label: option.value,
        isDefault: option.isDefault,
      })),
      defaultValue: defaultOption?.value,
      allowCustomValue: false,
    }
    : {
      kind: "text",
      message: prompt,
      required: true,
    };

  try {
    // Flush any in-place progress rendering before switching to terminal prompt IO.
    interactiveInput.prepareForPrompt?.();
    const result = await interactiveInput.prompt(request);
    const normalizedAnswer = normalizeAnswerValue(result.value);
    if (normalizedAnswer.length === 0) {
      return {
        kind: "failure",
        result: {
          exitCode: 1,
          failureMessage: "Question answer cannot be empty.",
          failureReason: "Question prompt returned empty answer.",
        },
      };
    }

    return {
      kind: "success",
      answer: normalizedAnswer,
      usedDefault: result.usedDefault,
      interactive: result.interactive,
    };
  } catch (error) {
    const interrupted = isInterruptedError(error);
    return {
      kind: "failure",
      result: interrupted
        ? {
          exitCode: 130,
          failureMessage: "Question prompt interrupted by user.",
          failureReason: "Question input interrupted.",
        }
        : {
          exitCode: 1,
          failureMessage: `Failed to collect question answer: ${toErrorMessage(error)}`,
          failureReason: "Question prompt failed.",
        },
    };
  }
}

function upsertAnswerSubItem(source: string, context: ToolHandlerContext, answer: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const parentLineIndex = context.task.line - 1;
  if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
    throw new Error(`Task line ${context.task.line} is out of range in ${context.task.file}`);
  }

  const parentLine = lines[parentLineIndex] ?? "";
  const childIndent = computeChildIndent(parentLine);
  const parentIndentLength = (parentLine.match(/^(\s*)/)?.[1] ?? "").length;
  const childIndentLength = childIndent.length;

  const immediateChildren: Array<{ index: number; text: string }> = [];
  for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }

    const leadingWhitespaceLength = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (leadingWhitespaceLength <= parentIndentLength) {
      break;
    }
    if (leadingWhitespaceLength !== childIndentLength) {
      continue;
    }
    if (!/^\s*[-*+]\s+/.test(line)) {
      continue;
    }

    const text = line.replace(/^\s*[-*+]\s+/, "").trim();
    immediateChildren.push({ index, text });
  }

  const answerLine = `${childIndent}- answer: ${answer}`;
  const existingAnswer = immediateChildren.find((child) => ANSWER_PREFIX_PATTERN.test(child.text));
  if (existingAnswer) {
    lines[existingAnswer.index] = answerLine;
    return lines.join(eol);
  }

  const optionChildren = immediateChildren.filter((child) => OPTION_PREFIX_PATTERN.test(child.text));
  const insertIndex = optionChildren.length > 0
    ? optionChildren[optionChildren.length - 1]!.index + 1
    : parentLineIndex + 1;
  lines.splice(insertIndex, 0, answerLine);
  return lines.join(eol);
}

function normalizeAnswerValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isInterruptedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "InteractiveInputInterruptedError"
    || error.name === "AbortError"
    || /(interrupted|aborted|cancelled|canceled|ctrl\s*\+\s*c|sigint)/i.test(error.message);
}
