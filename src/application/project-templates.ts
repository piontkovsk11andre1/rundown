import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_PLAN_APPEND_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
  DEFAULT_PLAN_PREPEND_TEMPLATE,
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
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_RESEARCH_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
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
  trace: string;
  undo: string;
  testVerify: string;
  testFuture: string;
  testMaterialized: string;
  migrate: string;
  migrateContext: string;
  migrateSnapshot: string;
  migrateBacklog: string;
  migrateReview: string;
  migrateUx: string;
  querySeed: string;
  queryExecute: string;
  queryStreamExecute: string;
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
      planLoop: DEFAULT_PLAN_LOOP_TEMPLATE,
      planPrepend: DEFAULT_PLAN_PREPEND_TEMPLATE,
      planAppend: DEFAULT_PLAN_APPEND_TEMPLATE,
      deepPlan: DEFAULT_DEEP_PLAN_TEMPLATE,
      research: DEFAULT_RESEARCH_TEMPLATE,
      researchVerify: DEFAULT_RESEARCH_VERIFY_TEMPLATE,
      researchRepair: DEFAULT_RESEARCH_REPAIR_TEMPLATE,
      researchResolve: DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
      undo: DEFAULT_UNDO_TEMPLATE,
      testVerify: DEFAULT_TEST_VERIFY_TEMPLATE,
      testFuture: DEFAULT_TEST_FUTURE_TEMPLATE,
      testMaterialized: DEFAULT_TEST_MATERIALIZED_TEMPLATE,
      migrate: DEFAULT_MIGRATE_TEMPLATE,
      migrateContext: DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
      migrateSnapshot: DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
      migrateBacklog: DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
      migrateReview: DEFAULT_MIGRATE_REVIEW_TEMPLATE,
      migrateUx: DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE,
      querySeed: DEFAULT_QUERY_SEED_TEMPLATE,
      queryExecute: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      queryStreamExecute: DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
      queryAggregate: DEFAULT_QUERY_AGGREGATION_TEMPLATE,
    };
  }

  // Resolve template paths relative to the discovered project config directory.
  const dir = configDir.configDir;
  const loadedAgentTemplate = templateLoader.load(pathOperations.join(dir, "agent.md"));
  const agentTemplate =
    loadedAgentTemplate && loadedAgentTemplate.trim().length > 0
      ? loadedAgentTemplate
      : DEFAULT_AGENT_TEMPLATE;

  return {
    // Prefer project overrides, then fall back to bundled default templates.
    agent: agentTemplate,
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
    planLoop: templateLoader.load(pathOperations.join(dir, "plan-loop.md")) ?? DEFAULT_PLAN_LOOP_TEMPLATE,
    planPrepend:
      templateLoader.load(pathOperations.join(dir, "plan-prepend.md")) ??
      DEFAULT_PLAN_PREPEND_TEMPLATE,
    planAppend:
      templateLoader.load(pathOperations.join(dir, "plan-append.md")) ??
      DEFAULT_PLAN_APPEND_TEMPLATE,
    deepPlan: templateLoader.load(pathOperations.join(dir, "deep-plan.md")) ?? DEFAULT_DEEP_PLAN_TEMPLATE,
    research: templateLoader.load(pathOperations.join(dir, "research.md")) ?? DEFAULT_RESEARCH_TEMPLATE,
    researchVerify:
      templateLoader.load(pathOperations.join(dir, "research-verify.md")) ??
      DEFAULT_RESEARCH_VERIFY_TEMPLATE,
    researchRepair:
      templateLoader.load(pathOperations.join(dir, "research-repair.md")) ??
      DEFAULT_RESEARCH_REPAIR_TEMPLATE,
    researchResolve:
      templateLoader.load(pathOperations.join(dir, "research-resolve.md")) ??
      DEFAULT_RESEARCH_RESOLVE_TEMPLATE,
    trace: templateLoader.load(pathOperations.join(dir, "trace.md")) ?? DEFAULT_TRACE_TEMPLATE,
    undo: templateLoader.load(pathOperations.join(dir, "undo.md")) ?? DEFAULT_UNDO_TEMPLATE,
    testVerify:
      templateLoader.load(pathOperations.join(dir, "test-verify.md")) ??
      DEFAULT_TEST_VERIFY_TEMPLATE,
    testFuture:
      templateLoader.load(pathOperations.join(dir, "test-future.md")) ??
      DEFAULT_TEST_FUTURE_TEMPLATE,
    testMaterialized:
      templateLoader.load(pathOperations.join(dir, "test-materialized.md")) ??
      DEFAULT_TEST_MATERIALIZED_TEMPLATE,
    migrate:
      templateLoader.load(pathOperations.join(dir, "migrate.md")) ??
      DEFAULT_MIGRATE_TEMPLATE,
    migrateContext:
      templateLoader.load(pathOperations.join(dir, "migrate-context.md")) ??
      DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
    migrateSnapshot:
      templateLoader.load(pathOperations.join(dir, "migrate-snapshot.md")) ??
      DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
    migrateBacklog:
      templateLoader.load(pathOperations.join(dir, "migrate-backlog.md")) ??
      DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
    migrateReview:
      templateLoader.load(pathOperations.join(dir, "migrate-review.md")) ??
      DEFAULT_MIGRATE_REVIEW_TEMPLATE,
    migrateUx:
      templateLoader.load(pathOperations.join(dir, "migrate-ux.md")) ??
      DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE,
    querySeed:
      templateLoader.load(pathOperations.join(dir, "query-seed.md")) ??
      DEFAULT_QUERY_SEED_TEMPLATE,
    queryExecute:
      templateLoader.load(pathOperations.join(dir, "query-execute.md")) ??
      DEFAULT_QUERY_EXECUTION_TEMPLATE,
    queryStreamExecute:
      templateLoader.load(pathOperations.join(dir, "query-stream-execute.md")) ??
      DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
    queryAggregate:
      templateLoader.load(pathOperations.join(dir, "query-aggregate.md")) ??
      DEFAULT_QUERY_AGGREGATION_TEMPLATE,
  };
}
