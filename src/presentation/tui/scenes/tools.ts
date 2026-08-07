// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import {
  createPagerState,
  renderPagerLines,
} from "../components/pager.ts";
import { launchEditor as defaultLaunchEditor } from "../components/editor-launch.ts";

const TOOLS_DIRECTORY_NAME = "tools";
const CONFIG_FILE_NAME = "config.json";
const TOOL_TEMPLATE_EXTENSION = ".md";
const TOOL_JS_EXTENSION = ".js";

type JsonRecord = Record<string, unknown>;
type PagerState = ReturnType<typeof createPagerState>;
type LaunchEditorResult = ReturnType<typeof defaultLaunchEditor>;

type ToolFileEntry = {
  name: string;
  extension: typeof TOOL_JS_EXTENSION | typeof TOOL_TEMPLATE_EXTENSION;
  fileName: string;
  filePath: string;
  directory: string;
};

type ShadowedToolEntry = ToolFileEntry & {
  shadowed: true;
  shadowedBy: {
    filePath: string;
    directory: string;
  };
};

type WinningToolEntry = ToolFileEntry & {
  shadowed: false;
  shadows: ShadowedToolEntry[];
};

type ToolsDiscoveryResult = {
  directories: string[];
  entries: Array<WinningToolEntry | ShadowedToolEntry>;
  tools: WinningToolEntry[];
};

type BuiltInsVisibilitySession = {
  explicit?: boolean;
  openedOnce: boolean;
};

type BuiltInToolDocsTarget = {
  docsPath: string;
  docsAnchor: string;
  docsSection: string;
  docsBulletNeedle: string;
  label: string;
};

type BuiltInToolCatalogRow = {
  label: string;
  prefixes: string[];
  docsPath: string;
  docsAnchor: string;
  docsSection: string;
  docsBulletNeedle: string;
};

type ToolsSceneState = {
  configDirPath: string;
  toolDirectories: string[];
  customTools: Array<WinningToolEntry | ShadowedToolEntry>;
  customToolWinners: WinningToolEntry[];
  loading: boolean;
  banner: string;
  builtInsVisible: boolean;
  selectedIndex: number;
  pager: PagerState | null;
};

function readConfigJson(configDirPath: string): JsonRecord | undefined {
  if (typeof configDirPath !== "string" || configDirPath.length === 0) {
    return undefined;
  }
  const configPath = path.join(configDirPath, CONFIG_FILE_NAME);
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolves the ordered list of tool directories for the given config directory.
 *
 * Each entry from `toolDirs` is resolved relative to `<config-dir>` unless it is
 * an absolute path. Entries that are not non-empty strings are skipped. Order is
 * preserved as given in the configuration. When `toolDirs` is missing or empty,
 * the default `<config-dir>/tools` directory is returned.
 */
export function resolveToolDirectories(configDirPath: string, configValue?: unknown): string[] {
  if (typeof configDirPath !== "string" || configDirPath.length === 0) {
    return [];
  }

  const config = configValue && typeof configValue === "object" && !Array.isArray(configValue)
    ? (configValue as JsonRecord)
    : readConfigJson(configDirPath);

  const candidates = config && Array.isArray(config.toolDirs) ? config.toolDirs : undefined;
  const resolved = [];

  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const resolvedDir = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(configDirPath, trimmed);
      resolved.push(resolvedDir);
    }
  }

  if (resolved.length === 0) {
    resolved.push(path.join(configDirPath, TOOLS_DIRECTORY_NAME));
  }

  return resolved;
}

