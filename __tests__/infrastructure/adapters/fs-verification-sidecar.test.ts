import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsVerificationSidecar } from "../../../src/infrastructure/adapters/fs-verification-sidecar.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createFsVerificationSidecar", () => {
  it("builds the validation file path, reads trimmed contents, and removes the file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-sidecar-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 2,
    };

    const sidecar = createFsVerificationSidecar();
    const filePath = sidecar.filePath(task as never);
    fs.writeFileSync(filePath, "  OK\n", "utf-8");

    expect(filePath).toBe(`${task.file}.2.validation`);
    expect(sidecar.read(task as never)).toBe("OK");

    sidecar.remove(task as never);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns null for missing files and ignores missing removes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-sidecar-"));
    tempDirs.push(root);

    const task = {
      file: path.join(root, "tasks.md"),
      index: 0,
    };

    const sidecar = createFsVerificationSidecar();

    expect(sidecar.read(task as never)).toBeNull();
    expect(() => sidecar.remove(task as never)).not.toThrow();
  });
});
