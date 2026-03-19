import type { Task } from "../parser.js";

export interface ValidationSidecar {
  filePath(task: Task): string;
  read(task: Task): string | null;
  remove(task: Task): void;
}
