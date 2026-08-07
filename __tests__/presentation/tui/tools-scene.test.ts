import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILT_IN_TOOL_CATALOG,
  BUILT_IN_TOOL_DOCS_PATH,
  closeToolsScenePager,
  createBuiltInsVisibilitySession,
  createToolsSceneState,
  discoverCustomTools,
  editSelectedCustomTool,
  findBuiltInToolDocsLine,
  inspectCustomToolTemplate,
  inspectSelectedCustomTool,
  openToolsScene,
  reloadCustomToolsAction,
  renderToolsSceneLines,
  resolveBuiltInToolDocsTarget,
  resolveToolDirectories,
  toggleBuiltInsVisibility,
} from "../../../src/presentation/tui/scenes/tools.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("tools scene custom tool discovery", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = makeTempDir("tools-scene-");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("defaults to <config-dir>/tools when toolDirs is missing", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({}));

    const directories = resolveToolDirectories(configDir);
    expect(directories).toEqual([path.join(configDir, "tools")]);
  });

  it("resolves relative entries against config dir and preserves listed order", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const config = { toolDirs: ["tools", "shared-tools"] };

    const directories = resolveToolDirectories(configDir, config);
    expect(directories).toEqual([
      path.join(configDir, "tools"),
      path.join(configDir, "shared-tools"),
    ]);
  });

  it("keeps absolute entries verbatim", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const absolute = path.join(workspaceRoot, "absolute-tools");
    const directories = resolveToolDirectories(configDir, { toolDirs: [absolute, "relative"] });
    expect(directories[0]).toBe(absolute);
    expect(directories[1]).toBe(path.join(configDir, "relative"));
  });

  it("returns no entries when no tool directories exist", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({}));

    const result = discoverCustomTools({ configDirPath: configDir });
    expect(result.entries).toEqual([]);
    expect(result.directories).toEqual([path.join(configDir, "tools")]);
  });

  it("scans .md and .js files and derives names from basename without extension", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "summary template");
    fs.writeFileSync(path.join(toolsDir, "triage-issue.js"), "module.exports = {}\n");
    fs.writeFileSync(path.join(toolsDir, "ignored.txt"), "nope");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));

    const result = discoverCustomTools({ configDirPath: configDir });
    const byName = result.entries.map((entry) => ({
      name: entry.name,
      extension: entry.extension,
      filePath: entry.filePath,
    }));
    expect(byName).toEqual([
      {
        name: "summarize",
        extension: ".md",
        filePath: path.join(toolsDir, "summarize.md"),
      },
      {
        name: "triage-issue",
        extension: ".js",
        filePath: path.join(toolsDir, "triage-issue.js"),
      },
    ]);
  });

  it("preserves directory order so first directory wins later precedence step", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const primary = path.join(configDir, "tools");
    const secondary = path.join(configDir, "shared-tools");
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(secondary, { recursive: true });
    fs.writeFileSync(path.join(primary, "post-on-gitea.md"), "primary");
    fs.writeFileSync(path.join(secondary, "post-on-gitea.md"), "secondary");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["tools", "shared-tools"] }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].directory).toBe(primary);
    expect(result.entries[1].directory).toBe(secondary);
  });

  it("ignores directories that do not exist without throwing", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["does-not-exist"] }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });
    expect(result.entries).toEqual([]);
    expect(result.directories).toEqual([path.join(configDir, "does-not-exist")]);
  });

  it("marks duplicate tool names as shadowed and groups them under the winner", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const primary = path.join(configDir, "tools");
    const secondary = path.join(configDir, "shared-tools");
    const tertiary = path.join(configDir, "extra-tools");
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(secondary, { recursive: true });
    fs.mkdirSync(tertiary, { recursive: true });
    fs.writeFileSync(path.join(primary, "post-on-gitea.md"), "primary");
    fs.writeFileSync(path.join(primary, "summarize.md"), "summary");
    fs.writeFileSync(path.join(secondary, "post-on-gitea.md"), "secondary");
    fs.writeFileSync(path.join(tertiary, "post-on-gitea.md"), "tertiary");
    fs.writeFileSync(path.join(tertiary, "triage.js"), "module.exports = {}\n");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["tools", "shared-tools", "extra-tools"] }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });

    // tools array contains only winners in discovery order
    expect(result.tools.map((tool: any) => ({ name: tool.name, directory: tool.directory }))).toEqual([
      { name: "post-on-gitea", directory: primary },
      { name: "summarize", directory: primary },
      { name: "triage", directory: tertiary },
    ]);

    const winner = result.tools.find((tool: any) => tool.name === "post-on-gitea");
    expect(winner).toBeDefined();
    expect(winner.shadowed).toBe(false);
    expect(winner.shadows).toHaveLength(2);
    expect(winner.shadows.map((entry: any) => entry.directory)).toEqual([secondary, tertiary]);
    for (const shadow of winner.shadows) {
      expect(shadow.shadowed).toBe(true);
      expect(shadow.shadowedBy.filePath).toBe(winner.filePath);
    }

    const summarize = result.tools.find((tool: any) => tool.name === "summarize");
    expect(summarize.shadows).toEqual([]);

    // flat entries still contains every discovered file in discovery order
    expect(result.entries.map((entry: any) => ({ name: entry.name, directory: entry.directory, shadowed: entry.shadowed }))).toEqual([
      { name: "post-on-gitea", directory: primary, shadowed: false },
      { name: "summarize", directory: primary, shadowed: false },
      { name: "post-on-gitea", directory: secondary, shadowed: true },
      { name: "post-on-gitea", directory: tertiary, shadowed: true },
      { name: "triage", directory: tertiary, shadowed: false },
    ]);
  });

  it("annotates winning tools with commands.tools.<name> worker override summary", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "post-on-gitea.md"), "primary");
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "summary");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        toolDirs: ["tools"],
        commands: {
          tools: {
            "post-on-gitea": ["opencode", "run", "--model", "gpt-5.3-mini", "--no-approval"],
          },
        },
      }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });

    const winner = result.tools.find((tool: any) => tool.name === "post-on-gitea");
    expect(winner).toBeDefined();
    expect(winner.override).toBeDefined();
    expect(winner.override.key).toBe("commands.tools.post-on-gitea");
    expect(winner.override.configuredName).toBe("post-on-gitea");
    expect(winner.override.worker).toEqual([
      "opencode",
      "run",
      "--model",
      "gpt-5.3-mini",
      "--no-approval",
    ]);
    expect(winner.override.workerSummary).toBe(
      "opencode run --model gpt-5.3-mini --no-approval",
    );
    expect(winner.override.description).toBe(
      "commands.tools.post-on-gitea overrides worker for this prefix",
    );

    const summarize = result.tools.find((tool: any) => tool.name === "summarize");
    expect(summarize).toBeDefined();
    expect(summarize.override).toBeUndefined();
  });

  it("annotates override even when worker tokens are empty", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "triage.md"), "triage");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        toolDirs: ["tools"],
        commands: { tools: { triage: [] } },
      }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });
    const winner = result.tools.find((tool: any) => tool.name === "triage");
    expect(winner.override).toBeDefined();
    expect(winner.override.worker).toEqual([]);
    expect(winner.override.workerSummary).toBe("");
    expect(winner.override.description).toBe(
      "commands.tools.triage overrides worker for this prefix",
    );
  });

  it("annotates every built-in catalog row with docs navigation metadata", () => {
    expect(BUILT_IN_TOOL_DOCS_PATH).toBe("README.md");
    expect(BUILT_IN_TOOL_CATALOG.length).toBeGreaterThan(0);
    for (const row of BUILT_IN_TOOL_CATALOG) {
      expect(row.docsPath).toBe(BUILT_IN_TOOL_DOCS_PATH);
      expect(typeof row.docsAnchor).toBe("string");
      expect(row.docsAnchor.length).toBeGreaterThan(0);
      expect(typeof row.docsSection).toBe("string");
      expect(row.docsSection.length).toBeGreaterThan(0);
      expect(typeof row.docsBulletNeedle).toBe("string");
      expect(row.docsBulletNeedle.length).toBeGreaterThan(0);
    }
  });

  it("points every built-in row at the unified prefix tool chain section", () => {
    for (const row of BUILT_IN_TOOL_CATALOG) {
      expect(row.docsAnchor).toBe("unified-prefix-tool-chain");
      expect(row.docsSection).toBe("Unified prefix tool chain");
    }
  });

  it("resolveBuiltInToolDocsTarget returns the row's docs path, anchor, section, and bullet needle", () => {
    const verify = BUILT_IN_TOOL_CATALOG.find((row) => row.label === "Verify-only");
    expect(verify).toBeDefined();
    const target = resolveBuiltInToolDocsTarget(verify);
    expect(target).toEqual({
      docsPath: BUILT_IN_TOOL_DOCS_PATH,
      docsAnchor: "unified-prefix-tool-chain",
      docsSection: "Unified prefix tool chain",
      docsBulletNeedle: "verify-only:",
      label: "Verify-only",
    });
  });

  it("resolveBuiltInToolDocsTarget returns undefined for non-row inputs", () => {
    expect(resolveBuiltInToolDocsTarget(undefined)).toBeUndefined();
    expect(resolveBuiltInToolDocsTarget(null)).toBeUndefined();
    expect(resolveBuiltInToolDocsTarget("not-a-row" as unknown as object)).toBeUndefined();
  });

  it("findBuiltInToolDocsLine locates the bullet line within the named section", () => {
    const docs = [
      "# Configuration",
      "",
      "## Other section",
      "",
      "- not the right place",
      "",
      "## Unified prefix tool chain",
      "",
      "Built-in handler aliases:",
      "",
      "- verify-only: `verify:`, `confirm:`, `check:`",
      "- memory capture: `memory:`",
      "",
      "## Tool templates",
      "- ignored",
    ].join("\n");

    const verifyRow = BUILT_IN_TOOL_CATALOG.find((row) => row.label === "Verify-only");
    const memoryRow = BUILT_IN_TOOL_CATALOG.find((row) => row.label === "Memory capture");
    const verifyLine = findBuiltInToolDocsLine(docs, resolveBuiltInToolDocsTarget(verifyRow));
    const memoryLine = findBuiltInToolDocsLine(docs, resolveBuiltInToolDocsTarget(memoryRow));

    expect(verifyLine).toBe(11);
    expect(memoryLine).toBe(12);
  });

  it("findBuiltInToolDocsLine falls back to the section heading when the bullet is missing", () => {
    const docs = [
      "# Configuration",
      "",
      "## Unified prefix tool chain",
      "",
      "(intentionally no bullets)",
      "",
      "## Tool templates",
    ].join("\n");

    const target = resolveBuiltInToolDocsTarget(
      BUILT_IN_TOOL_CATALOG.find((row) => row.label === "Verify-only"),
    );
    expect(findBuiltInToolDocsLine(docs, target)).toBe(3);
  });

  it("findBuiltInToolDocsLine returns line 1 when the section cannot be found", () => {
    const docs = "# Just a title\n\nNo matching section here.\n";
    const target = resolveBuiltInToolDocsTarget(BUILT_IN_TOOL_CATALOG[0]);
    expect(findBuiltInToolDocsLine(docs, target)).toBe(1);
  });

  it("findBuiltInToolDocsLine ignores bullets inside later sections", () => {
    const docs = [
      "## Unified prefix tool chain",
      "",
      "(no useful bullet here)",
      "",
      "## Other section",
      "",
      "- verify-only: should NOT match here",
    ].join("\n");

    const target = resolveBuiltInToolDocsTarget(
      BUILT_IN_TOOL_CATALOG.find((row) => row.label === "Verify-only"),
    );
    expect(findBuiltInToolDocsLine(docs, target)).toBe(1);
  });

  it("matches override key case-insensitively against discovered tool names", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "Summarize.md"), "summary");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        toolDirs: ["tools"],
        commands: { tools: { Summarize: ["opencode"] } },
      }),
    );

    const result = discoverCustomTools({ configDirPath: configDir });
    const winner = result.tools.find((tool: any) => tool.name === "summarize");
    expect(winner).toBeDefined();
    expect(winner.override).toBeDefined();
    expect(winner.override.configuredName).toBe("Summarize");
    expect(winner.override.key).toBe("commands.tools.Summarize");
  });
});

