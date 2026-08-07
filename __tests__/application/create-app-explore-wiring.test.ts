import { describe, expect, it, vi } from "vitest";

const {
  createStartProjectMock,
  createMigrateTaskMock,
  runExploreTaskMock,
} = vi.hoisted(() => {
  return {
    createStartProjectMock: vi.fn(() => async () => 0),
    createMigrateTaskMock: vi.fn(() => async () => 0),
    runExploreTaskMock: vi.fn(async () => 0),
  };
});

vi.mock("../../src/application/start-project.js", () => ({
  createStartProject: createStartProjectMock,
}));

vi.mock("../../src/application/migrate-task.js", () => ({
  createMigrateTask: createMigrateTaskMock,
}));

vi.mock("../../src/application/explore-task.js", () => ({
  createExploreTask: vi.fn(() => runExploreTaskMock),
}));

describe("createApp explore wiring", () => {
  it("passes internal explore runners into start and migrate use cases", async () => {
    const { createApp } = await import("../../src/create-app.js");

    createApp();

    expect(createStartProjectMock).toHaveBeenCalledTimes(1);
    expect(createMigrateTaskMock).toHaveBeenCalledTimes(1);

    const startDependencies = createStartProjectMock.mock.calls[0]?.[0] as {
      runExplore?: (source: string, cwd: string) => Promise<number>;
    };
    const migrateDependencies = createMigrateTaskMock.mock.calls[0]?.[0] as {
      runExplore?: (source: string, cwd: string) => Promise<number>;
    };

    expect(typeof startDependencies.runExplore).toBe("function");
    expect(typeof migrateDependencies.runExplore).toBe("function");

    await startDependencies.runExplore?.("design/current/Target.md", "/workspace");

    expect(runExploreTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "design/current/Target.md",
      cwd: "/workspace",
      mode: "wait",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      emitPhaseMessages: false,
    }));
  });
});
