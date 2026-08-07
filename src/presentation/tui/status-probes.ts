// @ts-nocheck
import { createApp } from "../../create-app.js";
import type { App, CreateAppDependencies } from "../../create-app.js";
import type { ApplicationOutputEvent } from "../../domain/ports/output-port.js";
import { detectRootWorkspaceState } from "./root-workspace-state.ts";
import fs from "node:fs";
import path from "node:path";

type AppFactory = (dependencies?: CreateAppDependencies) => App;

const UNKNOWN_PROBE_STATUS = Object.freeze({ text: "?", tone: "muted" });
const PENDING_PROBE_STATUS = Object.freeze({ text: "...", tone: "muted" });
const CONTINUE_SOURCE = "migrations/";
const AGENT_MARKDOWN_PATH = ".rundown/agent.md";

const PROBE_TTLS_MS = Object.freeze({
  start: Number.POSITIVE_INFINITY,
  continue: 2000,
  newWork: 5000,
  workers: 10000,
  profiles: 10000,
  settings: 30000,
  help: Number.POSITIVE_INFINITY,
});

const ROW_IDS = Object.freeze(Object.keys(PROBE_TTLS_MS));

function normalizeProbeStatus(value) {
  if (!value || typeof value !== "object") {
    return PENDING_PROBE_STATUS;
  }
  const text = typeof value.text === "string" ? value.text : String(value.text ?? "");
  const tone = value.tone === "ok" || value.tone === "warn" || value.tone === "error" || value.tone === "muted"
    ? value.tone
    : "muted";
  return { text, tone };
}

async function runProbeSafely(probe) {
  try {
    return normalizeProbeStatus(await probe());
  } catch {
    return UNKNOWN_PROBE_STATUS;
  }
}

function createDefaultProbe(rowId) {
  if (rowId === "start") {
    return createStartProbe();
  }
  if (rowId === "continue") {
    return createContinueProbe();
  }
  if (rowId === "newWork") {
    return createNewWorkProbe();
  }
  if (rowId === "workers") {
    return createWorkersProbe();
  }
  if (rowId === "profiles") {
    return createProfilesProbe();
  }
  if (rowId === "settings") {
    return createSettingsProbe();
  }
  if (rowId === "help") {
    return () => ({ text: "docs · website · changelog · keys", tone: "muted" });
  }
  return () => PENDING_PROBE_STATUS;
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
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

function collectAppTextOutput(event: ApplicationOutputEvent, buffer: string[]): void {
  if (event?.kind === "text" && typeof event.text === "string") {
    buffer.push(event.text);
  }
}

function parseHealthPayload(payload) {
  const parsed = safeObject(payload);
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const fallbackOrderSnapshots = Array.isArray(parsed.fallbackOrderSnapshots)
    ? parsed.fallbackOrderSnapshots
    : [];
  return {
    entries,
    fallbackOrderSnapshots,
  };
}

function parseConfigListPayload(payload) {
  const parsed = safeObject(payload);
  return safeObject(parsed.config);
}

function normalizeProfileIdentity(key) {
  if (typeof key !== "string") {
    return "";
  }
  return key.startsWith("profile:") ? key.slice("profile:".length) : key;
}

function toTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function describeEligibilityReason(candidate) {
  const workerReason = candidate?.worker?.reason;
  const profileReason = candidate?.profile?.reason;
  if (workerReason === "unavailable" || profileReason === "unavailable") {
    return "worker unavailable";
  }
  if (workerReason === "cooling_down" || profileReason === "cooling_down") {
    return "worker cooling down";
  }
  return "worker not eligible";
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
    if (exitCode !== 0) {
      return undefined;
    }
    return extractLastJsonText(textEvents, start);
  } finally {
    app?.releaseAllLocks?.();
    await app?.awaitShutdown?.();
  }
}

export function createContinueProbe({ appFactory = createApp, source = CONTINUE_SOURCE }: { appFactory?: AppFactory; source?: string } = {}) {
  return async function runContinueProbe() {
    const pendingFiles = new Set();
    let pendingTasks = 0;
    let app;

    try {
      app = appFactory({
        ports: {
          output: {
            emit(event: ApplicationOutputEvent) {
              if (event?.kind !== "task" || !event.task) {
                return;
              }
              pendingTasks += 1;
              const file = typeof event.task.file === "string" ? event.task.file : "";
              if (file.length > 0) {
                pendingFiles.add(file);
              }
            },
          },
        },
      });

      const exitCode = await app.listTasks({ source, sortMode: "name-sort", includeAll: false });
      if (exitCode !== 0 && exitCode !== 3) {
        return UNKNOWN_PROBE_STATUS;
      }

      return {
        text: `${pendingTasks} tasks · ${pendingFiles.size} migrations pending`,
        tone: pendingTasks > 0 ? "warn" : "ok",
      };
    } catch {
      return UNKNOWN_PROBE_STATUS;
    } finally {
      app?.releaseAllLocks?.();
      await app?.awaitShutdown?.();
    }
  };
}

