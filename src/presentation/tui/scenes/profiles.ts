// @ts-nocheck
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { launchEditor } from "../components/editor-launch.ts";
import { createConfigBridge } from "../bridges/config-bridge.ts";
import { createWorkspaceScanBridge } from "../bridges/workspace-scan.ts";

const PROFILE_SCAN_TTL_MS = 30_000;

export function createProfilesSceneState() {
  return {
    config: {},
    configPath: ".rundown/config.json",
    references: [],
    selectedProfileIndex: 0,
    inspectProfile: null,
    inspectSelectedReferenceIndex: 0,
    referencesScannedAt: 0,
    referencesScanned: false,
    banner: "",
    loading: true,
  };
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clampIndex(index, length) {
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

function withSectionGap(lines, sectionGap) {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

function formatCommandPreview(commandValue) {
  if (!Array.isArray(commandValue)) {
    return "(invalid command)";
  }
  const tokens = commandValue.filter((part) => typeof part === "string");
  if (tokens.length === 0) {
    return "(empty command)";
  }
  return tokens.join(" ");
}

function collectUsageByProfile(references) {
  const byProfile = new Map();
  const entries = Array.isArray(references) ? references : [];

  for (const reference of entries) {
    const profileName = typeof reference?.profile === "string" ? reference.profile : "";
    const kind = typeof reference?.kind === "string" ? reference.kind : "";
    if (profileName.length === 0) {
      continue;
    }
    if (kind !== "frontmatter" && kind !== "directive" && kind !== "prefix") {
      continue;
    }

    if (!byProfile.has(profileName)) {
      byProfile.set(profileName, {
        frontmatter: 0,
        directive: 0,
        prefix: 0,
      });
    }

    const aggregate = byProfile.get(profileName);
    aggregate[kind] += 1;
  }

  return byProfile;
}

function collectReferencesForProfile(references, profileName) {
  if (typeof profileName !== "string" || profileName.length === 0) {
    return [];
  }
  const entries = Array.isArray(references) ? references : [];
  return entries.filter((reference) => {
    if (reference?.profile !== profileName) {
      return false;
    }
    return reference?.kind === "frontmatter"
      || reference?.kind === "directive"
      || reference?.kind === "prefix";
  });
}

function collectUnknownReferenceGroups(references, knownProfileNames) {
  const known = new Set(Array.isArray(knownProfileNames) ? knownProfileNames : []);
  const entries = Array.isArray(references) ? references : [];
  const grouped = new Map();

  for (const reference of entries) {
    const profileName = typeof reference?.profile === "string" ? reference.profile : "";
    const kind = typeof reference?.kind === "string" ? reference.kind : "";
    if (profileName.length === 0 || known.has(profileName)) {
      continue;
    }
    if (kind !== "frontmatter" && kind !== "directive" && kind !== "prefix") {
      continue;
    }

    if (!grouped.has(profileName)) {
      grouped.set(profileName, []);
    }
    grouped.get(profileName).push(reference);
  }

  return Array.from(grouped.entries()).map(([name, refs]) => ({
    name,
    count: refs.length,
    references: refs,
  }));
}

function buildSelectableRows(profileNames, unknownGroups) {
  const rows = [];
  for (const name of profileNames) {
    rows.push({
      type: "profile",
      name,
    });
  }

  for (const group of unknownGroups) {
    rows.push({
      type: "unknown",
      name: group.name,
    });
  }

  return rows;
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

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeEditConfigFile(filePath, {
  currentWorkingDirectory,
  suspendTui,
  resumeTui,
  launchEditorFn,
} = {}) {
  try {
    ensureParentDirectory(filePath);
    suspendTui?.();
    let launchResult;
    try {
      launchResult = launchEditorFn(filePath, { cwd: currentWorkingDirectory });
    } finally {
      resumeTui?.();
    }
    return launchResult;
  } catch (error) {
    return {
      ok: false,
      message: `Failed to launch editor for ${filePath}: ${toErrorMessage(error)}`,
    };
  }
}

function buildBridgeBundle(currentWorkingDirectory, {
  configBridgeFactory = createConfigBridge,
  workspaceScanBridgeFactory = createWorkspaceScanBridge,
} = {}) {
  return {
    configBridge: configBridgeFactory({ cwd: currentWorkingDirectory }),
    workspaceScanBridge: workspaceScanBridgeFactory({ cwd: currentWorkingDirectory }),
  };
}

export async function reloadProfilesSceneState({
  state,
  currentWorkingDirectory = process.cwd(),
  forceRescan = false,
  keepBanner = false,
  now = Date.now,
  configBridgeFactory,
  workspaceScanBridgeFactory,
} = {}) {
  const sceneState = {
    ...(state ?? createProfilesSceneState()),
    loading: true,
  };
  if (!keepBanner) {
    sceneState.banner = "";
  }

  const { configBridge, workspaceScanBridge } = buildBridgeBundle(currentWorkingDirectory, {
    configBridgeFactory,
    workspaceScanBridgeFactory,
  });
  const configPathPromise = configBridge.resolveConfigPath("local");
  const configPromise = configBridge.loadWorkerConfig();

  const scanStale = now() - (sceneState.referencesScannedAt || 0) >= PROFILE_SCAN_TTL_MS;
  const shouldScan = forceRescan || !sceneState.referencesScanned || scanStale;
  const scanPromise = shouldScan
    ? workspaceScanBridge.scanProfileReferences({ sourcePath: currentWorkingDirectory })
    : Promise.resolve(sceneState.references);

  const [configPathResult, configResult, scanResult] = await Promise.allSettled([
    configPathPromise,
    configPromise,
    scanPromise,
  ]);

  const errors = [];

  if (configPathResult.status === "fulfilled" && typeof configPathResult.value === "string" && configPathResult.value.length > 0) {
    sceneState.configPath = configPathResult.value;
  } else if (configPathResult.status === "rejected") {
    errors.push(`Config path failed: ${toErrorMessage(configPathResult.reason)}`);
  }

  if (configResult.status === "fulfilled") {
    sceneState.config = safeObject(configResult.value);
  } else {
    errors.push(`Config load failed: ${toErrorMessage(configResult.reason)}`);
  }

  if (scanResult.status === "fulfilled") {
    sceneState.references = Array.isArray(scanResult.value) ? scanResult.value : [];
    if (shouldScan) {
      sceneState.referencesScannedAt = now();
      sceneState.referencesScanned = true;
    }
  } else {
    errors.push(`Workspace scan failed: ${toErrorMessage(scanResult.reason)}`);
  }

  if (errors.length > 0) {
    sceneState.banner = errors.join(" | ");
  }

  sceneState.loading = false;
  return sceneState;
}

export function renderProfilesSceneLines({ state, sectionGap = 1 } = {}) {
  const sceneState = state ?? createProfilesSceneState();
  const config = safeObject(sceneState.config);
  const profiles = safeObject(config.profiles);
  const usageByProfile = collectUsageByProfile(sceneState.references);
  const profileNames = Object.keys(profiles);
  const unknownReferenceGroups = collectUnknownReferenceGroups(sceneState.references, profileNames);
  const selectableRows = buildSelectableRows(profileNames, unknownReferenceGroups);
  const selectedProfileIndex = clampIndex(sceneState.selectedProfileIndex, selectableRows.length);
  const isInspecting = typeof sceneState.inspectProfile === "string" && sceneState.inspectProfile.length > 0;

  const lines = [
    pc.bold("Profiles"),
    pc.dim(sceneState.configPath || ".rundown/config.json"),
  ];

  if (sceneState.loading) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("Loading profiles..."));
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

  if (profileNames.length === 0 && unknownReferenceGroups.length === 0) {
    lines.push(pc.dim("No profiles defined."));
    lines.push(pc.dim("Hint: run `rundown config --help` for profile options."));
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("[e] edit config.json"));
    lines.push(pc.dim("[Esc] Back to menu"));
    return lines;
  }

  if (isInspecting) {
    const inspectProfile = sceneState.inspectProfile;
    const references = collectReferencesForProfile(sceneState.references, inspectProfile);
    const selectedReferenceIndex = clampIndex(sceneState.inspectSelectedReferenceIndex, references.length);
    lines.push(pc.bold(`Inspect references: ${inspectProfile}`));
    if (references.length === 0) {
      lines.push(pc.dim("  No references found."));
    } else {
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        const kind = reference.kind;
        const file = typeof reference.file === "string" && reference.file.length > 0 ? reference.file : "(unknown file)";
        const line = Number.isInteger(reference.line) && reference.line > 0 ? reference.line : 1;
        const prefix = index === selectedReferenceIndex ? "> " : "  ";
        lines.push(`${prefix}[${kind}] ${file}:${line}`);
      }
    }
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("[↵] open reference in editor"));
    lines.push(pc.dim("[Esc] Back to profiles"));
    return lines;
  }

  const nameColumnWidth = Math.max(
    8,
    profileNames.reduce((max, name) => Math.max(max, name.length), 0),
  );

  if (profileNames.length === 0) {
    lines.push(pc.dim("No profiles defined."));
    lines.push(pc.dim("Hint: run `rundown config --help` for profile options."));
    withSectionGap(lines, sectionGap);
  }

  for (let index = 0; index < profileNames.length; index += 1) {
    const profileName = profileNames[index];
    const preview = formatCommandPreview(profiles[profileName]);
    const rowIndex = index;
    const prefix = rowIndex === selectedProfileIndex ? "> " : "  ";
    lines.push(`${prefix}${profileName.padEnd(nameColumnWidth, " ")}  ${preview}`);

    const usage = usageByProfile.get(profileName);
    if (!usage) {
      lines.push(pc.dim("            used by: (no references found)"));
      continue;
    }

    lines.push(pc.dim(
      `            used by: ${usage.frontmatter} frontmatter · ${usage.directive} directives · ${usage.prefix} prefix`,
    ));
  }

  if (unknownReferenceGroups.length > 0) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.bold("Unknown references"));
    for (let index = 0; index < unknownReferenceGroups.length; index += 1) {
      const group = unknownReferenceGroups[index];
      const rowIndex = profileNames.length + index;
      const prefix = rowIndex === selectedProfileIndex ? "> " : "  ";
      lines.push(`${prefix}${group.name} · ${group.count}`);
    }
  }

  withSectionGap(lines, sectionGap);
  if (selectableRows.length > 0) {
    lines.push(pc.dim("[↵] inspect references"));
  }
  lines.push(pc.dim("[e] edit config.json"));
  lines.push(pc.dim("[u] full scan"));
  lines.push(pc.dim("[Esc] Back to menu"));
  return lines;
}

