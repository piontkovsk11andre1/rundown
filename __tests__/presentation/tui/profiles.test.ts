import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";
import {
  createProfilesSceneState,
  handleProfilesInput,
  reloadProfilesSceneState,
  renderProfilesSceneLines,
  runProfilesSceneAction,
} from "../../../src/presentation/tui/scenes/profiles.ts";
import { createApp } from "../../../src/create-app.js";

const profileMockData = vi.hoisted(() => ({
  profiles: {
    fast: ["opencode", "run", "--model", "gpt-5.3"],
    review: ["opencode", "run", "--model", "opus-4.6"],
  },
}));

describe("tui profiles integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the profiles scene on a seeded workspace", async () => {
    const harness = await createTuiHarness({
      initialScene: "profiles",
      workspaceFiles: {
        "migrations/001-first.md": "---\nprofile: fast\n---\n\n- [ ] First task\n",
        "migrations/002-second.md": "- profile=review\n",
        "specs/notes.md": "- [ ] profile=fast, tighten test coverage\n",
      },
    });

    const frame = harness.frame();

    expect(frame).toContain("Profiles");
    expect(frame).toContain("fast");
    expect(frame).toContain("used by: 1 frontmatter · 0 directives · 1 prefix");
    expect(frame).toContain("review");
    expect(frame).toContain("used by: 0 frontmatter · 1 directives · 0 prefix");
    expect(frame).toContain("[u] full scan");
    expect(createApp).toHaveBeenCalled();
  });

  it("returns to the main menu on Esc", async () => {
    const harness = await createTuiHarness({ initialScene: "profiles" });

    expect(harness.sceneStack()).toEqual(["mainMenu", "profiles"]);

    await harness.press("esc");

    expect(harness.sceneStack()).toEqual(["mainMenu"]);
    expect(harness.frame()).toContain("Main Menu:");
    expect(harness.frame()).toContain("4. Profiles");
  });

  it("drills into profile references on Enter and returns on Esc", async () => {
    const harness = await createTuiHarness({
      initialScene: "profiles",
      workspaceFiles: {
        "migrations/001-first.md": "---\nprofile: fast\n---\n\n- [ ] First task\n",
        "specs/notes.md": "- [ ] profile=fast, tighten test coverage\n",
      },
    });

    await harness.press("enter");
    let frame = harness.frame();
    expect(frame).toContain("Inspect references: fast");
    expect(frame).toContain("[frontmatter]");
    expect(frame).toContain("[prefix]");
    expect(frame).toContain("[Esc] Back to profiles");

    await harness.press("esc");
    frame = harness.frame();
    expect(frame).toContain("Profiles");
    expect(frame).toContain("[↵] inspect references");
    expect(frame).not.toContain("Inspect references: fast");
  });

  it("renders no-profiles hint with docs path and edit action", () => {
    const lines = renderProfilesSceneLines({
      state: {
        ...createProfilesSceneState(),
        loading: false,
        config: {},
        references: [],
      },
    });
    const frame = lines.join("\n");

    expect(frame).toContain("No profiles defined.");
    expect(frame).toContain("Hint: run `rundown config --help` for profile options.");
    expect(frame).toContain("[e] edit config.json");
  });

  it("shows unknown references group and allows drill-in", () => {
    const baseState = {
      ...createProfilesSceneState(),
      loading: false,
      config: {
        profiles: {
          fast: ["opencode", "run", "--model", "gpt-5.3"],
        },
      },
      references: [
        { profile: "missing", file: "a.md", line: 2, kind: "frontmatter" },
        { profile: "missing", file: "b.md", line: 7, kind: "directive" },
      ],
    };

    const frame = renderProfilesSceneLines({ state: baseState }).join("\n");
    expect(frame).toContain("Unknown references");
    expect(frame).toContain("missing · 2");

    const down = handleProfilesInput({ rawInput: "\u001b[B", state: baseState });
    const enter = handleProfilesInput({ rawInput: "\n", state: down.state });
    expect(enter.state.inspectProfile).toBe("missing");

    const inspectFrame = renderProfilesSceneLines({ state: enter.state }).join("\n");
    expect(inspectFrame).toContain("Inspect references: missing");
    expect(inspectFrame).toContain("[frontmatter] a.md:2");
    expect(inspectFrame).toContain("[directive] b.md:7");
  });

  it("caches profile scans for 30 seconds", async () => {
    const scanProfileReferences = vi.fn(async () => []);
    const workspaceScanBridgeFactory = () => ({
      scanProfileReferences,
    });
    const configBridgeFactory = () => ({
      resolveConfigPath: async () => "C:\\tmp\\.rundown\\config.json",
      loadWorkerConfig: async () => ({ profiles: profileMockData.profiles }),
    });

    const first = await reloadProfilesSceneState({
      state: createProfilesSceneState(),
      now: () => 1_000,
      configBridgeFactory,
      workspaceScanBridgeFactory,
    });

    await reloadProfilesSceneState({
      state: first,
      now: () => 30_000,
      configBridgeFactory,
      workspaceScanBridgeFactory,
    });

    await reloadProfilesSceneState({
      state: first,
      now: () => 31_001,
      configBridgeFactory,
      workspaceScanBridgeFactory,
    });

    expect(scanProfileReferences).toHaveBeenCalledTimes(2);
  });

  it("maps [u] to full-rescan action", () => {
    const result = handleProfilesInput({
      rawInput: "u",
      state: createProfilesSceneState(),
    });

    expect(result.handled).toBe(true);
    expect(result.backToParent).toBe(false);
    expect(result.action).toEqual({ type: "full-rescan" });
  });

  it("maps [e] to edit-config action", () => {
    const result = handleProfilesInput({
      rawInput: "e",
      state: createProfilesSceneState(),
    });

    expect(result.handled).toBe(true);
    expect(result.backToParent).toBe(false);
    expect(result.action).toEqual({ type: "edit-config" });
  });

  it("maps Enter to inspect-selected-profile action via state transition", () => {
    const result = handleProfilesInput({
      rawInput: "\n",
      state: {
        ...createProfilesSceneState(),
        loading: false,
        config: {
          profiles: profileMockData.profiles,
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.backToParent).toBe(false);
    expect(result.state.inspectProfile).toBe("fast");
  });

  it("maps Enter in inspect mode to open-reference action", () => {
    const result = handleProfilesInput({
      rawInput: "\n",
      state: {
        ...createProfilesSceneState(),
        loading: false,
        inspectProfile: "fast",
        inspectSelectedReferenceIndex: 0,
        references: [
          {
            profile: "fast",
            file: "C:\\Work\\md-todo\\specs\\notes.md",
            line: 7,
            kind: "prefix",
          },
        ],
      },
    });

    expect(result.handled).toBe(true);
    expect(result.backToParent).toBe(false);
    expect(result.action).toEqual({
      type: "open-reference",
      reference: {
        file: "C:\\Work\\md-todo\\specs\\notes.md",
        line: 7,
      },
    });
  });

  it("opens reference in editor at reported line", async () => {
    const launchEditorFn = vi.fn(() => ({ ok: true }));
    const currentState = {
      ...createProfilesSceneState(),
      loading: false,
      inspectProfile: "fast",
      references: [
        {
          profile: "fast",
          file: "C:\\Work\\md-todo\\specs\\notes.md",
          line: 12,
          kind: "frontmatter",
        },
      ],
    };

    await runProfilesSceneAction({
      action: {
        type: "open-reference",
        reference: {
          file: "C:\\Work\\md-todo\\specs\\notes.md",
          line: 12,
        },
      },
      state: currentState,
      currentWorkingDirectory: "C:\\Work\\md-todo",
      suspendTui: () => {},
      resumeTui: () => {},
      launchEditorFn,
    });

    expect(launchEditorFn).toHaveBeenCalledWith("C:\\Work\\md-todo\\specs\\notes.md", {
      cwd: "C:\\Work\\md-todo",
      line: 12,
    });
  });

  it("opens config editor and reloads after edit", async () => {
    const launchEditorFn = vi.fn(() => ({ ok: true }));
    const reloadProfilesSceneStateFn = vi.fn(async ({ state }) => ({
      ...state,
      loading: false,
      banner: "",
      config: {
        profiles: {
          fast: ["opencode", "run", "--model", "gpt-5.3"],
        },
      },
    }));

    const currentState = {
      ...createProfilesSceneState(),
      loading: false,
      configPath: "C:\\Work\\md-todo\\.rundown\\config.json",
    };

    await runProfilesSceneAction({
      action: { type: "edit-config" },
      state: currentState,
      currentWorkingDirectory: "C:\\Work\\md-todo",
      suspendTui: () => {},
      resumeTui: () => {},
      launchEditorFn,
      reloadProfilesSceneStateFn,
    });

    expect(launchEditorFn).toHaveBeenCalledWith("C:\\Work\\md-todo\\.rundown\\config.json", {
      cwd: "C:\\Work\\md-todo",
    });
    expect(reloadProfilesSceneStateFn).toHaveBeenCalled();
  });

  it("forceRescan bypasses cache before TTL", async () => {
    const scanProfileReferences = vi.fn(async () => []);
    const workspaceScanBridgeFactory = () => ({
      scanProfileReferences,
    });
    const configBridgeFactory = () => ({
      resolveConfigPath: async () => "C:\\tmp\\.rundown\\config.json",
      loadWorkerConfig: async () => ({ profiles: profileMockData.profiles }),
    });

    const initial = await reloadProfilesSceneState({
      state: createProfilesSceneState(),
      now: () => 5_000,
      configBridgeFactory,
      workspaceScanBridgeFactory,
    });

    await reloadProfilesSceneState({
      state: initial,
      forceRescan: true,
      now: () => 5_100,
      configBridgeFactory,
      workspaceScanBridgeFactory,
    });

    expect(scanProfileReferences).toHaveBeenCalledTimes(2);
  });
});

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    return {
      configList: vi.fn(async () => {
        emit?.({
          kind: "text",
          text: JSON.stringify({
            config: {
              profiles: profileMockData.profiles,
            },
          }),
        });
        return 0;
      }),
      configPath: vi.fn(async () => {
        emit?.({ kind: "text", text: JSON.stringify({ path: "C:\\Work\\md-todo\\.rundown\\config.json" }) });
        return 0;
      }),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));
