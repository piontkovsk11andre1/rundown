import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRevertTask,
  type RevertTaskDependencies,
  type RevertTaskOptions,
} from "../../src/application/revert-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStore,
  ArtifactStoreStatus,
  FileSystem,
  GitClient,
} from "../../src/domain/ports/index.js";

describe("revert-task", () => {
  it("returns 3 for --all with --last", async () => {
    const { revertTask, events, gitClient } = createDependencies([]);

    const code = await revertTask(createOptions({ all: true, last: 1 }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --all with --last."))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("returns 3 for --run <id> with --all", async () => {
    const { revertTask, events, gitClient } = createDependencies([]);

    const code = await revertTask(createOptions({ runId: "run-123", all: true }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --run <id> with --all or --last."))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("returns 3 for --run <id> with --last", async () => {
    const { revertTask, events, gitClient } = createDependencies([]);

    const code = await revertTask(createOptions({ runId: "run-123", last: 2 }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --run <id> with --all or --last."))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("returns 3 when --last is not a positive integer", async () => {
    const { revertTask, events, gitClient } = createDependencies([]);

    const code = await revertTask(createOptions({ last: 0 }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("--last must be a positive integer."))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("uses latest revertable run when latest completed has no commit SHA", async () => {
    const runNewestMissingSha = createRunMetadata({
      runId: "run-newest-missing-sha",
      status: "completed",
    });
    const runNextRevertable = createRunMetadata({
      runId: "run-next-revertable",
      status: "completed",
      commitSha: "abc123",
    });

    const { revertTask, events, gitClient } = createDependencies([
      runNewestMissingSha,
      runNextRevertable,
    ]);

    const code = await revertTask(createOptions({ runId: "latest", dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["cat-file", "-t", "abc123"], "/workspace");
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-next-revertable"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-newest-missing-sha"))).toBe(false);
  });

  it("filters --all to completed runs that contain extra.commitSha", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-completed-a", status: "completed", commitSha: "aaa111" }),
      createRunMetadata({ runId: "run-completed-no-sha", status: "completed" }),
      createRunMetadata({ runId: "run-completed-empty-sha", status: "completed", commitSha: "   " }),
      createRunMetadata({ runId: "run-reverify", status: "reverify-completed", commitSha: "bbb222" }),
      createRunMetadata({ runId: "run-completed-b", status: "completed", commitSha: "ccc333" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs);

    const code = await revertTask(createOptions({ all: true, dryRun: true }));

    expect(code).toBe(0);
    const catFileCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "cat-file");
    expect(catFileCalls).toHaveLength(2);
    expect(catFileCalls.map(([args]) => args[2])).toEqual(["aaa111", "ccc333"]);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-completed-a"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-completed-b"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-completed-no-sha"))).toBe(false);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-reverify"))).toBe(false);
  });

  it("applies --last after filtering revertable runs", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1-no-sha", status: "completed" }),
      createRunMetadata({ runId: "run-2", status: "completed", commitSha: "sha-2" }),
      createRunMetadata({ runId: "run-3", status: "completed", commitSha: "sha-3" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs);

    const code = await revertTask(createOptions({ last: 1, dryRun: true }));

    expect(code).toBe(0);
    const catFileCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "cat-file");
    expect(catFileCalls).toHaveLength(1);
    expect(catFileCalls[0]?.[0][2]).toBe("sha-2");
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-2"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-3"))).toBe(false);
  });

  it("returns 3 when no completed runs contain extra.commitSha", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-no-sha", status: "completed" }),
      createRunMetadata({ runId: "run-empty-sha", status: "completed", commitSha: "   " }),
      createRunMetadata({ runId: "run-reverify", status: "reverify-completed", commitSha: "abc123" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs);

    const code = await revertTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No revertable runs found."))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("extra.commitSha"))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("returns 3 when original run did not keep artifacts", async () => {
    const { revertTask, events, gitClient } = createDependencies([]);

    const code = await revertTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No saved runtime artifact run found for: latest completed"))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("returns 1 when not inside a git repository", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1", status: "completed", commitSha: "abc123" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
          return "false\n";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ dryRun: true }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Not inside a git repository."))).toBe(true);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["rev-parse", "--is-inside-work-tree"], "/workspace");
  });

  it("returns 1 when working directory is not clean", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1", status: "completed", commitSha: "abc123" }),
    ];

    const { revertTask, events } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "status") {
          return " M src/file.ts\n";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ dryRun: true }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Working directory is not clean."))).toBe(true);
  });

  it("skips clean-worktree check when --force is enabled", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1", status: "completed", commitSha: "abc123" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "status") {
          throw new Error("status should not be called when --force is enabled");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ dryRun: true, force: true }));

    expect(code).toBe(0);
    const statusCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "status");
    expect(statusCalls).toHaveLength(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
  });

  it("returns 1 when revert target commit SHA is not found in git history", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1", status: "completed", commitSha: "missing-sha" }),
    ];

    const { revertTask, events } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "cat-file" && args[1] === "-t") {
          throw new Error("fatal: Not a valid object name missing-sha");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ dryRun: true, method: "revert" }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("was not found in git history"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("run-1"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("missing-sha"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("fatal: Not a valid object name"))).toBe(true);
  });

  it("returns 1 when reset targets are not contiguous at HEAD", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-new", status: "completed", commitSha: "sha-new" }),
      createRunMetadata({ runId: "run-old", status: "completed", commitSha: "sha-old" }),
    ];

    const { revertTask, events } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          return "sha-new\nsha-other\n";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, dryRun: true, method: "reset" }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("contiguous block at HEAD"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Use --method revert for bulk revert"))).toBe(true);
  });

  it("skips contiguous-HEAD validation for reset when --force is enabled", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-new",
        status: "completed",
        commitSha: "sha-new",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-old",
        status: "completed",
        commitSha: "sha-old",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          throw new Error("rev-list should not be called when --force is enabled");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, dryRun: true, method: "reset", force: true }));

    expect(code).toBe(0);
    const revListCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "rev-list");
    expect(revListCalls).toHaveLength(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("--force enabled: skipping contiguous-HEAD validation for reset."))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("git reset --hard sha-old~1"))).toBe(true);
  });

  it("returns 1 for --method reset when target commit does not exist", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1", status: "completed", commitSha: "missing-sha" }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "cat-file" && args[1] === "-t") {
          throw new Error("fatal: Not a valid object name missing-sha");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ dryRun: true, method: "reset" }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("fatal: Not a valid object name"))).toBe(true);
    const revListCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "rev-list");
    expect(revListCalls).toHaveLength(0);
  });

  it("returns 3 when a reset-generated run is selected with --method revert", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-reset-revert",
        status: "reverted",
        commandName: "revert",
        extra: {
          method: "reset",
          preResetRef: "sha-before-reset",
        },
      }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs);

    const code = await revertTask(createOptions({ runId: "run-reset-revert", method: "revert" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("created by --method reset"))).toBe(true);
    expect(vi.mocked(gitClient.run)).not.toHaveBeenCalled();
  });

  it("restores a reset-generated run using saved preResetRef with --method reset", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-reset-revert",
        status: "reverted",
        commandName: "revert",
        extra: {
          method: "reset",
          preResetRef: "sha-before-reset",
        },
      }),
    ];

    const { revertTask, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return "sha-current-head\n";
        }
        if (args[0] === "reset" && args[1] === "--hard" && args[2] === "sha-before-reset") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ runId: "run-reset-revert", method: "reset" }));

    expect(code).toBe(0);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["reset", "--hard", "sha-before-reset"], "/workspace");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        extra: expect.objectContaining({
          method: "reset",
          runIds: ["run-reset-revert"],
          commitShas: [],
          preResetRef: "sha-current-head",
          revertedRunIds: ["run-reset-revert"],
          revertedCount: 1,
        }),
      }),
    );
  });

  it("executes --method reset by resetting before the oldest target commit", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-new", status: "completed", commitSha: "sha-new" }),
      createRunMetadata({ runId: "run-old", status: "completed", commitSha: "sha-old" }),
    ];

    const { revertTask, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          return "sha-new\nsha-old\n";
        }
        if (args[0] === "reset" && args[1] === "--hard" && args[2] === "sha-old~1") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, method: "reset" }));

    expect(code).toBe(0);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["reset", "--hard", "sha-old~1"], "/workspace");
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        extra: expect.objectContaining({
          method: "reset",
          runIds: ["run-new", "run-old"],
          commitShas: ["sha-new", "sha-old"],
        }),
      }),
    );
  });

  it("shows the reset command in --method reset dry-run output", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-new", status: "completed", commitSha: "sha-new" }),
      createRunMetadata({ runId: "run-old", status: "completed", commitSha: "sha-old" }),
    ];

    const { revertTask, events } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          return "sha-new\nsha-old\n";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, method: "reset", dryRun: true }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("git reset --hard sha-old~1"))).toBe(true);
  });

  it("executes --method revert newest-first with --no-edit", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-oldest",
        status: "completed",
        commitSha: "sha-oldest",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
      createRunMetadata({
        runId: "run-newest",
        status: "completed",
        commitSha: "sha-newest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-middle",
        status: "completed",
        commitSha: "sha-middle",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
    ];

    const { revertTask, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, method: "revert" }));

    expect(code).toBe(0);
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(3);
    expect(revertCalls.map(([args]) => args)).toEqual([
      ["revert", "sha-newest", "--no-edit"],
      ["revert", "sha-middle", "--no-edit"],
      ["revert", "sha-oldest", "--no-edit"],
    ]);
  });

  it("reverts --last N most recent committed runs newest-first", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-newest-missing-sha",
        status: "completed",
        startedAt: "2026-03-19T18:00:30.000Z",
      }),
      createRunMetadata({
        runId: "run-newest-committed",
        status: "completed",
        commitSha: "sha-newest-committed",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-second-committed",
        status: "completed",
        commitSha: "sha-second-committed",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
      createRunMetadata({
        runId: "run-third-committed",
        status: "completed",
        commitSha: "sha-third-committed",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
    ];

    const { revertTask, gitClient } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ last: 2, method: "revert" }));

    expect(code).toBe(0);
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(2);
    expect(revertCalls.map(([args]) => args)).toEqual([
      ["revert", "sha-newest-committed", "--no-edit"],
      ["revert", "sha-second-committed", "--no-edit"],
    ]);
  });

  it("reverts all committed runs with --all", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-newest-missing-sha",
        status: "completed",
        startedAt: "2026-03-19T18:00:30.000Z",
      }),
      createRunMetadata({
        runId: "run-newest-committed",
        status: "completed",
        commitSha: "sha-newest-committed",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-middle-committed",
        status: "completed",
        commitSha: "sha-middle-committed",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
      createRunMetadata({
        runId: "run-oldest-committed",
        status: "completed",
        commitSha: "sha-oldest-committed",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
    ];

    const { revertTask, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, method: "revert" }));

    expect(code).toBe(0);
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(3);
    expect(revertCalls.map(([args]) => args)).toEqual([
      ["revert", "sha-newest-committed", "--no-edit"],
      ["revert", "sha-middle-committed", "--no-edit"],
      ["revert", "sha-oldest-committed", "--no-edit"],
    ]);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        extra: expect.objectContaining({
          runIds: ["run-newest-committed", "run-middle-committed", "run-oldest-committed"],
          revertedRunIds: ["run-newest-committed", "run-middle-committed", "run-oldest-committed"],
          revertedCount: 3,
        }),
      }),
    );
  });

  it("reverts latest committed run with --method revert", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-latest",
        status: "completed",
        commitSha: "sha-latest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-older",
        status: "completed",
        commitSha: "sha-older",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
    ];

    const { revertTask, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[1] === "sha-latest" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ runId: "latest", method: "revert" }));

    expect(code).toBe(0);
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(1);
    expect(revertCalls[0]?.[0]).toEqual(["revert", "sha-latest", "--no-edit"]);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        extra: expect.objectContaining({
          method: "revert",
          runIds: ["run-latest"],
          commitShas: ["sha-latest"],
          revertedRunIds: ["run-latest"],
          revertedCount: 1,
        }),
      }),
    );
  });

  it("continues with commit-based revert when the saved task file no longer exists", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-latest",
        status: "completed",
        commitSha: "sha-latest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
    ];

    const { revertTask, gitClient, events } = createDependencies(runs, {
      fileExists: (filePath) => filePath !== "/workspace/roadmap.md",
      gitRun: async (args) => {
        if (args[0] === "revert" && args[1] === "sha-latest" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ runId: "latest", method: "revert" }));

    expect(code).toBe(0);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["revert", "sha-latest", "--no-edit"], "/workspace");
    expect(events.some((event) => event.kind === "info" && event.message.includes("which no longer exists"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("commit-based revert"))).toBe(true);
  });

  it("reverts latest committed run with --method reset", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-latest",
        status: "completed",
        commitSha: "sha-latest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-older",
        status: "completed",
        commitSha: "sha-older",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
    ];

    const { revertTask, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          return "sha-latest\n";
        }
        if (args[0] === "reset" && args[1] === "--hard" && args[2] === "sha-latest~1") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ runId: "latest", method: "reset" }));

    expect(code).toBe(0);
    expect(vi.mocked(gitClient.run)).toHaveBeenCalledWith(["reset", "--hard", "sha-latest~1"], "/workspace");
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        extra: expect.objectContaining({
          method: "reset",
          runIds: ["run-latest"],
          commitShas: ["sha-latest"],
          revertedRunIds: ["run-latest"],
          revertedCount: 1,
        }),
      }),
    );
  });

  it("creates revert artifact context and finalizes with reverted status", async () => {
    const run = createRunMetadata({ runId: "run-1", status: "completed", commitSha: "sha-1" });

    const { revertTask, artifactStore } = createDependencies([run], {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[1] === "sha-1" && args[2] === "--no-edit") {
          return "";
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ method: "revert", keepArtifacts: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledWith({
      cwd: "/workspace",
      commandName: "revert",
      mode: "wait",
      source: "roadmap.md",
      task: run.task,
      keepArtifacts: true,
    });
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        preserve: true,
        extra: expect.objectContaining({
          method: "revert",
          runIds: ["run-1"],
          commitShas: ["sha-1"],
        }),
      }),
    );
  });

  it("finalizes with revert-failed status when git revert fails", async () => {
    const run = createRunMetadata({ runId: "run-1", status: "completed", commitSha: "sha-1" });

    const { revertTask, artifactStore } = createDependencies([run], {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[1] === "sha-1" && args[2] === "--no-edit") {
          throw new Error("conflict while reverting");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ method: "revert", keepArtifacts: true }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "revert-failed",
        preserve: true,
        extra: expect.objectContaining({
          method: "revert",
          runIds: ["run-1"],
          attemptedRunIds: ["run-1"],
          revertedRunIds: [],
          revertedCount: 0,
          failedRunId: "run-1",
          error: "Failed to revert run run-1 (sha-1): conflict while reverting",
        }),
      }),
    );
  });

  it("finalizes with revert-failed status when git reset fails", async () => {
    const run = createRunMetadata({ runId: "run-1", status: "completed", commitSha: "sha-1" });

    const { revertTask, artifactStore } = createDependencies([run], {
      gitRun: async (args) => {
        if (args[0] === "rev-list") {
          return "sha-1\n";
        }
        if (args[0] === "reset" && args[1] === "--hard" && args[2] === "sha-1~1") {
          throw new Error("reset blocked");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ method: "reset", keepArtifacts: true }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "revert-failed",
        preserve: true,
        extra: expect.objectContaining({
          method: "reset",
          runIds: ["run-1"],
          attemptedRunIds: ["run-1"],
          revertedRunIds: [],
          revertedCount: 0,
          failedRunId: null,
          error: "reset blocked",
        }),
      }),
    );
  });

  it("stops on first failure in multi-run revert and reports progress", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-oldest",
        status: "completed",
        commitSha: "sha-oldest",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
      createRunMetadata({
        runId: "run-newest",
        status: "completed",
        commitSha: "sha-newest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
      createRunMetadata({
        runId: "run-middle",
        status: "completed",
        commitSha: "sha-middle",
        startedAt: "2026-03-19T18:00:10.000Z",
      }),
    ];

    const { revertTask, events, gitClient, artifactStore } = createDependencies(runs, {
      gitRun: async (args) => {
        if (args[0] === "revert" && args[1] === "sha-newest" && args[2] === "--no-edit") {
          return "";
        }
        if (args[0] === "revert" && args[1] === "sha-middle" && args[2] === "--no-edit") {
          throw new Error("conflict while reverting");
        }
        return undefined;
      },
    });

    const code = await revertTask(createOptions({ all: true, method: "revert", keepArtifacts: true }));

    expect(code).toBe(1);
    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(2);
    expect(revertCalls.map(([args]) => args)).toEqual([
      ["revert", "sha-newest", "--no-edit"],
      ["revert", "sha-middle", "--no-edit"],
    ]);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Revert stopped on run-middle after 1 successful run(s)."))).toBe(true);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "revert-failed",
        preserve: true,
        extra: expect.objectContaining({
          method: "revert",
          runIds: ["run-newest", "run-middle", "run-oldest"],
          attemptedRunIds: ["run-newest", "run-middle"],
          revertedRunIds: ["run-newest"],
          revertedCount: 1,
          failedRunId: "run-middle",
        }),
      }),
    );
  });

  it("uses newest-first order in --method revert dry-run output", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-oldest",
        status: "completed",
        commitSha: "sha-oldest",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
      createRunMetadata({
        runId: "run-newest",
        status: "completed",
        commitSha: "sha-newest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
    ];

    const { revertTask, events } = createDependencies(runs);

    const code = await revertTask(createOptions({ all: true, method: "revert", dryRun: true }));

    expect(code).toBe(0);
    const runLines = events
      .filter((event): event is Extract<ApplicationOutputEvent, { kind: "info" }> => event.kind === "info")
      .map((event) => event.message)
      .filter((message) => message.startsWith("- run="));
    expect(runLines).toEqual([
      expect.stringContaining("run=run-newest"),
      expect.stringContaining("run=run-oldest"),
    ]);
  });

  it("shows git revert commands in --method revert dry-run output without executing", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-oldest",
        status: "completed",
        commitSha: "sha-oldest",
        startedAt: "2026-03-19T18:00:00.000Z",
      }),
      createRunMetadata({
        runId: "run-newest",
        status: "completed",
        commitSha: "sha-newest",
        startedAt: "2026-03-19T18:00:20.000Z",
      }),
    ];

    const { revertTask, events, gitClient } = createDependencies(runs);

    const code = await revertTask(createOptions({ all: true, method: "revert", dryRun: true }));

    expect(code).toBe(0);
    const commandLines = events
      .filter((event): event is Extract<ApplicationOutputEvent, { kind: "info" }> => event.kind === "info")
      .map((event) => event.message)
      .filter((message) => message.startsWith("- git revert "));
    expect(commandLines).toEqual([
      "- git revert sha-newest --no-edit",
      "- git revert sha-oldest --no-edit",
    ]);

    const revertCalls = vi.mocked(gitClient.run).mock.calls
      .filter(([args]) => Array.isArray(args) && args[0] === "revert");
    expect(revertCalls).toHaveLength(0);
  });
});

