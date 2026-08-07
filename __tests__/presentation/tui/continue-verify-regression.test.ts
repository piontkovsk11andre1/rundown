import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTuiHarness } from "./harness.ts";

const VERIFY_WORKER_SCRIPT = [
  "const fs=require('node:fs');",
  "const promptPath=process.argv[process.argv.length-1];",
  "const prompt=fs.readFileSync(promptPath,'utf-8');",
  "if(/verify/i.test(prompt)){",
  "  setTimeout(()=>{console.log('OK');process.exit(0);},1200);",
  "}",
  "console.log('OK');",
  "process.exit(0);",
].join("");

describe("tui continue verify regression guard", () => {
  it("renders verify phase from a real verify/repair loop run", async () => {
    const isolatedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-verify-regression-"));
    const previousCwd = process.cwd();

    try {
      fs.mkdirSync(path.join(isolatedWorkspace, "migrations"), { recursive: true });
      fs.mkdirSync(path.join(isolatedWorkspace, ".rundown"), { recursive: true });
      fs.writeFileSync(
        path.join(isolatedWorkspace, "migrations", "verify-regression.md"),
        "# Verify regression\n\n- [ ] Keep verify progress emission wired\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(isolatedWorkspace, ".rundown", "config.json"),
        `${JSON.stringify({ workers: { default: ["node", "-e", VERIFY_WORKER_SCRIPT] } }, null, 2)}\n`,
        "utf8",
      );

      process.chdir(isolatedWorkspace);

      const harness = await createTuiHarness({ initialScene: "continue" });

      expect(harness.frame()).toContain("Continue Preview");

      await harness.press("enter");

      let sawVerifyOperation = false;
      let sawDoneSummary = false;

      for (let index = 0; index < 120; index += 1) {
        await harness.press("down");
        const frame = harness.frame();

        if (/Operation:\s+VERIFY/.test(frame)) {
          sawVerifyOperation = true;
        }
        if (frame.includes("Run Summary")) {
          sawDoneSummary = true;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(sawVerifyOperation).toBe(true);
      expect(sawDoneSummary).toBe(true);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(isolatedWorkspace, { recursive: true, force: true });
    }
  });
});
