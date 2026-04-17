import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
} from "../../src/domain/defaults.js";
import type { TemplateLoader } from "../../src/domain/ports/index.js";
import { loadProjectTemplatesFromPorts } from "../../src/application/project-templates.js";

describe("project-templates", () => {
  it("returns defaults when config directory is unavailable", () => {
    const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
    const templates = loadProjectTemplatesFromPorts(undefined, templateLoader, path);

    expect(templates).toEqual({
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
    });
    expect(templateLoader.load).not.toHaveBeenCalled();
  });

  it("loads project overrides and falls back per-template", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("query-stream-execute.md")) {
          return null;
        }
        if (filePath.endsWith("query-execute.md")) {
          return null;
        }
        if (filePath.endsWith("/execute.md") || filePath.endsWith("\\execute.md")) {
          return "TASK";
        }
        if (filePath.endsWith("/verify.md") || filePath.endsWith("\\verify.md")) {
          return "VERIFY";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates).toEqual({
      agent: DEFAULT_AGENT_TEMPLATE,
      task: "TASK",
      help: DEFAULT_HELP_TEMPLATE,
      discuss: DEFAULT_DISCUSS_TEMPLATE,
      discussFinished: DEFAULT_DISCUSS_FINISHED_TEMPLATE,
      verify: "VERIFY",
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
    });
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "agent.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "help.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-verify.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-repair.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-prepend.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-append.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-loop.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "deep-plan.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "trace.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "undo.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-verify.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-future.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-materialized.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate-context.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate-snapshot.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate-backlog.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate-review.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate-ux.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-stream-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-aggregate.md"));
  });

  it("loads undo/test/migrate template overrides from project templates", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("undo.md")) {
          return "UNDO";
        }
        if (filePath.endsWith("test-verify.md")) {
          return "TEST_VERIFY";
        }
        if (filePath.endsWith("test-future.md")) {
          return "TEST_FUTURE";
        }
        if (filePath.endsWith("test-materialized.md")) {
          return "TEST_MATERIALIZED";
        }
        if (filePath.endsWith("migrate.md")) {
          return "MIGRATE";
        }
        if (filePath.endsWith("migrate-context.md")) {
          return "MIGRATE_CONTEXT";
        }
        if (filePath.endsWith("migrate-snapshot.md")) {
          return "MIGRATE_SNAPSHOT";
        }
        if (filePath.endsWith("migrate-backlog.md")) {
          return "MIGRATE_BACKLOG";
        }
        if (filePath.endsWith("migrate-review.md")) {
          return "MIGRATE_REVIEW";
        }
        if (filePath.endsWith("migrate-ux.md")) {
          return "MIGRATE_UX";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.undo).toBe("UNDO");
    expect(templates.testVerify).toBe("TEST_VERIFY");
    expect(templates.testFuture).toBe("TEST_FUTURE");
    expect(templates.testMaterialized).toBe("TEST_MATERIALIZED");
    expect(templates.migrate).toBe("MIGRATE");
    expect(templates.migrateContext).toBe("MIGRATE_CONTEXT");
    expect(templates.migrateSnapshot).toBe("MIGRATE_SNAPSHOT");
    expect(templates.migrateBacklog).toBe("MIGRATE_BACKLOG");
    expect(templates.migrateReview).toBe("MIGRATE_REVIEW");
    expect(templates.migrateUx).toBe("MIGRATE_UX");
  });

  it("loads help template override from help.md", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("help.md")) {
          return "HELP";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.help).toBe("HELP");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "help.md"));
  });

  it("falls back plan-loop.md to default when override is missing", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("plan.md")) {
          return "PLAN";
        }
        if (filePath.endsWith("plan-loop.md")) {
          return null;
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.plan).toBe("PLAN");
    expect(templates.planLoop).toBe(DEFAULT_PLAN_LOOP_TEMPLATE);
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-loop.md"));
  });

  it("loads resolve template override from resolve.md", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("resolve.md")) {
          return "RESOLVE";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.resolve).toBe("RESOLVE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "resolve.md"));
  });

  it("loads query template overrides from query-*.md files", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("query-seed.md")) {
          return "QUERY_SEED";
        }
        if (filePath.endsWith("query-execute.md")) {
          return "QUERY_EXECUTE";
        }
        if (filePath.endsWith("query-stream-execute.md")) {
          return "QUERY_STREAM_EXECUTE";
        }
        if (filePath.endsWith("query-aggregate.md")) {
          return "QUERY_AGGREGATE";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.querySeed).toBe("QUERY_SEED");
    expect(templates.queryExecute).toBe("QUERY_EXECUTE");
    expect(templates.queryStreamExecute).toBe("QUERY_STREAM_EXECUTE");
    expect(templates.queryAggregate).toBe("QUERY_AGGREGATE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-stream-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-aggregate.md"));
  });

  it("loads agent warmup template override from agent.md", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("agent.md")) {
          return "AGENT";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.agent).toBe("AGENT");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "agent.md"));
  });

  it("falls back to default warmup when agent.md is empty or whitespace", () => {
    const configDir = "/workspace/.rundown";

    const emptyTemplateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("agent.md")) {
          return "";
        }
        return null;
      }),
    };
    const emptyTemplates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      emptyTemplateLoader,
      path,
    );
    expect(emptyTemplates.agent).toBe(DEFAULT_AGENT_TEMPLATE);

    const whitespaceTemplateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("agent.md")) {
          return "   \n\t  ";
        }
        return null;
      }),
    };
    const whitespaceTemplates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      whitespaceTemplateLoader,
      path,
    );
    expect(whitespaceTemplates.agent).toBe(DEFAULT_AGENT_TEMPLATE);
  });
});