describe("tools scene inspect template", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = makeTempDir("tools-inspect-");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("inspectCustomToolTemplate reads .md template into a pager state", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    const filePath = path.join(toolsDir, "summarize.md");
    const content = "# Summarize\n\nLine A\nLine B\n";
    fs.writeFileSync(filePath, content);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));

    const { tools } = discoverCustomTools({ configDirPath: configDir });
    const result: any = inspectCustomToolTemplate({ tool: tools[0], viewportHeight: 10 });

    expect(result.error).toBeUndefined();
    expect(result.pager).toBeDefined();
    expect(result.pager.title).toBe("Tool template: summarize");
    expect(result.pager.filePath).toBe(filePath);
    expect(result.pager.totalLines).toBeGreaterThan(0);
    expect(result.pager.lines.join("\n")).toContain("Summarize");
    expect(result.pager.viewportHeight).toBe(10);
    expect(result.pager.offset).toBe(0);
  });

  it("inspectCustomToolTemplate opens .js source the same way as templates", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    const filePath = path.join(toolsDir, "triage.js");
    fs.writeFileSync(filePath, "module.exports = {};\n");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));

    const { tools } = discoverCustomTools({ configDirPath: configDir });
    const result: any = inspectCustomToolTemplate({ tool: tools[0] });

    expect(result.pager).toBeDefined();
    expect(result.pager.title).toBe("Tool source: triage");
    expect(result.pager.filePath).toBe(filePath);
  });

  it("inspectCustomToolTemplate returns an error when the file cannot be read", () => {
    const result: any = inspectCustomToolTemplate({
      tool: { name: "missing", filePath: "/nope/missing.md", extension: ".md" },
    });
    expect(result.pager).toBeUndefined();
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("missing.md");
  });

  it("inspectSelectedCustomTool sets pager state on the scene state", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "template");
    fs.writeFileSync(path.join(toolsDir, "triage.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));
    const { tools } = discoverCustomTools({ configDirPath: configDir });

    const baseState = {
      ...createToolsSceneState(),
      configDirPath: configDir,
      customToolWinners: tools,
      loading: false,
      selectedIndex: 1,
    };
    const next: any = inspectSelectedCustomTool({ state: baseState });
    expect(next.pager).toBeDefined();
    expect(next.pager.title).toBe("Tool source: triage");
    expect(next.banner).toBe("");
  });

  it("inspectSelectedCustomTool sets a banner when there are no custom tools", () => {
    const next: any = inspectSelectedCustomTool({ state: { ...createToolsSceneState(), loading: false } });
    expect(next.pager).toBeNull();
    expect(next.banner).toContain("No custom tool");
  });

  it("renderToolsSceneLines delegates to the pager when one is active", () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "template body");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));
    const { tools } = discoverCustomTools({ configDirPath: configDir });

    const baseState = {
      ...createToolsSceneState(),
      configDirPath: configDir,
      customToolWinners: tools,
      loading: false,
    };
    const next: any = inspectSelectedCustomTool({ state: baseState });
    const lines = renderToolsSceneLines({ state: next });
    const text = lines.join("\n");
    expect(text).toContain("Tool template: summarize");
    expect(text).toContain("template body");
  });

  it("closeToolsScenePager clears the pager from the scene state", () => {
    const state: any = {
      ...createToolsSceneState(),
      pager: { title: "x", filePath: "x", lines: [], totalLines: 0, offset: 0, viewportHeight: 10 },
    };
    const next = closeToolsScenePager({ state });
    expect(next.pager).toBeNull();
  });
});

