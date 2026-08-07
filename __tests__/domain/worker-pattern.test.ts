import { describe, expect, it } from "vitest";
import { expandWorkerPattern, parseWorkerPattern } from "../../src/domain/worker-pattern.js";

describe("parseWorkerPattern", () => {
  it("detects explicit $bootstrap substitution", () => {
    const parsed = parseWorkerPattern("claude -p $bootstrap");

    expect(parsed.command).toEqual(["claude", "-p", "$bootstrap"]);
    expect(parsed.usesBootstrap).toBe(true);
    expect(parsed.usesFile).toBe(false);
    expect(parsed.appendFile).toBe(false);
  });

  it("detects explicit $file substitution", () => {
    const parsed = parseWorkerPattern("opencode run --file $file");

    expect(parsed.command).toEqual(["opencode", "run", "--file", "$file"]);
    expect(parsed.usesBootstrap).toBe(false);
    expect(parsed.usesFile).toBe(true);
    expect(parsed.appendFile).toBe(false);
  });

  it("detects both substitutions when both are present", () => {
    const parsed = parseWorkerPattern("agent --file $file --prompt=$bootstrap");

    expect(parsed.command).toEqual(["agent", "--file", "$file", "--prompt=$bootstrap"]);
    expect(parsed.usesBootstrap).toBe(true);
    expect(parsed.usesFile).toBe(true);
    expect(parsed.appendFile).toBe(false);
  });

  it("detects substitutions when multiple variables appear in one token", () => {
    const parsed = parseWorkerPattern("agent --combo=$bootstrap::$file::$bootstrap");

    expect(parsed.command).toEqual(["agent", "--combo=$bootstrap::$file::$bootstrap"]);
    expect(parsed.usesBootstrap).toBe(true);
    expect(parsed.usesFile).toBe(true);
    expect(parsed.appendFile).toBe(false);
  });

  it("defaults to implicit $file append when no substitution exists", () => {
    const parsed = parseWorkerPattern("my-agent");

    expect(parsed.command).toEqual(["my-agent"]);
    expect(parsed.usesBootstrap).toBe(false);
    expect(parsed.usesFile).toBe(false);
    expect(parsed.appendFile).toBe(true);
  });

  it("supports quoted arguments", () => {
    const parsed = parseWorkerPattern("agent --prompt='Read this first' --file \"$file\"");

    expect(parsed.command).toEqual(["agent", "--prompt=Read this first", "--file", "$file"]);
    expect(parsed.usesFile).toBe(true);
  });

  it("supports shell-quoted args while still detecting substitutions", () => {
    const parsed = parseWorkerPattern("agent --prompt=\"Read \\\"$file\\\" first\" '$bootstrap'");

    expect(parsed.command).toEqual(["agent", "--prompt=Read \"$file\" first", "$bootstrap"]);
    expect(parsed.usesBootstrap).toBe(true);
    expect(parsed.usesFile).toBe(true);
    expect(parsed.appendFile).toBe(false);
  });

  it("supports escaped spaces in unquoted tokens", () => {
    const parsed = parseWorkerPattern("agent path\\ with\\ spaces $file");

    expect(parsed.command).toEqual(["agent", "path with spaces", "$file"]);
    expect(parsed.usesFile).toBe(true);
  });

  it("throws when the pattern has no command tokens", () => {
    expect(() => parseWorkerPattern("   \t\n  "))
      .toThrow("Worker pattern must include at least one command token.");
  });

  it("throws when the pattern only contains empty quoted tokens", () => {
    expect(() => parseWorkerPattern("'' \"\""))
      .toThrow("Worker pattern must include at least one command token.");
  });

  it("throws on unterminated quotes", () => {
    expect(() => parseWorkerPattern("agent --prompt=\"oops"))
      .toThrow("Invalid worker pattern: unterminated quoted argument.");
  });

  it("throws on trailing escape character", () => {
    expect(() => parseWorkerPattern("agent --arg\\"))
      .toThrow("Invalid worker pattern: trailing escape character.");
  });
});

describe("expandWorkerPattern", () => {
  it("substitutes $bootstrap placeholders", () => {
    const parsed = parseWorkerPattern("claude -p $bootstrap");

    const args = expandWorkerPattern(
      parsed,
      "Read the task prompt file at .rundown/runs/run-123/01-worker/prompt.md and follow the instructions.",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    );

    expect(args).toEqual([
      "claude",
      "-p",
      "Read the task prompt file at .rundown/runs/run-123/01-worker/prompt.md and follow the instructions.",
    ]);
  });

  it("substitutes $file placeholders", () => {
    const parsed = parseWorkerPattern("opencode run --file $file");

    const args = expandWorkerPattern(
      parsed,
      "unused bootstrap",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    );

    expect(args).toEqual([
      "opencode",
      "run",
      "--file",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    ]);
  });

  it("substitutes placeholders inside token values", () => {
    const parsed = parseWorkerPattern("agent --prompt=$bootstrap --input=$file");

    const args = expandWorkerPattern(
      parsed,
      "open .rundown/runs/run-123/01-worker/prompt.md",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    );

    expect(args).toEqual([
      "agent",
      "--prompt=open .rundown/runs/run-123/01-worker/prompt.md",
      "--input=C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    ]);
  });

  it("appends prompt file path when no substitution variables exist", () => {
    const parsed = parseWorkerPattern("my-agent --flag");

    const args = expandWorkerPattern(
      parsed,
      "unused bootstrap",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    );

    expect(args).toEqual([
      "my-agent",
      "--flag",
      "C:/repo/.rundown/runs/run-123/01-worker/prompt.md",
    ]);
  });
});
