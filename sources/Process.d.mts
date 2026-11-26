import type { ExecutionContext } from "./types.mjs";
export interface ProcessOptions extends ExecutionContext {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface ProcessInput extends ProcessOptions {
  command: string;
  args?: string[];
}
export interface ProcessResult {
  stdout: string;
  stderr: string;
}
export function runProcess(
  command: string,
  args: string[],
  options?: ProcessOptions,
): Promise<ProcessResult>;
export class ProcessAdapter {
  constructor(defaults?: {
    timeoutMs?: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
  });
  run(input: ProcessInput): Promise<ProcessResult>;
}
