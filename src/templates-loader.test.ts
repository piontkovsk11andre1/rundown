import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectTemplates } from "./templates-loader.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-templates-"));
  tempDirs.push(dir);
  return dir;
}

function writeTemplate(baseDir: string, fileName: string, content: string): void {
  const configDir = path.join(baseDir, ".md-todo");
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
    expect(templates.validate).toBe("VERIFY");
    expect(templates.correct).toBe("REPAIR");
    expect(templates.plan).toBe("PLAN");
  });

  it("falls back to legacy task/validate/correct aliases", () => {
    const cwd = makeTempDir();
    writeTemplate(cwd, "task.md", "LEGACY TASK");
    writeTemplate(cwd, "validate.md", "LEGACY VALIDATE");
    writeTemplate(cwd, "correct.md", "LEGACY CORRECT");

    const templates = loadProjectTemplates(cwd);

    expect(templates.task).toBe("LEGACY TASK");
    expect(templates.validate).toBe("LEGACY VALIDATE");
    expect(templates.correct).toBe("LEGACY CORRECT");
  });

  it("prefers new filenames when both new and legacy files exist", () => {
    const cwd = makeTempDir();
    writeTemplate(cwd, "execute.md", "NEW EXECUTE");
    writeTemplate(cwd, "task.md", "OLD TASK");
    writeTemplate(cwd, "verify.md", "NEW VERIFY");
    writeTemplate(cwd, "validate.md", "OLD VALIDATE");
    writeTemplate(cwd, "repair.md", "NEW REPAIR");
    writeTemplate(cwd, "correct.md", "OLD CORRECT");

    const templates = loadProjectTemplates(cwd);

    expect(templates.task).toBe("NEW EXECUTE");
    expect(templates.validate).toBe("NEW VERIFY");
    expect(templates.correct).toBe("NEW REPAIR");
  });
});
