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

/**
 * Dependencies required to initialize a project configuration workspace.
 *
 * These ports provide filesystem access, optional resolved config directory
 * metadata, path utilities, and a channel for user-facing status messages.
 */
export interface InitProjectDependencies {
  fileSystem: FileSystem;
  configDir: ConfigDirResult | undefined;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

/**
 * Creates the project initialization use case.
 *
 * The returned function ensures the project configuration directory exists,
 * writes default template/config files when missing, and emits user-facing
 * status messages for both created and skipped files.
 */
export function createInitProject(
  dependencies: InitProjectDependencies,
): () => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  // Render paths relative to the current working directory unless config is explicit.
  const displayPathForMessage = (targetPath: string): string => {
    // Preserve the full path when the user explicitly selected a config directory.
    if (dependencies.configDir?.isExplicit) {
      return targetPath;
    }

    // Normalize separators so CLI output is consistent across platforms.
    const relative = dependencies.pathOperations.relative(
      dependencies.pathOperations.resolve(),
      targetPath,
    ).replace(/\\/g, "/");
    return relative === "" || relative === "." ? CONFIG_DIR_NAME : relative;
  };

  /**
   * Initializes a project with default template and configuration files.
   *
   * Existing files are preserved and reported as skipped. Missing files are
   * created with built-in defaults.
   */
  return async function initProject(): Promise<number> {
    // Use explicit config dir when provided; otherwise default to .rundown.
    const configDir = dependencies.configDir?.isExplicit
      ? dependencies.configDir.configDir
      : dependencies.pathOperations.resolve(CONFIG_DIR_NAME);
    const displayConfigDir = displayPathForMessage(configDir);

    // Create the config directory once when it does not yet exist.
    if (!dependencies.fileSystem.exists(configDir)) {
      dependencies.fileSystem.mkdir(configDir, { recursive: true });
    }

    // Write a default file only when no project-specific file exists yet.
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

    // Seed default workflow templates and project configuration files.
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

