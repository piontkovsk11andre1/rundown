import { describe, expect, it } from "vitest";
import {
  HARNESS_PRESET_KEYS,
  getHarnessPresetPayload,
  listHarnessPresetEntries,
  listHarnessPresetKeys,
  resolveHarnessPresetKey,
} from "../../src/domain/harness-preset-registry.ts";

describe("harness-preset-registry", () => {
  it("lists the expected canonical harness keys", () => {
    expect(listHarnessPresetKeys()).toEqual(HARNESS_PRESET_KEYS);
  });

  it("resolves canonical keys and aliases case-insensitively", () => {
    expect(resolveHarnessPresetKey("opencode")).toBe("opencode");
    expect(resolveHarnessPresetKey("OpenCode")).toBe("opencode");
    expect(resolveHarnessPresetKey("open-code")).toBe("opencode");
    expect(resolveHarnessPresetKey("CLAUDE-CODE")).toBe("claude");
    expect(resolveHarnessPresetKey("gemini-cli")).toBe("gemini");
    expect(resolveHarnessPresetKey("OpenAI-Codex")).toBe("codex");
    expect(resolveHarnessPresetKey("cursor-agent")).toBe("cursor");
    expect(resolveHarnessPresetKey("Pi-CLI")).toBe("pi");
  });

  it("defines the canonical opencode deterministic and interactive split", () => {
    const payload = getHarnessPresetPayload("opencode");

    expect(payload).toEqual({
      workers: {
        default: ["opencode", "run", "--file", "$file", "$bootstrap"],
        tui: ["opencode"],
      },
      commands: {
        discuss: ["opencode"],
      },
    });
  });

  it("returns undefined for unknown or blank aliases", () => {
    expect(resolveHarnessPresetKey("unknown")).toBeUndefined();
    expect(resolveHarnessPresetKey("   ")).toBeUndefined();
  });

  it("includes canonical key in each entry alias list", () => {
    for (const entry of listHarnessPresetEntries()) {
      expect(entry.aliases).toContain(entry.key);
    }
  });

  it("defines deterministic and interactive payloads for all supported harnesses", () => {
    for (const key of HARNESS_PRESET_KEYS) {
      const payload = getHarnessPresetPayload(key);

      expect(payload.workers.default).toEqual([key, "run", "--file", "$file", "$bootstrap"]);
      expect(payload.workers.tui).toEqual([key]);
      expect(payload.commands?.discuss).toEqual([key]);
    }
  });

  it("returns cloned payloads so callers cannot mutate registry state", () => {
    const first = getHarnessPresetPayload("opencode");
    first.workers.default[0] = "mutated";
    if (first.workers.tui) {
      first.workers.tui[0] = "mutated";
    }
    if (first.commands?.discuss) {
      first.commands.discuss[0] = "mutated";
    }

    const second = getHarnessPresetPayload("opencode");
    expect(second.workers.default[0]).toBe("opencode");
    expect(second.workers.tui?.[0]).toBe("opencode");
    expect(second.commands?.discuss?.[0]).toBe("opencode");
  });

  it("surfaces payloads on list entries", () => {
    for (const entry of listHarnessPresetEntries()) {
      expect(entry.payload.workers.default).toEqual([entry.key, "run", "--file", "$file", "$bootstrap"]);
      expect(entry.payload.workers.tui).toEqual([entry.key]);
      expect(entry.payload.commands?.discuss).toEqual([entry.key]);
    }
  });
});
