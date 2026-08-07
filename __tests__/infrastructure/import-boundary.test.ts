import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_ROOT = path.resolve(TEST_DIR, "..", "..");
const INFRASTRUCTURE_DIR = path.join(IMPLEMENTATION_ROOT, "src", "infrastructure");
const INFRASTRUCTURE_TRACE_ADAPTER_FILES = [
  "adapters/jsonl-trace-writer.ts",
  "adapters/noop-trace-writer.ts",
];

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
  it("includes trace adapter files in boundary scan", () => {
    const files = collectTypeScriptFiles(INFRASTRUCTURE_DIR);

    for (const relativePath of INFRASTRUCTURE_TRACE_ADAPTER_FILES) {
      const absolutePath = path.join(INFRASTRUCTURE_DIR, relativePath);

      if (fs.existsSync(absolutePath)) {
        expect(files).toContain(absolutePath);
      }
    }
  });

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
