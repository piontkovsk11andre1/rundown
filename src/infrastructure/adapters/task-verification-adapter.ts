import type {
  TaskVerificationOptions,
  TaskVerificationPort,
} from "../../domain/ports/task-verification-port.js";
import type { VerificationStore } from "../../domain/ports/verification-store.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { verify } from "../verification.js";

/**
 * Creates the task verification adapter that bridges domain verification
 * requests to the infrastructure verification pipeline.
 */
export function createTaskVerificationAdapter(verificationStore: VerificationStore): TaskVerificationPort {
  return {
    /**
     * Executes the verification flow with infrastructure dependencies and
     * narrowed adapter-level context values.
     */
    verify(options: TaskVerificationOptions) {
      return verify({
        ...options,
        // Inject verification persistence used by the infrastructure verification flow.
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
