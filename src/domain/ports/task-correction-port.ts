import type { Task } from "../parser.js";
import type { ProcessRunMode } from "./process-runner.js";
import type { PromptTransport } from "./worker-executor-port.js";

export interface TaskCorrectionOptions {
  task: Task;
  source: string;
  contextBefore: string;
  correctTemplate: string;
  validateTemplate: string;
  command: string[];
  maxRetries: number;
  mode?: ProcessRunMode;
  transport?: PromptTransport;
  cwd?: string;
  templateVars?: Record<string, unknown>;
  artifactContext?: unknown;
}

export interface TaskCorrectionResult {
  valid: boolean;
  attempts: number;
}

export interface TaskCorrectionPort {
  correct(options: TaskCorrectionOptions): Promise<TaskCorrectionResult>;
}