function listToolFiles(directoryPath: string): ToolFileEntry[] {
  let entries;
  try {
    entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    if (lowerName.endsWith(TOOL_JS_EXTENSION)) {
      const baseName = entry.name.slice(0, -TOOL_JS_EXTENSION.length);
      const trimmedName = baseName.trim();
      if (trimmedName.length === 0) {
        continue;
      }
      files.push({
        name: trimmedName.toLowerCase(),
        extension: TOOL_JS_EXTENSION,
        fileName: entry.name,
        filePath: path.join(directoryPath, entry.name),
        directory: directoryPath,
      });
      continue;
    }
    if (lowerName.endsWith(TOOL_TEMPLATE_EXTENSION)) {
      const baseName = entry.name.slice(0, -TOOL_TEMPLATE_EXTENSION.length);
      const trimmedName = baseName.trim();
      if (trimmedName.length === 0) {
        continue;
      }
      files.push({
        name: trimmedName.toLowerCase(),
        extension: TOOL_TEMPLATE_EXTENSION,
        fileName: entry.name,
        filePath: path.join(directoryPath, entry.name),
        directory: directoryPath,
      });
    }
  }

  files.sort((left, right) => {
    if (left.name === right.name) {
      return left.fileName.localeCompare(right.fileName);
    }
    return left.name.localeCompare(right.name);
  });

  return files;
}

/**
 * Discovers custom tools across the resolved tool directories, in configured
 * order. Each `.md` and `.js` file becomes an entry whose `name` is the file
 * basename without extension (lowercased). Discovery preserves directory order.
 *
 * First-wins precedence: when the same tool name appears in multiple
 * directories, the first one encountered wins (`shadowed: false`) and any
 * later duplicates are marked `shadowed: true`. Each winning entry receives a
 * `shadows` array holding shadowed duplicates in discovery order so the scene
 * can render them grouped beneath the winner. The flat `entries` array still
 * contains every discovered file in discovery order for callers that need it.
 *
 * The result also exposes a `tools` array containing only winning entries in
 * discovery order, suitable for direct rendering of the custom tool list.
 *
 */
export function discoverCustomTools({
  configDirPath,
  config,
}: {
  configDirPath?: string;
  config?: unknown;
} = {}): ToolsDiscoveryResult {
  if (typeof configDirPath !== "string" || configDirPath.length === 0) {
    return { directories: [], entries: [], tools: [] };
  }

  const directories = resolveToolDirectories(configDirPath, config);
  const entries = [];
  const winnersByName = new Map();
  const tools = [];

  for (const directory of directories) {
    const files = listToolFiles(directory);
    for (const file of files) {
      const winner = winnersByName.get(file.name);
      if (winner === undefined) {
        const winningEntry = {
          ...file,
          shadowed: false,
          shadows: [],
        };
        winnersByName.set(file.name, winningEntry);
        entries.push(winningEntry);
        tools.push(winningEntry);
      } else {
        const shadowedEntry = {
          ...file,
          shadowed: true,
          shadowedBy: {
            filePath: winner.filePath,
            directory: winner.directory,
          },
        };
        winner.shadows.push(shadowedEntry);
        entries.push(shadowedEntry);
      }
    }
  }

  return { directories, entries, tools };
}

export function createToolsSceneState() {
  return {
    configDirPath: "",
    toolDirectories: [],
    customTools: [],
    customToolWinners: [],
    loading: true,
    banner: "",
    builtInsVisible: true,
    selectedIndex: 0,
    pager: null,
  };
}

/**
 * Creates a fresh built-ins visibility session record. The Tools scene reads
 * and updates this object across scene opens within the same TUI session so
 * that:
 *
 * - On the first scene open in a session, built-ins are visible (so new users
 *   discover the catalog).
 * - On subsequent opens within the same session, built-ins default to hidden
 *   (the catalog is reference material; experienced users don't need it
 *   redrawn every time).
 * - Once the user has explicitly toggled visibility with `[b]`, that choice
 *   sticks for the remainder of the session and overrides the
 *   first-run/subsequent-run defaults on every open.
 *
 * The shape is intentionally a plain object so callers (TUI runtime, tests)
 * can persist it alongside other per-session state.
 *
 * - `explicit`: `undefined` until the user toggles `[b]`; thereafter `true`
 *   (visible) or `false` (hidden) reflecting the user's choice.
 * - `openedOnce`: `false` until the first call to `openToolsScene`; flips to
 *   `true` after that so subsequent opens use the hidden default.
 */
