// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { createApp } from "../../../create-app.js";
import type { App, CreateAppDependencies } from "../../../create-app.js";
import type { ApplicationOutputEvent } from "../../../domain/ports/output-port.js";
import { DEFAULT_AGENT_TEMPLATE } from "../../../domain/defaults.js";
import { openDirectory } from "../../../infrastructure/open-directory.js";
import { renderMissingAgentPanelLines } from "../components/missing-agent-panel.ts";
import type { TuiRunState } from "../output-bridge.ts";

type AppFactory = (dependencies?: CreateAppDependencies) => App;

const DEFAULT_WORKER_PATTERN = {
  command: [],
  usesBootstrap: false,
  usesFile: false,
  appendFile: true,
};

const AGENT_PROMPT_FILES = {
  a: ".rundown/discuss-agent.md",
  o: ".rundown/agent.md",
};

const ACTION_LABELS = {
  a: "discuss-agent",
  o: "open-agent",
};

const READY_ENTRY_ACTIONS = {
  enter: "o",
  d: "a",
};

const NEW_WORK_READINESS = {
  missingAgent: "missing-agent",
  missingWorker: "missing-worker",
  noEligibleWorker: "no-eligible-worker",
  ready: "ready",
};

const AGENT_MARKDOWN_PATH = ".rundown/agent.md";
const WORKER_HEALTH_PATH = ".rundown/worker-health.json";
const WORKER_HEALTH_SCHEMA_VERSION = 1;

export function createNewWorkSceneState() {
  return {
    loading: true,
    readiness: undefined,
    hint: "Checking New Work readiness...",
  };
}

function withSectionGap(lines, sectionGap) {
  const gap = Number.isInteger(sectionGap) && sectionGap > 0 ? sectionGap : 0;
  for (let index = 0; index < gap; index += 1) {
    lines.push("");
  }
}

function normalizeCandidateRow(candidate) {
  const workerLabel = typeof candidate?.workerLabel === "string" && candidate.workerLabel.length > 0
    ? candidate.workerLabel
    : "(unknown worker)";
  const source = typeof candidate?.source === "string" && candidate.source.length > 0
    ? candidate.source
    : "(unknown source)";
  const reason = typeof candidate?.reason === "string" && candidate.reason.length > 0
    ? candidate.reason
    : "worker not eligible";
  return `${workerLabel} [${source}] - ${reason}`;
}

export function renderNewWorkSceneLines({ state, sectionGap = 1 } = {}) {
  const sceneState = state ?? createNewWorkSceneState();
  const readiness = sceneState.readiness;
  const lines = [pc.bold("New Work")];

  if (sceneState.loading) {
    lines.push(pc.dim(sceneState.hint || "Checking New Work readiness..."));
    return lines;
  }

  if (readiness?.route === NEW_WORK_READINESS.missingAgent) {
    lines.push(...renderMissingAgentPanelLines({ sectionGap }));
    return lines;
  }

  if (readiness?.route === NEW_WORK_READINESS.missingWorker) {
    lines.push("No worker is configured.");
    withSectionGap(lines, sectionGap);
    lines.push("Configure a worker to run agent sessions:");
    lines.push("  rundown init --worker <command>");
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("[Esc] Back to menu"));
    return lines;
  }

  if (readiness?.route === NEW_WORK_READINESS.noEligibleWorker) {
    lines.push("No eligible worker is available right now.");
    withSectionGap(lines, sectionGap);
    lines.push("Worker health failures:");
    const candidates = Array.isArray(readiness.candidates) ? readiness.candidates : [];
    if (candidates.length === 0) {
      lines.push("  (no failing entries available)");
    } else {
      for (const candidate of candidates) {
        lines.push(`  - ${normalizeCandidateRow(candidate)}`);
      }
    }
    withSectionGap(lines, sectionGap);
    lines.push(pc.dim("[r] Reset worker health"));
    lines.push(pc.dim("[Esc] Back to menu"));
    return lines;
  }

  if (readiness?.route === NEW_WORK_READINESS.ready) {
    lines.push("Select agent flow:");
    lines.push("  [Enter] Open agent (.rundown/agent.md)");
    lines.push("  [d] Discuss agent (.rundown/discuss-agent.md)");
    lines.push(pc.dim("[Esc] Back to menu"));
    return lines;
  }

  if (typeof sceneState.hint === "string" && sceneState.hint.length > 0) {
    lines.push(sceneState.hint);
  } else {
    lines.push(pc.dim("New Work state unavailable."));
  }
  lines.push(pc.dim("[Esc] Back to menu"));
  return lines;
}

