// @ts-nocheck
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { createConfigBridge } from "../bridges/config-bridge.ts";
import { createHealthBridge } from "../bridges/health-bridge.ts";
import { launchEditor } from "../components/editor-launch.ts";

const COMMAND_OVERRIDE_ORDER = [
  "run",
  "plan",
  "discuss",
  "help",
  "research",
  "reverify",
  "verify",
  "memory",
];

const ROUTING_PHASE_ORDER = ["execute", "verify", "repair", "resolve", "resolveRepair", "reset"];
const EMPTY_JSON_WITH_NEWLINE = "{}\n";

function buildBridgeBundle(currentWorkingDirectory) {
  const configBridge = createConfigBridge({ cwd: currentWorkingDirectory });
  const healthBridge = createHealthBridge({
    cwd: currentWorkingDirectory,
    configDirPath: configBridge.configDirPath,
  });
  return {
    configBridge,
    healthBridge,
  };
}

export function createWorkersSceneState() {
  return {
    config: {},
    healthStatus: {
      entries: [],
    },
    configPath: ".rundown/config.json",
    globalConfigPath: "(unresolved)",
    banner: "",
    loading: true,
    pendingGlobalBootstrap: false,
  };
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function withSectionGap(lines, sectionGap) {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

function formatCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    return "(empty command)";
  }
  return command.join(" ");
}

function parseWorkerIdentityFromKey(key) {
  if (typeof key !== "string" || !key.startsWith("worker:")) {
    return "";
  }
  const payload = key.slice("worker:".length);
  try {
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
      return parsed.join(" ");
    }
  } catch {
    return "";
  }
  return "";
}

