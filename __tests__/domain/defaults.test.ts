import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../../src/domain/defaults.js";
import { renderTemplate } from "../../src/domain/template.js";

const sharedPrefix = `{{context}}\n\n---\n\nThe Markdown above is the source document up to but not including the selected unchecked task.\n\n## Source file\n\n\`{{file}}\` (line {{taskLine}})\n\n## Selected task\n\n{{task}}\n`;

describe("default prompt templates", () => {
  it("starts every built-in template with the same shared prefix", () => {
    expect(DEFAULT_TASK_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_VERIFY_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_REPAIR_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_RESOLVE_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_PLAN_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
    expect(DEFAULT_RESEARCH_TEMPLATE.startsWith(sharedPrefix)).toBe(true);
  });

  it("renders the variables section in the default task template", () => {
    const result = renderTemplate(DEFAULT_TASK_TEMPLATE, {
      task: "Ship release",
      file: "tasks.md",
      context: "- [ ] Ship release",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] Ship release",
      invocationDir: "/repo/invoke",
      workspaceDir: "/repo/workspace",
      workspaceLinkPath: "/repo/invoke/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "design",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspaceDesignPath: "/repo/workspace/design",
      workspaceSpecsPath: "/repo/workspace/specs",
      workspaceMigrationsPath: "/repo/workspace/migrations",
      userVariables: "branch=main\nticket=ENG-42",
    });

    expect(result).toContain("## Workspace context");
    expect(result).toContain("- Invocation directory: `/repo/invoke`");
    expect(result).toContain("- Workspace directory: `/repo/workspace`");
    expect(result).toContain("- Workspace link path: `/repo/invoke/.rundown/workspace.link`");
    expect(result).toContain("- Linked workspace: `true`");
    expect(result).toContain("- Prediction design directory: `design`");
    expect(result).toContain("- Prediction specs directory: `specs`");
    expect(result).toContain("- Prediction migrations directory: `migrations`");
    expect(result).toContain("- Prediction design path: `/repo/workspace/design`");
    expect(result).toContain("- Prediction specs path: `/repo/workspace/specs`");
    expect(result).toContain("- Prediction migrations path: `/repo/workspace/migrations`");
    expect(result).toContain("## Variables\n\nbranch=main\nticket=ENG-42");
  });

  it("renders (none) in the variables section when userVariables is empty", () => {
    const result = renderTemplate(DEFAULT_TASK_TEMPLATE, {
      task: "Ship release",
      file: "tasks.md",
      context: "- [ ] Ship release",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] Ship release",
      invocationDir: "/repo/workspace",
      workspaceDir: "/repo/workspace",
      workspaceLinkPath: "",
      isLinkedWorkspace: "false",
      workspaceDesignDir: "design",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspaceDesignPath: "/repo/workspace/design",
      workspaceSpecsPath: "/repo/workspace/specs",
      workspaceMigrationsPath: "/repo/workspace/migrations",
      userVariables: "(none)",
    });

    expect(result).toContain("- Invocation directory: `/repo/workspace`");
    expect(result).toContain("- Workspace directory: `/repo/workspace`");
    expect(result).toContain("- Workspace link path: ``");
    expect(result).toContain("- Linked workspace: `false`");
    expect(result).toContain("- Prediction design directory: `design`");
    expect(result).toContain("- Prediction specs directory: `specs`");
    expect(result).toContain("- Prediction migrations directory: `migrations`");
    expect(result).toContain("- Prediction design path: `/repo/workspace/design`");
    expect(result).toContain("- Prediction specs path: `/repo/workspace/specs`");
    expect(result).toContain("- Prediction migrations path: `/repo/workspace/migrations`");
    expect(result).toContain("## Variables\n\n(none)");
  });

  it("documents built-in planning prefixes and composition in default plan templates", () => {
    expect(DEFAULT_PLAN_TEMPLATE).toContain("## Rundown feature reference for planning");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`verify:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`fast:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`profile=<name>`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`memory:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`include: <path>`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- `- [ ] profile=fast, verify: release checks pass`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- `- [ ] profile=complex; memory: record migration constraints`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked items");

    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("## Rundown feature reference for deep planning");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`verify:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`fast:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`profile=<name>`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`memory:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`include: <path>`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- `- [ ] profile=fast, verify: release checks pass`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- `- [ ] profile=complex; memory: record migration constraints`");
  });

  it("maps sample prompts to rundown workflows and preserves migration + fallback guidance in help template", () => {
    expect(DEFAULT_HELP_TEMPLATE).toContain("\"plan this\" maps to `rundown plan`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("\"explore this\" maps to `rundown explore`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("Signals: \"plan this\", \"break this into tasks\"");
    expect(DEFAULT_HELP_TEMPLATE).toContain("Signals: \"explore this\", \"analyze then plan\"");

    expect(DEFAULT_HELP_TEMPLATE).toContain("Repository-specific migration guidance");
    expect(DEFAULT_HELP_TEMPLATE).toContain("Migration files are Markdown task files under `migrations/`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("<number>. <title>.md");

    expect(DEFAULT_HELP_TEMPLATE).toContain("Linked workspace awareness (`rundown start`)");
    expect(DEFAULT_HELP_TEMPLATE).toContain(".rundown/workspace.link");

    expect(DEFAULT_HELP_TEMPLATE).toContain("Fallback mode for non-rundown questions");
    expect(DEFAULT_HELP_TEMPLATE).toContain("answer directly as a normal assistant");
  });
});
