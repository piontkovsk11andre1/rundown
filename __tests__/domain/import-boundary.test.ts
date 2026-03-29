import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOMAIN_DIR = path.resolve("src/domain");
const DOMAIN_TRACE_FILES = [
  "trace.ts",
  "trace-parser.ts",
  "worker-output-parser.ts",
  "ports/trace-writer-port.ts",
];

const DOMAIN_DISCUSS_FILES = [
  "defaults.ts",
  "trace.ts",
  "ports/artifact-store.ts",
  "ports/worker-executor-port.ts",
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

function isDisallowedDomainImport(specifier: string): boolean {
  return /^((\.\.\/)+)(application|infrastructure|presentation)\//.test(specifier);
}

describe("domain import boundary", () => {
  it("includes trace domain files in boundary scan", () => {
    const files = collectTypeScriptFiles(DOMAIN_DIR);

    for (const relativePath of DOMAIN_TRACE_FILES) {
      const absolutePath = path.join(DOMAIN_DIR, relativePath);

      if (fs.existsSync(absolutePath)) {
        expect(files).toContain(absolutePath);
      }
    }
  });

  it("includes discuss domain files in boundary scan", () => {
    const files = collectTypeScriptFiles(DOMAIN_DIR);

    for (const relativePath of DOMAIN_DISCUSS_FILES) {
      const absolutePath = path.join(DOMAIN_DIR, relativePath);

      if (fs.existsSync(absolutePath)) {
        expect(files).toContain(absolutePath);
      }
    }
  });

  it("keeps domain imports isolated from outer layers", () => {
    const files = collectTypeScriptFiles(DOMAIN_DIR);
    const violations: string[] = [];

    for (const filePath of files) {
      const imports = readImportSpecifiers(filePath);

      for (const specifier of imports) {
        if (isDisallowedDomainImport(specifier)) {
          const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
          violations.push(`${relative} imports disallowed module: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
