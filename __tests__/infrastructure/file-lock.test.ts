import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLockError } from "../../src/domain/ports/file-lock.js";
import { createLockfileFileLock, lockfilePathFor } from "../../src/infrastructure/file-lock.js";

describe("createLockfileFileLock.acquire", () => {
  let tempDir = "";
  let sourcePath = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-file-lock-"));
    sourcePath = path.join(tempDir, "TODO.md");
    fs.writeFileSync(sourcePath, "- [ ] task\n", "utf-8");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a lock atomically and fails when another lock exists", () => {
    const lockDir = path.join(tempDir, ".rundown");
    expect(fs.existsSync(lockDir)).toBe(false);

    const first = createLockfileFileLock();
    first.acquire(sourcePath, { command: "run" });

    const lockPath = lockfilePathFor(sourcePath);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      pid: number;
      command: string;
      startedAt: string;
      file: string;
    };

    expect(payload.pid).toBe(process.pid);
    expect(payload.command).toBe("run");
    expect(payload.startedAt).toEqual(expect.any(String));
    expect(payload.file).toBe(path.resolve(sourcePath));

    const second = createLockfileFileLock();
    expect(() => second.acquire(sourcePath, { command: "plan" })).toThrow(FileLockError);
  });

  it("writes lock file as valid JSON with expected fields", () => {
    const lock = createLockfileFileLock();
    lock.acquire(sourcePath, { command: "run" });

    const lockPath = lockfilePathFor(sourcePath);
    const content = fs.readFileSync(lockPath, "utf-8");

    expect(() => JSON.parse(content)).not.toThrow();

    const payload = JSON.parse(content) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["command", "file", "pid", "startedAt"]);
    expect(payload.pid).toBe(process.pid);
    expect(payload.command).toBe("run");
    expect(typeof payload.startedAt).toBe("string");
    expect(payload.file).toBe(path.resolve(sourcePath));
  });

  it("throws FileLockError with holder details on double-acquire", () => {
    const first = createLockfileFileLock();
    first.acquire(sourcePath, { command: "run" });

    const lockPath = lockfilePathFor(sourcePath);
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      pid: number;
      command: string;
      startedAt: string;
      file: string;
    };

    const second = createLockfileFileLock();

    try {
      second.acquire(sourcePath, { command: "plan" });
      throw new Error("expected acquire to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FileLockError);
      const lockError = error as FileLockError;
      expect(lockError.filePath).toBe(path.resolve(sourcePath));
      expect(lockError.holder).toEqual({
        pid: payload.pid,
        command: payload.command,
        startTime: payload.startedAt,
      });
    }
  });

  it("replaces a stale lock when holder pid is no longer running", () => {
    const stalePid = 424242;
    const lockPath = lockfilePathFor(sourcePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: stalePid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: path.resolve(sourcePath),
    }), "utf-8");

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number | string, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid && signal === 0) {
        const error = new Error("ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }

      return originalKill(pid as number, signal as never);
    }) as typeof process.kill);

    const lock = createLockfileFileLock();
    lock.acquire(sourcePath, { command: "plan" });

    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      pid: number;
      command: string;
      startedAt: string;
      file: string;
    };
    expect(payload.pid).toBe(process.pid);
    expect(payload.command).toBe("plan");
  });

  it("throws FileLockError with holder details when lock holder is alive", () => {
    const lockPath = lockfilePathFor(sourcePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: path.resolve(sourcePath),
    }), "utf-8");

    const lock = createLockfileFileLock();

    try {
      lock.acquire(sourcePath, { command: "plan" });
      throw new Error("expected acquire to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FileLockError);
      const lockError = error as FileLockError;
      expect(lockError.filePath).toBe(path.resolve(sourcePath));
      expect(lockError.holder).toEqual({
        pid: process.pid,
        command: "run",
        startTime: "2026-01-01T00:00:00.000Z",
      });
    }
  });

  it("release deletes lockfile when owned by current pid", () => {
    const lock = createLockfileFileLock();
    lock.acquire(sourcePath, { command: "run" });

    const lockPath = lockfilePathFor(sourcePath);
    const unlinkSyncSpy = vi.spyOn(fs, "unlinkSync");
    expect(fs.existsSync(lockPath)).toBe(true);

    lock.release(sourcePath);
    expect(unlinkSyncSpy).toHaveBeenCalledWith(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("release keeps lockfile when ownership changed to different pid", () => {
    const lock = createLockfileFileLock();
    lock.acquire(sourcePath, { command: "run" });

    const lockPath = lockfilePathFor(sourcePath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 1,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: path.resolve(sourcePath),
    }), "utf-8");

    lock.release(sourcePath);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("release is idempotent and does not throw when lock is not held", () => {
    const lock = createLockfileFileLock();

    expect(() => lock.release(sourcePath)).not.toThrow();

    lock.acquire(sourcePath, { command: "run" });
    lock.release(sourcePath);

    expect(() => lock.release(sourcePath)).not.toThrow();
  });

  it("forceRelease breaks lock regardless of ownership", () => {
    const lockPath = lockfilePathFor(sourcePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 1,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: path.resolve(sourcePath),
    }), "utf-8");

    const lock = createLockfileFileLock();
    expect(fs.existsSync(lockPath)).toBe(true);

    lock.forceRelease(sourcePath);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(lock.isLocked(sourcePath)).toBe(false);
  });

  it("satisfies FileLock contract: acquire -> isLocked -> release -> not locked", () => {
    const lock = createLockfileFileLock();

    expect(lock.isLocked(sourcePath)).toBe(false);

    lock.acquire(sourcePath, { command: "run" });
    expect(lock.isLocked(sourcePath)).toBe(true);

    lock.release(sourcePath);
    expect(lock.isLocked(sourcePath)).toBe(false);
  });

  it("releaseAll releases every lock held by instance across multiple source files", () => {
    const lock = createLockfileFileLock();
    const secondDir = path.join(tempDir, "second");
    fs.mkdirSync(secondDir, { recursive: true });
    const secondPath = path.join(secondDir, "TODO.md");
    fs.writeFileSync(secondPath, "- [ ] second\n", "utf-8");

    lock.acquire(sourcePath, { command: "run" });
    lock.acquire(secondPath, { command: "run" });

    const firstLockPath = lockfilePathFor(sourcePath);
    const secondLockPath = lockfilePathFor(secondPath);
    const unlinkSyncSpy = vi.spyOn(fs, "unlinkSync");
    expect(fs.existsSync(firstLockPath)).toBe(true);
    expect(fs.existsSync(secondLockPath)).toBe(true);

    lock.releaseAll();

    expect(unlinkSyncSpy).toHaveBeenCalledWith(firstLockPath);
    expect(unlinkSyncSpy).toHaveBeenCalledWith(secondLockPath);
    expect(fs.existsSync(firstLockPath)).toBe(false);
    expect(fs.existsSync(secondLockPath)).toBe(false);
    expect(lock.isLocked(sourcePath)).toBe(false);
    expect(lock.isLocked(secondPath)).toBe(false);
  });

  it("reports a clear error when lockfile cannot be created on a read-only filesystem", () => {
    const lock = createLockfileFileLock();
    const lockPath = lockfilePathFor(sourcePath);

    vi.spyOn(fs, "mkdirSync").mockImplementation((() => {
      const error = new Error("EROFS") as NodeJS.ErrnoException;
      error.code = "EROFS";
      throw error;
    }) as typeof fs.mkdirSync);

    expect(() => lock.acquire(sourcePath, { command: "run" })).toThrowError(
      new RegExp(`Unable to prepare lock directory for source file: ${escapeRegex(path.resolve(sourcePath))}`),
    );

    try {
      lock.acquire(sourcePath, { command: "run" });
      throw new Error("expected acquire to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const lockError = error as Error;
      expect(lockError.name).toBe("FileLockIoError");
      expect(lockError.message).toContain("code: EROFS");
      expect(lockError.message).toContain(path.resolve(sourcePath));
      expect(lockError.message).toContain(lockPath);
      expect(lockError.message).toContain("read-only");
    }
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
