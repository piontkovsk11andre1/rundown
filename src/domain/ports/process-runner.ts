export type ProcessRunMode = "wait" | "tui" | "detached";

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  mode: ProcessRunMode;
  shell?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}
