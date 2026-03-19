import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APPLICATION_DIR = path.resolve("src/application");
const USE_CASE_FILES = [
  "run-task.ts",
  "plan-task.ts",
  "next-task.ts",
  "list-tasks.ts",
];

function readImportSpecifiers(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");
  return Array
    .from(source.matchAll(/from\s+["']([^"']+)["']/g))
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

describe("application import boundary", () => {
  it("keeps application imports pointed inward", () => {
    const files = fs.readdirSync(APPLICATION_DIR)
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => path.join(APPLICATION_DIR, entry));

    const violations: string[] = [];

    for (const filePath of files) {
      const imports = readImportSpecifiers(filePath);

      for (const specifier of imports) {
        if (specifier.startsWith("node:")) {
          continue;
        }

        if (specifier.startsWith("./")) {
          continue;
        }

        if (specifier.startsWith("../domain/")) {
          continue;
        }

        if (specifier.startsWith("../")) {
          const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
          violations.push(`${relative} imports disallowed module: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  for (const useCaseFile of USE_CASE_FILES) {
    it(`${useCaseFile} has no direct infrastructure imports`, () => {
      const filePath = path.join(APPLICATION_DIR, useCaseFile);
      const imports = readImportSpecifiers(filePath);
      const infraImports = imports.filter((specifier) => specifier.startsWith("../infrastructure/"));

      expect(infraImports).toEqual([]);
    });
  }
});
