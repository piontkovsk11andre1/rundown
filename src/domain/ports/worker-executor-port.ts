import type { ProcessRunMode } from "./process-runner.js";

export type PromptTransport = "file" | "arg";

export interface WorkerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface WorkerExecutionOptions {
  command: string[];
  prompt: string;
  mode: ProcessRunMode;
  transport: PromptTransport;
  trace?: boolean;
  captureOutput?: boolean;
  cwd: string;
  artifactContext?: unknown;
  artifactPhase?: "execute" | "verify" | "repair" | "worker" | "plan" | "discuss";
  artifactPhaseLabel?: string;
  artifactExtra?: Record<string, unknown>;
}

export interface InlineCliExecutionOptions {
  artifactContext?: unknown;
  keepArtifacts?: boolean;
  artifactExtra?: Record<string, unknown>;
}

export interface WorkerExecutorPort {
  runWorker(options: WorkerExecutionOptions): Promise<WorkerRunResult>;
  executeInlineCli(
    command: string,
    cwd: string,
    options?: InlineCliExecutionOptions,
  ): Promise<WorkerRunResult>;
}
