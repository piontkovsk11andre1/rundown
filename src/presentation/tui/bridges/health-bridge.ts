// @ts-nocheck
import path from "node:path";
import { createApp } from "../../../create-app.js";
import type { App, CreateAppDependencies } from "../../../create-app.js";
import type { ApplicationOutputEvent } from "../../../domain/ports/output-port.js";

type AppFactory = (dependencies?: CreateAppDependencies) => App;

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

function parseWorkerIdentityFromKey(key) {
  if (typeof key !== "string") {
    return "";
  }
  const normalized = key.startsWith("worker:") ? key.slice("worker:".length) : key;
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
      return parsed.join(" ");
    }
  } catch {
    // Non-JSON keys are treated as plain text.
  }
  return normalized;
}

function parseProfileIdentityFromKey(key) {
  if (typeof key !== "string") {
    return "";
  }
  return key.startsWith("profile:") ? key.slice("profile:".length) : key;
}

function normalizeStatus(entry) {
  if (entry?.status === "cooling_down" || entry?.reason === "cooling_down") {
    return "cooling_down";
  }
  if (entry?.status === "unavailable" || entry?.reason === "unavailable") {
    return "unavailable";
  }
  if (entry?.status === "healthy" || entry?.status === "ready") {
    return "ready";
  }
  if (entry?.eligible === false) {
    return "unavailable";
  }
  return "ready";
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value.source === "worker" || value.source === "profile"
    ? value.source
    : null;
  if (!source) {
    return null;
  }

  const key = typeof value.key === "string" ? value.key : "";
  const identity = typeof value.identity === "string" && value.identity.length > 0
    ? value.identity
    : source === "worker"
      ? parseWorkerIdentityFromKey(key)
      : parseProfileIdentityFromKey(key);

  const normalized = {
    source,
    key,
    identity,
    status: normalizeStatus(value),
  };

  if (typeof value.cooldownUntil === "string" && value.cooldownUntil.length > 0) {
    normalized.cooldownUntil = value.cooldownUntil;
  }
  if (typeof value.cooldownRemainingSeconds === "number" && Number.isFinite(value.cooldownRemainingSeconds)) {
    normalized.cooldownRemainingSeconds = value.cooldownRemainingSeconds;
  }
  if (typeof value.lastFailureClass === "string" && value.lastFailureClass.length > 0) {
    normalized.lastFailureClass = value.lastFailureClass;
  }
  if (typeof value.lastFailureAt === "string" && value.lastFailureAt.length > 0) {
    normalized.lastFailureAt = value.lastFailureAt;
  }
  if (typeof value.lastSuccessAt === "string" && value.lastSuccessAt.length > 0) {
    normalized.lastSuccessAt = value.lastSuccessAt;
  }
  if (typeof value.failureCountWindow === "number" && Number.isFinite(value.failureCountWindow)) {
    normalized.failureCountWindow = value.failureCountWindow;
  }

  return normalized;
}

function normalizeEntries(values) {
  const records = Array.isArray(values) ? values : [];
  return records
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry !== null)
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source.localeCompare(right.source);
      }
      return left.identity.localeCompare(right.identity);
    });
}

function normalizeHealthPayload(payload, { effectiveConfigDirPath, fallbackFilePath }) {
  const envelope = safeObject(payload);
  const filePath = typeof envelope.filePath === "string" && envelope.filePath.length > 0
    ? envelope.filePath
    : fallbackFilePath;
  const generatedAt = typeof envelope.generatedAt === "string" && envelope.generatedAt.length > 0
    ? envelope.generatedAt
    : new Date().toISOString();
  const configDir = typeof envelope.configDir === "string" && envelope.configDir.length > 0
    ? envelope.configDir
    : effectiveConfigDirPath;

  return {
    generatedAt,
    filePath,
    configDir,
    entries: normalizeEntries(envelope.entries),
  };
}

async function runWorkerHealthStatus({ appFactory }) {
  return runAppJsonCommand({
    appFactory,
    invoke: (app) => app.viewWorkerHealthStatus({ json: true }),
  });
}

