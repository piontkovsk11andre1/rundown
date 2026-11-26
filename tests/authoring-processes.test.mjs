import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { workspace, copyGreeting } from "./helpers.mjs";
import { initProject, checkProject } from "../sources/Authoring.mjs";
import { runProcess } from "../sources/Process.mjs";

test(
  "separate CLI processes preserve both catalog updates",
  { timeout: 15000 },
  async (t) => {
    const cwd = await workspace(t);
    await copyGreeting(cwd);
    await initProject("commands.md", { cwd });
    const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
    await Promise.all(
      ["one", "two"].map((name) =>
        runProcess(
          process.execPath,
          [bin, "--cwd", cwd, "--new-command", name],
          { timeoutMs: 10000 },
        ),
      ),
    );
    const checked = await checkProject({ cwd });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.commands.map((command) => command.name).sort(), [
      "example",
      "one",
      "two",
    ]);
  },
);
