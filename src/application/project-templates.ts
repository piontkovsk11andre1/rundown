import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SEED_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import type {
  ConfigDirResult,
  PathOperationsPort,
  TemplateLoader,
} from "../domain/ports/index.js";

/**
 * Represents the full set of prompt templates used by application workflows.
 *
 * Each property maps to a specific command mode and contains either a
 * project-provided override or the corresponding built-in default template.
 */
export interface ProjectTemplates {
  agent: string;
  task: string;
  help: string;
  discuss: string;
  discussFinished: string;
  verify: string;
  repair: string;
  resolve: string;
  plan: string;
  research: string;
  trace: string;
  querySeed: string;
  queryExecute: string;
  queryAggregate: string;
}

/**
 * Loads project-level prompt templates from the configured directory when available.
 *
 * Falls back to built-in default templates for any missing file and for cases where
 * project configuration is not enabled.
 */
export function loadProjectTemplatesFromPorts(
  configDir: ConfigDirResult | undefined,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ProjectTemplates {
  // Use only built-in defaults when no project config directory is available.
  if (!configDir) {
    return {
      agent: DEFAULT_AGENT_TEMPLATE,
      task: DEFAULT_TASK_TEMPLATE,
      help: DEFAULT_HELP_TEMPLATE,
      discuss: DEFAULT_DISCUSS_TEMPLATE,
      discussFinished: DEFAULT_DISCUSS_FINISHED_TEMPLATE,
      verify: DEFAULT_VERIFY_TEMPLATE,
      repair: DEFAULT_REPAIR_TEMPLATE,
      resolve: DEFAULT_RESOLVE_TEMPLATE,
      plan: DEFAULT_PLAN_TEMPLATE,
      research: DEFAULT_RESEARCH_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
      querySeed: DEFAULT_QUERY_SEED_TEMPLATE,
      queryExecute: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      queryAggregate: DEFAULT_QUERY_AGGREGATION_TEMPLATE,
    };
  }

  // Resolve template paths relative to the discovered project config directory.
  const dir = configDir.configDir;
  return {
    // Prefer project overrides, then fall back to bundled default templates.
    agent: templateLoader.load(pathOperations.join(dir, "agent.md")) ?? DEFAULT_AGENT_TEMPLATE,
    task: templateLoader.load(pathOperations.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    help: templateLoader.load(pathOperations.join(dir, "help.md")) ?? DEFAULT_HELP_TEMPLATE,
    discuss: templateLoader.load(pathOperations.join(dir, "discuss.md")) ?? DEFAULT_DISCUSS_TEMPLATE,
    discussFinished:
      templateLoader.load(pathOperations.join(dir, "discuss-finished.md")) ??
      DEFAULT_DISCUSS_FINISHED_TEMPLATE,
    verify: templateLoader.load(pathOperations.join(dir, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: templateLoader.load(pathOperations.join(dir, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
    resolve: templateLoader.load(pathOperations.join(dir, "resolve.md")) ?? DEFAULT_RESOLVE_TEMPLATE,
    plan: templateLoader.load(pathOperations.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
    research: templateLoader.load(pathOperations.join(dir, "research.md")) ?? DEFAULT_RESEARCH_TEMPLATE,
    trace: templateLoader.load(pathOperations.join(dir, "trace.md")) ?? DEFAULT_TRACE_TEMPLATE,
    querySeed:
      templateLoader.load(pathOperations.join(dir, "query-seed.md")) ??
      DEFAULT_QUERY_SEED_TEMPLATE,
    queryExecute:
      templateLoader.load(pathOperations.join(dir, "query-execute.md")) ??
      DEFAULT_QUERY_EXECUTION_TEMPLATE,
    queryAggregate:
      templateLoader.load(pathOperations.join(dir, "query-aggregate.md")) ??
      DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  };
}