function formatClock(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "";
  }
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const ss = String(time.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function buildHealthIndex(healthStatus) {
  const entries = Array.isArray(healthStatus?.entries) ? healthStatus.entries : [];
  const byIdentity = new Map();

  for (const entry of entries) {
    if (entry?.source !== "worker") {
      continue;
    }

    const identityFromKey = parseWorkerIdentityFromKey(entry.key);
    if (identityFromKey.length > 0 && !byIdentity.has(identityFromKey)) {
      byIdentity.set(identityFromKey, entry);
    }

    if (typeof entry.identity === "string" && entry.identity.length > 0 && !byIdentity.has(entry.identity)) {
      byIdentity.set(entry.identity, entry);
    }
  }

  return byIdentity;
}

function formatHealth(entry) {
  if (!entry || typeof entry !== "object") {
    return pc.dim("-");
  }

  if (entry.status === "ready") {
    return pc.green("✓ ready");
  }

  if (entry.status === "cooling_down") {
    const until = formatClock(entry.cooldownUntil);
    const failureClass = typeof entry.lastFailureClass === "string" && entry.lastFailureClass.length > 0
      ? ` (${entry.lastFailureClass})`
      : "";
    if (until) {
      return pc.yellow(`⚠ cooling until ${until}${failureClass}`);
    }
    return pc.yellow(`⚠ cooling${failureClass}`);
  }

  if (entry.status === "unavailable") {
    return pc.red("✗ unavailable");
  }

  return pc.dim("-");
}

function formatRoutingSummary(phase, routeConfig) {
  if (!routeConfig || typeof routeConfig !== "object") {
    if (phase === "reset") {
      return pc.green("✓ not configured (semantic reset disabled)");
    }
    return pc.green("✓ inherits");
  }

  if (phase === "repair" || phase === "resolveRepair") {
    const attempts = Array.isArray(routeConfig.attempts) ? routeConfig.attempts.length : 0;
    if (attempts > 0) {
      const ruleLabel = attempts === 1 ? "attempt rule" : "attempt rules";
      return pc.yellow(`⚙ overridden · ${attempts} ${ruleLabel}`);
    }
  }

  return pc.yellow("⚙ overridden");
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

async function resolveLocalConfigPath(sceneState, currentWorkingDirectory) {
  if (typeof sceneState.configPath === "string" && sceneState.configPath.length > 0) {
    return sceneState.configPath;
  }
  const bridges = buildBridgeBundle(currentWorkingDirectory);
  return bridges.configBridge.resolveConfigPath("local");
}

async function resolveGlobalConfigPath(sceneState, currentWorkingDirectory) {
  if (typeof sceneState.globalConfigPath === "string" && sceneState.globalConfigPath.length > 0) {
    return sceneState.globalConfigPath;
  }
  const bridges = buildBridgeBundle(currentWorkingDirectory);
  return bridges.configBridge.resolveGlobalConfigPath();
}

export async function reloadWorkersSceneState({
  state,
  currentWorkingDirectory = process.cwd(),
  keepBanner = false,
} = {}) {
  const sceneState = {
    ...(state ?? createWorkersSceneState()),
    loading: true,
    pendingGlobalBootstrap: false,
  };
  if (!keepBanner) {
    sceneState.banner = "";
  }

  const { configBridge, healthBridge } = buildBridgeBundle(currentWorkingDirectory);
  const [configResult, healthResult, localPathResult, globalPathResult] = await Promise.allSettled([
    configBridge.loadWorkerConfig(),
    healthBridge.loadHealthStatus(),
    configBridge.resolveConfigPath("local"),
    configBridge.resolveGlobalConfigPath(),
  ]);

  if (configResult.status === "fulfilled") {
    sceneState.config = safeObject(configResult.value);
  }
  if (healthResult.status === "fulfilled") {
    sceneState.healthStatus = safeObject(healthResult.value);
  }
  if (localPathResult.status === "fulfilled" && typeof localPathResult.value === "string" && localPathResult.value.length > 0) {
    sceneState.configPath = localPathResult.value;
  }
  if (globalPathResult.status === "fulfilled" && typeof globalPathResult.value === "string" && globalPathResult.value.length > 0) {
    sceneState.globalConfigPath = globalPathResult.value;
  }

  const errors = [];
  if (configResult.status === "rejected") {
    errors.push(`Config load failed: ${toErrorMessage(configResult.reason)}`);
  }
  if (healthResult.status === "rejected") {
    errors.push(`Health load failed: ${toErrorMessage(healthResult.reason)}`);
  }
  if (localPathResult.status === "rejected") {
    errors.push(`Local config path failed: ${toErrorMessage(localPathResult.reason)}`);
  }
  if (globalPathResult.status === "rejected") {
    errors.push(`Global config path failed: ${toErrorMessage(globalPathResult.reason)}`);
  }

  if (errors.length > 0) {
    sceneState.banner = errors.join(" | ");
  }

  sceneState.loading = false;
  return sceneState;
}

function editConfigFile(filePath, { currentWorkingDirectory, suspendTui, resumeTui } = {}) {
  ensureParentDirectory(filePath);
  suspendTui?.();
  let launchResult;
  try {
    launchResult = launchEditor(filePath, { cwd: currentWorkingDirectory });
  } finally {
    resumeTui?.();
  }
  return launchResult;
}

function safeEditConfigFile(filePath, options) {
  try {
    return editConfigFile(filePath, options);
  } catch (error) {
    return {
      ok: false,
      reason: "launch-threw",
      message: `Failed to launch editor for ${filePath}: ${toErrorMessage(error)}`,
    };
  }
}

function pushLabeledRow(lines, label, value, healthText = "") {
  const labelColumn = label.padEnd(18, " ");
  const base = `  ${labelColumn}${value}`;
  if (!healthText) {
    lines.push(base);
    return;
  }
  lines.push(`${base}  ${healthText}`);
}

export function renderWorkersSceneLines({ state, sectionGap = 1 } = {}) {
  const sceneState = state ?? createWorkersSceneState();
  const config = safeObject(sceneState.config);
  const workers = safeObject(config.workers);
  const commands = safeObject(config.commands);
  const routing = safeObject(safeObject(config.run).workerRouting);
  const healthByIdentity = buildHealthIndex(sceneState.healthStatus);

  const lines = [
    pc.bold("Workers"),
    pc.dim(sceneState.configPath || ".rundown/config.json"),
  ];

  if (sceneState.loading) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("Loading worker configuration..."));
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
  lines.push(pc.bold("Pool"));

  const hasDefault = Object.hasOwn(workers, "default");
  const hasTui = Object.hasOwn(workers, "tui");
  const fallbacks = Array.isArray(workers.fallbacks) ? workers.fallbacks : [];
  const hasWorkerTimeout = typeof config.workerTimeoutMs === "number";

  if (!hasDefault && !hasTui && fallbacks.length === 0 && !hasWorkerTimeout) {
    lines.push(pc.dim("  No worker defaults configured."));
  } else {
    if (hasDefault) {
      const value = formatCommand(workers.default);
      pushLabeledRow(lines, "default", value, formatHealth(healthByIdentity.get(value)));
    }

    if (hasTui) {
      const value = formatCommand(workers.tui);
      pushLabeledRow(lines, "tui", value, formatHealth(healthByIdentity.get(value)));
    }

    if (fallbacks.length > 0) {
      for (let index = 0; index < fallbacks.length; index += 1) {
        const fallbackValue = formatCommand(fallbacks[index]);
        const label = index === 0 ? "fallbacks" : "";
        pushLabeledRow(
          lines,
          label,
          `${index + 1}. ${fallbackValue}`,
          formatHealth(healthByIdentity.get(fallbackValue)),
        );
      }
    }

    if (hasWorkerTimeout) {
      pushLabeledRow(lines, "workerTimeoutMs", String(config.workerTimeoutMs));
    }
  }

  const commandKeys = Object.keys(commands);
  const orderedCommandKeys = [
    ...COMMAND_OVERRIDE_ORDER.filter((key) => Object.hasOwn(commands, key)),
    ...commandKeys.filter((key) => key.startsWith("tools.")).sort(),
    ...commandKeys
      .filter((key) => !COMMAND_OVERRIDE_ORDER.includes(key) && !key.startsWith("tools."))
      .sort(),
  ];

  if (orderedCommandKeys.length > 0) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.bold("Per-command overrides (commands.<name>)"));
    for (const key of orderedCommandKeys) {
      const value = formatCommand(commands[key]);
      pushLabeledRow(lines, key, value, formatHealth(healthByIdentity.get(value)));
    }
  }

  if (Object.keys(routing).length > 0) {
    withSectionGap(lines, sectionGap);
    lines.push(pc.bold("Phase routing (run.workerRouting) - summary"));
    for (const phase of ROUTING_PHASE_ORDER) {
      pushLabeledRow(lines, phase, formatRoutingSummary(phase, routing[phase]));
    }
  }

  withSectionGap(lines, sectionGap);
  lines.push(pc.dim("[e] edit config   [H] health   [T] tools   [r] reload"));
  lines.push(pc.dim("[Esc] Back to menu"));
  return lines;
}