export async function loadNewWorkSceneState({ currentWorkingDirectory, cliWorkerCommand = [] }) {
  const readiness = await resolveNewWorkReadiness({
    currentWorkingDirectory,
    cliWorkerCommand,
  });

  return {
    loading: false,
    readiness,
    hint: readiness.hint,
  };
}

export async function resetNewWorkWorkerHealth({ currentWorkingDirectory }) {
  const filePath = path.join(currentWorkingDirectory, WORKER_HEALTH_PATH);
  let removedEntries = 0;

  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed?.entries)) {
        removedEntries = parsed.entries.length;
      }
    } catch {
      removedEntries = 0;
    }
  }

  const payload = {
    schemaVersion: WORKER_HEALTH_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return { removedEntries };
}

export function handleNewWorkSceneInput({ rawInput, state } = {}) {
  const sceneState = state ?? createNewWorkSceneState();
  const input = String(rawInput ?? "").toLowerCase();
  const isEnter = rawInput === "\r" || rawInput === "\n";
  const isEscape = rawInput === "\u001b";
  const isBackspace = rawInput === "\b" || rawInput === "\u007f";

  if (isEscape || isBackspace) {
    return {
      handled: true,
      state: sceneState,
      backToParent: true,
    };
  }

  if (sceneState.loading) {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
    };
  }

  const route = sceneState.readiness?.route;
  if (route === NEW_WORK_READINESS.missingAgent) {
    if (input === "g") {
      return {
        handled: true,
        state: sceneState,
        backToParent: false,
        action: { type: "generate-agent-template" },
      };
    }
    if (input === "o") {
      return {
        handled: true,
        state: sceneState,
        backToParent: false,
        action: { type: "open-rundown-directory" },
      };
    }
  }

  if (route === NEW_WORK_READINESS.noEligibleWorker && input === "r") {
    return {
      handled: true,
      state: sceneState,
      backToParent: false,
      action: { type: "reset-worker-health" },
    };
  }

  if (route === NEW_WORK_READINESS.ready) {
    const actionKey = isEnter ? READY_ENTRY_ACTIONS.enter : READY_ENTRY_ACTIONS[input];
    if (actionKey) {
      return {
        handled: true,
        state: sceneState,
        backToParent: false,
        action: { type: "start-agent", actionKey },
      };
    }
  }

  return {
    handled: false,
    state: sceneState,
    backToParent: false,
  };
}

export function isNewWorkActionKey(actionKey) {
  return actionKey === "a" || actionKey === "o";
}

export function generateNewWorkAgentPrompt({ currentWorkingDirectory }) {
  const promptPath = path.join(currentWorkingDirectory, AGENT_MARKDOWN_PATH);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, DEFAULT_AGENT_TEMPLATE, "utf8");
  return { promptPath };
}

