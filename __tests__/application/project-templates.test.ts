import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_DISCUSS_TEMPLATE,
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
} from "../../src/domain/defaults.js";
import type { TemplateLoader } from "../../src/domain/ports/index.js";
import { loadProjectTemplatesFromPorts } from "../../src/application/project-templates.js";

describe("project-templates", () => {
  it("drops direct prediction-path guidance from migrate planner prompt", () => {
    const renderedPlannerPrompt = DEFAULT_MIGRATE_TEMPLATE.replaceAll("{{workspacePredictionPath}}", "prediction/");

    expect(renderedPlannerPrompt).toContain("current prediction tree");
    expect(renderedPlannerPrompt).not.toContain("prediction/");
    expect(renderedPlannerPrompt).not.toContain("satellite");
    expect(renderedPlannerPrompt).toContain("Thread mode active: {{migrateThreadMode}}");
    expect(renderedPlannerPrompt).toContain("Thread slug: {{migrateThreadSlug}}");
    expect(renderedPlannerPrompt).toContain("{{migrateThreadTranslatedBrief}}");
  });

  it("returns defaults when config directory is unavailable", () => {
    const templateLoader: TemplateLoader = { load: vi.fn(() => null) };
    const templates = loadProjectTemplatesFromPorts(undefined, templateLoader, path);

    expect(templates).toMatchObject({
      agent: DEFAULT_AGENT_TEMPLATE,
      task: DEFAULT_TASK_TEMPLATE,
      help: DEFAULT_HELP_TEMPLATE,
      discuss: DEFAULT_DISCUSS_TEMPLATE,
      verify: DEFAULT_VERIFY_TEMPLATE,
      repair: DEFAULT_REPAIR_TEMPLATE,
      resolve: DEFAULT_RESOLVE_TEMPLATE,
      plan: DEFAULT_PLAN_TEMPLATE,
      planLoop: DEFAULT_PLAN_LOOP_TEMPLATE,
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

    expect(templates).toMatchObject({
      agent: DEFAULT_AGENT_TEMPLATE,
      task: "TASK",
      help: DEFAULT_HELP_TEMPLATE,
      discuss: DEFAULT_DISCUSS_TEMPLATE,
      verify: "VERIFY",
      repair: DEFAULT_REPAIR_TEMPLATE,
      resolve: DEFAULT_RESOLVE_TEMPLATE,
      plan: DEFAULT_PLAN_TEMPLATE,
      planLoop: DEFAULT_PLAN_LOOP_TEMPLATE,
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
    });
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "agent.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "help.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-verify.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-repair.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research-output-contract.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-loop.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "deep-plan.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "trace.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "undo.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-verify.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-future.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "test-materialized.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "migrate.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed-yn.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed-success-error.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-stream-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-aggregate.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "translate.md"));
  });

  it("ignores legacy plan sidecar overrides when they are present", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("/plan.md") || filePath.endsWith("\\plan.md")) {
          return "PLAN";
        }
        if (filePath.endsWith("/deep-plan.md") || filePath.endsWith("\\deep-plan.md")) {
          return "DEEP_PLAN";
        }
        if (filePath.endsWith("/plan-loop.md") || filePath.endsWith("\\plan-loop.md")) {
          return "PLAN_LOOP";
        }
        if (filePath.endsWith("/plan-prepend.md") || filePath.endsWith("\\plan-prepend.md")) {
          return "LEGACY_PREPEND";
        }
        if (filePath.endsWith("/plan-append.md") || filePath.endsWith("\\plan-append.md")) {
          return "LEGACY_APPEND";
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
    expect(templates.planLoop).toBe("PLAN_LOOP");
    expect(templates.deepPlan).toBe("DEEP_PLAN");
    expect(templates.plan).not.toContain("LEGACY_PREPEND");
    expect(templates.plan).not.toContain("LEGACY_APPEND");
    expect(templates.deepPlan).not.toContain("LEGACY_PREPEND");
    expect(templates.deepPlan).not.toContain("LEGACY_APPEND");
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
        if (filePath.endsWith("query-seed-yn.md")) {
          return "QUERY_SEED_YN";
        }
        if (filePath.endsWith("query-seed-success-error.md")) {
          return "QUERY_SEED_SUCCESS_ERROR";
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
    expect(templates.querySeedYn).toBe("QUERY_SEED_YN");
    expect(templates.querySeedSuccessError).toBe("QUERY_SEED_SUCCESS_ERROR");
    expect(templates.queryExecute).toBe("QUERY_EXECUTE");
    expect(templates.queryStreamExecute).toBe("QUERY_STREAM_EXECUTE");
    expect(templates.queryAggregate).toBe("QUERY_AGGREGATE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed-yn.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed-success-error.md"));
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

  it("treats whitespace-only overrides as missing for all templates", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("execute.md")) {
          return "   \n\t  ";
        }
        if (filePath.endsWith("help.md")) {
          return "\n\n";
        }
        if (filePath.endsWith("query-execute.md")) {
          return "\t";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.task).toBe(DEFAULT_TASK_TEMPLATE);
    expect(templates.help).toBe(DEFAULT_HELP_TEMPLATE);
    expect(templates.queryExecute).toBe(DEFAULT_QUERY_EXECUTION_TEMPLATE);
  });

  it("keeps full override behavior when default placeholder is not present", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("execute.md")) {
          return "Repository-specific execute instructions only.";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.task).toBe("Repository-specific execute instructions only.");
  });

  it("expands default placeholder with prefix and suffix content", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("execute.md")) {
          return [
            "Repo preface.",
            "",
            "{{defaultTemplate}}",
            "",
            "Repo postscript.",
          ].join("\n");
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.task).toBe(
      [
        "Repo preface.",
        "",
        DEFAULT_TASK_TEMPLATE,
        "",
        "Repo postscript.",
      ].join("\n"),
    );
  });

  it("expands all default placeholder occurrences in one template", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("help.md")) {
          return "before\n{{defaultTemplate}}\nmid\n{{defaultTemplate}}\nafter";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.help).toBe(
      `before\n${DEFAULT_HELP_TEMPLATE}\nmid\n${DEFAULT_HELP_TEMPLATE}\nafter`,
    );
  });

  it("expands each override against its own bundled default only", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("execute.md")) {
          return "execute-prefix\n{{defaultTemplate}}\nexecute-suffix";
        }
        if (filePath.endsWith("help.md")) {
          return "help-prefix\n{{defaultTemplate}}\nhelp-suffix";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.task).toBe(
      ["execute-prefix", DEFAULT_TASK_TEMPLATE, "execute-suffix"].join("\n"),
    );
    expect(templates.help).toBe(
      ["help-prefix", DEFAULT_HELP_TEMPLATE, "help-suffix"].join("\n"),
    );
    expect(templates.task).not.toContain(DEFAULT_HELP_TEMPLATE);
    expect(templates.help).not.toContain(DEFAULT_TASK_TEMPLATE);
  });

  it("only resolves default placeholder and leaves runtime placeholders intact", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("plan.md")) {
          return "Header\n{{defaultTemplate}}\nTask: {{task}}\nFooter";
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.plan).toContain(DEFAULT_PLAN_TEMPLATE);
    expect(templates.plan).toContain("Task: {{task}}");
    expect(templates.plan).not.toContain("{{defaultTemplate}}");
  });
});
