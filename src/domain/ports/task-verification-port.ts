import type { Task } from "../parser.js";
import type { ProcessRunMode } from "./process-runner.js";
import type { PromptTransport } from "./worker-executor-port.js";

export interface TaskVerificationOptions {
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

export interface TaskVerificationPort {
  verify(options: TaskVerificationOptions): Promise<boolean>;
}