describe("tools scene edit prompt", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = makeTempDir("tools-edit-");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("editSelectedCustomTool sets a banner when no custom tools exist", async () => {
    const calls: string[] = [];
    const next: any = await editSelectedCustomTool({
      state: { ...createToolsSceneState(), loading: false },
      launchEditor: () => {
        calls.push("launched");
        return { ok: true };
      },
      reload: async ({ state }) => state,
    });
    expect(calls).toEqual([]);
    expect(next.banner).toContain("No custom tool");
  });

  it("editSelectedCustomTool launches the editor with the selected tool path and reloads on return", async () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    const summarizePath = path.join(toolsDir, "summarize.md");
    fs.writeFileSync(summarizePath, "template");
    fs.writeFileSync(path.join(toolsDir, "triage.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["tools"] }),
    );
    const { tools } = discoverCustomTools({ configDirPath: configDir });

    const baseState = {
      ...createToolsSceneState(),
      configDirPath: configDir,
      customToolWinners: tools,
      customTools: tools,
      loading: false,
      selectedIndex: 0,
    };

    const events: string[] = [];
    let launchedPath = "";
    let reloaded = false;
    const next: any = await editSelectedCustomTool({
      state: baseState,
      currentWorkingDirectory: workspaceRoot,
      suspendTui: () => events.push("suspend"),
      resumeTui: () => events.push("resume"),
      launchEditor: (filePath: string) => {
        launchedPath = filePath;
        events.push("launch");
        return { ok: true };
      },
      reload: async ({ state }: any) => {
        reloaded = true;
        events.push("reload");
        return { ...state, customToolWinners: tools, customTools: tools };
      },
    });

    expect(launchedPath).toBe(summarizePath);
    expect(reloaded).toBe(true);
    expect(events).toEqual(["suspend", "launch", "resume", "reload"]);
    expect(next.banner).toBe("");
    expect(next.selectedIndex).toBe(0);
    expect(next.customToolWinners).toEqual(tools);
  });

  it("editSelectedCustomTool resumes the TUI even when the editor throws", async () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "template");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));
    const { tools } = discoverCustomTools({ configDirPath: configDir });

    const events: string[] = [];
    let reloadCalled = false;
    const next: any = await editSelectedCustomTool({
      state: {
        ...createToolsSceneState(),
        configDirPath: configDir,
        customToolWinners: tools,
        loading: false,
      },
      suspendTui: () => events.push("suspend"),
      resumeTui: () => events.push("resume"),
      launchEditor: () => {
        events.push("launch-throw");
        throw new Error("spawn failed");
      },
      reload: async ({ state }: any) => {
        reloadCalled = true;
        return state;
      },
    });

    expect(events).toEqual(["suspend", "launch-throw", "resume"]);
    expect(reloadCalled).toBe(false);
    expect(next.banner).toContain("spawn failed");
  });

  it("editSelectedCustomTool surfaces editor failure result without reloading", async () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "template");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));
    const { tools } = discoverCustomTools({ configDirPath: configDir });

    let reloadCalled = false;
    const next: any = await editSelectedCustomTool({
      state: {
        ...createToolsSceneState(),
        configDirPath: configDir,
        customToolWinners: tools,
        loading: false,
      },
      launchEditor: () => ({ ok: false, reason: "editor-not-found", message: "no editor available" }),
      reload: async ({ state }: any) => {
        reloadCalled = true;
        return state;
      },
    });

    expect(reloadCalled).toBe(false);
    expect(next.banner).toBe("no editor available");
  });
});