export function createBuiltInsVisibilitySession(): BuiltInsVisibilitySession {
  return {
    explicit: undefined,
    openedOnce: false,
  };
}

function resolveBuiltInsVisibilityForOpen(session?: BuiltInsVisibilitySession): boolean {
  if (!session || typeof session !== "object") {
    return true;
  }
  if (typeof session.explicit === "boolean") {
    return session.explicit;
  }
  return session.openedOnce !== true;
}

/**
 * Computes the `builtInsVisible` value for the Tools scene state on open and
 * advances the session record so subsequent opens use the hidden default.
 *
 * If the user has explicitly toggled visibility earlier in this TUI session
 * (`session.explicit` is a boolean), that choice is honored. Otherwise the
 * very first open returns `true` (visible) and any later open returns
 * `false` (hidden by default).
 *
 * Returns a new scene state object with `builtInsVisible` set; the caller
 * should also keep the (mutated) session for the next open and toggle calls.
 *
 * Both arguments are optional: when `state` is missing a default state is
 * created; when `session` is missing the open is treated as a first run.
 */
export function openToolsScene({
  session,
  state,
}: {
  session?: BuiltInsVisibilitySession;
  state?: ToolsSceneState;
} = {}): ToolsSceneState {
  const sceneState = state ?? createToolsSceneState();
  const sessionRecord = session ?? createBuiltInsVisibilitySession();
  const builtInsVisible = resolveBuiltInsVisibilityForOpen(sessionRecord);
  if (sessionRecord && typeof sessionRecord === "object") {
    sessionRecord.openedOnce = true;
  }
  return {
    ...sceneState,
    builtInsVisible,
  };
}

/**
 * Toggles built-in catalog visibility for the Tools scene and records the
 * choice on the visibility session so it persists across subsequent scene
 * opens within the same TUI session.
 *
 * Returns the updated scene state with `builtInsVisible` flipped. If a
 * `session` object is supplied it is mutated to set `explicit` to the new
 * visibility, which overrides the first-run/subsequent-run defaults from
 * `openToolsScene`.
 */
export function toggleBuiltInsVisibility({
  session,
  state,
}: {
  session?: BuiltInsVisibilitySession;
  state?: ToolsSceneState;
} = {}): ToolsSceneState {
  const sceneState = state ?? createToolsSceneState();
  const previous = sceneState.builtInsVisible !== false;
  const next = !previous;
  if (session && typeof session === "object") {
    session.explicit = next;
    session.openedOnce = true;
  }
  return {
    ...sceneState,
    builtInsVisible: next,
  };
}

const DEFAULT_PAGER_VIEWPORT_HEIGHT = 20;

function describeToolKind(extension: string): "source" | "template" | "file" {
  if (extension === TOOL_JS_EXTENSION) {
    return "source";
  }
  if (extension === TOOL_TEMPLATE_EXTENSION) {
    return "template";
  }
  return "file";
}

/**
 * Reads the given custom tool's file from disk and produces a pager state for
 * a paginated read-only view. Both `.md` templates and `.js` sources use the
 * same pager, with the title reflecting the tool kind.
 *
 * Returns `{ pager }` on success or `{ error }` when the file cannot be read.
 *
 * - `tool` must be a discovered custom tool entry (with `name`, `filePath`,
 *   `extension`).
 * - `readFile` is injectable for testing; defaults to `fs.readFileSync` in
 *   utf-8 mode.
 * - `viewportHeight` is forwarded to the pager (clamped by the pager itself).
 */
