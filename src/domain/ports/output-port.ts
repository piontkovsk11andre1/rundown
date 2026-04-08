import type { SubItem, Task } from "../parser.js";

/**
 * Structured progress metadata for long-running lifecycle updates.
 */
export interface ApplicationProgressPayload {
  // Human-readable phase or activity label.
  label: string;
  // Optional concise status detail shown next to the label.
  detail?: string;
  // Optional bounded progress counters.
  current?: number;
  total?: number;
  // Optional counter unit name (for example: attempts, scans).
  unit?: string;
}

/**
 * Represents a normalized output event emitted by the application layer.
 *
 * Consumers can render these events in a terminal, UI, log sink, or any other
 * output target without coupling to command execution internals.
 */
export type ApplicationOutputEvent =
  // Generic informational message for non-critical updates.
  | { kind: "info"; message: string }
  // Warning message indicating a recoverable or notable condition.
  | { kind: "warn"; message: string }
  // Error message describing a failure condition.
  | { kind: "error"; message: string }
  // Positive completion or success message.
  | { kind: "success"; message: string }
  // Structured progress event for in-flight lifecycle updates.
  | { kind: "progress"; progress: ApplicationProgressPayload }
  // Marks the start of a grouped output block.
  | { kind: "group-start"; label: string; counter?: { current: number; total: number } }
  // Marks the end of a grouped output block.
  | { kind: "group-end"; status: "success" | "failure"; message?: string }
  // Structured task payload for planner/task-list rendering.
  | { kind: "task"; task: Task; blocked?: boolean; children?: Task[]; subItems?: SubItem[] }
  // Structured per-file task summary payload for explore rendering.
  | {
    kind: "explore-file-summary";
    summary: {
      file: string;
      total: number;
      checked: number;
      unchecked: number;
      percent: number;
    };
  }
  // Raw text line intended for standard application output.
  | { kind: "text"; text: string }
  // Raw text line captured from standard error output.
  | { kind: "stderr"; text: string };

/**
 * Defines the output boundary for domain-to-adapter communication.
 *
 * Implementations decide how events are presented (for example, console output,
 * file logging, or test capture), while the domain emits only typed events.
 */
export interface ApplicationOutputPort {
  /**
   * Publishes a single output event to the configured output adapter.
   */
  emit(event: ApplicationOutputEvent): void;
}
