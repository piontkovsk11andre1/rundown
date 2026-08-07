import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRESET_KEYS,
  getProviderPresetPayload,
  listProviderPresetEntries,
  listProviderPresetKeys,
  resolveProviderPresetKey,
} from "../../src/domain/provider-preset-registry.ts";

describe("provider-preset-registry", () => {
  it("lists the expected canonical provider keys", () => {
    expect(listProviderPresetKeys()).toEqual(PROVIDER_PRESET_KEYS);
  });

  it("resolves canonical keys and aliases case-insensitively", () => {
    expect(resolveProviderPresetKey("opencode")).toBe("opencode");
    expect(resolveProviderPresetKey("OpenCode")).toBe("opencode");
    expect(resolveProviderPresetKey("open-code")).toBe("opencode");
    expect(resolveProviderPresetKey("CLAUDE-CODE")).toBe("claude");
    expect(resolveProviderPresetKey("gemini-cli")).toBe("gemini");
    expect(resolveProviderPresetKey("OpenAI-Codex")).toBe("codex");
    expect(resolveProviderPresetKey("cursor-agent")).toBe("cursor");
    expect(resolveProviderPresetKey("Pi-CLI")).toBe("pi");
  });

  it("defines the canonical opencode deterministic and interactive split", () => {
    const payload = getProviderPresetPayload("opencode");

    expect(payload).toEqual({
      workers: {
        default: ["opencode", "run", "$bootstrap"],
        interactive: ["opencode", "--prompt", "$bootstrap"],
      },
    });
  });

  it("returns undefined for unknown or blank aliases", () => {
    expect(resolveProviderPresetKey("unknown")).toBeUndefined();
    expect(resolveProviderPresetKey("   ")).toBeUndefined();
  });

  it("includes canonical key in each entry alias list", () => {
    for (const entry of listProviderPresetEntries()) {
      expect(entry.aliases).toContain(entry.key);
    }
  });

  it("defines deterministic and interactive payloads for all supported providers", () => {
    for (const key of PROVIDER_PRESET_KEYS) {
      const payload = getProviderPresetPayload(key);

      if (key === "opencode") {
        expect(payload.workers.default).toEqual(["opencode", "run", "$bootstrap"]);
        expect(payload.workers.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
      } else {
        expect(payload.workers.default).toEqual([key, "run", "--file", "$file", "$bootstrap"]);
        expect(payload.workers.interactive).toEqual([key]);
      }
    }
  });

  it("returns cloned payloads so callers cannot mutate registry state", () => {
    const first = getProviderPresetPayload("opencode");
    first.workers.default[0] = "mutated";
    if (first.workers.interactive) {
      first.workers.interactive[0] = "mutated";
    }

    const second = getProviderPresetPayload("opencode");
    expect(second.workers.default[0]).toBe("opencode");
    expect(second.workers.interactive?.[0]).toBe("opencode");
  });

  it("surfaces payloads on list entries", () => {
    for (const entry of listProviderPresetEntries()) {
      if (entry.key === "opencode") {
        expect(entry.payload.workers.default).toEqual(["opencode", "run", "$bootstrap"]);
        expect(entry.payload.workers.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
      } else {
        expect(entry.payload.workers.default).toEqual([entry.key, "run", "--file", "$file", "$bootstrap"]);
        expect(entry.payload.workers.interactive).toEqual([entry.key]);
      }
    }
  });
});
