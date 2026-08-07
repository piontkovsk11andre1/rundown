import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactVerificationStore } from "../../../src/infrastructure/adapters/artifact-verification-store.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
} from "../../../src/infrastructure/runtime-artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createArtifactVerificationStore", () => {
  it("reads and writes verificationResult on latest verify phase metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifact-verification-"));
    tempDirs.push(root);

    const runsRoot = path.join(root, ".rundown", "runs");
    const runOlder = path.join(runsRoot, "run-20260328T100000000Z-aaaa1111");
    const runLatest = path.join(runsRoot, "run-20260328T110000000Z-bbbb2222");
    const olderVerifyDir = path.join(runOlder, "01-verify");
    const latestVerifyDir = path.join(runLatest, "01-verify");
    fs.mkdirSync(olderVerifyDir, { recursive: true });
    fs.mkdirSync(latestVerifyDir, { recursive: true });

    const task = {
      file: path.join(root, "tasks.md"),
      index: 2,
    };
    fs.writeFileSync(task.file, "- [ ] Task\n", "utf-8");

    fs.writeFileSync(path.join(olderVerifyDir, "metadata.json"), JSON.stringify({
      phase: "verify",
      task,
      verificationResult: "older failure",
    }, null, 2));
    fs.writeFileSync(path.join(latestVerifyDir, "metadata.json"), JSON.stringify({
      phase: "verify",
      task,
      verificationResult: "  current failure  ",
    }, null, 2));

    const store = createArtifactVerificationStore(path.join(root, ".rundown"));

    expect(store.read(task as never)).toBe("current failure");

    store.write(task as never, "  rewritten reason\n");

    const latestMetadata = JSON.parse(
      fs.readFileSync(path.join(latestVerifyDir, "metadata.json"), "utf-8"),
    ) as { verificationResult?: string };
    const olderMetadata = JSON.parse(
      fs.readFileSync(path.join(olderVerifyDir, "metadata.json"), "utf-8"),
    ) as { verificationResult?: string };

    expect(latestMetadata.verificationResult).toBe("rewritten reason");
    expect(olderMetadata.verificationResult).toBe("older failure");
  });

  it("returns null when no verify-phase artifact exists and remove does not throw", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifact-verification-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 0,
    };

    const store = createArtifactVerificationStore(path.join(root, ".rundown"));

    expect(store.read(task as never)).toBeNull();
    expect(() => store.write(task as never, "missing context")).not.toThrow();
    expect(() => store.remove(task as never)).not.toThrow();
  });

  it("falls back to in-memory results when no active artifact context exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifact-verification-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 0,
    };
    fs.writeFileSync(task.file, "- [ ] Task\n", "utf-8");

    const store = createArtifactVerificationStore(path.join(root, ".rundown"));

    store.write(task as never, "  missing schema field  ");
    expect(store.read(task as never)).toBe("missing schema field");

    store.remove(task as never);
    expect(store.read(task as never)).toBeNull();
  });

  it("keeps verification results only while non-preserved artifacts exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifact-verification-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 0,
      text: "Ship release",
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 14,
      checked: false,
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };
    fs.writeFileSync(task.file, "- [ ] Ship release\n", "utf-8");

    const artifactContext = createRuntimeArtifactsContext({
      cwd: root,
      commandName: "run",
      task: {
        text: task.text,
        file: task.file,
        line: task.line,
        index: task.index,
        source: "tasks.md",
      },
      keepArtifacts: false,
    });

    const verifyPhase = beginRuntimePhase(artifactContext, {
      phase: "verify",
      prompt: "verify",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });
    completeRuntimePhase(verifyPhase, {
      exitCode: 1,
      stdout: "missing test coverage",
      stderr: "",
      outputCaptured: true,
    });

    const store = createArtifactVerificationStore(path.join(root, ".rundown"));
    store.write(task as never, "missing test coverage");

    expect(store.read(task as never)).toBe("missing test coverage");

    finalizeRuntimeArtifacts(artifactContext, { status: "verification-failed", preserve: false });

    expect(fs.existsSync(artifactContext.rootDir)).toBe(false);
    expect(store.read(task as never)).toBeNull();
  });

  it("retains verification results when artifacts are preserved", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifact-verification-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 1,
      text: "Ship release",
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 14,
      checked: false,
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };
    fs.writeFileSync(task.file, "- [ ] Ship release\n", "utf-8");

    const artifactContext = createRuntimeArtifactsContext({
      cwd: root,
      commandName: "run",
      task: {
        text: task.text,
        file: task.file,
        line: task.line,
        index: task.index,
        source: "tasks.md",
      },
      keepArtifacts: true,
    });

    const verifyPhase = beginRuntimePhase(artifactContext, {
      phase: "verify",
      prompt: "verify",
      command: ["worker"],
      mode: "wait",
      transport: "file",
    });
    completeRuntimePhase(verifyPhase, {
      exitCode: 1,
      stdout: "schema mismatch",
      stderr: "",
      outputCaptured: true,
    });

    const store = createArtifactVerificationStore(path.join(root, ".rundown"));
    store.write(task as never, "schema mismatch");

    finalizeRuntimeArtifacts(artifactContext, { status: "verification-failed", preserve: true });

    expect(fs.existsSync(artifactContext.rootDir)).toBe(true);
    expect(store.read(task as never)).toBe("schema mismatch");
  });
});
