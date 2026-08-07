// @ts-nocheck
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { createConfigBridge } from "../bridges/config-bridge.ts";
import { launchEditor } from "../components/editor-launch.ts";
import { createPagerState, handlePagerInput, renderPagerLines } from "../components/pager.ts";

const SUPPORTED_SCOPES = ["effective", "local", "global"];

function getNextScope(scope) {
  const currentIndex = SUPPORTED_SCOPES.indexOf(scope);
  if (currentIndex < 0) {
    return SUPPORTED_SCOPES[0];
  }
  return SUPPORTED_SCOPES[(currentIndex + 1) % SUPPORTED_SCOPES.length];
}

function isSupportedScope(value) {
  return typeof value === "string" && SUPPORTED_SCOPES.includes(value);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function withSectionGap(lines, sectionGap) {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

function toErrorMessage(error, fallback = "Unexpected error.") {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return fallback;
}

function shouldReloadAfterEditorSession(launchResult) {
  if (!launchResult || typeof launchResult !== "object") {
    return false;
  }
  if (launchResult.ok) {
    return true;
  }
  return launchResult.reason === "non-zero-exit"
    || launchResult.reason === "terminated"
    || launchResult.reason === "unknown-result";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flattenConfigEntries(config, prefix = "") {
  const entries = [];
  const source = safeObject(config);
  const keys = Object.keys(source);
  for (const key of keys) {
    const value = source[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      const nested = flattenConfigEntries(value, fullKey);
      if (nested.length === 0) {
        entries.push({ key: fullKey, value });
      } else {
        entries.push(...nested);
      }
      continue;
    }
    entries.push({ key: fullKey, value });
  }
  return entries;
}

function formatValueOneLine(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

const ARRAY_PREVIEW_LIMIT = 3;
const MIN_VALUE_WIDTH = 12;
const DEFAULT_VIEWPORT_COLUMNS = 80;
const EMPTY_JSON_WITH_NEWLINE = "{}\n";

function truncateInline(text, maxLength) {
  const value = String(text);
  if (maxLength <= 0) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength === 1) {
    return "…";
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatArrayPreview(value, maxLength) {
  if (!Array.isArray(value)) {
    return null;
  }
  const head = value.slice(0, ARRAY_PREVIEW_LIMIT).map((item) => formatValueOneLine(item));
  const suffix = value.length > ARRAY_PREVIEW_LIMIT ? ", …" : "";
  const candidate = `[${head.join(", ")}${suffix}]`;
  if (candidate.length <= maxLength) {
    return candidate;
  }
  return null;
}

function formatRowValue(value, maxLength) {
  const safeMax = Math.max(1, Math.floor(maxLength));
  const oneLine = formatValueOneLine(value);
  if (oneLine.length <= safeMax) {
    return oneLine;
  }
  if (Array.isArray(value)) {
    const preview = formatArrayPreview(value, safeMax);
    if (preview !== null) {
      return preview;
    }
  }
  return truncateInline(oneLine, safeMax);
}

function resolveValueColumnWidth(viewportColumns, keyColumnWidth, provenanceReserve) {
  const cols = Number.isFinite(viewportColumns) && viewportColumns > 0
    ? viewportColumns
    : DEFAULT_VIEWPORT_COLUMNS;
  // Layout: "  " (2) + key (keyColumnWidth) + "  " (2) + value + "  " + marker
  const available = cols - 2 - keyColumnWidth - 2 - provenanceReserve;
  return Math.max(MIN_VALUE_WIDTH, available);
}

function clampSelectedIndex(index, length) {
  if (!Number.isInteger(index) || index < 0) {
    return 0;
  }
  if (!Number.isInteger(length) || length <= 0) {
    return 0;
  }
  if (index >= length) {
    return length - 1;
  }
  return index;
}

function formatInspectorContent({ entry, scope, source }) {
  const keyText = typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : "(unknown)";
  const sourceLine = scope === "effective"
    ? `Source: ${typeof source === "string" && source.length > 0 ? source : "unknown"}`
    : "Source: n/a (scope-specific view)";
  const valueText = JSON.stringify(entry?.value, null, 2);
  return [
    `Key: ${keyText}`,
    sourceLine,
    "",
    "Value (pretty JSON):",
    typeof valueText === "string" ? valueText : String(entry?.value),
  ].join("\n");
}

function openSettingsInspector({ state, viewportHeight }) {
  const sceneState = state ?? createSettingsSceneState();
  const entries = Array.isArray(sceneState.entries) ? sceneState.entries : [];
  if (entries.length === 0) {
    return {
      ...sceneState,
      banner: "No setting selected to inspect.",
    };
  }
  const index = clampSelectedIndex(sceneState.selectedIndex, entries.length);
  const entry = entries[index];
  const scope = isSupportedScope(sceneState.scope) ? sceneState.scope : "effective";
  const sources = safeObject(sceneState.sources);
  const source = typeof entry?.key === "string" ? sources[entry.key] : undefined;
  const content = formatInspectorContent({ entry, scope, source });
  const pager = createPagerState({
    title: "Settings Inspector",
    filePath: typeof entry?.key === "string" ? entry.key : "",
    content,
    viewportHeight,
  });

  return {
    ...sceneState,
    selectedIndex: index,
    banner: "",
    hint: "",
    pager,
  };
}

export function createSettingsSceneState() {
  return {
    scope: "effective",
    entries: [],
    sources: undefined,
    selectedIndex: 0,
    banner: "",
    hint: "",
    pager: null,
    pendingGlobalCreate: false,
    loading: false,
    lastError: "",
  };
}

export async function reloadSettingsSceneState({
  state,
  currentWorkingDirectory = process.cwd(),
  keepBanner = false,
} = {}) {
  const previous = state ?? createSettingsSceneState();
  const scope = isSupportedScope(previous.scope) ? previous.scope : "effective";
  const sceneState = {
    ...previous,
    scope,
    loading: true,
  };
  if (!keepBanner) {
    sceneState.banner = "";
  }

  try {
    const bridge = createConfigBridge({ cwd: currentWorkingDirectory });
    const listed = scope === "effective"
      ? await bridge.listEffective()
      : scope === "local"
        ? await bridge.listLocal()
        : await bridge.listGlobal();
    const config = safeObject(listed?.config);
    const sources = scope === "effective" ? safeObject(listed?.sources) : undefined;
    const entries = flattenConfigEntries(config);
    return {
      ...sceneState,
      entries,
      sources,
      selectedIndex: Math.min(sceneState.selectedIndex ?? 0, Math.max(0, entries.length - 1)),
      loading: false,
      lastError: "",
    };
  } catch (error) {
    const message = `Failed to load ${scope} config: ${toErrorMessage(error)}`;
    return {
      ...sceneState,
      entries: [],
      sources: undefined,
      selectedIndex: 0,
      loading: false,
      lastError: message,
      banner: message,
    };
  }
}

export async function runSettingsSceneAction({
  action,
  state,
  currentWorkingDirectory = process.cwd(),
  suspendTui,
  resumeTui,
} = {}) {
  const sceneState = state ?? createSettingsSceneState();
  if (!action || typeof action !== "object") {
    return sceneState;
  }

  if (action.type === "reload") {
    return reloadSettingsSceneState({
      state: {
        ...sceneState,
        loading: true,
      },
      currentWorkingDirectory,
    });
  }

  if (action.type === "edit") {
    const scope = isSupportedScope(sceneState.scope) ? sceneState.scope : "effective";
    if (scope === "effective") {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        hint: "effective is a merged read-only view; switch to local or global to edit.",
      };
    }

    const bridge = createConfigBridge({ cwd: currentWorkingDirectory });
    let filePath;
    try {
      filePath = scope === "local"
        ? await bridge.resolveConfigPath("local")
        : await bridge.getGlobalPath();
    } catch (error) {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: `Unable to resolve ${scope} config path: ${toErrorMessage(error)}`,
      };
    }

    if (typeof filePath !== "string" || filePath.length === 0 || filePath === bridge.unresolvedPathMarker) {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: `${scope} config path is unresolved.`,
      };
    }

    if (scope === "global" && !fs.existsSync(filePath)) {
      if (!sceneState.pendingGlobalCreate) {
        return {
          ...sceneState,
          pendingGlobalCreate: true,
          hint: `Global config missing at ${filePath}. Press [e] again to create {} and edit.`,
        };
      }
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, EMPTY_JSON_WITH_NEWLINE, "utf8");
      } catch (error) {
        return {
          ...sceneState,
          pendingGlobalCreate: false,
          banner: `Failed to bootstrap global config at ${filePath}: ${toErrorMessage(error)}`,
        };
      }
    }

    let launchResult;
    suspendTui?.();
    try {
      launchResult = launchEditor(filePath, { cwd: currentWorkingDirectory });
    } catch (error) {
      launchResult = {
        ok: false,
        message: `Failed to launch editor for ${filePath}: ${toErrorMessage(error)}`,
      };
    } finally {
      resumeTui?.();
    }

    if (!shouldReloadAfterEditorSession(launchResult)) {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: launchResult.message || "Failed to open editor.",
      };
    }

    const reloadedState = await reloadSettingsSceneState({
      state: {
        ...sceneState,
        pendingGlobalCreate: false,
        hint: "",
      },
      currentWorkingDirectory,
      keepBanner: false,
    });

    if (!launchResult.ok) {
      return {
        ...reloadedState,
        banner: launchResult.message || "Editor exited unexpectedly; configuration was reloaded.",
      };
    }

    return reloadedState;
  }

  if (action.type === "reveal-path") {
    const scope = isSupportedScope(sceneState.scope) ? sceneState.scope : "effective";
    if (scope === "effective") {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: "effective is a merged view and has no single config file path. Switch to local or global.",
      };
    }

    const bridge = createConfigBridge({ cwd: currentWorkingDirectory });
    let filePath;
    try {
      filePath = scope === "local"
        ? await bridge.resolveConfigPath("local")
        : await bridge.getGlobalPath();
    } catch (error) {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: `Unable to resolve ${scope} config path: ${toErrorMessage(error)}`,
      };
    }

    if (typeof filePath !== "string" || filePath.length === 0 || filePath === bridge.unresolvedPathMarker) {
      return {
        ...sceneState,
        pendingGlobalCreate: false,
        banner: `${scope} config path is unresolved.`,
      };
    }

    return {
      ...sceneState,
      pendingGlobalCreate: false,
      hint: "",
      banner: `${scope} config path: ${filePath}`,
    };
  }

  return sceneState;
}

