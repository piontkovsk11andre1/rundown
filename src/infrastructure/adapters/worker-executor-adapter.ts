import type {
  WorkerExecutionOptions,
  WorkerExecutorPort,
  WorkerRunResult,
} from "../../domain/ports/worker-executor-port.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { executeInlineCli } from "../inline-cli.js";
import { runWorker } from "../runner.js";

export function createWorkerExecutorAdapter(): WorkerExecutorPort {
  return {
    async runWorker(options: WorkerExecutionOptions): Promise<WorkerRunResult> {
      return runWorker({
        command: options.command,
        prompt: options.prompt,
        mode: options.mode,
        transport: options.transport,
        trace: options.trace,
        captureOutput: options.captureOutput,
        cwd: options.cwd,
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
        artifactPhase: options.artifactPhase,
        artifactPhaseLabel: options.artifactPhaseLabel,
        artifactExtra: options.artifactExtra,
      });
    },
    async executeInlineCli(
      command,
      cwd,
      options,
    ): Promise<WorkerRunResult> {
      return executeInlineCli(command, cwd, {
        artifactContext: options?.artifactContext as RuntimeArtifactsContext | undefined,
        keepArtifacts: options?.keepArtifacts,
        artifactExtra: options?.artifactExtra,
      });
    },
  };
}
