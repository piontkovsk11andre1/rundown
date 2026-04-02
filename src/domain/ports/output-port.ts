import type { SubItem, Task } from "../parser.js";

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
  // Structured task payload for planner/task-list rendering.
  | { kind: "task"; task: Task; blocked?: boolean; children?: Task[]; subItems?: SubItem[] }
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
