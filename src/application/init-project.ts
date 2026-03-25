import {
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
  DEFAULT_VARS_FILE_CONTENT,
} from "../domain/defaults.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

const CONFIG_DIR = ".rundown";

export interface InitProjectDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
}

export function createInitProject(
  dependencies: InitProjectDependencies,
): () => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function initProject(): Promise<number> {
    if (!dependencies.fileSystem.exists(CONFIG_DIR)) {
      dependencies.fileSystem.mkdir(CONFIG_DIR, { recursive: true });
    }

    const write = (name: string, content: string) => {
      const filePath = `${CONFIG_DIR}/${name}`;
      if (dependencies.fileSystem.exists(filePath)) {
        emit({ kind: "warn", message: `${filePath} already exists, skipping.` });
        return;
      }

      dependencies.fileSystem.writeText(filePath, content);
      emit({ kind: "success", message: `Created ${filePath}` });
    };

    write("execute.md", DEFAULT_TASK_TEMPLATE);
    write("verify.md", DEFAULT_VERIFY_TEMPLATE);
    write("repair.md", DEFAULT_REPAIR_TEMPLATE);
    write("plan.md", DEFAULT_PLAN_TEMPLATE);
    write("vars.json", DEFAULT_VARS_FILE_CONTENT);

    emit({ kind: "success", message: "Initialized .rundown/ with default templates." });
    return 0;
  };
}

export const initProject = createInitProject;
