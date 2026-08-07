// @ts-nocheck
import path from "node:path";
import { createApp } from "../../../create-app.js";
import type { App, CreateAppDependencies } from "../../../create-app.js";
import type { ApplicationOutputEvent } from "../../../domain/ports/output-port.js";

type AppFactory = (dependencies?: CreateAppDependencies) => App;

const UNRESOLVED_PATH = "(unresolved)";

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function resolveConfigDirCandidate(value) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value && typeof value === "object" && typeof value.configDir === "string" && value.configDir.length > 0) {
    return value.configDir;
  }
  return undefined;
}

function collectAppTextOutput(event: ApplicationOutputEvent, buffer: string[]): void {
  if (event?.kind === "text" && typeof event.text === "string") {
    buffer.push(event.text);
  }
}

function extractLastJsonText(entries, fromIndex = 0) {
  for (let index = entries.length - 1; index >= fromIndex; index -= 1) {
    const text = entries[index];
    if (typeof text !== "string") {
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      // Keep scanning earlier text entries.
    }
  }
  return undefined;
}

async function runAppJsonCommand({ appFactory = createApp, invoke }: { appFactory?: AppFactory; invoke: (app: App) => Promise<number> | number }) {
  const textEvents = [];
  let app: App | undefined;

  try {
    app = appFactory({
      ports: {
        output: {
          emit(event: ApplicationOutputEvent) {
            collectAppTextOutput(event, textEvents);
          },
        },
      },
    });

    const start = textEvents.length;
    const exitCode = await invoke(app);
    if (typeof exitCode !== "number") {
      throw new Error("App command returned an invalid exit code.");
    }
    if (exitCode !== 0) {
      throw new Error(`App command failed with exit code ${exitCode}.`);
    }

    const payload = extractLastJsonText(textEvents, start);
    if (payload === undefined) {
      throw new Error("App command did not return JSON output.");
    }
    return payload;
  } finally {
    app?.releaseAllLocks?.();
    await app?.awaitShutdown?.();
  }
}

async function runConfigList({ appFactory, scope, showSource = false }) {
  const payload = await runAppJsonCommand({
    appFactory,
    invoke: (app) => app.configList({
      scope,
      json: true,
      showSource,
    }),
  });
  const envelope = safeObject(payload);
  return {
    config: envelope.config,
    sources: envelope.sources,
  };
}

async function runConfigPath({ appFactory, scope }) {
  const payload = await runAppJsonCommand({
    appFactory,
    invoke: (app) => app.configPath({ scope }),
  });

  const envelope = safeObject(payload);
  const pathValue = envelope.path;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error(`App command returned invalid path for scope ${scope}.`);
  }
  return pathValue;
}

export function createConfigBridge({
  appFactory = createApp,
  cwd = process.cwd(),
  configDirPath,
  workerConfigPort,
  configDirResolver,
} = {}) {
  const effectiveConfigDirPath = typeof configDirPath === "string" && configDirPath.length > 0
    ? configDirPath
    : resolveConfigDirCandidate(
      typeof configDirResolver === "function" ? configDirResolver(cwd) : undefined,
    ) ?? path.join(cwd, ".rundown");

  function fallbackListConfig(scope) {
    if (typeof workerConfigPort?.listValues !== "function") {
      return undefined;
    }
    return workerConfigPort.listValues(effectiveConfigDirPath, scope);
  }

  function fallbackListEffective() {
    if (typeof workerConfigPort?.loadWithSources !== "function") {
      return undefined;
    }
    const loaded = workerConfigPort.loadWithSources(effectiveConfigDirPath);
    if (!loaded || typeof loaded !== "object") {
      return undefined;
    }
    return {
      config: loaded.config,
      sources: loaded.valueSources,
    };
  }

  function fallbackResolvePath(scope) {
    if (typeof workerConfigPort?.getConfigPaths !== "function") {
      return undefined;
    }

    const paths = workerConfigPort.getConfigPaths(effectiveConfigDirPath);
    if (scope === "global") {
      return paths.globalConfigPath ?? paths.globalCanonicalPath ?? UNRESOLVED_PATH;
    }
    return paths.localConfigPath;
  }

  async function listConfig(scope = "effective") {
    try {
      const result = await runConfigList({ appFactory, scope, showSource: false });
      return result.config;
    } catch (error) {
      const fallback = fallbackListConfig(scope);
      if (fallback !== undefined) {
        return fallback;
      }
      throw error;
    }
  }

  async function listEffective() {
    try {
      return await runConfigList({ appFactory, scope: "effective", showSource: true });
    } catch (error) {
      const fallback = fallbackListEffective();
      if (fallback !== undefined) {
        return fallback;
      }
      const configFallback = fallbackListConfig("effective");
      if (configFallback !== undefined) {
        return {
          config: configFallback,
          sources: undefined,
        };
      }
      throw error;
    }
  }

  async function listLocal() {
    const config = await listConfig("local");
    return { config };
  }

  async function listGlobal() {
    const config = await listConfig("global");
    return { config };
  }

  async function resolveConfigPath(scope = "local") {
    try {
      const resolved = await runConfigPath({ appFactory, scope });
      if (scope === "global" && resolved === UNRESOLVED_PATH) {
        return UNRESOLVED_PATH;
      }
      return resolved;
    } catch (error) {
      const fallback = fallbackResolvePath(scope);
      if (typeof fallback === "string" && fallback.length > 0) {
        return fallback;
      }
      throw error;
    }
  }

  async function resolveGlobalConfigPath() {
    return resolveConfigPath("global");
  }

  async function getGlobalPath() {
    return resolveGlobalConfigPath();
  }

  async function loadWorkerConfig() {
    return listConfig("effective");
  }

  return {
    configDirPath: effectiveConfigDirPath,
    unresolvedPathMarker: UNRESOLVED_PATH,
    listEffective,
    listLocal,
    listGlobal,
    getGlobalPath,
    listConfig,
    loadWorkerConfig,
    resolveConfigPath,
    resolveGlobalConfigPath,
  };
}
