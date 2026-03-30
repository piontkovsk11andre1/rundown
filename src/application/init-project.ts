import {
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
  DEFAULT_VARS_FILE_CONTENT,
} from "../domain/defaults.js";
import {
  CONFIG_DIR_NAME,
  type ConfigDirResult,
} from "../domain/ports/config-dir-port.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { PathOperationsPort } from "../domain/ports/path-operations-port.js";

export interface InitProjectDependencies {
  fileSystem: FileSystem;
  configDir: ConfigDirResult | undefined;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

export function createInitProject(
  dependencies: InitProjectDependencies,
): () => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  const displayPathForMessage = (targetPath: string): string => {
    if (dependencies.configDir?.isExplicit) {
      return targetPath;
    }

    const relative = dependencies.pathOperations.relative(
      dependencies.pathOperations.resolve(),
      targetPath,
    ).replace(/\\/g, "/");
    return relative === "" || relative === "." ? CONFIG_DIR_NAME : relative;
  };

  return async function initProject(): Promise<number> {
    const configDir = dependencies.configDir?.isExplicit
      ? dependencies.configDir.configDir
      : dependencies.pathOperations.resolve(CONFIG_DIR_NAME);
    const displayConfigDir = displayPathForMessage(configDir);

    if (!dependencies.fileSystem.exists(configDir)) {
      dependencies.fileSystem.mkdir(configDir, { recursive: true });
    }

    const write = (name: string, content: string) => {
      const filePath = `${configDir}/${name}`;
      const displayFilePath = `${displayConfigDir}/${name}`;
      if (dependencies.fileSystem.exists(filePath)) {
        emit({ kind: "warn", message: `${displayFilePath} already exists, skipping.` });
        return;
      }

      dependencies.fileSystem.writeText(filePath, content);
      emit({ kind: "success", message: `Created ${displayFilePath}` });
    };

    write("execute.md", DEFAULT_TASK_TEMPLATE);
    write("verify.md", DEFAULT_VERIFY_TEMPLATE);
    write("repair.md", DEFAULT_REPAIR_TEMPLATE);
    write("plan.md", DEFAULT_PLAN_TEMPLATE);
    write("trace.md", DEFAULT_TRACE_TEMPLATE);
    write("vars.json", DEFAULT_VARS_FILE_CONTENT);
    write("config.json", DEFAULT_CONFIG_CONTENT);

    emit({ kind: "success", message: `Initialized ${displayConfigDir}/ with default templates.` });
    return 0;
  };
}

