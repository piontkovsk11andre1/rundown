import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHealthSceneState,
  renderHealthSceneLines,
} from "../../../src/presentation/tui/scenes/health.ts";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function makeTmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("health scene empty state", () => {
  it("renders an absent-file empty state when the worker-health snapshot does not exist", () => {
    const tmpRoot = makeTmpDir("health-scene-empty-absent-");
    try {
      const filePath = path.join(tmpRoot, ".rundown", "worker-health.json");
      const state = {
        ...createHealthSceneState(),
        loading: false,
        healthStatus: {
          generatedAt: "2026-05-02T00:00:00.000Z",
          filePath,
          configDir: path.join(tmpRoot, ".rundown"),
          entries: [],
        },
        config: {},
        configPath: path.join(tmpRoot, ".rundown", "config.json"),
      };
      const rendered = renderHealthSceneLines({ state }).map(stripAnsi);
      expect(rendered.some((line) => line.includes("Workers"))).toBe(true);
      expect(rendered.some((line) => line.includes("No worker-health snapshot found."))).toBe(true);
      expect(rendered.some((line) => line.includes(`Expected at: ${filePath}`))).toBe(true);
      expect(
        rendered.some((line) =>
          line.includes("Entries appear here after the first worker invocation."),
        ),
      ).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("renders a present-but-empty state when the snapshot file exists with no entries", () => {
    const tmpRoot = makeTmpDir("health-scene-empty-present-");
    try {
      const dir = path.join(tmpRoot, ".rundown");
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, "worker-health.json");
      writeFileSync(
        filePath,
        JSON.stringify({ schemaVersion: 1, updatedAt: "2026-05-02T00:00:00.000Z", entries: [] }),
        "utf-8",
      );

      const state = {
        ...createHealthSceneState(),
        loading: false,
        healthStatus: {
          generatedAt: "2026-05-02T00:00:00.000Z",
          filePath,
          configDir: dir,
          entries: [],
        },
        config: {},
        configPath: path.join(dir, "config.json"),
      };
      const rendered = renderHealthSceneLines({ state }).map(stripAnsi);
      expect(rendered.some((line) => line.includes("No worker-health entries recorded."))).toBe(true);
      expect(rendered.some((line) => line.includes(`Snapshot: ${filePath}`))).toBe(true);
      expect(
        rendered.some((line) =>
          line.includes("Entries appear here as workers succeed or fail."),
        ),
      ).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("hides entry-specific action hints in the empty state but keeps Policy and [e]", () => {
    const state = {
      ...createHealthSceneState(),
      loading: false,
      healthStatus: {
        generatedAt: "2026-05-02T00:00:00.000Z",
        filePath: "",
        configDir: "",
        entries: [],
      },
      config: {},
      configPath: ".rundown/config.json",
    };
    const rendered = renderHealthSceneLines({ state }).map(stripAnsi);

    expect(rendered.some((line) => line.includes("Policy"))).toBe(true);
    expect(rendered.some((line) => line.includes("[e] edit healthPolicy in config.json"))).toBe(true);
    expect(rendered.some((line) => line.includes("[Esc] Back to menu"))).toBe(true);
    expect(
      rendered.some((line) =>
        line.includes("entry actions") && line.includes("[↵]/[r]/[p]"),
      ),
    ).toBe(true);

    const fullText = rendered.join("\n");
    expect(fullText.includes("[r] reset entry")).toBe(false);
    expect(fullText.includes("[p] probe now")).toBe(false);
    expect(fullText.includes("[↵] view recent failures")).toBe(false);
  });
});
