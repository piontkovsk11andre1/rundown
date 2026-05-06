import type { ApplicationOutputEvent, ApplicationOutputPort } from "../domain/ports/output-port.js";
import pc from "picocolors";
import { formatCliTimestamp } from "../domain/cli-timestamp.js";
import { formatTaskDetailLines } from "./task-detail-lines.js";

interface ProgressPayload {
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  unit?: string;
}

let groupDepth = 0;
let quietMode = false;
let timestampProvider: () => Date | string = () => new Date().toISOString();

/**
 * Preserved for compatibility with callers that previously waited for animations.
 */
export function drainAnimationQueue(): Promise<void> {
  return Promise.resolve();
}

/**
 * Resets mutable render state between CLI invocations.
 */
export function resetCliOutputPortState(): void {
  groupDepth = 0;
  quietMode = false;
  timestampProvider = () => new Date().toISOString();
}

/**
 * Toggles quiet rendering mode for the CLI output port.
 */
export function setCliOutputPortQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

/**
 * Overrides timestamp generation for deterministic rendering (primarily tests).
 */
export function setCliOutputPortTimestampProvider(provider: (() => string) | undefined): void {
  timestampProvider = provider ?? (() => new Date().toISOString());
}

/**
 * Prefixes user-facing terminal lines with a local ISO-8601 timestamp.
 */
function withTimestamp(message: string): string {
  return `[${formatCliTimestamp(timestampProvider())}] ${message}`;
}

/**
 * Applies a dimmed terminal style to supporting status text.
 */
function dim(message: string): string {
  return pc.dim(message);
}

/**
 * Builds the primary CLI label for a task entry.
 */