function buildHeaderLine(scope) {
  const scopeLabel = isSupportedScope(scope) ? scope : "effective";
  const provenanceSuffix = scopeLabel === "effective" ? " ─ provenance shown" : "";
  return pc.bold(`Settings ─ scope: ${scopeLabel}${provenanceSuffix}`);
}

function formatProvenanceMarker(source) {
  if (typeof source !== "string" || source.length === 0) {
    return "";
  }
  return pc.dim(`◀ ${source}`);
}

export function renderSettingsSceneLines({ state, sectionGap = 1, viewportColumns } = {}) {
  const sceneState = state ?? createSettingsSceneState();
  if (sceneState.pager) {
    return renderPagerLines({ state: sceneState.pager });
  }
  const scope = isSupportedScope(sceneState.scope) ? sceneState.scope : "effective";
  const lines = [buildHeaderLine(scope)];

  if (sceneState.loading) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim(`Loading ${scope} configuration...`));
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

  if (typeof sceneState.hint === "string" && sceneState.hint.length > 0) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.yellow(sceneState.hint));
  }

  withSectionGap(lines, sectionGap);

  const entries = Array.isArray(sceneState.entries) ? sceneState.entries : [];
  const showProvenance = scope === "effective";
  const sources = safeObject(sceneState.sources);

  if (entries.length === 0) {
    lines.push(pc.dim(`  No configuration values to show for scope "${scope}".`));
  } else {
    const selectedIndex = clampSelectedIndex(sceneState.selectedIndex, entries.length);
    const longestKey = entries.reduce((max, entry) => {
      const length = typeof entry?.key === "string" ? entry.key.length : 0;
      return length > max ? length : max;
    }, 0);
    const keyColumnWidth = Math.min(Math.max(longestKey, 12), 36);
    // Reserve approximate width for the provenance marker ("◀ built-in" ≈ 11 chars + leading "  ").
    const provenanceReserve = showProvenance ? 14 : 0;
    const valueColumnWidth = resolveValueColumnWidth(viewportColumns, keyColumnWidth, provenanceReserve);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const keyText = typeof entry?.key === "string" ? entry.key : "";
      const valueText = formatRowValue(entry?.value, valueColumnWidth);
      const paddedKey = keyText.padEnd(keyColumnWidth, " ");
      const prefix = index === selectedIndex ? "> " : "  ";
      let row = `${prefix}${paddedKey}  ${valueText}`;
      if (showProvenance) {
        const marker = formatProvenanceMarker(sources[keyText]);
        if (marker) {
          row = `${row}  ${marker}`;
        }
      }
      lines.push(row);
    }
  }

  withSectionGap(lines, sectionGap);
  lines.push(pc.dim("[s] scope ▸ effective | local | global"));
  lines.push(pc.dim("[e] edit current scope file in $EDITOR   [o] reveal config file path"));
  lines.push(pc.dim("[↵] inspect value (full text + raw JSON)"));
  lines.push(pc.dim("[Esc] Back to menu"));
  return lines;
}

