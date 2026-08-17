import type {
  WorkerEventAction,
  WorkerEventKind,
  WorkerEventPayload,
} from "./trace.js";

export type WorkerEventProvider = WorkerEventPayload["provider"];

export interface NormalizedWorkerEvent {
  provider: WorkerEventProvider;
  kind: WorkerEventKind;
  action: WorkerEventAction;
  name: string | null;
  file_path: string | null;
  command: string | null;
  duration_ms: number | null;
  status: string | null;
  raw_event?: unknown;
}

export function parseWorkerJsonEventsFromChunk(chunk: string): NormalizedWorkerEvent[] {
  const events: NormalizedWorkerEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }

    try {
      const raw = JSON.parse(trimmed) as unknown;
      const normalized = normalizeWorkerJsonEvent(raw);
      if (normalized) {
        events.push(normalized);
      }
    } catch {
      // Worker streams commonly mix plain text and JSON; ignore non-JSON lines.
    }
  }

  return events;
}

export function normalizeWorkerJsonEvent(raw: unknown): NormalizedWorkerEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const type = firstString(raw, ["type", "event", "event_type", "kind"]);
  const lowerType = type?.toLowerCase() ?? "";
  const toolName = firstString(raw, ["tool", "tool_name", "toolName", "name"])
    ?? firstNestedString(raw, ["tool", "name"])
    ?? firstNestedString(raw, ["call", "name"]);
  const filePath = firstString(raw, ["file", "file_path", "filePath", "path"])
    ?? firstNestedString(raw, ["input", "file_path"])
    ?? firstNestedString(raw, ["input", "filePath"])
    ?? firstNestedString(raw, ["input", "path"])
    ?? firstNestedString(raw, ["args", "path"]);
  const command = firstString(raw, ["command", "cmd"])
    ?? firstNestedString(raw, ["input", "command"])
    ?? firstNestedString(raw, ["args", "command"]);
  const status = firstString(raw, ["status", "state", "result"]);
  const durationMs = firstNumber(raw, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]);

  const kind = inferKind(lowerType, toolName, filePath, command);
  if (kind === "unknown" && !status) {
    return undefined;
  }

  return {
    provider: inferProvider(raw),
    kind,
    action: inferAction(lowerType, status, kind, toolName),
    name: toolName ?? null,
    file_path: filePath ?? null,
    command: command ?? null,
    duration_ms: durationMs ?? null,
    status: status ?? null,
    raw_event: raw,
  };
}

function inferProvider(raw: Record<string, unknown>): WorkerEventProvider {
  const provider = firstString(raw, ["provider", "source"]);
  const lowerProvider = provider?.toLowerCase() ?? "";
  if (lowerProvider.includes("opencode")) {
    return "opencode";
  }
  if (lowerProvider.includes("claude")) {
    return "claude";
  }
  if (lowerProvider.includes("codex")) {
    return "codex";
  }

  return "unknown";
}

function inferKind(
  lowerType: string,
  toolName: string | undefined,
  filePath: string | undefined,
  command: string | undefined,
): WorkerEventKind {
  const lowerToolName = toolName?.toLowerCase() ?? "";
  if (lowerType.includes("think") || lowerType.includes("reason")) {
    return "thinking";
  }
  if (command || lowerToolName === "bash" || lowerToolName === "shell" || lowerToolName === "command") {
    return "command";
  }
  if (filePath || ["read", "write", "edit", "glob", "grep"].includes(lowerToolName)) {
    return "file";
  }
  if (lowerType.includes("tool") || toolName) {
    return "tool";
  }
  if (lowerType.includes("message") || lowerType.includes("assistant")) {
    return "message";
  }

  return "unknown";
}

function inferAction(
  lowerType: string,
  status: string | undefined,
  kind: WorkerEventKind,
  toolName: string | undefined,
): WorkerEventAction {
  const lowerStatus = status?.toLowerCase() ?? "";
  const lowerToolName = toolName?.toLowerCase() ?? "";
  if (lowerType.includes("start") || lowerStatus === "started" || lowerStatus === "running") {
    return "started";
  }
  if (lowerType.includes("finish") || lowerType.includes("complete") || lowerStatus === "finished" || lowerStatus === "completed") {
    return "finished";
  }
  if (kind === "file") {
    if (lowerType.includes("write") || lowerToolName === "write" || lowerToolName === "edit") {
      return "write";
    }
    return "read";
  }
  if (kind === "command" || kind === "tool") {
    return "called";
  }
  if (kind === "message") {
    return "emitted";
  }

  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function firstNestedString(record: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}
