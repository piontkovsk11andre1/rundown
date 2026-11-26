import test from "node:test";
import assert from "node:assert/strict";
import { loadCommands, Runtime } from "../sources/index.mjs";
import { checkProject } from "../sources/Authoring.mjs";
import { fileURLToPath } from "node:url";

test("the callback example resolves and runs its project binding with an unconfigured core Runtime", async () => {
  const cwd = fileURLToPath(new URL("../examples/callbacks/", import.meta.url));
  const checked = await checkProject({ cwd });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.ok(
    checked.files.some((file) => file.file.endsWith("/ai/harness/fake.md")),
  );
  const runtime = new Runtime(await loadCommands(undefined, { cwd }), { cwd });
  try {
    assert.deepEqual(await runtime.invoke("agent"), {
      ok: true,
      summary: "Deterministic callback round trip completed.",
    });
  } finally {
    await runtime.close();
  }
});
