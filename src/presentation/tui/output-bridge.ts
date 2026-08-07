// @ts-nocheck
import { isBadgeOperationKey, normalizeOperationKey } from "./components/badge.ts";
import type { App } from "../../create-app.js";
import type { ApplicationOutputEvent } from "../../domain/ports/output-port.js";

type RecentMessageKind = Extract<ApplicationOutputEvent, { kind: "info" | "warn" | "error" | "success" }>["kind"];

type RunPhaseCounter = {
  current: number;
  total: number;
};

export type TuiRunState = {
  actionKey: string | null;
  actionLabel: string;
  sourceTarget: string;
  runStartedAt: number;
  currentTaskStartedAt: number;
  completedTasks: number;
  totalTasks: number;
  currentTaskIndex: number;
  currentOperation: string;
  currentPhaseCounter: RunPhaseCounter | null;
  phaseCounters: Record<string, RunPhaseCounter>;
  failures: number;
  repairs: number;
  resolvings: number;
  resets: number;
  recentMessages: Array<{ kind: RecentMessageKind; message: string; at: number }>;
  statusMessage: string;
  finished: boolean;
  exitCode: number | null;
  error: string | null;
  app: App | null;
};

export async function releaseApp(app: App | null | undefined): Promise<void> {
  if (!app) {
    return;
  }
  try {
    app.releaseAllLocks?.();
    await app.awaitShutdown?.();
  } catch {
    // Ignore shutdown errors during cleanup.
  }
}

export function pushRecentMessage(runState: TuiRunState, kind: RecentMessageKind, message: string): void {
  if (typeof message !== "string" || message.length === 0) {
    return;
  }
  runState.recentMessages.push({ kind, message, at: Date.now() });
  while (runState.recentMessages.length > 6) {
    runState.recentMessages.shift();
  }
}

export function createInitialRunState(): TuiRunState {
  return {
    actionKey: null,
    actionLabel: "",
    sourceTarget: "",
    runStartedAt: 0,
    currentTaskStartedAt: 0,
    completedTasks: 0,
    totalTasks: 0,
    currentTaskIndex: -1,
    currentOperation: "scan",
    currentPhaseCounter: null,
    phaseCounters: {},
    failures: 0,
    repairs: 0,
    resolvings: 0,
    resets: 0,
    recentMessages: [],
    statusMessage: "",
    finished: false,
    exitCode: null,
    error: null,
    app: null,
  };
}

export function applyOutputEvent(runState: TuiRunState, event: ApplicationOutputEvent): void {
  switch (event.kind) {
    case "group-start": {
      runState.currentTaskStartedAt = Date.now();
      if (event.counter) {
        if (typeof event.counter.current === "number") {
          runState.currentTaskIndex = Math.max(0, event.counter.current - 1);
        }
        if (typeof event.counter.total === "number" && event.counter.total > 0) {
          runState.totalTasks = event.counter.total;
        }
      }
      runState.currentOperation = "execute";
      runState.statusMessage = event.label ?? "";
      return;
    }
    case "group-end": {
      if (event.status === "success") {
        runState.completedTasks += 1;
        runState.currentOperation = "finalize";
      } else {
        runState.failures += 1;
        runState.currentOperation = "repair";
        if (event.message) {
          pushRecentMessage(runState, "error", event.message);
        }
      }
      return;
    }
    case "progress": {
      const progress = event.progress ?? {};
      const counterKey = normalizeOperationKey(progress.label);
      if (typeof progress.label === "string" && progress.label.length > 0) {
        if (isBadgeOperationKey(counterKey)) {
          runState.currentOperation = counterKey;
        }
      }
      const current = progress.current;
      const total = progress.total;
      const hasCurrent = typeof current === "number" && Number.isFinite(current);
      const hasTotal = typeof total === "number" && Number.isFinite(total) && total > 0;
      if (hasCurrent && hasTotal) {
        const counter = {
          current: Math.max(0, Math.trunc(current)),
          total: Math.max(1, Math.trunc(total)),
        };
        runState.currentPhaseCounter = counter;
        if (counterKey.length > 0) {
          runState.phaseCounters[counterKey] = counter;
        } else if (runState.currentOperation) {
          runState.phaseCounters[runState.currentOperation] = counter;
        }
      }
      if (typeof progress.detail === "string" && progress.detail.length > 0) {
        pushRecentMessage(runState, "info", progress.detail);
      }
      return;
    }
    case "info":
    case "warn":
    case "error":
    case "success": {
      const message = event.message ?? "";
      if (/repair/i.test(message)) {
        runState.repairs += 1;
        runState.currentOperation = "repair";
      } else if (/resolve|resolving/i.test(message)) {
        runState.resolvings += 1;
      } else if (/reset/i.test(message)) {
        runState.resets += 1;
      } else if (/verify|verifying/i.test(message)) {
        runState.currentOperation = "verify";
      }
      pushRecentMessage(runState, event.kind, message);
      return;
    }
    case "text":
    case "stderr":
    case "task":
      return;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return;
    }
  }
}

export function resolveProcessArgv(argv?: string[]): string[] {
  if (Array.isArray(argv)) {
    return ["node", "tui", ...argv];
  }
  return process.argv;
}