async function runResetWorkerHealthEntry({ appFactory, key }) {
  return runAppJsonCommand({
    appFactory,
    invoke: (app) => {
      if (typeof app.resetWorkerHealthEntry !== "function") {
        throw new Error("resetWorkerHealthEntry use case is not registered on the app.");
      }
      return app.resetWorkerHealthEntry({ key, json: true });
    },
  });
}

export function createHealthBridge({
  appFactory = createApp,
  cwd = process.cwd(),
  configDirPath,
  configDirResolver,
  workerHealthStore,
} = {}) {
  const effectiveConfigDirPath = typeof configDirPath === "string" && configDirPath.length > 0
    ? configDirPath
    : resolveConfigDirCandidate(
      typeof configDirResolver === "function" ? configDirResolver(cwd) : undefined,
    ) ?? path.join(cwd, ".rundown");
  const fallbackFilePath = typeof workerHealthStore?.filePath === "function"
    ? workerHealthStore.filePath(effectiveConfigDirPath)
    : path.join(effectiveConfigDirPath, "worker-health.json");

  function fallbackLoadHealthStatus() {
    if (typeof workerHealthStore?.read !== "function") {
      throw new Error("Unable to load worker health: app.viewWorkerHealthStatus failed and no fallback workerHealthStore.read is available.");
    }

    const snapshot = safeObject(workerHealthStore.read(effectiveConfigDirPath));
    return normalizeHealthPayload({
      generatedAt: snapshot.updatedAt,
      filePath: fallbackFilePath,
      configDir: effectiveConfigDirPath,
      entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
    }, {
      effectiveConfigDirPath,
      fallbackFilePath,
    });
  }

  async function loadHealthStatus() {
    try {
      const payload = await runWorkerHealthStatus({ appFactory });
      return normalizeHealthPayload(payload, {
        effectiveConfigDirPath,
        fallbackFilePath,
      });
    } catch {
      return fallbackLoadHealthStatus();
    }
  }

  async function resetEntry(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("resetEntry requires a non-empty entry key.");
    }

    try {
      const payload = await runResetWorkerHealthEntry({ appFactory, key });
      const envelope = safeObject(payload);
      return {
        key: typeof envelope.removedKey === "string" ? envelope.removedKey : key,
        removed: envelope.removed === true,
        filePath: typeof envelope.filePath === "string" && envelope.filePath.length > 0
          ? envelope.filePath
          : fallbackFilePath,
        configDir: typeof envelope.configDir === "string" && envelope.configDir.length > 0
          ? envelope.configDir
          : effectiveConfigDirPath,
        generatedAt: typeof envelope.generatedAt === "string" && envelope.generatedAt.length > 0
          ? envelope.generatedAt
          : new Date().toISOString(),
      };
    } catch (error) {
      // If the application use case is unavailable (e.g. older runtime) but the
      // bridge was constructed with a direct workerHealthStore handle that
      // exposes removeEntry, fall back to the port to keep the scene usable.
      if (typeof workerHealthStore?.removeEntry === "function") {
        const before = safeObject(workerHealthStore.read?.(effectiveConfigDirPath));
        const existed = Array.isArray(before.entries)
          ? before.entries.some((entry) => entry?.key === key)
          : false;
        const snapshot = workerHealthStore.removeEntry(key, effectiveConfigDirPath);
        return {
          key,
          removed: existed,
          filePath: fallbackFilePath,
          configDir: effectiveConfigDirPath,
          generatedAt: typeof snapshot?.updatedAt === "string" && snapshot.updatedAt.length > 0
            ? snapshot.updatedAt
            : new Date().toISOString(),
        };
      }
      throw error;
    }
  }

  async function probeEntry(key) {
    // Manual on-demand worker probes are not yet supported in any layer (no
    // probe port, no probe use case, no probe CLI). Return a stable shape so
    // the Health scene can render `probe not yet supported` and remain usable
    // when a real probe API lands.
    return {
      key: typeof key === "string" ? key : "",
      supported: false,
      reason: "probe not yet supported",
    };
  }

  return {
    configDirPath: effectiveConfigDirPath,
    loadHealthStatus,
    loadWorkerHealth: loadHealthStatus,
    resetEntry,
    probeEntry,
  };
}
