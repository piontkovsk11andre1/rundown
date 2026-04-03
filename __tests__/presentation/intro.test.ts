import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntro } from "../../src/presentation/intro.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("renderIntro", () => {
  let output: string;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    output = "";
    originalIsTTY = process.stdout.isTTY;

    // Force non-TTY mode so all animations are instant (no delays).
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, writable: true, configurable: true });
    vi.restoreAllMocks();
  });

  it("returns exit code 0", async () => {
    const exitCode = await renderIntro("1.0.0");
    expect(exitCode).toBe(0);
  });

  it("includes the version string in the footer", async () => {
    await renderIntro("2.5.0-rc.3");
    expect(output).toContain("v2.5.0-rc.3");
  });

  it("outputs the ASCII banner", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    // Block character banner — contains the distinctive block art rows
    expect(plain).toContain("██████");
    expect(plain).toContain("██   ██");
  });

  it("outputs act I — the promise", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("AI can do anything");
    expect(plain).toContain("write a prompt");
    expect(plain).toContain("mostly");
  });

  it("outputs act II — the problem", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("login endpoint");
    expect(plain).toContain("Production incident");
    expect(plain).toContain("Nobody verified it");
  });

  it("outputs act III — the idea", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("second AI");
    expect(plain).toContain("Verified right");
    expect(plain).toContain("Execute.");
    expect(plain).toContain("Verify.");
    expect(plain).toContain("Repair.");
  });

  it("outputs act IV — the proof with execute/verify/repair", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("Verification failed");
    expect(plain).toContain("Repair attempt");
    expect(plain).toContain("Repair succeeded");
    expect(plain).toContain("Verification passed");
    expect(plain).toContain("All tasks completed");
  });

  it("outputs act V — the workflow (research/plan/make/run)", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("rundown research");
    expect(plain).toContain("rundown plan");
    expect(plain).toContain("rundown make");
    expect(plain).toContain("TODO items");
  });

  it("outputs act VI — the power (CLI blocks)", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("cli");
    expect(plain).toContain("npm test");
    expect(plain).toContain("inline");
  });

  it("outputs act VII — the machine (clean runs and caching)", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("--clean");
    expect(plain).toContain("Round 1/3");
    expect(plain).toContain("cached");
  });

  it("outputs finale with tagline and help hint", async () => {
    await renderIntro("1.0.0");
    const plain = stripAnsi(output);
    expect(plain).toContain("It is where work runs");
    expect(plain).toContain("rundown --help");
  });

  it("completes quickly in non-TTY mode (no animation delays)", async () => {
    const start = Date.now();
    await renderIntro("1.0.0");
    const elapsed = Date.now() - start;
    // Should complete in under 500ms without any sleep delays.
    expect(elapsed).toBeLessThan(500);
  });

  it("does not show 'press any key' prompt in non-TTY mode", async () => {
    await renderIntro("1.0.0");
    expect(output).not.toContain("press any key");
  });
});
