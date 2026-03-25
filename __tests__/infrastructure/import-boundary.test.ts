import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INFRASTRUCTURE_DIR = path.resolve("src/infrastructure");

function collectTypeScriptFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function readImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");
  return Array
    .from(source.matchAll(/from\s+["']([^"']+)["']/g))
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function isDisallowedInfrastructureImport(specifier: string): boolean {
  return /^((\.\.\/)+)application\//.test(specifier);
}

describe("infrastructure import boundary", () => {
  it("prevents infrastructure from depending on application", () => {
    const files = collectTypeScriptFiles(INFRASTRUCTURE_DIR);
    const violations: string[] = [];

    for (const filePath of files) {
      const imports = readImportSpecifiers(filePath);

      for (const specifier of imports) {
        if (isDisallowedInfrastructureImport(specifier)) {
          const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
          violations.push(`${relative} imports disallowed module: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
