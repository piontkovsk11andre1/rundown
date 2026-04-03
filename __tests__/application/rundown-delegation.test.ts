import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDelegatedRundownArgs,
  delegatedTargetExists,
  normalizeLegacyRetryArgs,
  parseRundownTaskArgs,
  resolveDelegatedRundownInvocation,
  resolveDelegatedRundownTargetArg,
  validateDelegatedRundownInvocation,
  validateRundownTaskArgs,
} from "../../src/application/rundown-delegation.js";
import { createInMemoryFileSystem } from "./run-task-test-helpers.js";

describe("rundown-delegation", () => {
  it("parses args and normalizes --retries variants", () => {
    expect(parseRundownTaskArgs("--retries 3 --verify")).toEqual(["--repair-attempts", "3", "--verify"]);
    expect(normalizeLegacyRetryArgs(["--retries=2", "--no-verify"])).toEqual(["--repair-attempts=2", "--no-verify"]);
  });

  it("keeps quoted text groups and -- separator tokens", () => {
    expect(parseRundownTaskArgs("run Child.md -- --scan-count 3")).toEqual([
      "run",
      "Child.md",
      "--",
      "--scan-count",
      "3",
    ]);

    expect(parseRundownTaskArgs("make \"Scan count 3 by default\" \"3. Scan.md\"")).toEqual([
      "make",
      "Scan count 3 by default",
      "3. Scan.md",
    ]);
  });

  it("detects explicit delegated subcommands and preserves legacy implicit run", () => {
    expect(resolveDelegatedRundownInvocation(["run", "Child.md", "--verify"])).toEqual({
      subcommand: "run",
      args: ["Child.md", "--verify"],
      isExplicitSubcommand: true,
    });

    expect(resolveDelegatedRundownInvocation(["make", "Scan count 3 by default", "3. Scan.md"])).toEqual({
      subcommand: "make",
      args: ["Scan count 3 by default", "3. Scan.md"],
      isExplicitSubcommand: true,
    });

    expect(resolveDelegatedRundownInvocation(["Child.md", "--verify"])).toEqual({
      subcommand: "run",
      args: ["Child.md", "--verify"],
      isExplicitSubcommand: false,
    });

    expect(resolveDelegatedRundownInvocation(["plan", "Child.md"])).toEqual({
      subcommand: "run",
      args: ["Child.md"],
      isExplicitSubcommand: true,
      unsupportedSubcommand: "plan",
    });
  });

  it("parses explicit run and make path operands for POSIX and Windows forms", () => {
    const explicitPosixRun = parseRundownTaskArgs("run ./docs/Child.md --verify");
    expect(resolveDelegatedRundownInvocation(explicitPosixRun)).toEqual({
      subcommand: "run",
      args: ["./docs/Child.md", "--verify"],
      isExplicitSubcommand: true,
    });

    const explicitWindowsRun = parseRundownTaskArgs("run .\\docs\\Child.md --verify");
    expect(resolveDelegatedRundownInvocation(explicitWindowsRun)).toEqual({
      subcommand: "run",
      args: [".\\docs\\Child.md", "--verify"],
      isExplicitSubcommand: true,
    });

    const explicitPosixMake = parseRundownTaskArgs("make Feature ./docs/3.Feature.md");
    expect(resolveDelegatedRundownInvocation(explicitPosixMake)).toEqual({
      subcommand: "make",
      args: ["Feature", "./docs/3.Feature.md"],
      isExplicitSubcommand: true,
    });

    const explicitWindowsMake = parseRundownTaskArgs("make Feature .\\docs\\3.Feature.md");
    expect(resolveDelegatedRundownInvocation(explicitWindowsMake)).toEqual({
      subcommand: "make",
      args: ["Feature", ".\\docs\\3.Feature.md"],
      isExplicitSubcommand: true,
    });
  });

  it("inherits parent options when delegated args omit them", () => {
    const delegated = buildDelegatedRundownArgs("run", ["docs/tasks.md"], {
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "file",
      parentKeepArtifacts: true,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: true,
      parentVerify: false,
      parentNoRepair: false,
      parentRepairAttempts: 2,
    });

    expect(delegated).toEqual([
      "docs/tasks.md",
      "--worker",
      "opencode",
      "run",
      "--transport",
      "file",
      "--keep-artifacts",
      "--show-agent-output",
      "--ignore-cli-block",
      "--no-verify",
      "--repair-attempts",
      "2",
    ]);
  });

  it("keeps explicit delegated --no-show-agent-output over parent default", () => {
    const delegated = buildDelegatedRundownArgs("run", ["docs/tasks.md", "--no-show-agent-output"], {
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "file",
      parentKeepArtifacts: false,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: false,
      parentVerify: true,
      parentNoRepair: false,
      parentRepairAttempts: 1,
    });

    expect(delegated).toEqual([
      "docs/tasks.md",
      "--no-show-agent-output",
      "--worker",
      "opencode",
      "run",
      "--transport",
      "file",
      "--verify",
      "--repair-attempts",
      "1",
    ]);
  });

  it("forwards only make-compatible options for delegated make", () => {
    const delegated = buildDelegatedRundownArgs("make", ["Feature text", "3. Feature.md"], {
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "file",
      parentKeepArtifacts: true,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: true,
      parentVerify: false,
      parentNoRepair: true,
      parentRepairAttempts: 4,
    });

    expect(delegated).toEqual([
      "Feature text",
      "3. Feature.md",
      "--worker",
      "opencode",
      "run",
      "--transport",
      "file",
      "--keep-artifacts",
      "--show-agent-output",
      "--ignore-cli-block",
    ]);
  });

  it("ignores run-only inherited options for delegated make across parent verify/repair variants", () => {
    const delegated = buildDelegatedRundownArgs("make", ["Feature text", "3. Feature.md"], {
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "arg",
      parentKeepArtifacts: false,
      parentShowAgentOutput: false,
      parentIgnoreCliBlock: false,
      parentVerify: true,
      parentNoRepair: false,
      parentRepairAttempts: 6,
    });

    expect(delegated).toEqual([
      "Feature text",
      "3. Feature.md",
      "--worker",
      "opencode",
      "run",
      "--transport",
      "arg",
    ]);
  });

  it("prefers inherited --no-repair over inherited repair attempts for delegated run", () => {
    const delegated = buildDelegatedRundownArgs("run", ["docs/tasks.md"], {
      parentWorkerCommand: [],
      parentTransport: "",
      parentKeepArtifacts: false,
      parentShowAgentOutput: false,
      parentIgnoreCliBlock: false,
      parentVerify: true,
      parentNoRepair: true,
      parentRepairAttempts: 9,
    });

    expect(delegated).toEqual([
      "docs/tasks.md",
      "--verify",
      "--no-repair",
    ]);
  });

  it("resolves delegated target and checks path candidates", () => {
    expect(resolveDelegatedRundownTargetArg(["docs/tasks.md", "--verify"])).toBe("docs/tasks.md");
    expect(resolveDelegatedRundownTargetArg(["--verify"])).toBeNull();

    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const delegatedFile = path.join(cwd, "docs", "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [ ] parent\n",
      [delegatedFile]: "- [ ] child\n",
    });

    expect(delegatedTargetExists(
      delegatedFile,
      "docs/tasks.md",
      taskFile,
      fileSystem,
      path,
    )).toBe(true);
    expect(delegatedTargetExists(
      path.join(cwd, "missing.md"),
      "missing.md",
      taskFile,
      fileSystem,
      path,
    )).toBe(false);
  });

  it("validates delegated run invocation source operands", () => {
    expect(validateDelegatedRundownInvocation({
      subcommand: "run",
      args: ["Child.md", "--verify"],
      isExplicitSubcommand: true,
    })).toEqual({ valid: true });

    expect(validateDelegatedRundownInvocation({
      subcommand: "run",
      args: ["--verify"],
      isExplicitSubcommand: true,
    })).toEqual({
      valid: false,
      errorMessage: "Rundown task requires a source operand before any flags (example: rundown: run Child.md --verify).",
    });

    expect(validateDelegatedRundownInvocation({
      subcommand: "run",
      args: ["--verify"],
      isExplicitSubcommand: false,
    })).toEqual({
      valid: false,
      errorMessage: "Rundown task requires a source operand before any flags (example: rundown: Child.md --verify).",
    });
  });

  it("returns a clear error for unsupported delegated explicit subcommands", () => {
    expect(validateDelegatedRundownInvocation({
      subcommand: "run",
      args: ["Child.md"],
      isExplicitSubcommand: true,
      unsupportedSubcommand: "plan",
    })).toEqual({
      valid: false,
      errorMessage: "Unsupported delegated rundown subcommand `plan`. Supported inline subcommands: run, make.",
    });
  });

  it("validates delegated make invocation operand pairs", () => {
    expect(validateDelegatedRundownInvocation({
      subcommand: "make",
      args: ["Scan count 3 by default", "3. Scan.md"],
      isExplicitSubcommand: true,
    })).toEqual({ valid: true });

    expect(validateDelegatedRundownInvocation({
      subcommand: "make",
      args: ["Scan count 3 by default"],
      isExplicitSubcommand: true,
    })).toEqual({
      valid: false,
      errorMessage: "Rundown task delegated `make` requires <seed-text> and <markdown-file> operands (example: rundown: make \"Feature text\" \"3. Feature.md\").",
    });

    expect(validateDelegatedRundownInvocation({
      subcommand: "make",
      args: ["--dry-run", "3. Scan.md"],
      isExplicitSubcommand: true,
    })).toEqual({
      valid: false,
      errorMessage: "Rundown task delegated `make` requires <seed-text> and <markdown-file> operands (example: rundown: make \"Feature text\" \"3. Feature.md\").",
    });

    expect(validateDelegatedRundownInvocation({
      subcommand: "make",
      args: ["Feature text", "feature.txt"],
      isExplicitSubcommand: true,
    })).toEqual({
      valid: false,
      errorMessage: "Rundown task delegated `make` requires a Markdown <markdown-file> operand (.md or .markdown).",
    });

    expect(validateDelegatedRundownInvocation({
      subcommand: "make",
      args: ["Feature text", "3. Feature.md", "--", "--scan-count", "3"],
      isExplicitSubcommand: true,
    })).toEqual({ valid: true });
  });

  it("validates and parses raw rundown task args in one step", () => {
    expect(validateRundownTaskArgs("run Child.md --verify")).toEqual({ valid: true });
    expect(validateRundownTaskArgs("Child.md --verify")).toEqual({ valid: true });
    expect(validateRundownTaskArgs("run Child.md -- --scan-count 3")).toEqual({ valid: true });
    expect(validateRundownTaskArgs("make \"Feature text\" \"17. Add do.md\"")).toEqual({ valid: true });
    expect(validateRundownTaskArgs("run --verify")).toEqual({
      valid: false,
      errorMessage: "Rundown task requires a source operand before any flags (example: rundown: run Child.md --verify).",
    });
    expect(validateRundownTaskArgs("run -- --scan-count 3")).toEqual({
      valid: false,
      errorMessage: "Rundown task requires a source operand before any flags (example: rundown: run Child.md --verify).",
    });
    expect(validateRundownTaskArgs("make \"Feature\" --dry-run")).toEqual({
      valid: false,
      errorMessage: "Rundown task delegated `make` requires <seed-text> and <markdown-file> operands (example: rundown: make \"Feature text\" \"3. Feature.md\").",
    });
    expect(validateRundownTaskArgs("plan Child.md")).toEqual({
      valid: false,
      errorMessage: "Unsupported delegated rundown subcommand `plan`. Supported inline subcommands: run, make.",
    });
  });
});