export function handleProfilesInput({ rawInput, state } = {}) {
  const sceneState = state ?? createProfilesSceneState();
  const config = safeObject(sceneState.config);
  const profiles = safeObject(config.profiles);
  const profileNames = Object.keys(profiles);
  const unknownReferenceGroups = collectUnknownReferenceGroups(sceneState.references, profileNames);
  const selectableRows = buildSelectableRows(profileNames, unknownReferenceGroups);
  const input = String(rawInput ?? "");
  const normalized = input.toLowerCase();

  const isInspecting = typeof sceneState.inspectProfile === "string" && sceneState.inspectProfile.length > 0;
  if (isInspecting) {
    if (rawInput === "\u001b" || rawInput === "\b" || rawInput === "\u007f") {
      return {
        handled: true,
        state: {
          ...sceneState,
          inspectProfile: null,
          inspectSelectedReferenceIndex: 0,
        },
        backToParent: false,
      };
    }

    const references = collectReferencesForProfile(sceneState.references, sceneState.inspectProfile);
    const selectedReferenceIndex = clampIndex(sceneState.inspectSelectedReferenceIndex, references.length);
    if (input === "\u001b[A" || normalized === "k") {
      return {
        handled: true,
        state: {
          ...sceneState,
          inspectSelectedReferenceIndex: clampIndex(selectedReferenceIndex - 1, references.length),
        },
        backToParent: false,
      };
    }
    if (input === "\u001b[B" || normalized === "j") {
      return {
        handled: true,
        state: {
          ...sceneState,
          inspectSelectedReferenceIndex: clampIndex(selectedReferenceIndex + 1, references.length),
        },
        backToParent: false,
      };
    }

    if (input === "\r" || input === "\n") {
      const reference = references[selectedReferenceIndex];
      if (!reference || typeof reference.file !== "string" || reference.file.length === 0) {
        return {
          handled: true,
          state: sceneState,
          backToParent: false,
        };
      }
      return {
        handled: true,
        state: sceneState,
        backToParent: false,
        action: {
          type: "open-reference",
          reference: {
            file: reference.file,
            line: reference.line,
          },
        },
      };
    }

    return {
      handled: false,
      state: sceneState,
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

  const selectedProfileIndex = clampIndex(sceneState.selectedProfileIndex, selectableRows.length);

  if (input === "\u001b[A" || normalized === "k") {
    return {
      handled: true,
      state: {
        ...sceneState,
        selectedProfileIndex: clampIndex(selectedProfileIndex - 1, selectableRows.length),
      },
      backToParent: false,
    };
  }

  if (input === "\u001b[B" || normalized === "j") {
    return {
      handled: true,
      state: {
        ...sceneState,
        selectedProfileIndex: clampIndex(selectedProfileIndex + 1, selectableRows.length),
      },
      backToParent: false,
    };
  }

  if (input === "\r" || input === "\n") {
    const selectedRow = selectableRows[selectedProfileIndex];
    if (!selectedRow?.name) {
      return {
        handled: true,
        state: sceneState,
        backToParent: false,
      };
    }
    return {
      handled: true,
      state: {
        ...sceneState,
        inspectProfile: selectedRow.name,
        inspectSelectedReferenceIndex: 0,
      },
      backToParent: false,
    };
  }

  if (normalized === "u") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "full-rescan" },
    };
  }

  if (input === "e") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "edit-config" },
    };
  }

  return {
    handled: false,
    state: sceneState,
    backToParent: false,
  };
}