export function createNewWorkProbe({ appFactory = createApp, cwd = process.cwd() }: { appFactory?: AppFactory; cwd?: string } = {}) {
  return async function runNewWorkProbe() {
    try {
      const agentPath = path.join(cwd, AGENT_MARKDOWN_PATH);
      if (!fs.existsSync(agentPath)) {
        return { text: "agent.md missing!", tone: "error" };
      }

      const payload = await runAppJsonCommand({
        appFactory,
        invoke: (app) => app.viewWorkerHealthStatus({ json: true }),
      });
      const { fallbackOrderSnapshots } = parseHealthPayload(payload);
      const runSnapshot = fallbackOrderSnapshots.find((snapshot) => snapshot?.commandName === "run");
      const primaryCandidate = Array.isArray(runSnapshot?.candidates)
        ? runSnapshot.candidates.find((candidate) => candidate?.source === "primary")
        : undefined;

      if (!primaryCandidate) {
        return { text: "worker status unavailable", tone: "warn" };
      }

      if (primaryCandidate.eligible) {
        return { text: "worker ready", tone: "ok" };
      }

      return {
        text: describeEligibilityReason(primaryCandidate),
        tone: "warn",
      };
    } catch {
      return UNKNOWN_PROBE_STATUS;
    }
  };
}

export function createStartProbe() {
  return async function runStartProbe() {
    return {
      text: "scaffold design/ + migrations/",
      tone: "muted",
    };
  };
}

export function createWorkersProbe({
  appFactory = createApp,
  cwd = process.cwd(),
  detectWorkspaceState = detectRootWorkspaceState,
}: {
  appFactory?: AppFactory;
  cwd?: string;
  detectWorkspaceState?: (cwd: string) => { isEmptyBootstrap: boolean; hasWorkersConfigured: boolean };
} = {}) {
  return async function runWorkersProbe() {
    try {
      const workspaceState = detectWorkspaceState(cwd);
      if (workspaceState?.isEmptyBootstrap || !workspaceState?.hasWorkersConfigured) {
        return {
          text: "no workers configured yet",
          tone: "warn",
        };
      }

      const [workerConfigPayload, workerHealthPayload] = await Promise.all([
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.configList({ scope: "effective", json: true, showSource: false }),
        }),
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.viewWorkerHealthStatus({ json: true }),
        }),
      ]);

      const workerConfig = parseConfigListPayload(workerConfigPayload);
      const workers = safeObject(workerConfig.workers);
      const fallbackCount = Array.isArray(workers.fallbacks) ? workers.fallbacks.length : 0;

      const { entries } = parseHealthPayload(workerHealthPayload);
      let coolingCount = 0;
      let unavailableCount = 0;
      for (const entry of entries) {
        if (entry?.status === "unavailable") {
          unavailableCount += 1;
          continue;
        }
        if (entry?.status === "cooling_down") {
          coolingCount += 1;
        }
      }

      const segments = [
        `default ${Array.isArray(workers.default) && workers.default.length > 0 ? "✓" : "✗"}`,
        `tui ${Array.isArray(workers.tui) && workers.tui.length > 0 ? "✓" : "✗"}`,
        `${fallbackCount} fallbacks`,
      ];
      if (coolingCount > 0) {
        segments.push(`${coolingCount} cooling`);
      }
      if (unavailableCount > 0) {
        segments.push(`${unavailableCount} unavailable`);
      }

      const tone = unavailableCount > 0 ? "error" : coolingCount > 0 ? "warn" : "ok";
      return {
        text: segments.join(" · "),
        tone,
      };
    } catch {
      return UNKNOWN_PROBE_STATUS;
    }
  };
}