export function handleSettingsInput({ rawInput, state } = {}) {
  const sceneState = state ?? createSettingsSceneState();

  if (sceneState.pager) {
    const pagerResult = handlePagerInput({ rawInput, state: sceneState.pager });
    if (pagerResult.backToParent) {
      return {
        handled: true,
        state: {
          ...sceneState,
          pager: null,
        },
        backToParent: false,
      };
    }
    return {
      handled: pagerResult.handled,
      state: {
        ...sceneState,
        pager: pagerResult.state,
      },
      backToParent: false,
    };
  }

  const isEscape = rawInput === "\u001b";
  const isBackspace = rawInput === "\b" || rawInput === "\u007f";
  if (isEscape || isBackspace) {
    return {
      handled: true,
      state: sceneState,
      backToParent: true,
    };
  }

  const input = typeof rawInput === "string" ? rawInput : "";

  const entries = Array.isArray(sceneState.entries) ? sceneState.entries : [];
  const selectedIndex = clampSelectedIndex(sceneState.selectedIndex, entries.length);

  if (input === "\u001b[A" || input === "k") {
    return {
      handled: true,
      state: {
        ...sceneState,
        selectedIndex: clampSelectedIndex(selectedIndex - 1, entries.length),
      },
      backToParent: false,
    };
  }

  if (input === "\u001b[B" || input === "j") {
    return {
      handled: true,
      state: {
        ...sceneState,
        selectedIndex: clampSelectedIndex(selectedIndex + 1, entries.length),
      },
      backToParent: false,
    };
  }

  if (input === "\r" || input === "\n") {
    return {
      handled: true,
      state: openSettingsInspector({ state: sceneState }),
      backToParent: false,
    };
  }

  const normalized = input.toLowerCase();
  if (normalized === "s") {
    const nextScope = getNextScope(sceneState.scope);
    return {
      handled: true,
      state: {
        ...sceneState,
        scope: nextScope,
        loading: true,
        selectedIndex: 0,
        banner: "",
        hint: "",
        pendingGlobalCreate: false,
      },
      backToParent: false,
      action: { type: "reload" },
    };
  }

  if (normalized === "e") {
    return {
      handled: true,
      state: {
        ...sceneState,
        banner: "",
      },
      backToParent: false,
      action: { type: "edit" },
    };
  }

  if (normalized === "o") {
    return {
      handled: true,
      state: {
        ...sceneState,
        hint: "",
      },
      backToParent: false,
      action: { type: "reveal-path" },
    };
  }

  return {
    handled: false,
    state: sceneState,
    backToParent: false,
  };
}
