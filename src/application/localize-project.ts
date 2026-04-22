import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_LOCALIZE_ALIASES_TEMPLATE,
  DEFAULT_LOCALIZE_MESSAGES_TEMPLATE,
  DEFAULT_LOCALIZE_PROMPT_TEMPLATE,
  DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
  DEFAULT_PLAN_APPEND_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
  DEFAULT_PLAN_PREPEND_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SEED_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
  DEFAULT_QUERY_YN_SEED_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
  DEFAULT_RESEARCH_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_RESEARCH_VERIFY_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TEST_FUTURE_TEMPLATE,
  DEFAULT_TEST_MATERIALIZED_TEMPLATE,
  DEFAULT_TEST_VERIFY_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_UNDO_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { msg, type LocaleMessages } from "../domain/locale.js";
import { MESSAGES, type MessageId } from "../domain/messages.js";
import type {
  ConfigDirResult,
  FileSystem,
  TemplateLoader,
  WorkerConfigPort,
  WorkerExecutorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";

const LOCALE_CONFIG_FILE_NAME = "locale.json";

const LOCALIZABLE_TEMPLATES: ReadonlyArray<{ fileName: string; fallback: string }> = [
  { fileName: "agent.md", fallback: DEFAULT_AGENT_TEMPLATE },
  { fileName: "execute.md", fallback: DEFAULT_TASK_TEMPLATE },
  { fileName: "help.md", fallback: DEFAULT_HELP_TEMPLATE },
  { fileName: "discuss.md", fallback: DEFAULT_DISCUSS_TEMPLATE },
  { fileName: "discuss-finished.md", fallback: DEFAULT_DISCUSS_FINISHED_TEMPLATE },
  { fileName: "verify.md", fallback: DEFAULT_VERIFY_TEMPLATE },
  { fileName: "repair.md", fallback: DEFAULT_REPAIR_TEMPLATE },
  { fileName: "resolve.md", fallback: DEFAULT_RESOLVE_TEMPLATE },
  { fileName: "plan.md", fallback: DEFAULT_PLAN_TEMPLATE },
  { fileName: "plan-loop.md", fallback: DEFAULT_PLAN_LOOP_TEMPLATE },
  { fileName: "plan-prepend.md", fallback: DEFAULT_PLAN_PREPEND_TEMPLATE },
  { fileName: "plan-append.md", fallback: DEFAULT_PLAN_APPEND_TEMPLATE },
  { fileName: "deep-plan.md", fallback: DEFAULT_DEEP_PLAN_TEMPLATE },
  { fileName: "research.md", fallback: DEFAULT_RESEARCH_TEMPLATE },
  { fileName: "research-verify.md", fallback: DEFAULT_RESEARCH_VERIFY_TEMPLATE },
  { fileName: "research-repair.md", fallback: DEFAULT_RESEARCH_REPAIR_TEMPLATE },
  { fileName: "research-resolve.md", fallback: DEFAULT_RESEARCH_RESOLVE_TEMPLATE },
  { fileName: "research-output-contract.md", fallback: DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE },
  { fileName: "trace.md", fallback: DEFAULT_TRACE_TEMPLATE },
  { fileName: "undo.md", fallback: DEFAULT_UNDO_TEMPLATE },
  { fileName: "test-verify.md", fallback: DEFAULT_TEST_VERIFY_TEMPLATE },
  { fileName: "test-future.md", fallback: DEFAULT_TEST_FUTURE_TEMPLATE },
  { fileName: "test-materialized.md", fallback: DEFAULT_TEST_MATERIALIZED_TEMPLATE },
  { fileName: "migrate.md", fallback: DEFAULT_MIGRATE_TEMPLATE },
  { fileName: "migrate-snapshot.md", fallback: DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE },
  { fileName: "query-seed.md", fallback: DEFAULT_QUERY_SEED_TEMPLATE },
  { fileName: "query-seed-yn.md", fallback: DEFAULT_QUERY_YN_SEED_TEMPLATE },
  { fileName: "query-seed-success-error.md", fallback: DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE },
  { fileName: "query-execute.md", fallback: DEFAULT_QUERY_EXECUTION_TEMPLATE },
  { fileName: "query-stream-execute.md", fallback: DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE },
  { fileName: "query-aggregate.md", fallback: DEFAULT_QUERY_AGGREGATION_TEMPLATE },
];

export interface LocalizeProjectOptions {
  language: string;
}

export interface LocalizeProjectDependencies {
  fileSystem: FileSystem;
  workerExecutor: WorkerExecutorPort;
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
  templateLoader: TemplateLoader;
}

function parseAliases(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Failed to parse localization aliases JSON: ${String(error)}.`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Localization aliases must be a JSON object.");
  }

  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Localization aliases contain an invalid key.");
    }

    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Localization alias \"${key}\" must map to a non-empty string value.`);
    }

    aliases[key] = value;
  }

  return aliases;
}

function renderLocalizationPrompt(language: string, content: string): string {
  const vars: TemplateVars = {
    task: "Localize template",
    file: "",
    context: content,
    taskIndex: 0,
    taskLine: 1,
    source: content,
    language,
    content,
  };

  return renderTemplate(DEFAULT_LOCALIZE_PROMPT_TEMPLATE, vars);
}

function renderAliasPrompt(language: string): string {
  const vars: TemplateVars = {
    task: "Localize aliases",
    file: "",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: "",
    language,
  };

  return renderTemplate(DEFAULT_LOCALIZE_ALIASES_TEMPLATE, vars);
}

function renderMessagesPrompt(language: string, catalog: string): string {
  const vars: TemplateVars = {
    task: "Localize messages",
    file: "",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: "",
    language,
    catalog,
  };

  return renderTemplate(DEFAULT_LOCALIZE_MESSAGES_TEMPLATE, vars);
}