function createDependencies(
  runs: ArtifactRunMetadata[],
  options: {
    gitRun?: (args: string[]) => string | undefined | Promise<string | undefined>;
    fileExists?: (filePath: string) => boolean;
  } = {},
): {
  revertTask: (options: RevertTaskOptions) => Promise<number>;
  events: ApplicationOutputEvent[];
  gitClient: GitClient;
  artifactStore: ArtifactStore;
} {
  const events: ApplicationOutputEvent[] = [];

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-revert",
      rootDir: "/workspace/.rundown/runs/run-revert",
      cwd: "/workspace",
      keepArtifacts: false,
      commandName: "revert",
      mode: "wait",
      transport: "file",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-revert"),
    rootDir: vi.fn(() => "/workspace/.rundown/runs"),
    listSaved: vi.fn(() => runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => runs[0] ?? null),
    find: vi.fn((runId: string) => runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const gitClient: GitClient = {
    run: vi.fn(async (args: string[]) => {
      const overriddenOutput = options.gitRun ? await options.gitRun(args) : undefined;
      if (typeof overriddenOutput === "string") {
        return overriddenOutput;
      }

      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true\n";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "head-sha\n";
      }
      if (args[0] === "status") {
        return "";
      }
      if (args[0] === "cat-file" && args[1] === "-t") {
        return "commit\n";
      }

      throw new Error("Unexpected git command: " + args.join(" "));
    }),
  };

  const dependencies: RevertTaskDependencies = {
    artifactStore,
    gitClient,
    workingDirectory: {
      cwd: vi.fn(() => "/workspace"),
    },
    fileSystem: createInMemoryFileSystem({ fileExists: options.fileExists }),
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    revertTask: createRevertTask(dependencies),
    events,
    gitClient,
    artifactStore,
  };
}

