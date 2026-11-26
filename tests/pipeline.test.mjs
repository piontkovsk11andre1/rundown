import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace } from "./helpers.mjs";
import { runProcess } from "../sources/Process.mjs";
import { checkProject } from "../sources/Authoring.mjs";

const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
test(
  "Markdown pipeline resumes a receipt committed before interruption without rerunning it",
  { timeout: 15000 },
  async (t) => {
    const cwd = await workspace(t);
    await cp(new URL("../examples/pipeline/", import.meta.url), cwd, {
      recursive: true,
    });
    assert.equal((await checkProject({ cwd })).ok, true);
    const child = spawn(
      process.execPath,
      [bin, "--cwd", cwd, "build", "--pause-after", "alpha"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RUNDOWN_LOG_FORMAT: "json" },
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    let logs = "";
    let checkpoint;
    const ready = new Promise((resolve, reject) => {
      checkpoint = resolve;
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("Pipeline exited before checkpoint: " + logs)),
      );
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
      if (logs.includes('"checkpoint":true')) checkpoint();
    });
    child.stdout.resume();
    await ready;
    const artifact = join(cwd, "work/alpha/Artifact.md"),
      receipt = join(cwd, "work/alpha/Receipt.md");
    const before = {
      artifact: await readFile(artifact, "utf8"),
      receipt: await readFile(receipt, "utf8"),
      mtime: (await stat(artifact)).mtimeMs,
    };
    const exited = new Promise((resolve) => child.once("close", resolve));
    child.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT");
    await exited;
    const resumed = await runProcess(
      process.execPath,
      [bin, "--cwd", cwd, "build"],
      { timeoutMs: 10000 },
    );
    assert.deepEqual(JSON.parse(resumed.stdout), {
      completed: [
        { id: "alpha", built: false },
        { id: "beta", built: true },
      ],
    });
    assert.equal(await readFile(artifact, "utf8"), before.artifact);
    assert.equal(await readFile(receipt, "utf8"), before.receipt);
    assert.equal((await stat(artifact)).mtimeMs, before.mtime);
    const plan = await readFile(join(cwd, "Plan.md"), "utf8");
    assert.equal((plan.match(/\[x\]/g) ?? []).length, 2);
    const again = await runProcess(
      process.execPath,
      [bin, "--cwd", cwd, "build"],
      { timeoutMs: 10000 },
    );
    assert.deepEqual(JSON.parse(again.stdout), { completed: [] });
  },
);
