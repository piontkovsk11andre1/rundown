import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATION_ROOT = path.resolve(TEST_DIR, "..", "..");
const DOMAIN_DIR = path.join(IMPLEMENTATION_ROOT, "src", "domain");
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

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (match[1]) {
      specifiers.add(match[1]);
    }
  }

  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    if (match[1]) {
      specifiers.add(match[1]);
    }
  }

  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

function readImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");
  return extractImportSpecifiers(source);
}

function isDisallowedDomainImport(specifier: string): boolean {
  return /^((\.\.\/)+)(application|infrastructure|presentation)\//.test(specifier);
}

describe("domain import boundary", () => {
  it("collects from, side-effect, and dynamic import specifiers", () => {
    const source = [
      'import { x } from "../domain/x";',
      'import "../../infrastructure/y";',
      'const z = await import("../../../presentation/z");',
      'import { y } from "../domain/x";',
    ].join("\n");

    expect(extractImportSpecifiers(source)).toEqual([
      "../domain/x",
      "../../infrastructure/y",
      "../../../presentation/z",
    ]);
  });

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
