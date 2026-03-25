import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../../src/domain/defaults.js";
import { loadProjectTemplates } from "../../src/infrastructure/templates-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-templates-"));
  tempDirs.push(dir);
  return dir;
}

function writeTemplate(baseDir: string, fileName: string, content: string): void {
  const configDir = path.join(baseDir, ".rundown");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, fileName), content, "utf-8");
}

describe("loadProjectTemplates", () => {
  it("loads new execute/verify/repair filenames", () => {
    const cwd = makeTempDir();
    writeTemplate(cwd, "execute.md", "EXECUTE");
    writeTemplate(cwd, "verify.md", "VERIFY");
    writeTemplate(cwd, "repair.md", "REPAIR");
    writeTemplate(cwd, "plan.md", "PLAN");

    const templates = loadProjectTemplates(cwd);

    expect(templates.task).toBe("EXECUTE");
    expect(templates.verify).toBe("VERIFY");
    expect(templates.repair).toBe("REPAIR");
    expect(templates.plan).toBe("PLAN");
  });

  it("falls back to defaults when templates are missing", () => {
    const cwd = makeTempDir();

    const templates = loadProjectTemplates(cwd);

    expect(templates.task).toBe(DEFAULT_TASK_TEMPLATE);
    expect(templates.verify).toBe(DEFAULT_VERIFY_TEMPLATE);
    expect(templates.repair).toBe(DEFAULT_REPAIR_TEMPLATE);
  });

  it("loads explicit execute/verify/repair files with precedence", () => {
    const cwd = makeTempDir();
    writeTemplate(cwd, "execute.md", "NEW EXECUTE");
    writeTemplate(cwd, "verify.md", "NEW VERIFY");
    writeTemplate(cwd, "repair.md", "NEW REPAIR");

    const templates = loadProjectTemplates(cwd);

    expect(templates.task).toBe("NEW EXECUTE");
    expect(templates.verify).toBe("NEW VERIFY");
    expect(templates.repair).toBe("NEW REPAIR");
  });
});
