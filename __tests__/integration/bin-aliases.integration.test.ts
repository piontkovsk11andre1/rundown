import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  bin?: Record<string, string>;
}

interface PackageLockRoot {
  bin?: Record<string, string>;
}

interface PackageLockFile {
  packages?: Record<string, PackageLockRoot>;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXPECTED_CLI_ENTRYPOINT = "dist/cli.js";
const EXPECTED_BIN_NAMES = ["rundown", "rndn"] as const;

describe("packaged bin aliases", () => {
  it("exposes rndn and rundown in package.json for npm/pnpm/yarn/bun shims", () => {
    const packageJsonPath = path.join(REPO_ROOT, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageManifest;
    const bin = packageJson.bin ?? {};

    for (const name of EXPECTED_BIN_NAMES) {
      expect(bin[name]).toBe(EXPECTED_CLI_ENTRYPOINT);
    }
  });

  it("keeps lockfile root bin metadata aligned for rndn and rundown", () => {
    const packageLockPath = path.join(REPO_ROOT, "package-lock.json");
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf-8")) as PackageLockFile;
    const rootBin = packageLock.packages?.[""]?.bin ?? {};

    for (const name of EXPECTED_BIN_NAMES) {
      expect(rootBin[name]).toBe(EXPECTED_CLI_ENTRYPOINT);
    }
  });
});
