import { describe, expect, it, vi } from "vitest";
import { createLogRuns } from "../../src/application/log-runs.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStore,
  Clock,
} from "../../src/domain/ports/index.js";

describe("log-runs", () => {
  it("shows completed runs in compact one-line format", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-20260328T120000000Z-aaaaaaaa",
        status: "completed",
        commandName: "run",
        completedAt: "2026-03-28T11:58:00.000Z",
        task: {
          text: "Ship release notes",
          file: "TODO.md",
          line: 22,
          index: 1,
          source: "TODO.md",
        },
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 12,
              snapshotPath: "/snapshots/root/12",
            },
          ],
        },
      }),
      createRun({
        runId: "run-20260328T110000000Z-bbbbbbbb",
        status: "completed",
        commandName: "plan",
        completedAt: "2026-03-28T11:30:00.000Z",
        task: {
          text: "Plan rollout",
          file: "roadmap.md",
          line: 9,
          index: 0,
          source: "roadmap.md",
        },
      }),
      createRun({
        runId: "run-20260328T100000000Z-cccccccc",
        status: "failed",
        commandName: "run",
      }),
    ];

    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: false });

    expect(code).toBe(0);
    expect(events).toEqual([
      {
        kind: "text",
        text: `run-20260328T120 | ${formatExpectedCliTimestamp("2026-03-28T11:58:00.000Z")} (2m ago) | [completed] | Ship release notes | source=TODO.md:22 | command=run | snapshot=root:12 | revertable=yes`,
      },
      {
        kind: "text",
        text: `run-20260328T110 | ${formatExpectedCliTimestamp("2026-03-28T11:30:00.000Z")} (30m ago) | [completed] | Plan rollout | source=roadmap.md:9 | command=plan | snapshot=- | revertable=no`,
      },
      {
        kind: "info",
        message: "2 runs listed.",
      },
    ]);
  });

  it("filters to revertable runs when --revertable is set", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-a",
        status: "completed",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 4,
              snapshotPath: "/snapshots/root/4",
            },
          ],
        },
      }),
      createRun({ runId: "run-b", status: "completed" }),
      createRun({
        runId: "run-c",
        status: "reverify-completed",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 3,
              snapshotPath: "/snapshots/root/3",
            },
          ],
        },
      }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: true, json: false });

    expect(code).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: "text",
      text: `run-a | ${formatExpectedCliTimestamp("2026-03-28T11:50:00.000Z")} (10m ago) | [completed] | Do work | source=roadmap.md:3 | command=run | snapshot=root:4 | revertable=yes`,
    });
    expect(events[1]).toEqual({ kind: "info", message: "1 run listed." });
  });

  it("falls back to startedAt for compact timestamp tokens when completedAt is missing", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-started-at-only",
        status: "completed",
        startedAt: "2026-03-28T11:57:00.000Z",
        completedAt: undefined,
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 2,
              snapshotPath: "/snapshots/root/2",
            },
          ],
        },
      }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: false });

    expect(code).toBe(0);
    expect(events[0]).toEqual({
      kind: "text",
      text: `run-started-at-o | ${formatExpectedCliTimestamp("2026-03-28T11:57:00.000Z")} (3m ago) | [completed] | Do work | source=roadmap.md:3 | command=run | snapshot=root:2 | revertable=yes`,
    });
    expect(events[1]).toEqual({ kind: "info", message: "1 run listed." });
  });

  it("applies command filter and limit", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-1",
        status: "completed",
        commandName: "run",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 1,
              snapshotPath: "/snapshots/root/1",
            },
          ],
        },
      }),
      createRun({ runId: "run-2", status: "completed", commandName: "plan" }),
      createRun({ runId: "run-3", status: "completed", commandName: "run" }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, commandName: "RUN", limit: 1, json: false });

    expect(code).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: "text",
      text: `run-1 | ${formatExpectedCliTimestamp("2026-03-28T11:50:00.000Z")} (10m ago) | [completed] | Do work | source=roadmap.md:3 | command=run | snapshot=root:1 | revertable=yes`,
    });
    expect(events[1]).toEqual({ kind: "info", message: "1 run listed." });
  });

  it("returns JSON entries when --json is set", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-json",
        status: "completed",
        commandName: "run",
        completedAt: "2026-03-28T11:55:00.000Z",
        task: {
          text: "A very long task summary that should be truncated because it exceeds the compact output width by a lot",
          file: "TODO.md",
          line: 42,
          index: 7,
          source: "TODO.md",
        },
        source: "fallback.md",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 8,
              snapshotPath: "/snapshots/root/8",
            },
          ],
        },
      }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: true });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("text");
    if (event?.kind !== "text") {
      return;
    }

    const parsed = JSON.parse(event.text) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([
      {
        runId: "run-json",
        shortRunId: "run-json",
        commandName: "run",
        status: "completed",
        relativeTime: "5m ago",
        taskSummary: "A very long task summary that should be truncated because it exceeds the comp...",
        source: "TODO.md:42",
        snapshot: "root:8",
        revertable: true,
        startedAt: "2026-03-28T11:50:00.000Z",
        completedAt: "2026-03-28T11:55:00.000Z",
      },
    ]);
  });

  it("handles relative timestamp edge cases", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-future",
        status: "completed",
        completedAt: "2026-03-28T12:00:30.000Z",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 9,
              snapshotPath: "/snapshots/root/9",
            },
          ],
        },
      }),
      createRun({
        runId: "run-just-now",
        status: "completed",
        completedAt: "2026-03-28T11:59:58.000Z",
      }),
      createRun({
        runId: "run-invalid-time",
        status: "completed",
        startedAt: "not-a-date",
        completedAt: undefined,
      }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: true });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("text");
    if (event?.kind !== "text") {
      return;
    }

    const parsed = JSON.parse(event.text) as Array<Record<string, unknown>>;
    expect(parsed.map((entry) => entry.relativeTime)).toEqual(["in 30s", "just now", "not-a-date"]);
  });

  it("keeps compact log line readable when timestamp is invalid", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-invalid-time",
        status: "completed",
        startedAt: "not-a-date",
        completedAt: undefined,
      }),
    ];
    const { logRuns, events } = createDependencies({ runs, existingSnapshotPaths: [] });

    const code = logRuns({ revertable: false, json: false });

    expect(code).toBe(0);
    expect(events).toEqual([
      {
        kind: "text",
        text: "run-invalid-time | not-a-date | [completed] | Do work | source=roadmap.md:3 | command=run | snapshot=- | revertable=no",
      },
      {
        kind: "info",
        message: "1 run listed.",
      },
    ]);
  });

  it("renders compact absolute tokens with non-hour offsets deterministically", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-half-hour-offset",
        status: "completed",
        completedAt: "2026-03-28T11:58:00.000Z",
      }),
    ];
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);
    const { logRuns, events } = createDependencies({ runs, existingSnapshotPaths: [] });

    const code = logRuns({ revertable: false, json: false });

    expect(code).toBe(0);
    expect(events[0]).toEqual({
      kind: "text",
      text: `run-half-hour-of | ${formatExpectedCliTimestamp("2026-03-28T11:58:00.000Z")} (2m ago) | [completed] | Do work | source=roadmap.md:3 | command=run | snapshot=- | revertable=no`,
    });
    expect(events[0]?.kind === "text" ? events[0].text : "").toContain("+05:30");
    expect(events[1]).toEqual({ kind: "info", message: "1 run listed." });
  });

  it("generates compact short IDs and preserves run order", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-20260328T130000000Z-zzzzzzzz",
        status: "completed",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 13,
              snapshotPath: "/snapshots/root/13",
            },
          ],
        },
      }),
      createRun({ runId: "run-short", status: "completed" }),
      createRun({ runId: "run-20260328T110000000Z-xxxxxxxx", status: "completed" }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: true });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("text");
    if (event?.kind !== "text") {
      return;
    }

    const parsed = JSON.parse(event.text) as Array<Record<string, unknown>>;
    expect(parsed.map((entry) => entry.runId)).toEqual([
      "run-20260328T130000000Z-zzzzzzzz",
      "run-short",
      "run-20260328T110000000Z-xxxxxxxx",
    ]);
    expect(parsed.map((entry) => entry.shortRunId)).toEqual([
      "run-20260328T130",
      "run-short",
      "run-20260328T110",
    ]);
  });

  it("includes only completed entries when statuses are mixed", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-completed",
        status: "completed",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 5,
              snapshotPath: "/snapshots/root/5",
            },
          ],
        },
      }),
      createRun({ runId: "run-failed", status: "failed", commandName: "run" }),
      createRun({ runId: "run-cancelled", status: "revert-failed", commandName: "revert" }),
      createRun({ runId: "run-exec-failed", status: "execution-failed", commandName: "plan" }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, json: true });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("text");
    if (event?.kind !== "text") {
      return;
    }

    const parsed = JSON.parse(event.text) as Array<Record<string, unknown>>;
    expect(parsed.map((entry) => entry.runId)).toEqual(["run-completed"]);
  });

  it("prints info message when no runs match filters", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({ runId: "run-1", status: "completed", commandName: "plan" }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: true, commandName: "run", json: false });

    expect(code).toBe(3);
    expect(events).toEqual([{ kind: "info", message: "No revertable runs found. Revertable runs must be completed with implementation snapshot metadata and a snapshot payload that still exists on disk." }]);
  });

  it("explains when snapshot metadata exists but payloads are missing", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({
        runId: "run-missing-payload",
        status: "completed",
        extra: {
          implementationSnapshotTargets: [
            {
              laneKind: "root",
              migrationNumber: 7,
              snapshotPath: "/snapshots/root/7",
            },
          ],
        },
      }),
    ];
    const { logRuns, events } = createDependencies({ runs, existingSnapshotPaths: [] });

    const code = logRuns({ revertable: true, json: false });

    expect(code).toBe(3);
    expect(events).toEqual([
      {
        kind: "info",
        message: "No revertable runs found. Revertable runs must be completed with implementation snapshot metadata and a snapshot payload that still exists on disk. Completed runs with snapshot metadata were found, but their snapshot payloads are missing on disk. Restore those snapshot directories or record new snapshots before retrying.",
      },
    ]);
  });
});

