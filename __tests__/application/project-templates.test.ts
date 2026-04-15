import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
      research: DEFAULT_RESEARCH_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
      querySeed: DEFAULT_QUERY_SEED_TEMPLATE,
      queryExecute: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      queryAggregate: DEFAULT_QUERY_AGGREGATION_TEMPLATE,
    });
    expect(templateLoader.load).not.toHaveBeenCalled();
  });

  it("loads project overrides and falls back per-template", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("query-execute.md")) {
          return null;
        }
        if (filePath.endsWith("execute.md")) {
          return "TASK";
        }
        if (filePath.endsWith("verify.md")) {
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
      research: DEFAULT_RESEARCH_TEMPLATE,
      trace: DEFAULT_TRACE_TEMPLATE,
      querySeed: DEFAULT_QUERY_SEED_TEMPLATE,
      queryExecute: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      queryAggregate: DEFAULT_QUERY_AGGREGATION_TEMPLATE,
    });
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "agent.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "help.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "research.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "trace.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-execute.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-aggregate.md"));
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
    expect(templates.queryAggregate).toBe("QUERY_AGGREGATE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-seed.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "query-execute.md"));
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
});