export async function runProfilesSceneAction({
  action,
  state,
  currentWorkingDirectory = process.cwd(),
  suspendTui,
  resumeTui,
  launchEditorFn = launchEditor,
  reloadProfilesSceneStateFn = reloadProfilesSceneState,
} = {}) {
  if (!action || typeof action.type !== "string") {
    return state ?? createProfilesSceneState();
  }

  if (action.type === "full-rescan") {
    return reloadProfilesSceneState({
      state,
      currentWorkingDirectory,
      forceRescan: true,
      keepBanner: false,
    });
  }

  if (action.type === "open-reference") {
    const sceneState = state ?? createProfilesSceneState();
    const reference = action.reference;
    const filePath = typeof reference?.file === "string" ? reference.file : "";
    const line = Number.isInteger(reference?.line) && reference.line > 0 ? reference.line : undefined;
    if (filePath.length === 0) {
      return {
        ...sceneState,
        banner: "Reference file path is missing.",
      };
    }

    let launchResult;
    suspendTui?.();
    try {
      launchResult = launchEditorFn(filePath, { cwd: currentWorkingDirectory, line });
    } catch (error) {
      launchResult = {
        ok: false,
        message: `Failed to launch editor for ${filePath}: ${toErrorMessage(error)}`,
      };
    } finally {
      resumeTui?.();
    }

    if (!launchResult.ok) {
      return {
        ...sceneState,
        banner: launchResult.message || "Failed to open editor.",
      };
    }

    return {
      ...sceneState,
      banner: "",
    };
  }

  if (action.type === "edit-config") {
    const sceneState = state ?? createProfilesSceneState();
    const configPath = typeof sceneState.configPath === "string" && sceneState.configPath.length > 0
      ? sceneState.configPath
      : path.join(currentWorkingDirectory, ".rundown", "config.json");

    const launchResult = safeEditConfigFile(configPath, {
      currentWorkingDirectory,
      suspendTui,
      resumeTui,
      launchEditorFn,
    });

    if (!launchResult?.ok) {
      return {
        ...sceneState,
        configPath,
        banner: launchResult?.message || "Failed to open editor.",
      };
    }

    try {
      return await reloadProfilesSceneStateFn({
        state: {
          ...sceneState,
          configPath,
        },
        currentWorkingDirectory,
        keepBanner: false,
      });
    } catch (error) {
      return {
        ...sceneState,
        configPath,
        loading: false,
        banner: `Config load failed: ${toErrorMessage(error)}`,
      };
    }
  }

  return state ?? createProfilesSceneState();
}
