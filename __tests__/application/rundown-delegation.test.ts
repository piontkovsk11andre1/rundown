import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDelegatedRundownArgs,
  delegatedTargetExists,
  normalizeLegacyRetryArgs,
  parseRundownTaskArgs,
  resolveDelegatedRundownTargetArg,
} from "../../src/application/rundown-delegation.js";
import { createInMemoryFileSystem } from "./run-task-test-helpers.js";

describe("rundown-delegation", () => {
  it("parses args and normalizes --retries variants", () => {
    expect(parseRundownTaskArgs("--retries 3 --verify")).toEqual(["--repair-attempts", "3", "--verify"]);
    expect(normalizeLegacyRetryArgs(["--retries=2", "--no-verify"])).toEqual(["--repair-attempts=2", "--no-verify"]);
  });

  it("inherits parent options when delegated args omit them", () => {
    const delegated = buildDelegatedRundownArgs(["docs/tasks.md"], {
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
    const delegated = buildDelegatedRundownArgs(["docs/tasks.md", "--no-show-agent-output"], {
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
});
