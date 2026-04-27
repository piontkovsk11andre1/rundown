import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
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
import { msg, type LocaleMessages } from "../domain/locale.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { PathOperationsPort } from "../domain/ports/path-operations-port.js";

export interface InitProjectOptions {
  defaultWorker?: string;
  tuiWorker?: string;
  gitignore?: boolean;
  overwriteConfig?: boolean;
  silent?: boolean;
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
  localeMessages: LocaleMessages;
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
  const { localeMessages } = dependencies;

  const resolveLocaleMessages = (configDir: string): LocaleMessages => {
    const localeConfigPath = `${configDir}/locale.json`;
    if (!dependencies.fileSystem.exists(localeConfigPath)) {
      return localeMessages;
    }

    try {
      const rawLocaleConfig = dependencies.fileSystem.readText(localeConfigPath);
      const parsed = JSON.parse(rawLocaleConfig) as { messages?: unknown };
      const configuredMessages = parsed.messages;
      if (!configuredMessages || typeof configuredMessages !== "object" || Array.isArray(configuredMessages)) {
        return localeMessages;
      }

      const normalizedMessages: LocaleMessages = { ...localeMessages };
      for (const [key, value] of Object.entries(configuredMessages)) {
        if (typeof value === "string" && value.length > 0) {
          normalizedMessages[key] = value;
        }
      }

      return normalizedMessages;
    } catch {
      return localeMessages;
    }
  };

  const emitIfEnabled = (options: InitProjectOptions, event: Parameters<typeof emit>[0]): void => {
    if (options.silent) {
      return;
    }

    emit(event);
  };

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
    const activeLocaleMessages = resolveLocaleMessages(configDir);

    // Create the config directory once when it does not yet exist.
    if (!dependencies.fileSystem.exists(configDir)) {
      dependencies.fileSystem.mkdir(configDir, { recursive: true });
    }

    const toolsDirPath = `${configDir}/tools`;
    if (!dependencies.fileSystem.exists(toolsDirPath)) {
      dependencies.fileSystem.mkdir(toolsDirPath, { recursive: true });
      emitIfEnabled(options, {
        kind: "success",
        message: msg("init.created-tools-dir", { configDir: displayConfigDir }, activeLocaleMessages),
      });
    }

    // Write a default file only when no project-specific file exists yet.
    const write = (name: string, content: string) => {
      const filePath = `${configDir}/${name}`;
      const displayFilePath = `${displayConfigDir}/${name}`;
      if (dependencies.fileSystem.exists(filePath)) {
        emitIfEnabled(options, {
          kind: "warn",
          message: msg("init.skip-existing", { filePath: displayFilePath }, activeLocaleMessages),
        });
        return;
      }

      dependencies.fileSystem.writeText(filePath, content);
      emitIfEnabled(options, {
        kind: "success",
        message: msg("init.created", { filePath: displayFilePath }, activeLocaleMessages),
      });
    };

    const writeConfigArtifact = (name: "config.json" | "vars.json", content: string) => {
      const filePath = `${configDir}/${name}`;
      const displayFilePath = `${displayConfigDir}/${name}`;
      const exists = dependencies.fileSystem.exists(filePath);
      if (exists && !options.overwriteConfig) {
        emitIfEnabled(options, {
          kind: "warn",
          message: msg("init.preserved", { filePath: displayFilePath }, activeLocaleMessages),
        });
        return;
      }

      dependencies.fileSystem.writeText(filePath, content);
      emitIfEnabled(options, {
        kind: "success",
        message: msg(
            "init.updated-or-created",
            { action: exists ? "Updated" : "Created", filePath: displayFilePath },
            activeLocaleMessages,
          ),
        });
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
          emitIfEnabled(options, {
            kind: "warn",
            message: msg("init.gitignore-skip", { configDirName: CONFIG_DIR_NAME }, activeLocaleMessages),
          });
        } else {
          const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          dependencies.fileSystem.writeText(gitignorePath, existing + separator + CONFIG_DIR_NAME + "\n");
          emitIfEnabled(options, {
            kind: "success",
            message: msg("init.gitignore-added", { configDirName: CONFIG_DIR_NAME }, activeLocaleMessages),
          });
        }
      } else {
        dependencies.fileSystem.writeText(gitignorePath, CONFIG_DIR_NAME + "\n");
        emitIfEnabled(options, {
          kind: "success",
          message: msg("init.gitignore-created", { configDirName: CONFIG_DIR_NAME }, activeLocaleMessages),
        });
      }
    }

    emitIfEnabled(options, {
      kind: "success",
      message: msg("init.success", { configDir: displayConfigDir }, activeLocaleMessages),
    });
    return 0;
  };
}
