import type {
  WorkerExecutionOptions,
  WorkerExecutorPort,
  WorkerRunResult,
} from "../../domain/ports/worker-executor-port.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { executeInlineCli } from "../inline-cli.js";
import { executeRundownTask } from "../inline-rundown.js";
import { runWorker } from "../runner.js";

/**
 * Creates the worker execution adapter that bridges domain-level execution
 * requests to infrastructure runtime helpers.
 */
export function createWorkerExecutorAdapter(): WorkerExecutorPort {
  return {
    /**
     * Runs a worker process using the standard runner implementation.
     */
    async runWorker(options: WorkerExecutionOptions): Promise<WorkerRunResult> {
      // Forward domain options to the low-level runner without changing semantics.
      return runWorker({
        command: options.command,
        prompt: options.prompt,
        mode: options.mode,
        transport: options.transport,
        trace: options.trace,
        captureOutput: options.captureOutput,
        cwd: options.cwd,
        configDir: options.configDir,
        // Runtime artifacts are managed by infrastructure and narrowed for the runner.
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
        artifactPhase: options.artifactPhase,
        artifactPhaseLabel: options.artifactPhaseLabel,
        artifactExtra: options.artifactExtra,
      });
    },
    /**
     * Executes an inline CLI command through the shared inline CLI executor.
     */
    async executeInlineCli(
      command,
      cwd,
      options,
    ): Promise<WorkerRunResult> {
      return executeInlineCli(command, cwd, {
        // Narrow the context to infrastructure artifact state expected downstream.
        artifactContext: options?.artifactContext as RuntimeArtifactsContext | undefined,
        keepArtifacts: options?.keepArtifacts,
        artifactExtra: options?.artifactExtra,
      });
    },
    /**
     * Executes a nested rundown invocation while preserving parent worker context
     * needed for artifact and behavior propagation.
     */
    async executeRundownTask(args, cwd, options): Promise<WorkerRunResult> {
      return executeRundownTask(args, cwd, {
        // Keep artifact handling consistent with other adapter execution paths.
        artifactContext: options?.artifactContext as RuntimeArtifactsContext | undefined,
        keepArtifacts: options?.keepArtifacts,
        artifactExtra: options?.artifactExtra,
        // Propagate parent execution settings so nested runs inherit caller intent.
        rundownCommand: options?.rundownCommand,
        parentWorkerCommand: options?.parentWorkerCommand,
        parentTransport: options?.parentTransport,
        parentKeepArtifacts: options?.parentKeepArtifacts,
        parentShowAgentOutput: options?.parentShowAgentOutput,
        parentIgnoreCliBlock: options?.parentIgnoreCliBlock,
        parentVerify: options?.parentVerify,
        parentNoRepair: options?.parentNoRepair,
        parentRepairAttempts: options?.parentRepairAttempts,
      });
    },
  };
}
