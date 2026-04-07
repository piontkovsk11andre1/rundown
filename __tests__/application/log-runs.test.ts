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
        extra: { commitSha: "1234567890abcdef1234567890abcdef12345678" },
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
        text: "run-20260328T120 | 2m ago | [completed] | Ship release notes | source=TODO.md:22 | command=run | sha=1234567890ab | revertable=yes",
      },
      {
        kind: "text",
        text: "run-20260328T110 | 30m ago | [completed] | Plan rollout | source=roadmap.md:9 | command=plan | sha=- | revertable=no",
      },
    ]);
  });

  it("filters to revertable runs when --revertable is set", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({ runId: "run-a", status: "completed", extra: { commitSha: "aaa111" } }),
      createRun({ runId: "run-b", status: "completed" }),
      createRun({ runId: "run-c", status: "reverify-completed", extra: { commitSha: "ccc333" } }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: true, json: false });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "text",
      text: "run-a | 10m ago | [completed] | Do work | source=roadmap.md:3 | command=run | sha=aaa111 | revertable=yes",
    });
  });

  it("applies command filter and limit", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({ runId: "run-1", status: "completed", commandName: "run", extra: { commitSha: "sha-1" } }),
      createRun({ runId: "run-2", status: "completed", commandName: "plan", extra: { commitSha: "sha-2" } }),
      createRun({ runId: "run-3", status: "completed", commandName: "run", extra: { commitSha: "sha-3" } }),
    ];
    const { logRuns, events } = createDependencies({ runs });

    const code = logRuns({ revertable: false, commandName: "RUN", limit: 1, json: false });

    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "text",
      text: "run-1 | 10m ago | [completed] | Do work | source=roadmap.md:3 | command=run | sha=sha-1 | revertable=yes",
    });
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
        extra: { commitSha: "abcdefabcdefabcdef" },
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
        commitSha: "abcdefabcdefabcdef",
        shortCommitSha: "abcdefabcdef",
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
        extra: { commitSha: "future-sha" },
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

  it("generates compact short IDs and preserves run order", () => {
    const runs: ArtifactRunMetadata[] = [
      createRun({ runId: "run-20260328T130000000Z-zzzzzzzz", status: "completed", extra: { commitSha: "sha-z" } }),
      createRun({ runId: "run-short", status: "completed", extra: { commitSha: "sha-y" } }),
      createRun({ runId: "run-20260328T110000000Z-xxxxxxxx", status: "completed", extra: { commitSha: "sha-x" } }),
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
      createRun({ runId: "run-completed", status: "completed", extra: { commitSha: "done-sha" } }),
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

    expect(code).toBe(0);
    expect(events).toEqual([{ kind: "info", message: "No matching completed runs found." }]);
  });
});

function createDependencies(options: {
  runs: ArtifactRunMetadata[];
  nowIso?: string;
}): {
  logRuns: ReturnType<typeof createLogRuns>;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  clock: Clock;
} {
  const events: ApplicationOutputEvent[] = [];
  const nowIso = options.nowIso ?? "2026-03-28T12:00:00.000Z";
  const now = new Date(nowIso);

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