export function inspectCustomToolTemplate({
  tool,
  viewportHeight = DEFAULT_PAGER_VIEWPORT_HEIGHT,
  readFile,
}: {
  tool?: WinningToolEntry;
  viewportHeight?: number;
  readFile?: (filePath: string) => string;
} = {}): { pager: PagerState } | { error: string } {
  if (!tool || typeof tool !== "object") {
    return { error: "No tool selected." };
  }
  if (typeof tool.filePath !== "string" || tool.filePath.length === 0) {
    return { error: "Selected tool has no file path." };
  }
  const reader = typeof readFile === "function"
    ? readFile
    : (p: string) => fs.readFileSync(p, "utf8");
  let content;
  try {
    content = reader(tool.filePath);
  } catch (caught) {
    const message = caught && caught.message ? caught.message : String(caught);
    return { error: `Failed to read ${tool.filePath}: ${message}` };
  }
  const safeContent = typeof content === "string" ? content : String(content ?? "");
  const kind = describeToolKind(tool.extension);
  const title = `Tool ${kind}: ${tool.name}`;
  const pager = createPagerState({
    content: safeContent,
    title,
    filePath: tool.filePath,
    viewportHeight,
  });
  return { pager };
}

function clampSelectedIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (!Number.isInteger(index) || index < 0) {
    return 0;
  }
  if (index >= length) {
    return length - 1;
  }
  return index;
}

/**
 * Opens the currently selected custom tool in the pager. Returns the updated
 * scene state. When no winning custom tool is available, returns the state
 * unchanged with a banner indicating nothing can be inspected.
 */
export function inspectSelectedCustomTool({
  state,
  viewportHeight = DEFAULT_PAGER_VIEWPORT_HEIGHT,
  readFile,
}: {
  state?: ToolsSceneState;
  viewportHeight?: number;
  readFile?: (filePath: string) => string;
} = {}): ToolsSceneState {
  const sceneState = state ?? createToolsSceneState();
  const winners = Array.isArray(sceneState.customToolWinners)
    ? sceneState.customToolWinners
    : [];
  if (winners.length === 0) {
    return {
      ...sceneState,
      banner: "No custom tool to inspect.",
    };
  }
  const index = clampSelectedIndex(sceneState.selectedIndex, winners.length);
  const tool = winners[index];
  const result = inspectCustomToolTemplate({ tool, viewportHeight, readFile });
  if ("error" in result) {
    return {
      ...sceneState,
      selectedIndex: index,
      banner: result.error,
    };
  }
  return {
    ...sceneState,
    selectedIndex: index,
    banner: "",
    pager: result.pager,
  };
}

/**
 * Closes any active inspect pager and returns to the Tools scene listing.
 */
export function closeToolsScenePager({ state }: { state?: ToolsSceneState } = {}): ToolsSceneState {
  const sceneState = state ?? createToolsSceneState();
  if (!sceneState.pager) {
    return sceneState;
  }
  return {
    ...sceneState,
    pager: null,
  };
}

function describeEditorLaunchFailure(result: LaunchEditorResult | undefined, filePath: string): string {
  if (!result || typeof result !== "object") {
    return `Failed to launch editor for ${filePath}.`;
  }
  if (typeof result.message === "string" && result.message.length > 0) {
    return result.message;
  }
  if (typeof result.reason === "string" && result.reason.length > 0) {
    return `Editor launch failed (${result.reason}).`;
  }
  return `Failed to launch editor for ${filePath}.`;
}

/**
 * Opens the currently selected custom tool's file in `$EDITOR` (or `$VISUAL`,
 * with platform-aware fallbacks via `editor-launch.js`). The TUI is suspended
 * while the editor runs and resumed when the editor exits, then the tool
 * discovery state is reloaded so any edits to the file are reflected
 * immediately in the scene.
 *
 * Returns the updated scene state. When no winning custom tool is available,
 * returns the state unchanged with a banner indicating nothing can be edited.
 * On editor launch failure, the existing scene state is preserved (no reload)
 * and a banner is set describing the failure.
 *
 * The function takes optional `suspendTui`/`resumeTui` callbacks (provided by
 * the TUI runtime) plus `launchEditor` and `reload` overrides for testing.
 */