function taskLabel(task: { text: string; file: string; line: number; index: number }): string {
  return `${pc.cyan(task.file)}:${pc.yellow(String(task.line))} ${pc.dim(`[#${task.index}]`)} ${task.text}`;
}

/**
 * Renders a progress payload into a stable one-line status string.
 */
function formatProgressLine(progress: ProgressPayload): string {
  const hasCounters = typeof progress.current === "number" && typeof progress.total === "number";
  const counter = hasCounters
    ? ` (${progress.current}/${progress.total}${progress.unit ? ` ${progress.unit}` : ""})`
    : "";
  const detail = progress.detail ? ` — ${progress.detail}` : "";
  return `${progress.label}${counter}${detail}`;
}

/**
 * Group state still tracks task boundaries, but CLI lines always render flush-left.
 */
function groupLinePrefix(): string {
  return "";
}

/**
 * Prefixes a single-line message when rendering inside a task group.
 */
function withGroupPrefix(message: string): string {
  return `${groupLinePrefix()}${message}`;
}

/**
 * Prefixes each line of a multiline message when rendering inside a task group.
 */
function withGroupPrefixMultiline(message: string): string {
  const prefix = groupLinePrefix();
  if (prefix === "") {
    return message;
  }

  const normalized = message.replace(/\r\n/g, "\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  const prefixed = lines.map((line) => `${prefix}${line}`).join("\n");
  return hasTrailingNewline ? `${prefixed}\n` : prefixed;
}

/**
 * Applies lightweight styling to dry-run revert output while preserving message text.
 */
function styleInfoMessage(message: string): string {
  if (message.startsWith("Dry run - would restore ")) {
    return pc.yellow(message);
  }

  if (message.startsWith("- run=")) {
    return pc.yellow(message);
  }

  if (message.startsWith("- source=") || message.startsWith("- snapshot=")) {
    return pc.dim(message);
  }

  return message;
}

/**
 * Applies log-runs specific styling to plain text lines emitted by the application layer.
 */
function styleLogRunsLine(message: string): string {
  if (!message.includes(" | source=") || !message.includes(" | command=") || !message.includes(" | revertable=")) {
    return message;
  }

  const statusMatch = message.match(/\| \[([^\]]+)\] \|/);
  let styled = message;
  if (statusMatch && statusMatch[0]) {
    const statusValue = statusMatch[1]?.toLowerCase() ?? "";
    const statusToken = statusMatch[0].slice(2, -2);
    const coloredStatus = (() => {
      switch (statusValue) {
        case "completed":
          return pc.green(statusToken);
        case "failed":
          return pc.red(statusToken);
        case "cancelled":
        case "canceled":
          return pc.yellow(statusToken);
        default:
          return pc.blue(statusToken);
      }
    })();

    styled = styled.replace(statusToken, coloredStatus);
  }

  if (styled.endsWith(" | revertable=no")) {
    return pc.dim(styled);
  }

  return styled;
}

/**
 * Styles text event content while preserving non-log-runs payloads verbatim.
 */
function styleTextMessage(message: string): string {
  if (!message.includes("\n")) {
    return styleLogRunsLine(message);
  }

  return message
    .split("\n")
    .map((line) => styleLogRunsLine(line))
    .join("\n");
}

/**
 * CLI implementation of the application output port.
 *
 * Routes domain output events to console channels with consistent color and structure.
 */
export const cliOutputPort: ApplicationOutputPort = {
  /**
   * Emits a single application output event to the terminal.
   */
  emit(event: ApplicationOutputEvent): void {
    if (
      quietMode
      && (
        event.kind === "info"
        || event.kind === "success"
        || event.kind === "progress"
        || event.kind === "group-start"
        || event.kind === "group-end"
      )
    ) {
      return;
    }

    // Delegate formatting by event kind to keep each output path explicit.
    switch (event.kind) {
      case "group-start": {
        const counter = event.counter ? `[${event.counter.current}/${event.counter.total}] ` : "";
        const parentPrefix = groupLinePrefix();
        const content = withTimestamp(`${counter}${event.label}`);
        console.log(`${parentPrefix}${content}`);
        groupDepth += 1;
        return;
      }
      case "group-end": {
        groupDepth = Math.max(0, groupDepth - 1);
        const isSuccess = event.status === "success";
        const statusLabel = isSuccess ? `${pc.green("✔")} Done` : `${pc.red("✖")} Failed`;
        const suffix = event.message ? ` — ${event.message}` : "";
        const parentPrefix = groupLinePrefix();
        const content = withTimestamp(`${statusLabel}${suffix}`);
        const writeLine = isSuccess ? console.log : console.error;

        writeLine(`${parentPrefix}${content}`);
        return;
      }
      case "info":
        {
          console.log(withGroupPrefix(withTimestamp(`${pc.blue("ℹ")} ${styleInfoMessage(event.message)}`)));
        }
        return;
      case "warn":
        console.error(withGroupPrefix(withTimestamp(`${pc.yellow("⚠")} ${event.message}`)));
        return;
      case "error":
        console.error(withGroupPrefix(withTimestamp(`${pc.red("✖")} ${event.message}`)));
        return;
      case "success":
        console.log(withGroupPrefix(withTimestamp(`${pc.green("✔")} ${event.message}`)));
        return;
      case "progress":
        console.log(withTimestamp(pc.blue("⏳") + " " + formatProgressLine(event.progress)));
        return;
      case "task":
        {
          // Prefer explicitly supplied nested details, then fall back to task payload data.
          const children = event.children ?? event.task.children;
          const subItems = event.subItems ?? event.task.subItems;
          const lines = [
            taskLabel(event.task)
            + (event.blocked ? dim(" (blocked — has unchecked subtasks)") : ""),
            ...formatTaskDetailLines({
              file: event.task.file,
              parentDepth: event.task.depth,
              children,
              subItems,
              indentLevel: 1,
              formatTaskLine: taskLabel,
              formatSubItemLine: (subItem) => `${pc.cyan(subItem.file)}:${pc.yellow(String(subItem.line))} - ${subItem.text}`,
            }),
          ];
          console.log(lines.join("\n"));
        }
        return;
      case "text":
        console.log(withGroupPrefixMultiline(styleTextMessage(event.text)));
        return;
      case "stderr":
        {
          const formatted = withGroupPrefixMultiline(event.text);
          if (formatted.length === 0) {
            return;
          }

          process.stderr.write(formatted.endsWith("\n") ? formatted : `${formatted}\n`);
        }
        return;
      default:
        return;
    }
  },
};
