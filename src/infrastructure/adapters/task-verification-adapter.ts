import type {
  TaskVerificationOptions,
  TaskVerificationPort,
} from "../../domain/ports/task-verification-port.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { verify } from "../verification.js";

export function createTaskVerificationAdapter(): TaskVerificationPort {
  return {
    verify(options: TaskVerificationOptions) {
      return verify({
        ...options,
        templateVars: options.templateVars as ExtraTemplateVars | undefined,
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
      });
    },
  };
}