export function createProfilesProbe({ appFactory = createApp }: { appFactory?: AppFactory } = {}) {
  return async function runProfilesProbe() {
    try {
      const [workerConfigPayload, workerHealthPayload] = await Promise.all([
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.configList({ scope: "effective", json: true, showSource: false }),
        }),
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.viewWorkerHealthStatus({ json: true }),
        }),
      ]);

      const workerConfig = parseConfigListPayload(workerConfigPayload);
      const profiles = safeObject(workerConfig.profiles);
      const profileNames = Object.keys(profiles);
      const definedCount = profileNames.length;

      const { entries } = parseHealthPayload(workerHealthPayload);
      let latestProfileName = "";
      let latestTimestamp = Number.NEGATIVE_INFINITY;
      for (const entry of entries) {
        if (entry?.source !== "profile") {
          continue;
        }
        const candidateTimestamp = Math.max(
          toTimestamp(entry.lastSuccessAt),
          toTimestamp(entry.lastFailureAt),
        );
        if (candidateTimestamp <= latestTimestamp) {
          continue;
        }
        latestTimestamp = candidateTimestamp;
        latestProfileName = normalizeProfileIdentity(entry.key);
      }

      const text = latestProfileName
        ? `${definedCount} defined · last used: ${latestProfileName}`
        : `${definedCount} defined`;
      return {
        text,
        tone: definedCount === 0 ? "muted" : "ok",
      };
    } catch {
      return UNKNOWN_PROBE_STATUS;
    }
  };
}

export function createSettingsProbe({ appFactory = createApp }: { appFactory?: AppFactory } = {}) {
  return async function runSettingsProbe() {
    try {
      const [localConfigPayload, globalPathPayload] = await Promise.all([
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.configList({ scope: "local", json: true, showSource: false }),
        }),
        runAppJsonCommand({
          appFactory,
          invoke: (app) => app.configPath({ scope: "global" }),
        }),
      ]);

      const localConfig = parseConfigListPayload(localConfigPayload);
      const commandCount = Object.keys(safeObject(localConfig.commands)).length;
      const profileCount = Object.keys(safeObject(localConfig.profiles)).length;
      const overrideCount = commandCount + profileCount;

      const globalPath = safeObject(globalPathPayload).path;
      const hasGlobalConfig = typeof globalPath === "string"
        && globalPath.length > 0
        && globalPath !== "(unresolved)"
        && fs.existsSync(globalPath);

      return {
        text: `${hasGlobalConfig ? "local + global" : "local"} · ${overrideCount} effective overrides`,
        tone: "muted",
      };
    } catch {
      return UNKNOWN_PROBE_STATUS;
    }
  };
}

export function createStatusProbeRegistry({ probes = {}, now = Date.now } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  for (const rowId of ROW_IDS) {
    cache.set(rowId, {
      status: PENDING_PROBE_STATUS,
      updatedAt: 0,
      stale: true,
    });
  }

  function getTtl(rowId) {
    return PROBE_TTLS_MS[rowId] ?? 0;
  }

  function isStale(rowId, updatedAt) {
    const ttlMs = getTtl(rowId);
    if (!Number.isFinite(ttlMs)) {
      return updatedAt <= 0;
    }
    return now() - updatedAt >= ttlMs;
  }

  async function refreshProbe(rowId) {
    if (!ROW_IDS.includes(rowId)) {
      return UNKNOWN_PROBE_STATUS;
    }
    const existing = inFlight.get(rowId);
    if (existing) {
      return existing;
    }

    const probe = typeof probes[rowId] === "function" ? probes[rowId] : createDefaultProbe(rowId);
    const refreshPromise = runProbeSafely(probe).then((status) => {
      cache.set(rowId, { status, updatedAt: now(), stale: false });
      inFlight.delete(rowId);
      return status;
    });

    inFlight.set(rowId, refreshPromise);
    return refreshPromise;
  }

  function getProbeStatus(rowId) {
    if (!ROW_IDS.includes(rowId)) {
      return UNKNOWN_PROBE_STATUS;
    }
    const entry = cache.get(rowId) ?? { status: PENDING_PROBE_STATUS, updatedAt: 0, stale: true };
    const stale = isStale(rowId, entry.updatedAt);
    if (entry.stale !== stale) {
      cache.set(rowId, {
        status: entry.status,
        updatedAt: entry.updatedAt,
        stale,
      });
    }
    if (stale) {
      void refreshProbe(rowId);
    }
    return entry.status;
  }

  async function refreshAllProbes() {
    await Promise.all(ROW_IDS.map((rowId) => refreshProbe(rowId)));
  }

  return {
    getProbeStatus,
    refreshProbe,
    refreshAllProbes,
    getTtl,
  };
}

export { PROBE_TTLS_MS, ROW_IDS, UNKNOWN_PROBE_STATUS, PENDING_PROBE_STATUS };
