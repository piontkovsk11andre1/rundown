import { describe, expect, it } from "vitest";
import {
  sanitizeGlobalOutputLogEntry,
  serializeGlobalOutputLogEntry,
} from "../../src/domain/global-output-log.js";

const STABLE_ENTRY_KEYS = [
  "argv",
  "command",
  "cwd",
  "kind",
  "level",
  "message",
  "pid",
  "session_id",
  "stream",
  "ts",
  "version",
] as const;

describe("global output log serialization", () => {
  it("serializes a single JSON object per line", () => {
    const line = serializeGlobalOutputLogEntry({
      ts: "2026-03-27T00:00:00.000Z",
      level: "info",
      stream: "stdout",
      kind: "info",
      message: "hello",
      command: "run",
      argv: ["run", "tasks.md"],
      cwd: "/workspace",
      pid: 123,
      version: "1.0.0",
      session_id: "session-1",
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);

    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed["message"]).toBe("hello");
    expect(Object.keys(parsed).sort()).toEqual(STABLE_ENTRY_KEYS);
  });

  it("strips ANSI escape codes from all string fields", () => {
    const ansiRed = "\u001b[31m";
    const ansiReset = "\u001b[0m";
    const line = serializeGlobalOutputLogEntry({
      ts: `${ansiRed}2026-03-27T00:00:00.000Z${ansiReset}`,
      level: "error",
      stream: "stderr",
      kind: `${ansiRed}error${ansiReset}` as unknown as "error",
      message: `${ansiRed}boom${ansiReset}`,
      command: `${ansiRed}run${ansiReset}`,
      argv: [`${ansiRed}run${ansiReset}`, `${ansiRed}tasks.md${ansiReset}`],
      cwd: `${ansiRed}/workspace${ansiReset}`,
      pid: 999,
      version: `${ansiRed}1.0.0${ansiReset}`,
      session_id: `${ansiRed}session-2${ansiReset}`,
    });

    expect(line).not.toContain("\u001b");
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed["message"]).toBe("boom");
    expect(parsed["command"]).toBe("run");
    expect(parsed["cwd"]).toBe("/workspace");
    expect(parsed["version"]).toBe("1.0.0");
    expect(parsed["session_id"]).toBe("session-2");
    expect(parsed["argv"]).toEqual(["run", "tasks.md"]);
    expect(parsed["level"]).toBe("error");
    expect(parsed["stream"]).toBe("stderr");
    expect(parsed["kind"]).toBe("error");
    expect(Object.keys(parsed).sort()).toEqual(STABLE_ENTRY_KEYS);
  });

  it("normalizes carriage-return frame updates and control characters", () => {
    const line = serializeGlobalOutputLogEntry({
      ts: "2026-03-27T00:00:00.000Z",
      level: "info",
      stream: "stdout",
      kind: "progress",
      message: "frame 1\rframe 2\u0007",
      command: "run",
      argv: ["run", "tasks.md", "--label=scan\rscan2"],
      cwd: "/workspace\u0008",
      pid: 1000,
      version: "1.0.0",
      session_id: "session-5\u000c",
    });

    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed["message"]).toBe("frame 2");
    expect(parsed["argv"]).toEqual(["run", "tasks.md", "scan2"]);
    expect(parsed["cwd"]).toBe("/workspace");
    expect(parsed["session_id"]).toBe("session-5");
  });

  it("keeps multi-line message content escaped within one JSONL line", () => {
    const line = serializeGlobalOutputLogEntry({
      ts: "2026-03-27T00:00:00.000Z",
      level: "info",
      stream: "stdout",
      kind: "task",
      message: "parent line\n  child line",
      command: "run",
      argv: ["run", "tasks.md"],
      cwd: "/workspace",
      pid: 123,
      version: "1.0.0",
      session_id: "session-3",
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);

    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed["message"]).toBe("parent line\n  child line");
  });

  it("sanitizes all string fields at domain level", () => {
    const ansiRed = "\u001b[31m";
    const ansiReset = "\u001b[0m";

    const sanitized = sanitizeGlobalOutputLogEntry({
      ts: `${ansiRed}2026-03-27T00:00:00.000Z${ansiReset}`,
      level: `${ansiRed}warn${ansiReset}` as unknown as "warn",
      stream: `${ansiRed}stderr${ansiReset}` as unknown as "stderr",
      kind: `${ansiRed}group-end${ansiReset}` as unknown as "group-end",
      message: `${ansiRed}group failed${ansiReset}`,
      command: `${ansiRed}run${ansiReset}`,
      argv: [`${ansiRed}run${ansiReset}`, `${ansiRed}tasks.md${ansiReset}`],
      cwd: `${ansiRed}/workspace${ansiReset}`,
      pid: 1001,
      version: `${ansiRed}1.0.0${ansiReset}`,
      session_id: `${ansiRed}session-4${ansiReset}`,
    });

    expect(sanitized).toEqual({
      ts: "2026-03-27T00:00:00.000Z",
      level: "warn",
      stream: "stderr",
      kind: "group-end",
      message: "group failed",
      command: "run",
      argv: ["run", "tasks.md"],
      cwd: "/workspace",
      pid: 1001,
      version: "1.0.0",
      session_id: "session-4",
    });
    expect(Object.keys(sanitized).sort()).toEqual(STABLE_ENTRY_KEYS);
  });
});
