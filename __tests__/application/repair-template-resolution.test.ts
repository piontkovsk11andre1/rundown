import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractRundownSubcommand,
  normalizeRepairPathForDisplay,
  resolveInlineRundownTargetArtifactPath,
  resolveRepairTemplateForTask,
  resolveResolveTemplateForTask,
  serializeSelectedTaskMetadata,
} from "../../src/application/repair-template-resolution.js";
import type { Task } from "../../src/domain/parser.js";
import type { TemplateLoader } from "../../src/domain/ports/index.js";

describe("repair-template-resolution", () => {
  it("detects rundown research subcommand from inline cli command", () => {
    expect(extractRundownSubcommand("rundown research \"topic.md\"")).toBe("research");
    expect(extractRundownSubcommand("./rundown.cmd research topic.md")).toBe("research");
    expect(extractRundownSubcommand("powershell -c rundown research topic.md")).toBe("research");
  });

  it("returns null when command does not invoke rundown", () => {
    expect(extractRundownSubcommand("npm test")).toBeNull();
    expect(extractRundownSubcommand("opencode run --file prompt.md")).toBeNull();
  });

  it("uses research-repair template when available for inline rundown research tasks", () => {
    const task = createInlineTask("cli: rundown research \"topic.md\"");
    const templateLoader: TemplateLoader = {
      load: vi.fn((templatePath: string) => {
        if (templatePath.endsWith(path.join(".rundown", "research-repair.md"))) {
          return "RESEARCH REPAIR";
        }
        return null;
      }),
    };

    const resolved = resolveRepairTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultRepairTemplate: "DEFAULT REPAIR",
    });

    expect(resolved).toBe("RESEARCH REPAIR");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join("/workspace", ".rundown", "research-repair.md"));
  });

  it("falls back to default repair template when no command-specific template is available", () => {
    const task = createInlineTask("cli: rundown research \"topic.md\"");
    const templateLoader: TemplateLoader = {
      load: vi.fn(() => null),
    };

    const resolved = resolveRepairTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultRepairTemplate: "DEFAULT REPAIR",
    });

    expect(resolved).toBe("DEFAULT REPAIR");
  });

  it("falls back to default repair template for non-inline tasks", () => {
    const task = createTask("Research migration behavior");
    const templateLoader: TemplateLoader = {
      load: vi.fn(() => "RESEARCH REPAIR"),
    };

    const resolved = resolveRepairTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultRepairTemplate: "DEFAULT REPAIR",
    });

    expect(resolved).toBe("DEFAULT REPAIR");
    expect(templateLoader.load).not.toHaveBeenCalled();
  });

  it("uses command-specific resolve template when available", () => {
    const task = createInlineTask("cli: rundown research \"topic.md\"");
    const templateLoader: TemplateLoader = {
      load: vi.fn((templatePath: string) => {
        if (templatePath.endsWith(path.join(".rundown", "research-resolve.md"))) {
          return "RESEARCH RESOLVE";
        }
        return null;
      }),
    };

    const resolved = resolveResolveTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultResolveTemplate: "DEFAULT RESOLVE",
    });

    expect(resolved).toBe("RESEARCH RESOLVE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join("/workspace", ".rundown", "research-resolve.md"));
  });

  it("falls back to .rundown/resolve.md when command-specific resolve template is missing", () => {
    const task = createInlineTask("cli: rundown research \"topic.md\"");
    const templateLoader: TemplateLoader = {
      load: vi.fn((templatePath: string) => {
        if (templatePath.endsWith(path.join(".rundown", "resolve.md"))) {
          return "PROJECT RESOLVE";
        }
        return null;
      }),
    };

    const resolved = resolveResolveTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultResolveTemplate: "DEFAULT RESOLVE",
    });

    expect(resolved).toBe("PROJECT RESOLVE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join("/workspace", ".rundown", "research-resolve.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join("/workspace", ".rundown", "resolve.md"));
  });

  it("falls back to default resolve template when project overrides are unavailable", () => {
    const task = createInlineTask("cli: rundown research \"topic.md\"");
    const templateLoader: TemplateLoader = {
      load: vi.fn(() => null),
    };

    const resolved = resolveResolveTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultResolveTemplate: "DEFAULT RESOLVE",
    });

    expect(resolved).toBe("DEFAULT RESOLVE");
  });

  it("uses .rundown/resolve.md fallback for non-inline tasks", () => {
    const task = createTask("General resolve behavior");
    const templateLoader: TemplateLoader = {
      load: vi.fn((templatePath: string) => {
        if (templatePath.endsWith(path.join(".rundown", "resolve.md"))) {
          return "PROJECT RESOLVE";
        }
        return null;
      }),
    };

    const resolved = resolveResolveTemplateForTask({
      task,
      configDir: { configDir: path.join("/workspace", ".rundown"), isExplicit: false },
      templateLoader,
      pathOperations: path,
      defaultResolveTemplate: "DEFAULT RESOLVE",
    });

    expect(resolved).toBe("PROJECT RESOLVE");
    expect(templateLoader.load).toHaveBeenCalledWith(path.join("/workspace", ".rundown", "resolve.md"));
  });

  it("resolves research artifact path from inline rundown research command", () => {
    const task = createInlineTask('cli: rundown research "38. Fix output for every command.md"');

    const resolved = resolveInlineRundownTargetArtifactPath({
      task,
      pathOperations: path,
    });

    expect(resolved).toBe(path.resolve("/workspace", "38. Fix output for every command.md"));
  });

  it("returns null for non-research inline rundown command", () => {
    const task = createInlineTask("cli: rundown run tasks.md");

    const resolved = resolveInlineRundownTargetArtifactPath({
      task,
      pathOperations: path,
    });

    expect(resolved).toBeNull();
  });

  it("serializes selected task metadata for repair templates", () => {
    const task = createInlineTask("cli: rundown research topic.md");

    const serialized = serializeSelectedTaskMetadata({
      task,
      controllingTaskPath: "/workspace/Research.md",
    });
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      text: task.text,
      index: task.index,
      line: task.line,
      file: task.file,
      controllingTaskPath: "/workspace/Research.md",
      isInlineCli: true,
      cliCommand: "rundown research topic.md",
    });
    expect(parsed.childrenCount).toBe(0);
    expect(parsed.subItemsCount).toBe(0);
  });

  it("normalizes absolute repair paths to cwd-relative display paths", () => {
    const displayPath = normalizeRepairPathForDisplay({
      absolutePath: "/workspace/migrations/38. Fix output for every command.md",
      cwd: "/workspace/migrations",
      pathOperations: path,
    });

    expect(displayPath).toBe("38. Fix output for every command.md");
  });

  it("falls back to absolute repair path display when outside cwd", () => {
    const absolutePath = path.resolve("/workspace/migrations/38. Fix output for every command.md");
    const displayPath = normalizeRepairPathForDisplay({
      absolutePath,
      cwd: "/other",
      pathOperations: path,
    });

    expect(displayPath).toBe(absolutePath);
  });
});

function createTask(text: string): Task {
  return {
    text,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: text.length,
    file: "/workspace/tasks.md",
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

function createInlineTask(text: string): Task {
  const command = text.replace(/^cli:\s*/i, "");
  return {
    ...createTask(text),
    isInlineCli: true,
    cliCommand: command,
  };
}
