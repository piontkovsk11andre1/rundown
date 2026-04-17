import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMakeCommandAction } from "../../../src/presentation/cli-command-actions.js";
import type { CliApp } from "../../../src/presentation/cli-app-init.js";

type CliOpts = Record<string, string | string[] | boolean>;

describe("createMakeCommandAction", () => {
  it("runs research and plan by default", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-default-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, {});

      expect(exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("forwards --skip-research as normalized skip mode and bypasses research", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-skip-research-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, { skipResearch: true });

      expect(exitCode).toBe(0);
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: targetFile,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes --raw alias to the same skip mode and bypasses research", async () => {
    const scenarios: Array<{ label: string; opts: CliOpts }> = [
      { label: "raw alias", opts: { raw: true } },
      { label: "both flags", opts: { raw: true, skipResearch: true } },
    ];

    for (const scenario of scenarios) {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rundown-make-raw-${scenario.label.replace(/\s+/g, "-")}-`));
      const targetFile = path.join(tempRoot, "migrations", "seed.md");
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });

      const researchTask = vi.fn(async () => 0);
      const planTask = vi.fn(async () => 0);
      const app = { researchTask, planTask } as unknown as CliApp;
      const action = createMakeCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => undefined,
        makeModes: ["wait"],
      });

      try {
        const exitCode = await action("seed", targetFile, scenario.opts);

        expect(exitCode).toBe(0);
        expect(researchTask).not.toHaveBeenCalled();
        expect(planTask).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });
});