function isMessageId(value: string): value is MessageId {
  return value in MESSAGES;
}

function parseLocaleMessages(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(String(error));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Locale messages must be a JSON object.");
  }

  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isMessageId(key)) {
      throw new Error(`Locale messages contain unknown key: ${key}.`);
    }

    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Locale message \"${key}\" must be a non-empty string value.`);
    }

    messages[key] = value;
  }

  return messages;
}

export function createLocalizeProject(
  dependencies: LocalizeProjectDependencies,
): (options: LocalizeProjectOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const localeMessages: LocaleMessages = {};

  return async function localizeProject(options: LocalizeProjectOptions): Promise<number> {
    const language = options.language.trim();
    if (language.length === 0) {
      emit({ kind: "error", message: msg("localize.missing-language", {}, localeMessages) });
      return EXIT_CODE_FAILURE;
    }

    if (!dependencies.configDir?.configDir) {
      emit({ kind: "error", message: msg("localize.no-config-dir", {}, localeMessages) });
      return EXIT_CODE_FAILURE;
    }

    const configDir = dependencies.configDir.configDir;
    const loadedWorkerConfig = dependencies.workerConfigPort.load(configDir);
    const resolvedWorker = resolveWorkerPatternForInvocation({
      commandName: "translate",
      workerConfig: loadedWorkerConfig,
      cliWorkerPattern: undefined,
      emit,
      mode: "wait",
    });

    if (resolvedWorker.workerCommand.length === 0) {
      emit({
        kind: "error",
        message: msg("localize.no-worker", {}, localeMessages),
      });
      return EXIT_CODE_FAILURE;
    }

    if (!dependencies.fileSystem.exists(configDir)) {
      dependencies.fileSystem.mkdir(configDir, { recursive: true });
    }

    const workerTimeoutMs = loadedWorkerConfig?.workerTimeoutMs;

    for (const template of LOCALIZABLE_TEMPLATES) {
      const templatePath = `${configDir}/${template.fileName}`;
      const existingTemplate = dependencies.templateLoader.load(templatePath);
      const sourceTemplate = existingTemplate ?? template.fallback;
      const prompt = renderLocalizationPrompt(language, sourceTemplate);
      const result = await dependencies.workerExecutor.runWorker({
        workerPattern: resolvedWorker.workerPattern,
        prompt,
        mode: "wait",
        captureOutput: true,
        cwd: configDir,
        configDir,
        timeoutMs: workerTimeoutMs,
      });

      if (result.exitCode !== 0) {
        emit({
          kind: "error",
          message: msg(
            "localize.template-error",
            {
              fileName: template.fileName,
              exitCode: String(result.exitCode ?? "null"),
            },
            localeMessages,
          ),
        });
        return EXIT_CODE_FAILURE;
      }

      dependencies.fileSystem.writeText(templatePath, result.stdout);
      emit({
        kind: "success",
        message: msg("localize.template-done", { fileName: template.fileName }, localeMessages),
      });
    }

    const aliasesPrompt = renderAliasPrompt(language);
    const aliasesResult = await dependencies.workerExecutor.runWorker({
      workerPattern: resolvedWorker.workerPattern,
      prompt: aliasesPrompt,
      mode: "wait",
      captureOutput: true,
      cwd: configDir,
      configDir,
      timeoutMs: workerTimeoutMs,
    });

    if (aliasesResult.exitCode !== 0) {
      emit({
        kind: "error",
        message: msg(
          "localize.aliases-error",
          { exitCode: String(aliasesResult.exitCode ?? "null") },
          localeMessages,
        ),
      });
      return EXIT_CODE_FAILURE;
    }

    let aliases: Record<string, string>;
    try {
      aliases = parseAliases(aliasesResult.stdout);
    } catch (error) {
      emit({
        kind: "error",
        message: msg(
          "localize.aliases-parse-error",
          { error: error instanceof Error ? error.message : String(error) },
          localeMessages,
        ),
      });
      return EXIT_CODE_FAILURE;
    }

    const catalog = JSON.stringify(MESSAGES, null, 2);
    const messagesPrompt = renderMessagesPrompt(language, catalog);
    const messagesResult = await dependencies.workerExecutor.runWorker({
      workerPattern: resolvedWorker.workerPattern,
      prompt: messagesPrompt,
      mode: "wait",
      captureOutput: true,
      cwd: configDir,
      configDir,
      timeoutMs: workerTimeoutMs,
    });

    if (messagesResult.exitCode !== 0) {
      emit({
        kind: "error",
        message: msg(
          "localize.messages-error",
          { exitCode: String(messagesResult.exitCode ?? "null") },
          localeMessages,
        ),
      });
      return EXIT_CODE_FAILURE;
    }

    let messages: Record<string, string>;
    try {
      messages = parseLocaleMessages(messagesResult.stdout);
    } catch (error) {
      emit({
        kind: "error",
        message: msg(
          "localize.messages-parse-error",
          { error: error instanceof Error ? error.message : String(error) },
          localeMessages,
        ),
      });
      return EXIT_CODE_FAILURE;
    }

    emit({
      kind: "success",
      message: msg("localize.messages-done", { count: String(Object.keys(messages).length) }, localeMessages),
    });

    const localeConfigPath = `${configDir}/${LOCALE_CONFIG_FILE_NAME}`;
    dependencies.fileSystem.writeText(
      localeConfigPath,
      JSON.stringify({ language, aliases, messages }, null, 2) + "\n",
    );
    emit({ kind: "success", message: msg("localize.locale-written", { path: localeConfigPath }, localeMessages) });
    return EXIT_CODE_SUCCESS;
  };
}
