import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadProjectTemplatesFromPorts } from "../../../src/application/project-templates.js";
import { DEFAULT_PLAN_LOOP_TEMPLATE } from "../../../src/domain/defaults.js";
import type { TemplateLoader } from "../../../src/domain/ports/index.js";

describe("project-templates", () => {
  it("falls back plan-loop.md to default when override is missing", () => {
    const configDir = "/workspace/.rundown";
    const templateLoader: TemplateLoader = {
      load: vi.fn((filePath: string) => {
        if (filePath.endsWith("plan.md")) {
          return "PLAN";
        }
        if (filePath.endsWith("plan-loop.md")) {
          return null;
        }
        return null;
      }),
    };

    const templates = loadProjectTemplatesFromPorts(
      { configDir, isExplicit: false },
      templateLoader,
      path,
    );

    expect(templates.plan).toBe("PLAN");
    expect(templates.planLoop).toBe(DEFAULT_PLAN_LOOP_TEMPLATE);
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan.md"));
    expect(templateLoader.load).toHaveBeenCalledWith(path.join(configDir, "plan-loop.md"));
  });
});