export function handleWorkersInput({ rawInput, state } = {}) {
  const sceneState = state ?? createWorkersSceneState();
  const input = String(rawInput ?? "");
  const normalized = input.toLowerCase();
  const isEscape = rawInput === "\u001b";
  const isBackspace = rawInput === "\b" || rawInput === "\u007f";
  if (isEscape || isBackspace) {
    return {
      handled: true,
      state: sceneState,
      backToParent: true,
    };
  }

  if (normalized === "r") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "reload" },
    };
  }

  if (input === "e") {
    return {
      handled: true,
      state: {
        ...sceneState,
        pendingGlobalBootstrap: false,
      },
      backToParent: false,
      action: { type: "edit-local" },
    };
  }

  if (input === "E") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "edit-global" },
    };
  }

  if (input === "H") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "open-health" },
    };
  }

  if (input === "T") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "open-tools" },
    };
  }

  return {
    handled: false,
    state: sceneState,
    backToParent: false,
  };
}

export async function runWorkersSceneAction({
  action,
  state,
  currentWorkingDirectory = process.cwd(),
  suspendTui,
  resumeTui,
} = {}) {
  const sceneState = state ?? createWorkersSceneState();
  if (!action || typeof action.type !== "string") {
    return sceneState;
  }

  if (action.type === "reload") {
    return reloadWorkersSceneState({
      state: {
        ...sceneState,
        pendingGlobalBootstrap: false,
      },
      currentWorkingDirectory,
      keepBanner: false,
    });
  }

  if (action.type === "edit-local") {
    let localPath;
    try {
      localPath = await resolveLocalConfigPath(sceneState, currentWorkingDirectory);
    } catch (error) {
      return {
        ...sceneState,
        pendingGlobalBootstrap: false,
        banner: `Unable to resolve local config path: ${toErrorMessage(error)}`,
      };
    }

    const launchResult = safeEditConfigFile(localPath, {
      currentWorkingDirectory,
      suspendTui,
      resumeTui,
    });
    if (!launchResult.ok) {
      return {
        ...sceneState,
        configPath: localPath,
        pendingGlobalBootstrap: false,
        banner: launchResult.message || "Failed to open editor.",
      };
    }

    return reloadWorkersSceneState({
      state: {
        ...sceneState,
        configPath: localPath,
      },
      currentWorkingDirectory,
      keepBanner: false,
    });
  }

  if (action.type === "edit-global") {
    let globalPath;
    try {
      globalPath = await resolveGlobalConfigPath(sceneState, currentWorkingDirectory);
    } catch (error) {
      return {
        ...sceneState,
        pendingGlobalBootstrap: false,
        banner: `Unable to resolve global config path: ${toErrorMessage(error)}`,
      };
    }

    if (typeof globalPath !== "string" || globalPath.length === 0 || globalPath === "(unresolved)") {
      return {
        ...sceneState,
        globalConfigPath: globalPath,
        pendingGlobalBootstrap: false,
        banner: "Global config path is unresolved.",
      };
    }

    if (!fs.existsSync(globalPath)) {
      if (!sceneState.pendingGlobalBootstrap) {
        return {
          ...sceneState,
          globalConfigPath: globalPath,
          pendingGlobalBootstrap: true,
          banner: `Global config missing at ${globalPath}. Press [E] again to create {} and edit.`,
        };
      }
      try {
        ensureParentDirectory(globalPath);
        fs.writeFileSync(globalPath, EMPTY_JSON_WITH_NEWLINE, "utf8");
      } catch (error) {
        return {
          ...sceneState,
          globalConfigPath: globalPath,
          pendingGlobalBootstrap: false,
          banner: `Failed to bootstrap global config at ${globalPath}: ${toErrorMessage(error)}`,
        };
      }
    }

    const launchResult = safeEditConfigFile(globalPath, {
      currentWorkingDirectory,
      suspendTui,
      resumeTui,
    });
    if (!launchResult.ok) {
      return {
        ...sceneState,
        globalConfigPath: globalPath,
        pendingGlobalBootstrap: false,
        banner: launchResult.message || "Failed to open editor.",
      };
    }

    return reloadWorkersSceneState({
      state: {
        ...sceneState,
        globalConfigPath: globalPath,
        pendingGlobalBootstrap: false,
      },
      currentWorkingDirectory,
      keepBanner: false,
    });
  }

  return sceneState;
}
