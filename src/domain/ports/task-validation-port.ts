import type { Task } from "../parser.js";
import type { ProcessRunMode } from "./process-runner.js";
import type { PromptTransport } from "./worker-executor-port.js";

export interface TaskValidationOptions {
  task: Task;
  source: string;
  contextBefore: string;
  template: string;
  command: string[];
  mode?: ProcessRunMode;
  transport?: PromptTransport;
  cwd?: string;
  templateVars?: Record<string, unknown>;
  artifactContext?: unknown;
}

export interface TaskValidationPort {
  validate(options: TaskValidationOptions): Promise<boolean>;
}