export async function editSelectedCustomTool({
  state,
  currentWorkingDirectory = process.cwd(),
  suspendTui,
  resumeTui,
  launchEditor: launchEditorOverride,
  reload: reloadOverride,
}: {
  state?: ToolsSceneState;
  currentWorkingDirectory?: string;
  suspendTui?: () => void;
  resumeTui?: () => void;
  launchEditor?: typeof defaultLaunchEditor;
  reload?: typeof reloadToolsSceneState;
} = {}): Promise<ToolsSceneState> {
  const sceneState = state ?? createToolsSceneState();
  const winners = Array.isArray(sceneState.customToolWinners)
    ? sceneState.customToolWinners
    : [];
  if (winners.length === 0) {
    return {
      ...sceneState,
      banner: "No custom tool to edit.",
    };
  }
  const index = clampSelectedIndex(sceneState.selectedIndex, winners.length);
  const tool = winners[index];
  if (!tool || typeof tool.filePath !== "string" || tool.filePath.length === 0) {
    return {
      ...sceneState,
      selectedIndex: index,
      banner: "Selected tool has no file path.",
    };
  }

  const launcher = typeof launchEditorOverride === "function"
    ? launchEditorOverride
    : defaultLaunchEditor;

  if (typeof suspendTui === "function") {
    try {
      suspendTui();
    } catch {
      // ignore suspend errors; we still attempt the editor launch
    }
  }

  let launchResult: LaunchEditorResult | undefined;
  let launchError: unknown;
  try {
    launchResult = launcher(tool.filePath, { cwd: currentWorkingDirectory });
  } catch (caught) {
    launchError = caught;
  } finally {
    if (typeof resumeTui === "function") {
      try {
        resumeTui();
      } catch {
        // ignore resume errors
      }
    }
  }

  if (launchError) {
    const message = launchError && typeof launchError === "object" && "message" in launchError
      ? String((launchError as { message?: unknown }).message ?? "")
      : String(launchError);
    return {
      ...sceneState,
      selectedIndex: index,
      banner: `Failed to launch editor for ${tool.filePath}: ${message}`,
    };
  }

  if (!launchResult || launchResult.ok !== true) {
    return {
      ...sceneState,
      selectedIndex: index,
      banner: describeEditorLaunchFailure(launchResult, tool.filePath),
    };
  }

  const reloader = typeof reloadOverride === "function"
    ? reloadOverride
    : reloadToolsSceneState;
  let reloadedState;
  try {
    reloadedState = await reloader({
      state: { ...sceneState, selectedIndex: index, banner: "" },
      currentWorkingDirectory,
    });
  } catch (caught) {
    const message = caught && typeof caught === "object" && "message" in caught
      ? String((caught as { message?: unknown }).message ?? "")
      : String(caught);
    return {
      ...sceneState,
      selectedIndex: index,
      banner: `Reload failed after edit: ${message}`,
    };
  }

  const reloadedWinners = Array.isArray(reloadedState?.customToolWinners)
    ? reloadedState.customToolWinners
    : [];
  return {
    ...reloadedState,
    selectedIndex: clampSelectedIndex(index, reloadedWinners.length),
    banner: "",
  };
}

/**
 * Forces re-discovery of custom tools from the configured `toolDirs` and
 * refreshes the visible custom/shadowed entries. Bound to the `[r] reload
 * tool dirs` action in the Tools scene.
 *
 * Returns the updated scene state with `loading` cleared, the freshly
 * discovered `customTools`/`customToolWinners`/`toolDirectories`, the
 * previous `selectedIndex` clamped against the new winner list, and a
 * concise confirmation banner summarizing how many tools, shadowed entries,
 * and directories were rediscovered. Built-in catalog visibility is left
 * untouched so the user's `[b]` choice persists across reloads.
 *
 * The optional `reload` argument is injectable for testing; it defaults to
 * `reloadToolsSceneState` which performs the actual filesystem discovery.
 * On reload failure, the previous scene state is preserved (no reset of
 * the visible entries) and a banner describes the failure.
 */
