import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../sources/Process.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const bin = fileURLToPath(new URL("../bin/rundown.mjs", import.meta.url));
test("documented examples check and execute with deterministic expected outputs", async () => {
  for (const example of [
    "greeting",
    "document-processing",
    "callbacks",
    "pipeline",
  ]) {
    const cwd = fileURLToPath(
      new URL(`../examples/${example}/`, import.meta.url),
    );
    const checked = JSON.parse(
      (
        await runProcess(
          process.execPath,
          [bin, "--cwd", cwd, "--check", "--json"],
          { cwd: root },
        )
      ).stdout,
    );
    assert.equal(checked.ok, true);
  }
  const run = (cwd, ...args) =>
    runProcess(process.execPath, [bin, "--cwd", cwd, ...args], { cwd: root });
  assert.equal(
    (await run(root + "/examples/greeting", "example", "Ada")).stdout,
    "Hello, Ada!\n",
  );
  const input = new URL(
    "../examples/document-processing/Target.md",
    import.meta.url,
  );
  const original = await readFile(input, "utf8");
  assert.deepEqual(
    JSON.parse(
      (
        await run(
          root + "/examples/document-processing",
          "pending",
          "Target.md",
        )
      ).stdout,
    ),
    { total: 3, completed: 1, pending: 2 },
  );
  assert.equal(await readFile(input, "utf8"), original);
  const callbacks = await run(root + "/examples/callbacks", "agent");
  assert.deepEqual(JSON.parse(callbacks.stdout), {
    ok: true,
    summary: "Deterministic callback round trip completed.",
  });
});
