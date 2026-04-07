import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-memory-validate-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}> {
  const previousCwd = process.cwd();
  const previousEnv = process.env.RUNDOWN_DISABLE_AUTO_PARSE;
  const previousTestModeEnv = process.env.RUNDOWN_TEST_MODE;

  process.chdir(cwd);
  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.resetModules();

  const logs: string[] = [];
  const errors: string[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map((value) => String(value)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map((value) => String(value)).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw {
      __cliExit: true,
      exitCode: typeof code === "number" ? code : Number(code ?? 0),
    };
  }) as typeof process.exit);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(args);
    return { code: 0, logs, errors, stdoutWrites, stderrWrites };
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "__cliExit" in error
      && (error as { __cliExit?: unknown }).__cliExit === true
    ) {
      return {
        code: (error as { exitCode: number }).exitCode,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    if (
      typeof error === "object"
      && error !== null
      && "exitCode" in error
      && typeof (error as { exitCode?: unknown }).exitCode === "number"
    ) {
      return {
        code: (error as { exitCode: number }).exitCode,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    const message = String(error);
    const match = message.match(/CLI exited with code (\d+)/);
    if (match) {
      return {
        code: Number(match[1]),
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    errors.push(String(error));
    return { code: 1, logs, errors, stdoutWrites, stderrWrites };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.chdir(previousCwd);

    if (previousEnv === undefined) {
      delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    } else {
      process.env.RUNDOWN_DISABLE_AUTO_PARSE = previousEnv;
    }

    if (previousTestModeEnv === undefined) {
      delete process.env.RUNDOWN_TEST_MODE;
    } else {
      process.env.RUNDOWN_TEST_MODE = previousTestModeEnv;
    }
  }
}

describe.sequential("memory CLI integration", () => {
  it("memory-view --help lists options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["memory-view", "--help"], workspace);

    expect(result.code, JSON.stringify(result)).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n").replace(/\s+/g, " ");
    expect(helpOutput).toContain("memory-view [options] <source>");
    expect(helpOutput).toContain("--json");
    expect(helpOutput).toContain("--summary");
    expect(helpOutput).toContain("--all");
  });

  it("memory-clean --help lists options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["memory-clean", "--help"], workspace);

    expect(result.code, JSON.stringify(result)).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n").replace(/\s+/g, " ");
    expect(helpOutput).toContain("memory-clean [options] <source>");
    expect(helpOutput).toContain("--dry-run");
    expect(helpOutput).toContain("--orphans");
    expect(helpOutput).toContain("--outdated");
    expect(helpOutput).toContain("--older-than <duration>");
    expect(helpOutput).toContain("--all");
    expect(helpOutput).toContain("--force");
  });

  it("memory-validate --help lists options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["memory-validate", "--help"], workspace);

    expect(result.code, JSON.stringify(result)).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n").replace(/\s+/g, " ");
    expect(helpOutput).toContain("memory-validate [options] <source>");
    expect(helpOutput).toContain("--fix");
    expect(helpOutput).toContain("--json");
  });

  it("memory-view prints entries and exits 0 when memory exists", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const memoryDir = path.join(workspace, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [ ] memory: capture context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, ["Captured release context", "---", "Owner: platform"].join("\n"), "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Owner: platform",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 2,
        lastPrefix: "memory",
      },
    }, null, 2), "utf-8");

    const result = await runCli(["memory-view", "roadmap.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes(sourcePath))).toBe(true);
    expect(result.logs.some((line) => line.includes("entries (2)"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Captured release context"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Owner: platform"))).toBe(true);
  });

  it("memory-view exits 1 when no memory exists", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Ship release\n", "utf-8");

    const result = await runCli(["memory-view", "roadmap.md"], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("No memory entries found."))).toBe(true);
  });

  it("memory-validate reports issues and exits 1", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const memoryDir = path.join(workspace, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [ ] memory: capture context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Wrong summary",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 9,
        origin: {
          taskText: "memory: capture context",
          taskLine: 1,
        },
      },
    }, null, 2), "utf-8");

    const result = await runCli(["memory-validate", "roadmap.md"], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("entry-count-mismatch"))).toBe(true);
    expect(result.logs.some((line) => line.includes("summary-drift"))).toBe(true);
    expect(result.logs.some((line) => line.includes("origin-task-unchecked"))).toBe(true);
  });

  it("memory-clean --dry-run reports plan without deleting files", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const memoryDir = path.join(workspace, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2020-01-01T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const result = await runCli(["memory-clean", "roadmap.md", "--dry-run", "--all", "--force"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Cleanup plan:"))).toBe(true);
    expect(result.logs.some((line) => line.includes(memoryFilePath))).toBe(true);
    expect(result.logs.some((line) => line.includes("Dry run:"))).toBe(true);
    expect(fs.existsSync(memoryFilePath)).toBe(true);
    expect(fs.existsSync(memoryIndexPath)).toBe(true);
  });

  it("memory-clean removes orphan memory files and prunes index entries", async () => {
    const workspace = makeTempWorkspace();
    const liveSourcePath = path.join(workspace, "roadmap.md");
    const orphanSourcePath = path.join(workspace, "removed.md");
    const memoryDir = path.join(workspace, ".rundown");
    const liveMemoryPath = path.join(memoryDir, "roadmap.md.memory.md");
    const orphanMemoryPath = path.join(memoryDir, "removed.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(liveSourcePath, "- [x] memory: keep context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(liveMemoryPath, "Live context\n", "utf-8");
    fs.writeFileSync(orphanMemoryPath, "Orphaned context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(liveSourcePath)]: {
        summary: "Live context",
        updatedAt: new Date().toISOString(),
        entryCount: 1,
      },
      [path.resolve(orphanSourcePath)]: {
        summary: "Orphaned context",
        updatedAt: "2025-01-01T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const result = await runCli(["memory-clean", "roadmap.md", "--orphans", "--force"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Removed 1 memory file(s)."))).toBe(true);
    expect(fs.existsSync(orphanMemoryPath)).toBe(false);
    expect(fs.existsSync(liveMemoryPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, unknown>;
    expect(index[path.resolve(orphanSourcePath)]).toBeUndefined();
    expect(index[path.resolve(liveSourcePath)]).toBeDefined();
  });
});