export function openNewWorkRundownDirectory({ currentWorkingDirectory }) {
  const rundownDirectoryPath = path.join(currentWorkingDirectory, ".rundown");
  fs.mkdirSync(rundownDirectoryPath, { recursive: true });
  openDirectory(rundownDirectoryPath);
  return { rundownDirectoryPath };
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

async function resolveNewWorkReadiness({ currentWorkingDirectory, cliWorkerCommand = [] }) {
  const agentPath = path.join(currentWorkingDirectory, AGENT_MARKDOWN_PATH);
  if (!fs.existsSync(agentPath)) {
    return {
      route: NEW_WORK_READINESS.missingAgent,
      agentPath: AGENT_MARKDOWN_PATH,
    };
  }

  const [configPayload, workerHealthPayload] = await Promise.all([
    runAppJsonCommand({
      invoke: (app) => app.configList({ scope: "effective", json: true, showSource: false }),
    }),
    runAppJsonCommand({
      invoke: (app) => app.viewWorkerHealthStatus({ json: true }),
    }),
  ]);

  const config = safeObject(safeObject(configPayload).config);
  const workers = safeObject(config.workers);
  const hasDefaultWorker = Array.isArray(workers.default) && workers.default.length > 0;
  const hasTuiWorker = Array.isArray(workers.tui) && workers.tui.length > 0;
  const hasCliWorker = Array.isArray(cliWorkerCommand) && cliWorkerCommand.length > 0;

  if (!hasDefaultWorker && !hasTuiWorker && !hasCliWorker) {
    return {
      route: NEW_WORK_READINESS.missingWorker,
      hint: "Run `rundown init --worker <command>` to configure a worker.",
    };
  }

  const fallbackOrderSnapshots = Array.isArray(safeObject(workerHealthPayload).fallbackOrderSnapshots)
    ? safeObject(workerHealthPayload).fallbackOrderSnapshots
    : [];
  const runSnapshot = fallbackOrderSnapshots.find((snapshot) => snapshot?.commandName === "run");
  if (!runSnapshot || !Array.isArray(runSnapshot.candidates)) {
    return {
      route: NEW_WORK_READINESS.noEligibleWorker,
      hint: "Unable to read worker eligibility. Run `rundown worker-health`.",
      candidates: [],
    };
  }

  const eligibleCandidate = runSnapshot.candidates.find((candidate) => candidate?.eligible);
  if (eligibleCandidate) {
    return {
      route: NEW_WORK_READINESS.ready,
    };
  }

  return {
    route: NEW_WORK_READINESS.noEligibleWorker,
    candidates: runSnapshot.candidates.map((candidate) => ({
      workerLabel: candidate?.workerLabel ?? "(unknown worker)",
      source: candidate?.source ?? "(unknown source)",
      reason: describeEligibilityReason(candidate),
    })),
  };
}

function readAgentPrompt(actionKey, workingDirectory) {
  const relativePath = AGENT_PROMPT_FILES[actionKey];
  if (!relativePath) {
    return { content: "", source: "(none)", exists: false };
  }
  const resolved = path.resolve(workingDirectory, relativePath);
  if (!fs.existsSync(resolved)) {
    return { content: "", source: relativePath, exists: false };
  }
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return { content, source: relativePath, exists: true };
  } catch (error) {
    return { content: "", source: relativePath, exists: false, error: String(error) };
  }
}

async function runAgentSession(actionKey: string, promptContent: string, runState: TuiRunState): Promise<number> {
  const app = createApp();
  runState.app = app;
  runState.actionKey = actionKey;
  runState.actionLabel = ACTION_LABELS[actionKey];
  runState.sourceTarget = AGENT_PROMPT_FILES[actionKey];
  runState.runStartedAt = Date.now();
  runState.currentOperation = "agent";

  try {
    const exitCode = await app.helpTask({
      workerPattern: { ...DEFAULT_WORKER_PATTERN },
      keepArtifacts: false,
      trace: false,
      cliVersion: "tui",
      promptOverride: promptContent,
    });
    runState.exitCode = exitCode;
    runState.finished = true;
    return exitCode;
  } catch (error) {
    runState.exitCode = 1;
    runState.error = error instanceof Error ? error.message : String(error);
    runState.finished = true;
    throw error;
  }
}

export async function startNewWorkSceneAction({
  actionKey,
  currentWorkingDirectory,
  runState,
  teardownTuiForWorker,
  restoreTuiAfterWorker,
  releaseApp,
  cliWorkerCommand = [],
}) {
  const readiness = await resolveNewWorkReadiness({
    currentWorkingDirectory,
    cliWorkerCommand,
  });
  if (readiness.route !== NEW_WORK_READINESS.ready) {
    return {
      started: false,
      route: readiness.route,
      readiness,
      hint: readiness.hint,
    };
  }

  const promptResult = readAgentPrompt(actionKey, currentWorkingDirectory);
  if (!promptResult.exists || promptResult.content.trim().length === 0) {
    return {
      started: false,
      route: "missing-prompt",
      hint: `Prompt file not found or empty: ${promptResult.source}`,
    };
  }

  teardownTuiForWorker();

  let app: App | null = null;
  try {
    const sessionPromise = runAgentSession(actionKey, promptResult.content, runState);
    app = runState.app;
    await sessionPromise;
  } catch {
    // Error is captured on runState.
  } finally {
    await releaseApp(app);
    runState.app = null;
    restoreTuiAfterWorker();
  }

  return { started: true, route: NEW_WORK_READINESS.ready };
}

export { NEW_WORK_READINESS, resolveNewWorkReadiness };