describe("tools scene reload action", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = makeTempDir("tools-scene-reload-");
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("reloadCustomToolsAction re-runs discovery and surfaces the new entries", async () => {
    const configDir = path.join(workspaceRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ toolDirs: ["tools"] }));
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "template");

    const initialState = {
      ...createToolsSceneState(),
      configDirPath: configDir,
      loading: false,
      customToolWinners: [],
      customTools: [],
      toolDirectories: [toolsDir],
      builtInsVisible: false,
      selectedIndex: 0,
    };

    // Add another tool on disk after initial discovery to simulate a change.
    fs.writeFileSync(path.join(toolsDir, "triage.js"), "module.exports = {};\n");

    const reload = async ({ state }: any) => {
      const { directories, entries, tools } = discoverCustomTools({ configDirPath: configDir });
      return {
        ...state,
        loading: false,
        configDirPath: configDir,
        toolDirectories: directories,
        customTools: entries,
        customToolWinners: tools,
      };
    };

    const next: any = await reloadCustomToolsAction({
      state: initialState,
      currentWorkingDirectory: workspaceRoot,
      reload,
    });

    expect(next.loading).toBe(false);
    expect(next.customToolWinners.map((tool: any) => tool.name)).toEqual([
      "summarize",
      "triage",
    ]);
    expect(next.builtInsVisible).toBe(false);
    expect(next.banner).toContain("Reloaded 2 custom tools");
    expect(next.banner).toContain("0 shadowed");
    expect(next.banner).toContain("1 directory");
  });

  it("reloadCustomToolsAction clamps selectedIndex when the winner list shrinks", async () => {
    const initialState = {
      ...createToolsSceneState(),
      loading: false,
      selectedIndex: 5,
      builtInsVisible: true,
    };

    const reload = async ({ state }: any) => ({
      ...state,
      loading: false,
      customToolWinners: [{ name: "alpha" }],
      customTools: [{ name: "alpha" }],
      toolDirectories: ["/tmp/tools"],
    });

    const next: any = await reloadCustomToolsAction({
      state: initialState,
      reload,
    });

    expect(next.selectedIndex).toBe(0);
    expect(next.banner).toContain("Reloaded 1 custom tool");
  });

  it("reloadCustomToolsAction surfaces failure without resetting state", async () => {
    const initialState = {
      ...createToolsSceneState(),
      loading: false,
      customToolWinners: [{ name: "kept" }],
      customTools: [{ name: "kept" }],
      toolDirectories: ["/tmp/tools"],
    };

    const next: any = await reloadCustomToolsAction({
      state: initialState,
      reload: async () => {
        throw new Error("disk unreadable");
      },
    });

    expect(next.banner).toContain("Reload failed");
    expect(next.banner).toContain("disk unreadable");
    expect(next.customToolWinners).toEqual(initialState.customToolWinners);
  });
});

