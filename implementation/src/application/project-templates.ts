import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_PLAN_APPEND_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
  DEFAULT_PLAN_PREPEND_TEMPLATE,
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_YN_SEED_TEMPLATE,
  DEFAULT_TRANSLATE_TEMPLATE,
  DEFAULT_RESEARCH_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
  DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
  DEFAULT_RESEARCH_VERIFY_TEMPLATE,
  DEFAULT_QUERY_SEED_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TEST_FUTURE_TEMPLATE,
  DEFAULT_TEST_MATERIALIZED_TEMPLATE,
  DEFAULT_TEST_VERIFY_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_UNDO_TEMPLATE,
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
  planLoop: string;
  planPrepend: string;
  planAppend: string;
  deepPlan?: string;
  research: string;
  researchVerify: string;
  researchRepair: string;
  researchResolve: string;
  researchOutputContract: string;
  trace: string;
  undo: string;
  testVerify: string;
  testFuture: string;
  testMaterialized: string;
  migrate: string;
  querySeed: string;
  querySeedYn: string;
  querySeedSuccessError: string;
  queryExecute: string;
  queryStreamExecute: string;
  queryAggregate: string;
  translate: string;
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
      planLoop: DEFAULT_PLAN_LOOP_TEMPLATE,
      planPrepend: DEFAULT_PLAN_PREPEND_TEMPLATE,
      planAppend: DEFAULT_PLAN_APPEND_TEMPLATE,
      deepPlan: DEFAULT_DEEP_PLAN_TEMPLATE,
      research: DEFAULT_RESEARCH_TEMPLATE,
      researchVerify: DEFAULT_RESEARCH_VERIFY_TEMPLATE,
      researchRepair: DEFAULT_RESEARCH_REPAIR_TEMPLATE,
      researchResolve: DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
      researchOutputContract: DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
      undo: DEFAULT_UNDO_TEMPLATE,
      testVerify: DEFAULT_TEST_VERIFY_TEMPLATE,
      testFuture: DEFAULT_TEST_FUTURE_TEMPLATE,
      testMaterialized: DEFAULT_TEST_MATERIALIZED_TEMPLATE,
      migrate: DEFAULT_MIGRATE_TEMPLATE,
      querySeed: DEFAULT_QUERY_SEED_TEMPLATE,
      querySeedYn: DEFAULT_QUERY_YN_SEED_TEMPLATE,
      querySeedSuccessError: DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
      queryExecute: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      queryStreamExecute: DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
      queryAggregate: DEFAULT_QUERY_AGGREGATION_TEMPLATE,
      translate: DEFAULT_TRANSLATE_TEMPLATE,
    };
  }

  // Resolve template paths relative to the discovered project config directory.
  const dir = configDir.configDir;
  const loadTemplateWithFallback = (fileName: string, fallback: string): string => {
    const loadedTemplate = templateLoader.load(pathOperations.join(dir, fileName));
    return loadedTemplate !== null && loadedTemplate.trim().length > 0
      ? loadedTemplate
      : fallback;
  };

  return {
    // Prefer project overrides, then fall back to bundled default templates.
    agent: loadTemplateWithFallback("agent.md", DEFAULT_AGENT_TEMPLATE),
    task: loadTemplateWithFallback("execute.md", DEFAULT_TASK_TEMPLATE),
    help: loadTemplateWithFallback("help.md", DEFAULT_HELP_TEMPLATE),
    discuss: loadTemplateWithFallback("discuss.md", DEFAULT_DISCUSS_TEMPLATE),
    discussFinished: loadTemplateWithFallback("discuss-finished.md", DEFAULT_DISCUSS_FINISHED_TEMPLATE),
    verify: loadTemplateWithFallback("verify.md", DEFAULT_VERIFY_TEMPLATE),
    repair: loadTemplateWithFallback("repair.md", DEFAULT_REPAIR_TEMPLATE),
    resolve: loadTemplateWithFallback("resolve.md", DEFAULT_RESOLVE_TEMPLATE),
    plan: loadTemplateWithFallback("plan.md", DEFAULT_PLAN_TEMPLATE),
    planLoop: loadTemplateWithFallback("plan-loop.md", DEFAULT_PLAN_LOOP_TEMPLATE),
    planPrepend: loadTemplateWithFallback("plan-prepend.md", DEFAULT_PLAN_PREPEND_TEMPLATE),
    planAppend: loadTemplateWithFallback("plan-append.md", DEFAULT_PLAN_APPEND_TEMPLATE),
    deepPlan: loadTemplateWithFallback("deep-plan.md", DEFAULT_DEEP_PLAN_TEMPLATE),
    research: loadTemplateWithFallback("research.md", DEFAULT_RESEARCH_TEMPLATE),
    researchVerify: loadTemplateWithFallback("research-verify.md", DEFAULT_RESEARCH_VERIFY_TEMPLATE),
    researchRepair: loadTemplateWithFallback("research-repair.md", DEFAULT_RESEARCH_REPAIR_TEMPLATE),
    researchResolve: loadTemplateWithFallback("research-resolve.md", DEFAULT_RESEARCH_RESOLVE_TEMPLATE),
    researchOutputContract: loadTemplateWithFallback(
      "research-output-contract.md",
      DEFAULT_RESEARCH_OUTPUT_CONTRACT_TEMPLATE,
    ),
    trace: loadTemplateWithFallback("trace.md", DEFAULT_TRACE_TEMPLATE),
    undo: loadTemplateWithFallback("undo.md", DEFAULT_UNDO_TEMPLATE),
    testVerify: loadTemplateWithFallback("test-verify.md", DEFAULT_TEST_VERIFY_TEMPLATE),
    testFuture: loadTemplateWithFallback("test-future.md", DEFAULT_TEST_FUTURE_TEMPLATE),
    testMaterialized: loadTemplateWithFallback("test-materialized.md", DEFAULT_TEST_MATERIALIZED_TEMPLATE),
    migrate: loadTemplateWithFallback("migrate.md", DEFAULT_MIGRATE_TEMPLATE),
    querySeed: loadTemplateWithFallback("query-seed.md", DEFAULT_QUERY_SEED_TEMPLATE),
    querySeedYn: loadTemplateWithFallback("query-seed-yn.md", DEFAULT_QUERY_YN_SEED_TEMPLATE),
    querySeedSuccessError: loadTemplateWithFallback(
      "query-seed-success-error.md",
      DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
    ),
    queryExecute: loadTemplateWithFallback("query-execute.md", DEFAULT_QUERY_EXECUTION_TEMPLATE),
    queryStreamExecute: loadTemplateWithFallback(
      "query-stream-execute.md",
      DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
    ),
    queryAggregate: loadTemplateWithFallback("query-aggregate.md", DEFAULT_QUERY_AGGREGATION_TEMPLATE),
    translate: loadTemplateWithFallback("translate.md", DEFAULT_TRANSLATE_TEMPLATE),
  };
}
