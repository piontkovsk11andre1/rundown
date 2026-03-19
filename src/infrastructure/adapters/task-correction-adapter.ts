import type {
  TaskCorrectionOptions,
  TaskCorrectionPort,
  TaskCorrectionResult,
} from "../../domain/ports/task-correction-port.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { correct } from "../correction.js";

export function createTaskCorrectionAdapter(): TaskCorrectionPort {
  return {
    correct(options: TaskCorrectionOptions): Promise<TaskCorrectionResult> {
      return correct({
        ...options,
        templateVars: options.templateVars as ExtraTemplateVars | undefined,
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
      });
    },
  };
}