describe("tools scene built-ins visibility session", () => {
  it("shows built-ins on first open and hides them on subsequent opens within the same session", () => {
    const session = createBuiltInsVisibilitySession();
    expect(session.openedOnce).toBe(false);
    expect(session.explicit).toBeUndefined();

    const firstOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(firstOpen.builtInsVisible).toBe(true);
    expect(session.openedOnce).toBe(true);

    const secondOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(secondOpen.builtInsVisible).toBe(false);

    const thirdOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(thirdOpen.builtInsVisible).toBe(false);
  });

  it("toggleBuiltInsVisibility flips visibility and persists the choice across subsequent opens", () => {
    const session = createBuiltInsVisibilitySession();
    const firstOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(firstOpen.builtInsVisible).toBe(true);

    const afterToggle = toggleBuiltInsVisibility({ session, state: firstOpen });
    expect(afterToggle.builtInsVisible).toBe(false);
    expect(session.explicit).toBe(false);

    // Subsequent opens honor the explicit choice instead of the
    // first-run/subsequent-run defaults.
    const secondOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(secondOpen.builtInsVisible).toBe(false);

    const reShown = toggleBuiltInsVisibility({ session, state: secondOpen });
    expect(reShown.builtInsVisible).toBe(true);
    expect(session.explicit).toBe(true);

    const thirdOpen = openToolsScene({ session, state: createToolsSceneState() });
    expect(thirdOpen.builtInsVisible).toBe(true);
  });

  it("openToolsScene treats a missing session as a first-run open", () => {
    const opened = openToolsScene({ state: createToolsSceneState() });
    expect(opened.builtInsVisible).toBe(true);
  });
});
