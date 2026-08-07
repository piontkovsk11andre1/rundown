import { describe, expect, it } from "vitest";
import { createTuiHarness } from "./harness.ts";

describe("tui tools integration", () => {
  it("discovers custom tools from toolDirs and renders shadowed entries", async () => {
    const harness = await createTuiHarness({
      initialScene: "workers",
      configJson: {
        toolDirs: ["tools", "shared-tools"],
        commands: {
          tools: {
            "post-on-gitea": ["opencode", "run", "--model", "gpt-5.3-mini", "--no-approval"],
          },
        },
      },
      workspaceFiles: {
        ".rundown/tools/post-on-gitea.md": "# Primary post\n",
        ".rundown/tools/summarize.md": "# Summarize\n",
        ".rundown/shared-tools/post-on-gitea.js": "module.exports = {};\n",
        ".rundown/shared-tools/triage.js": "module.exports = {};\n",
      },
    });

    await harness.press("T");

    const frame = harness.frame();
    expect(frame).toContain("Tools");
    expect(frame).toContain("toolDirs: [tools, shared-tools]");
    expect(frame).toContain("post-on-gitea");
    expect(frame).toMatch(/tools[\\/]post-on-gitea\.md/);
    expect(frame).toContain("commands.tools.post-on-gitea overrides worker for this prefix");
    expect(frame).toMatch(/shadowed: shared-tools[\\/]post-on-gitea\.js/);
    expect(frame).toContain("triage");
    expect(frame).toMatch(/shared-tools[\\/]triage\.js/);
  });

  it("shows built-ins on first open and hides them on next open in-session", async () => {
    const harness = await createTuiHarness({ initialScene: "workers" });

    await harness.press("T");
    expect(harness.frame()).toContain("Built-in (read-only)");
    expect(harness.frame()).toContain("Verify-only");

    await harness.press("esc");
    expect(harness.frame()).toContain("Workers");

    await harness.press("T");
    expect(harness.frame()).toContain("Built-in catalog hidden. [b] to show.");
    expect(harness.frame()).not.toContain("Built-in (read-only)");
  });
});
