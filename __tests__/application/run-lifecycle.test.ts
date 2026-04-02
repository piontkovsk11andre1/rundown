import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactRunContext,
  ArtifactStore,
} from "../../src/domain/ports/index.js";

import { finalizeRunArtifacts } from "../../src/application/run-lifecycle.js";

describe("run-lifecycle", () => {
  describe("finalizeRunArtifacts", () => {
    it("finalizes runtime artifacts and emits the saved path when preserved", () => {
      const emit = vi.fn();
      const artifactStore: ArtifactStore = {
        createContext: vi.fn(),
        beginPhase: vi.fn(),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ".rundown/runs/run-1"),
        rootDir: vi.fn(),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      };
      const context: ArtifactRunContext = {
        runId: "run-1",
        rootDir: "/workspace/.rundown/runs/run-1",
        cwd: "/workspace",
        keepArtifacts: true,
        commandName: "run",
      };

      finalizeRunArtifacts(
        artifactStore,
        context,
        true,
        "completed",
        emit,
      );

      expect(artifactStore.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1" }),
        { status: "completed", preserve: true },
      );
      expect(emit).toHaveBeenCalledWith({
        kind: "info",
        message: "Runtime artifacts saved at .rundown/runs/run-1.",
      });
    });
  });
});
