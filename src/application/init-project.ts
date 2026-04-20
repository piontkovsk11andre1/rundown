import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
  DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
  DEFAULT_MIGRATE_REVIEW_TEMPLATE,
  DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
  DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE,
  DEFAULT_PLAN_APPEND_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
  DEFAULT_PLAN_PREPEND_TEMPLATE,
  DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SEED_TEMPLATE,
  DEFAULT_QUERY_YN_SEED_TEMPLATE,
  DEFAULT_RESEARCH_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
  DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
  DEFAULT_RESEARCH_VERIFY_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TEST_VERIFY_TEMPLATE,
  DEFAULT_TEST_FUTURE_TEMPLATE,
  DEFAULT_TEST_MATERIALIZED_TEMPLATE,
  DEFAULT_UNDO_TEMPLATE,
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

export interface InitProjectOptions {
  defaultWorker?: string;
  tuiWorker?: string;
  gitignore?: boolean;
  overwriteConfig?: boolean;
}

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
): (options?: InitProjectOptions) => Promise<number> {
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
  return async function initProject(options: InitProjectOptions = {}): Promise<number> {
    // Use explicit config dir when provided; otherwise default to .rundown.
    const configDir = dependencies.configDir?.isExplicit
      ? dependencies.configDir.configDir
      : dependencies.pathOperations.resolve(CONFIG_DIR_NAME);
    const displayConfigDir = displayPathForMessage(configDir);

    // Create the config directory once when it does not yet exist.
    if (!dependencies.fileSystem.exists(configDir)) {
      dependencies.fileSystem.mkdir(configDir, { recursive: true });
    }

    const toolsDirPath = `${configDir}/tools`;
    if (!dependencies.fileSystem.exists(toolsDirPath)) {
      dependencies.fileSystem.mkdir(toolsDirPath, { recursive: true });
      emit({ kind: "success", message: `Created ${displayConfigDir}/tools/` });
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

    const writeConfigArtifact = (name: "config.json" | "vars.json", content: string) => {
      const filePath = `${configDir}/${name}`;
      const displayFilePath = `${displayConfigDir}/${name}`;
      const exists = dependencies.fileSystem.exists(filePath);
      if (exists && !options.overwriteConfig) {
        emit({ kind: "warn", message: `Preserved ${displayFilePath} (already exists).` });
        return;
      }

      dependencies.fileSystem.writeText(filePath, content);
      emit({ kind: "success", message: `${exists ? "Updated" : "Created"} ${displayFilePath}` });
    };

    // Seed default workflow templates and project configuration files.
    write("agent.md", DEFAULT_AGENT_TEMPLATE);
    write("execute.md", DEFAULT_TASK_TEMPLATE);
    write("help.md", DEFAULT_HELP_TEMPLATE);
    write("discuss.md", DEFAULT_DISCUSS_TEMPLATE);
    write("discuss-finished.md", DEFAULT_DISCUSS_FINISHED_TEMPLATE);
    write("verify.md", DEFAULT_VERIFY_TEMPLATE);
    write("repair.md", DEFAULT_REPAIR_TEMPLATE);
    write("resolve.md", DEFAULT_RESOLVE_TEMPLATE);
    write("plan.md", DEFAULT_PLAN_TEMPLATE);
    write("plan-loop.md", DEFAULT_PLAN_LOOP_TEMPLATE);
    write("plan-prepend.md", DEFAULT_PLAN_PREPEND_TEMPLATE);
    write("plan-append.md", DEFAULT_PLAN_APPEND_TEMPLATE);
    write("deep-plan.md", DEFAULT_DEEP_PLAN_TEMPLATE);
    write("research.md", DEFAULT_RESEARCH_TEMPLATE);
    write("research-verify.md", DEFAULT_RESEARCH_VERIFY_TEMPLATE);
    write("research-repair.md", DEFAULT_RESEARCH_REPAIR_TEMPLATE);
    write("research-resolve.md", DEFAULT_RESEARCH_RESOLVE_TEMPLATE);
    write("research-output-contract.md", DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE);
    write("trace.md", DEFAULT_TRACE_TEMPLATE);
    write("undo.md", DEFAULT_UNDO_TEMPLATE);
    write("test-verify.md", DEFAULT_TEST_VERIFY_TEMPLATE);
    write("test-future.md", DEFAULT_TEST_FUTURE_TEMPLATE);
    write("test-materialized.md", DEFAULT_TEST_MATERIALIZED_TEMPLATE);
    write("migrate.md", DEFAULT_MIGRATE_TEMPLATE);
    write("migrate-context.md", DEFAULT_MIGRATE_CONTEXT_TEMPLATE);
    write("migrate-snapshot.md", DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE);
    write("migrate-backlog.md", DEFAULT_MIGRATE_BACKLOG_TEMPLATE);
    write("migrate-review.md", DEFAULT_MIGRATE_REVIEW_TEMPLATE);
    write("migrate-ux.md", DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE);
    write("query-seed.md", DEFAULT_QUERY_SEED_TEMPLATE);
    write("query-seed-yn.md", DEFAULT_QUERY_YN_SEED_TEMPLATE);
    write("query-seed-success-error.md", DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE);
    write("query-execute.md", DEFAULT_QUERY_EXECUTION_TEMPLATE);
    write("query-stream-execute.md", DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE);
    write("query-aggregate.md", DEFAULT_QUERY_AGGREGATION_TEMPLATE);
    writeConfigArtifact("vars.json", DEFAULT_VARS_FILE_CONTENT);

    // Generate config content: embed worker(s) when provided, otherwise use default.
    const hasWorkerOptions = options.defaultWorker || options.tuiWorker;
    const configContent = hasWorkerOptions
      ? JSON.stringify({
        workers: {
          ...(options.defaultWorker ? { default: options.defaultWorker.split(/\s+/) } : {}),
          ...(options.tuiWorker ? { tui: options.tuiWorker.split(/\s+/) } : {}),
        },
      }, null, 2) + "\n"
      : DEFAULT_CONFIG_CONTENT;
    writeConfigArtifact("config.json", configContent);

    // Append .rundown to .gitignore when requested.
    if (options.gitignore) {
      const gitignorePath = dependencies.pathOperations.resolve(".gitignore");
      if (dependencies.fileSystem.exists(gitignorePath)) {
        const existing = dependencies.fileSystem.readText(gitignorePath);
        const lines = existing.split("\n");
        if (lines.some((line) => line.trim() === CONFIG_DIR_NAME)) {
          emit({ kind: "warn", message: `.gitignore already contains ${CONFIG_DIR_NAME}, skipping.` });
        } else {
          const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          dependencies.fileSystem.writeText(gitignorePath, existing + separator + CONFIG_DIR_NAME + "\n");
          emit({ kind: "success", message: `Added ${CONFIG_DIR_NAME} to .gitignore` });
        }
      } else {
        dependencies.fileSystem.writeText(gitignorePath, CONFIG_DIR_NAME + "\n");
        emit({ kind: "success", message: `Created .gitignore with ${CONFIG_DIR_NAME}` });
      }
    }

    emit({ kind: "success", message: `Initialized ${displayConfigDir}/ with default templates.` });
    return 0;
  };
}
