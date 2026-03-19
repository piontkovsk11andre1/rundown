import type {
  TaskValidationOptions,
  TaskValidationPort,
} from "../../domain/ports/task-validation-port.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { validate } from "../validation.js";

export function createTaskValidationAdapter(): TaskValidationPort {
  return {
    validate(options: TaskValidationOptions) {
      return validate({
        ...options,
        templateVars: options.templateVars as ExtraTemplateVars | undefined,
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
      });
    },
  };
}