export async function reloadCustomToolsAction({
  state,
  currentWorkingDirectory = process.cwd(),
  reload: reloadOverride,
}: {
  state?: ToolsSceneState;
  currentWorkingDirectory?: string;
  reload?: typeof reloadToolsSceneState;
} = {}): Promise<ToolsSceneState> {
  const sceneState = state ?? createToolsSceneState();
  const reloader = typeof reloadOverride === "function"
    ? reloadOverride
    : reloadToolsSceneState;

  let reloaded;
  try {
    reloaded = await reloader({
      state: { ...sceneState, banner: "" },
      currentWorkingDirectory,
    });
  } catch (caught) {
    const message = caught && caught.message ? caught.message : String(caught);
    return {
      ...sceneState,
      banner: `Reload failed: ${message}`,
    };
  }

  const winners = Array.isArray(reloaded?.customToolWinners)
    ? reloaded.customToolWinners
    : [];
  const entries = Array.isArray(reloaded?.customTools)
    ? reloaded.customTools
    : [];
  const directories = Array.isArray(reloaded?.toolDirectories)
    ? reloaded.toolDirectories
    : [];
  const shadowedCount = entries.length - winners.length;

  const directoryWord = directories.length === 1 ? "directory" : "directories";
  const toolsWord = winners.length === 1 ? "tool" : "tools";
  const banner = `Reloaded ${winners.length} custom ${toolsWord} (${shadowedCount} shadowed) from ${directories.length} ${directoryWord}.`;

  return {
    ...reloaded,
    selectedIndex: clampSelectedIndex(sceneState.selectedIndex, winners.length),
    builtInsVisible: sceneState.builtInsVisible !== false,
    banner,
  };
}

export async function reloadToolsSceneState({
  state,
  currentWorkingDirectory = process.cwd(),
}: {
  state?: ToolsSceneState;
  currentWorkingDirectory?: string;
} = {}): Promise<ToolsSceneState> {
  const sceneState = {
    ...(state ?? createToolsSceneState()),
    loading: true,
    banner: "",
  };

  const { createConfigBridge } = await import("../bridges/config-bridge.js");
  const configBridge = createConfigBridge({ cwd: currentWorkingDirectory });
  const configDirPath = configBridge.configDirPath;

  const { directories, entries, tools } = discoverCustomTools({ configDirPath });

  return {
    ...sceneState,
    configDirPath,
    toolDirectories: directories,
    customTools: entries,
    customToolWinners: tools,
    loading: false,
  };
}

/**
 * Path to the README used as the read-only navigation target for built-in
 * catalog rows. Resolved against `process.cwd()` only when a caller needs the
 * absolute filesystem path; the relative form is what the scene displays in the
 * pager header and what `docsPath` exposes on each row.
 */
export const BUILT_IN_TOOL_DOCS_PATH = "README.md";

/**
 * Hand-maintained catalog of built-in prefix handlers shipped with rundown.
 * Mirrors the rows shown in migration 164.
 *
 * Each row carries navigation metadata used by the Tools scene's read-only
 * inspect behavior: pressing Enter on a built-in row opens the configuration
 * docs in the pager and scrolls to the row's section/bullet:
 *
 * - `docsPath` is the workspace-relative path to the docs file.
 * - `docsAnchor` is the GitHub-flavored heading slug (kebab-cased) of the
 *   section that documents the prefix family, matching an actual `##`
 *   heading in `README.md`.
 * - `docsSection` is the human-readable heading text used to locate the
 *   section by line number when no anchor index is available.
 * - `docsBulletNeedle` is a substring expected on the bullet line within
 *   that section that names this row's prefix family. The pager uses it to
 *   scroll to the precise line; if not found, navigation falls back to the
 *   section heading.
 */
