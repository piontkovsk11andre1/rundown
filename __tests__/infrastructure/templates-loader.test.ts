import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_DISCUSS_FINISHED_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../../src/domain/defaults.js";
import { CONFIG_DIR_NAME } from "../../src/domain/ports/config-dir-port.js";
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

function writeTemplate(configDir: string, fileName: string, content: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, fileName), content, "utf-8");
}

describe("loadProjectTemplates", () => {
  it("loads new execute/verify/repair filenames", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "execute.md", "EXECUTE");
    writeTemplate(configDir, "discuss.md", "DISCUSS");
    writeTemplate(configDir, "discuss-finished.md", "DISCUSS FINISHED");
    writeTemplate(configDir, "verify.md", "VERIFY");
    writeTemplate(configDir, "repair.md", "REPAIR");
    writeTemplate(configDir, "plan.md", "PLAN");
    writeTemplate(configDir, "research.md", "RESEARCH");

    const templates = loadProjectTemplates(configDir);

    expect(templates.task).toBe("EXECUTE");
    expect(templates.discuss).toBe("DISCUSS");
    expect(templates.discussFinished).toBe("DISCUSS FINISHED");
    expect(templates.verify).toBe("VERIFY");
    expect(templates.repair).toBe("REPAIR");
    expect(templates.plan).toBe("PLAN");
    expect(templates.research).toBe("RESEARCH");
    expect(templates.trace).toBe(DEFAULT_TRACE_TEMPLATE);
  });

  it("falls back to defaults when templates are missing", () => {
    makeTempDir();

    const templates = loadProjectTemplates();

    expect(templates.task).toBe(DEFAULT_TASK_TEMPLATE);
    expect(templates.discuss).toBe(DEFAULT_DISCUSS_TEMPLATE);
    expect(templates.discussFinished).toBe(DEFAULT_DISCUSS_FINISHED_TEMPLATE);
    expect(templates.verify).toBe(DEFAULT_VERIFY_TEMPLATE);
    expect(templates.repair).toBe(DEFAULT_REPAIR_TEMPLATE);
    expect(templates.plan).toBe(DEFAULT_PLAN_TEMPLATE);
    expect(templates.research).toBe(DEFAULT_RESEARCH_TEMPLATE);
    expect(templates.trace).toBe(DEFAULT_TRACE_TEMPLATE);
  });

  it("loads explicit execute/verify/repair files with precedence", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "execute.md", "NEW EXECUTE");
    writeTemplate(configDir, "verify.md", "NEW VERIFY");
    writeTemplate(configDir, "repair.md", "NEW REPAIR");

    const templates = loadProjectTemplates(configDir);

    expect(templates.task).toBe("NEW EXECUTE");
    expect(templates.discuss).toBe(DEFAULT_DISCUSS_TEMPLATE);
    expect(templates.discussFinished).toBe(DEFAULT_DISCUSS_FINISHED_TEMPLATE);
    expect(templates.verify).toBe("NEW VERIFY");
    expect(templates.repair).toBe("NEW REPAIR");
    expect(templates.plan).toBe(DEFAULT_PLAN_TEMPLATE);
    expect(templates.research).toBe(DEFAULT_RESEARCH_TEMPLATE);
    expect(templates.trace).toBe(DEFAULT_TRACE_TEMPLATE);
  });

  it("loads trace.md when present", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "trace.md", "TRACE");

    const templates = loadProjectTemplates(configDir);

    expect(templates.trace).toBe("TRACE");
  });

  it("loads discuss.md when present", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "discuss.md", "DISCUSS");

    const templates = loadProjectTemplates(configDir);

    expect(templates.discuss).toBe("DISCUSS");
  });

  it("loads discuss-finished.md when present", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "discuss-finished.md", "DISCUSS FINISHED");

    const templates = loadProjectTemplates(configDir);

    expect(templates.discussFinished).toBe("DISCUSS FINISHED");
  });

  it("loads research.md when present", () => {
    const cwd = makeTempDir();
    const configDir = path.join(cwd, CONFIG_DIR_NAME);
    writeTemplate(configDir, "research.md", "RESEARCH");

    const templates = loadProjectTemplates(configDir);

    expect(templates.research).toBe("RESEARCH");
  });
});
