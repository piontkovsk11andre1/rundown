import { describe, expect, it } from "vitest";
import { createTuiHarness } from "./harness.ts";

describe("tui help integration", () => {
  it("discovers local docs including fixed files and docs/*.md", async () => {
    const harness = await createTuiHarness({ initialScene: "help" });

    const frame = harness.frame();
    expect(frame).toContain("Help");
    expect(frame).toContain("Documentation (local)");
    expect(frame).toContain("README.md");
    expect(frame).toContain("roadmap.md");
    expect(frame).toMatch(/docs\/[\w.-]+\.md/);
  });

  it("shows synthesized and external help rows", async () => {
    const harness = await createTuiHarness({ initialScene: "help" });

    const frame = harness.frame();
    expect(frame).toContain("Synthesized references");
    expect(frame).toContain("Effective config dump (current workspace)");
    expect(frame).toContain("External");
    expect(frame).toContain("Project website");
  });

  it("renders keybindings overlay with [k]", async () => {
    const harness = await createTuiHarness({
      initialScene: "help",
    });

    await harness.press("k");

    const frame = harness.frame();
    expect(frame).toContain("Keybindings cheatsheet");
    expect(frame).toContain("Global");
    expect(frame).toContain("[Enter] open local docs and synthesized references");
    expect(frame).toContain("[Esc] close");
  });
});