export const BUILT_IN_TOOL_CATALOG: BuiltInToolCatalogRow[] = [
  {
    label: "Verify-only",
    prefixes: ["verify:", "confirm:", "check:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "verify-only:",
  },
  {
    label: "Memory capture",
    prefixes: ["memory:", "memorize:", "remember:", "inventory:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "memory capture:",
  },
  {
    label: "Fast execution",
    prefixes: ["fast:", "raw:", "quick:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "fast execution",
  },
  {
    label: "Conditional skip",
    prefixes: ["optional:", "skip:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "conditional sibling skip",
  },
  {
    label: "Terminal stop",
    prefixes: ["quit:", "exit:", "end:", "break:", "return:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "terminal stop control",
  },
  {
    label: "Include another md",
    prefixes: ["include:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "include task file",
  },
  {
    label: "Outer retry wrapper",
    prefixes: ["force:"],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "outer retry wrapper",
  },
  {
    label: "Modifier",
    prefixes: ["profile="],
    docsPath: BUILT_IN_TOOL_DOCS_PATH,
    docsAnchor: "unified-prefix-tool-chain",
    docsSection: "Unified prefix tool chain",
    docsBulletNeedle: "Built-in modifier:",
  },
];

function slugifyHeading(headingText: string): string {
  if (typeof headingText !== "string") {
    return "";
  }
  return headingText
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Returns the read-only inspect navigation target for a built-in catalog row.
 *
 * The shape is stable for downstream callers (Tools scene Enter handler,
 * Help scene cross-links): it identifies the docs file, the heading slug,
 * the heading text used to locate the section by line, and the optional
 * bullet substring used to scroll to a precise line within that section.
 *
 * Returns `undefined` when `row` is not a recognized catalog entry so callers
 * can fall back to non-navigating behavior.
 */
export function resolveBuiltInToolDocsTarget(row: unknown): BuiltInToolDocsTarget | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const rowRecord = row as JsonRecord;
  const docsPath = typeof rowRecord.docsPath === "string" && rowRecord.docsPath.length > 0
    ? rowRecord.docsPath
    : BUILT_IN_TOOL_DOCS_PATH;
  const docsSection = typeof rowRecord.docsSection === "string" ? rowRecord.docsSection : "";
  const explicitAnchor = typeof rowRecord.docsAnchor === "string" && rowRecord.docsAnchor.length > 0
    ? rowRecord.docsAnchor
    : slugifyHeading(docsSection);
  const docsBulletNeedle = typeof rowRecord.docsBulletNeedle === "string"
    ? rowRecord.docsBulletNeedle
    : "";
  return {
    docsPath,
    docsAnchor: explicitAnchor,
    docsSection,
    docsBulletNeedle,
    label: typeof rowRecord.label === "string" ? rowRecord.label : "",
  };
}

/**
 * Locates the line number (1-indexed) within `docsContent` that the pager
 * should scroll to when inspecting the given catalog row. The lookup walks
 * the file once: first to find the matching `##` section heading, then,
 * within that section, the first line containing the bullet needle.
 *
 * Returns `1` when the section cannot be found so the pager opens at the
 * top of the document rather than failing. Returns the section heading line
 * when the bullet needle is missing or empty.
 */
export function findBuiltInToolDocsLine(docsContent: string, target: BuiltInToolDocsTarget | undefined): number {
  if (typeof docsContent !== "string" || docsContent.length === 0 || !target) {
    return 1;
  }
  const lines = docsContent.split(/\r?\n/);
  const sectionHeading = typeof target.docsSection === "string"
    ? target.docsSection.trim()
    : "";
  const bulletNeedle = typeof target.docsBulletNeedle === "string"
    ? target.docsBulletNeedle.trim()
    : "";

  let sectionLine = -1;
  let nextSectionLine = lines.length;
  if (sectionHeading.length > 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (sectionLine === -1) {
        if (/^##\s+/.test(line) && line.replace(/^##\s+/, "").trim() === sectionHeading) {
          sectionLine = index;
        }
      } else if (/^##\s+/.test(line)) {
        nextSectionLine = index;
        break;
      }
    }
  }

  if (sectionLine === -1) {
    return 1;
  }

  if (bulletNeedle.length === 0) {
    return sectionLine + 1;
  }

  for (let index = sectionLine + 1; index < nextSectionLine; index += 1) {
    if (lines[index].includes(bulletNeedle)) {
      return index + 1;
    }
  }
  return sectionLine + 1;
}

const BUILT_IN_LABEL_COLUMN_WIDTH = 20;

function withSectionGap(lines: string[], sectionGap: number): void {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

function formatToolDirsHeader(toolDirectories: string[], configDirPath: string): string {
  if (!Array.isArray(toolDirectories) || toolDirectories.length === 0) {
    return "toolDirs: []";
  }
  const labels = toolDirectories.map((dir) => {
    if (typeof dir !== "string" || dir.length === 0) {
      return "";
    }
    if (typeof configDirPath === "string" && configDirPath.length > 0) {
      const relative = path.relative(configDirPath, dir);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
      }
    }
    return dir;
  });
  return `toolDirs: [${labels.join(", ")}]`;
}

function formatToolPath(filePath: string, configDirPath: string): string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return "";
  }
  if (typeof configDirPath === "string" && configDirPath.length > 0) {
    const relative = path.relative(configDirPath, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return filePath;
}

function paddedName(name: string, columnWidth: number): string {
  const safe = typeof name === "string" ? name : "";
  if (safe.length >= columnWidth) {
    return `${safe} `;
  }
  return safe.padEnd(columnWidth, " ");
}

function computeNameColumnWidth(winners: WinningToolEntry[]): number {
  let width = 16;
  if (!Array.isArray(winners)) {
    return width;
  }
  for (const tool of winners) {
    if (tool && typeof tool.name === "string" && tool.name.length > width) {
      width = tool.name.length;
    }
  }
  return width;
}

export function renderToolsSceneLines({
  state,
  sectionGap = 1,
}: {
  state?: ToolsSceneState;
  sectionGap?: number;
} = {}): string[] {
  const sceneState = state ?? createToolsSceneState();
  if (sceneState.pager) {
    return renderPagerLines({ state: sceneState.pager });
  }
  const headerSummary = formatToolDirsHeader(
    sceneState.toolDirectories,
    sceneState.configDirPath,
  );

  const lines = [pc.bold("Tools"), pc.dim(headerSummary)];

  if (sceneState.loading) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("Loading custom tools..."));
    lines.push(pc.dim("[Esc] Back to menu"));
    return lines;
  }

  if (typeof sceneState.banner === "string" && sceneState.banner.length > 0) {
    withSectionGap(lines, sectionGap);
    const bannerLines = sceneState.banner.split(/\r?\n/);
    for (let index = 0; index < bannerLines.length; index += 1) {
      const prefix = index === 0 ? "! " : "  ";
      lines.push(pc.red(`${prefix}${bannerLines[index]}`));
    }
  }

  withSectionGap(lines, sectionGap);
  lines.push(pc.bold("Custom (project)"));

  const winners = Array.isArray(sceneState.customToolWinners)
    ? sceneState.customToolWinners
    : [];

  if (winners.length === 0) {
    lines.push(pc.dim("  No custom tools discovered."));
  } else {
    const nameColumnWidth = computeNameColumnWidth(winners);
    for (const tool of winners) {
      const namePart = paddedName(tool.name, nameColumnWidth);
      const pathPart = formatToolPath(tool.filePath, sceneState.configDirPath);
      lines.push(`  ${namePart} ${pathPart}`);
      if (Array.isArray(tool.shadows) && tool.shadows.length > 0) {
        for (const shadow of tool.shadows) {
          const shadowPath = formatToolPath(shadow.filePath, sceneState.configDirPath);
          lines.push(pc.dim(`      shadowed: ${shadowPath}`));
        }
      }
    }
  }

  withSectionGap(lines, sectionGap);
  const builtInsVisible = sceneState.builtInsVisible !== false;
  if (builtInsVisible) {
    lines.push(pc.bold("Built-in (read-only)"));
    for (const row of BUILT_IN_TOOL_CATALOG) {
      const label = row.label.padEnd(BUILT_IN_LABEL_COLUMN_WIDTH, " ");
      lines.push(pc.dim(`  ${label}${row.prefixes.join(" ")}`));
    }
  } else {
    lines.push(pc.dim("Built-in catalog hidden. [b] to show."));
  }

  withSectionGap(lines, sectionGap);
  lines.push(pc.dim("[↵] inspect template   [e] edit prompt   [r] reload tool dirs   [b] toggle built-ins"));
  lines.push(pc.dim("[Esc] Back to menu"));
  return lines;
}
