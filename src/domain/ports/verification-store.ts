import type { Task } from "../parser.js";

/**
 * Defines persistence operations for task verification artifacts.
 *
 * Implementations are responsible for mapping a task identity to a stable
 * storage location so verification content can be written, retrieved, and
 * removed consistently across runs.
 */
export interface VerificationStore {
  /** Persists verification content for the provided task. */
  write(task: Task, content: string): void;
  /** Loads previously persisted verification content for the provided task. */
  read(task: Task): string | null;
  /** Deletes persisted verification content for the provided task. */
  remove(task: Task): void;
}
