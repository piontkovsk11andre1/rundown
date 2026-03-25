import type {
  TaskRepairOptions,
  TaskRepairPort,
  TaskRepairResult,
} from "../../domain/ports/task-repair-port.js";
import type { ExtraTemplateVars } from "../../domain/template-vars.js";
import type { RuntimeArtifactsContext } from "../runtime-artifacts.js";
import { repair } from "../repair.js";

export function createTaskRepairAdapter(): TaskRepairPort {
  return {
    repair(options: TaskRepairOptions): Promise<TaskRepairResult> {
      return repair({
        ...options,
        templateVars: options.templateVars as ExtraTemplateVars | undefined,
        artifactContext: options.artifactContext as RuntimeArtifactsContext | undefined,
      });
    },
  };
}