function createDependencies(options: {
  runs: ArtifactRunMetadata[];
  nowIso?: string;
  existingSnapshotPaths?: string[];
}): {
  logRuns: ReturnType<typeof createLogRuns>;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  clock: Clock;
} {
  const events: ApplicationOutputEvent[] = [];
  const nowIso = options.nowIso ?? "2026-03-28T12:00:00.000Z";
  const now = new Date(nowIso);
  const snapshotPaths = new Set(options.existingSnapshotPaths ?? options.runs
    .flatMap((run) => {
      const rawTargets = run.extra?.["implementationSnapshotTargets"];
      return Array.isArray(rawTargets) ? rawTargets : [];
    })
    .map((target) => {
      if (typeof target !== "object" || target === null) {
        return "";
      }
      const snapshotPath = (target as Record<string, unknown>)["snapshotPath"];
      return typeof snapshotPath === "string" ? snapshotPath : "";
    })
    .filter((snapshotPath) => snapshotPath.length > 0));

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-1"),
    rootDir: vi.fn(() => "/workspace/.rundown/runs"),
    listSaved: vi.fn(() => options.runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => options.runs[0] ?? null),
    find: vi.fn((runId: string) => options.runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const clock: Clock = {
    now: vi.fn(() => now),
    nowIsoString: vi.fn(() => nowIso),
  };

  const logRuns = createLogRuns({
    artifactStore,
    configDir: undefined,
    fileSystem: {
      exists: vi.fn((filePath: string) => snapshotPaths.has(filePath)),
      readText: vi.fn(),
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(() => []),
      stat: vi.fn((filePath: string) => snapshotPaths.has(filePath)
        ? { isDirectory: true, isFile: false }
        : null),
      unlink: vi.fn(),
      rm: vi.fn(),
      rename: vi.fn(),
    },
    clock,
    output: {
      emit(event) {
        events.push(event);
      },
    },
  });

  return { logRuns, events, artifactStore, clock };
}

function createRun(overrides: Partial<ArtifactRunMetadata> = {}): ArtifactRunMetadata {
  return {
    runId: overrides.runId ?? "run-1",
    rootDir: overrides.rootDir ?? "/workspace/.rundown/runs/run-1",
    relativePath: overrides.relativePath ?? ".rundown/runs/run-1",
    commandName: overrides.commandName ?? "run",
    workerCommand: overrides.workerCommand,
    mode: overrides.mode,
    transport: overrides.transport,
    source: overrides.source ?? "roadmap.md",
    task: overrides.task ?? {
      text: "Do work",
      file: "roadmap.md",
      line: 3,
      index: 0,
      source: "roadmap.md",
    },
    keepArtifacts: overrides.keepArtifacts ?? true,
    startedAt: overrides.startedAt ?? "2026-03-28T11:50:00.000Z",
    completedAt: overrides.completedAt,
    status: overrides.status ?? "completed",
    extra: overrides.extra,
  };
}

function formatExpectedCliTimestamp(value: string): string {
  const date = new Date(value);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(absoluteMinutes % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}