function createRunMetadata(options: {
  runId: string;
  status: ArtifactStoreStatus;
  commitSha?: string;
  startedAt?: string;
  commandName?: string;
  extra?: Record<string, unknown>;
}): ArtifactRunMetadata {
  const commitExtra = options.commitSha === undefined
    ? {}
    : { commitSha: options.commitSha };
  const mergedExtra = {
    ...commitExtra,
    ...(options.extra ?? {}),
  };
  const extra = Object.keys(mergedExtra).length > 0 ? mergedExtra : undefined;

  return {
    runId: options.runId,
    rootDir: path.join("/workspace", ".rundown", "runs", options.runId),
    relativePath: `.rundown/runs/${options.runId}`,
    commandName: options.commandName ?? "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
    source: "roadmap.md",
    task: {
      text: "Do work",
      file: "/workspace/roadmap.md",
      line: 1,
      index: 0,
      source: "roadmap.md",
    },
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-19T18:00:00.000Z",
    completedAt: "2026-03-19T18:00:30.000Z",
    status: options.status,
    extra,
  };
}

function createInMemoryFileSystem(options: {
  fileExists?: (filePath: string) => boolean;
} = {}): FileSystem {
  return {
    exists: vi.fn((filePath: string) => options.fileExists ? options.fileExists(filePath) : true),
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createOptions(overrides: Partial<RevertTaskOptions>): RevertTaskOptions {
  return {
    runId: "latest",
    last: undefined,
    all: false,
    method: "revert",
    dryRun: false,
    keepArtifacts: false,
    force: false,
    ...overrides,
  };
}
