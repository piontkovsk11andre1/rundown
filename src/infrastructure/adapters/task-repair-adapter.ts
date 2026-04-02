import type {
  TaskRepairOptions,
  TaskRepairPort,
  TaskRepairResult,
} from "../../domain/ports/task-repair-port.js";
import type { VerificationStore } from "../../domain/ports/verification-store.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { repair } from "../repair.js";

/**
 * Creates the task repair adapter that bridges domain repair requests to the
 * infrastructure repair pipeline.
 */
export function createTaskRepairAdapter(verificationStore: VerificationStore): TaskRepairPort {
  return {
    /**
     * Executes the repair flow with infrastructure dependencies and narrowed
     * adapter-level context values.
     */
    repair(options: TaskRepairOptions): Promise<TaskRepairResult> {
      return repair({
        ...options,
        // Inject verification persistence used by the infrastructure repair flow.
        verificationStore,
        // Narrow optional domain variables to infrastructure-specific template values.
        templateVars: options.templateVars as ExtraTemplateVars | undefined,
        // Narrow optional domain artifact context to infrastructure runtime artifacts.
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
        // Forward CLI execution dependencies without behavior changes.
        cliBlockExecutor: options.cliBlockExecutor,
        cliExecutionOptions: options.cliExecutionOptions,
      });
    },
  };
}
