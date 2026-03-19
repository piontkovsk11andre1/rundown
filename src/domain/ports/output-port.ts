import type { Task } from "../parser.js";

export type ApplicationOutputEvent =
  | { kind: "info"; message: string }
  | { kind: "warn"; message: string }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string }
  | { kind: "task"; task: Task; blocked?: boolean }
  | { kind: "text"; text: string }
  | { kind: "stderr"; text: string };

export interface ApplicationOutputPort {
  emit(event: ApplicationOutputEvent): void;
}
