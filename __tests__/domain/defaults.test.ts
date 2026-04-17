import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEP_PLAN_TEMPLATE,
  DEFAULT_HELP_TEMPLATE,
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_RESEARCH_VERIFY_TEMPLATE,
  DEFAULT_RESOLVE_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_PLAN_LOOP_TEMPLATE,
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
      workspaceDesignPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
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
    expect(result).toContain("- Prediction design placement: `sourcedir`");
    expect(result).toContain("- Prediction specs placement: `sourcedir`");
    expect(result).toContain("- Prediction migrations placement: `sourcedir`");
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
      workspaceDesignPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
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
    expect(result).toContain("- Prediction design placement: `sourcedir`");
    expect(result).toContain("- Prediction specs placement: `sourcedir`");
    expect(result).toContain("- Prediction migrations placement: `sourcedir`");
    expect(result).toContain("- Prediction design path: `/repo/workspace/design`");
    expect(result).toContain("- Prediction specs path: `/repo/workspace/specs`");
    expect(result).toContain("- Prediction migrations path: `/repo/workspace/migrations`");
    expect(result).toContain("## Variables\n\n(none)");
  });

  it("documents built-in planning prefixes and composition in default plan templates", () => {
    expect(DEFAULT_PLAN_TEMPLATE).toContain("## Rundown feature reference for planning");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`verify:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`fast:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`get:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`loop:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`profile=<name>`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`memory:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`include: <path>`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Prefix decision table (choose the closest matching intent)");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Discover concrete facts for downstream tasks");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Repeat work until an explicit stop condition");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- `- [ ] profile=fast, verify: release checks pass`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- `- [ ] profile=complex; memory: record migration constraints`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("there is no explicit target file write/edit/create in that task");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Do NOT use `memory:` when the task asks to write/edit/create/update any file");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("prepare notes section in this doc");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Explicit write-target examples that must remain normal execution TODOs");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- [ ] Write findings to docs/research-notes.md");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("- [ ] Research rollout risks and write findings into docs/rollout-plan.md");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("If a directive parent suggests memory capture intent");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("no inherited `memory:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("split into separate TODOs when possible");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Mixed-intent split example (correct)");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`- [ ] memory: research rollout constraints`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`- [ ] Write rollout findings to docs/rollout-plan.md`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("\"research and write findings into X.md\"");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Author new memory-capture TODOs with the canonical `memory:` prefix only");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`remember:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`memorize:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`inventory:`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked items");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("Output contract requirements for agentic tasks");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("For every newly authored `get:` task, include this canonical inline output contract sentence in task text");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`Output one item per line using plain lines or Markdown list items (bulleted or numbered only, no JSON). If none are found, output exactly nothing.`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("avoid a literal `get-result:` prefix in output instructions");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("that mixes iterative discovery with durable context capture");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`- [ ] loop: audit rollout blockers until no new blockers appear`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`  - [ ] get: list one blocker per line. Output one item per line using plain lines or Markdown list items (bulleted or numbered only, no JSON). If none are found, output exactly nothing.`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`  - [ ] memory: capture blocker trends that should influence the next pass`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("`  - [ ] end: stop when two consecutive passes produce no new blockers`");
    expect(DEFAULT_PLAN_TEMPLATE).toContain("explicit terminal stop condition via an `end:` step");

    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("## Loop composition requirements");
    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("`get:` discovers an iterable set of items/values");
    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("`end:` defines a deterministic stop rule");
    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("`for:` iterates discovered values and runs per-item implementation/review child tasks");
    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("For loop-oriented tasks, require explicit `get:` + `for:` + `end:` composition");
    expect(DEFAULT_PLAN_LOOP_TEMPLATE).toContain("Any `loop:` task must include an explicit terminal `end:` stop condition");

    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("## Rundown feature reference for deep planning");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`verify:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`fast:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`get:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`loop:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`profile=<name>`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`memory:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`include: <path>`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Prefix decision table (choose the closest matching intent)");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Capture reusable context for later tasks (no file write/edit target)");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Apply a small mechanical change");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- `- [ ] profile=fast, verify: release checks pass`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- `- [ ] profile=complex; memory: record migration constraints`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Never invent child TODO items based on examples, sample output, or hypothetical scenarios found in the document.");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("actual work described by the parent task and document context");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("there is no explicit target file write/edit/create in that child task");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Do NOT use `memory:` when the child task asks to write/edit/create/update any file");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("prepare notes section in this doc");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Explicit write-target child examples that must remain normal execution TODOs");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- [ ] Write findings to docs/research-notes.md");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("- [ ] Research rollout risks and write findings into docs/rollout-plan.md");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("If a parent directive suggests memory capture intent");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("no inherited `memory:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("split into separate child TODOs when possible");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Mixed-intent child split example (correct)");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`- [ ] memory: research rollout constraints`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`- [ ] Write rollout findings to docs/rollout-plan.md`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("\"research and write findings into X.md\"");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Author new child memory-capture TODOs with the canonical `memory:` prefix only");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`remember:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`memorize:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`inventory:`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Remove obviously wrong duplicate directive groups/prefix wrappers and duplicate inline prefixes on unchecked child items");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("If child plan coverage is already sufficient, leave the file unchanged.");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("Output contract requirements for agentic tasks");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("For every newly authored `get:` child task, include this canonical inline output contract sentence in task text");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`Output one item per line using plain lines or Markdown list items (bulleted or numbered only, no JSON). If none are found, output exactly nothing.`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("avoid a literal `get-result:` prefix in output instructions");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("that mixes iterative discovery with durable context capture");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`- [ ] loop: audit rollout blockers until no new blockers appear`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`  - [ ] get: list one blocker per line. Output one item per line using plain lines or Markdown list items (bulleted or numbered only, no JSON). If none are found, output exactly nothing.`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`  - [ ] memory: capture blocker trends that should influence the next pass`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("`  - [ ] end: stop when two consecutive passes produce no new blockers`");
    expect(DEFAULT_DEEP_PLAN_TEMPLATE).toContain("explicit terminal stop condition via an `end:` step");
  });

  it("enforces deterministic query execution output contracts", () => {
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("## Output contract (strict)");
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("Output extracted items only.");
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("Emit exactly one extracted item per line.");
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("Preserve discovery order.");
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("Do not add commentary, headings, labels, code fences, or JSON.");
    expect(DEFAULT_QUERY_EXECUTION_TEMPLATE).toContain("If no items are found, write an empty file.");

    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("## Output contract (strict)");
    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("Output extracted items only.");
    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("Emit exactly one extracted item per line.");
    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("Preserve discovery order.");
    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("Do not add commentary, headings, labels, code fences, or JSON.");
    expect(DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE).toContain("If no items are found, print nothing.");
  });

  it("keeps memory-vs-write classification fixtures consistent in plan and deep-plan templates", () => {
    const classificationFixtures = [
      {
        label: "research-only capture with no file target",
        taskText: "research rollout constraints",
        expectedDecision: "memory",
        evidence: "`- [ ] memory: research rollout constraints`",
      },
      {
        label: "explicit write target",
        taskText: "Write findings to docs/research-notes.md",
        expectedDecision: "execution",
        evidence: "- [ ] Write findings to docs/research-notes.md",
      },
      {
        label: "mixed research and write",
        taskText: "Research rollout risks and write findings into docs/rollout-plan.md",
        expectedDecision: "execution",
        evidence: "- [ ] Research rollout risks and write findings into docs/rollout-plan.md",
      },
      {
        label: "implicit write target",
        taskText: "prepare notes section in this doc",
        expectedDecision: "execution",
        evidence: "prepare notes section in this doc",
      },
      {
        label: "parent memory intent does not override child write task",
        taskText: "directive parent memory intent with child write language",
        expectedDecision: "execution",
        evidence: "no inherited `memory:`",
      },
    ] as const;

    const templateCases = [
      {
        label: "plan",
        template: DEFAULT_PLAN_TEMPLATE,
        memoryRule: "Use `memory:` when the objective is research/inventory/constraints/reference capture for later tasks and there is no explicit target file write/edit/create in that task.",
        executionRule:
          "Do NOT use `memory:` when the task asks to write/edit/create/update any file or persistent document artifact (including \"prepare notes section in this doc\" or \"research and write findings into X.md\"). These must remain normal execution TODOs.",
        splitRule: "split into separate TODOs when possible",
      },
      {
        label: "deep-plan",
        template: DEFAULT_DEEP_PLAN_TEMPLATE,
        memoryRule:
          "Use `memory:` when the child task objective is research/inventory/constraints/reference capture for later tasks and there is no explicit target file write/edit/create in that child task.",
        executionRule:
          "Do NOT use `memory:` when the child task asks to write/edit/create/update any file or persistent document artifact (including \"prepare notes section in this doc\" or \"research and write findings into X.md\"). These must remain normal execution TODOs.",
        splitRule: "split into separate child TODOs when possible",
      },
    ] as const;

    for (const templateCase of templateCases) {
      expect(templateCase.template, `${templateCase.label} memory rule`).toContain(templateCase.memoryRule);
      expect(templateCase.template, `${templateCase.label} non-memory rule`).toContain(templateCase.executionRule);
      expect(templateCase.template, `${templateCase.label} mixed-intent split guidance`).toContain(templateCase.splitRule);

      for (const fixture of classificationFixtures) {
        expect(templateCase.template, `${templateCase.label} fixture (${fixture.expectedDecision}): ${fixture.label} :: ${fixture.taskText}`).toContain(
          fixture.evidence,
        );

        if (fixture.expectedDecision === "memory") {
          expect(templateCase.template, `${templateCase.label} memory fixture should keep memory rule`).toContain(
            templateCase.memoryRule,
          );
          continue;
        }

        expect(templateCase.template, `${templateCase.label} execution fixture should keep non-memory rule`).toContain(
          templateCase.executionRule,
        );
      }
    }
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

    expect(DEFAULT_HELP_TEMPLATE).toContain("Author new tasks with canonical prefixes only: `verify:`, `memory:`, `fast:`, `get:`, and `loop:`.");
    expect(DEFAULT_HELP_TEMPLATE).toContain("Treat alias prefixes (`check:`, `confirm:`, `quick:`, `raw:`, `memorize:`, `remember:`, `inventory:`) as legacy compatibility forms and normalize them to canonical names when encountered.");

    expect(DEFAULT_HELP_TEMPLATE).toContain("Customizable templates:");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`agent.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`plan-loop.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`deep-plan.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`discuss-finished.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`research-verify.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`research-repair.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`research-resolve.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`research-output-contract.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`undo.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`test-verify.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`test-future.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`test-materialized.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`migrate*.md`");
    expect(DEFAULT_HELP_TEMPLATE).toContain("`query-*.md`");
  });

  it("keeps research verification template deterministic and outcome-oriented", () => {
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("Evaluate the output against outcome-level constraints:");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- Existing checkbox states are unchanged.");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- No new unchecked TODO items were introduced.");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- Original author intent is preserved semantically");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- Enrichment quality is present");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("Use a deterministic verdict contract so orchestration can parse your result.");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- `OK`");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("- `NOT_OK: <specific failure reason>`");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("Name the missing or violated outcome-level constraint directly.");
    expect(DEFAULT_RESEARCH_VERIFY_TEMPLATE).toContain("Keep the reason concrete and repairable in one short sentence.");
  });
});
