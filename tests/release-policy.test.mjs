import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../sources/Process.mjs";
import { VERSION } from "../sources/Metadata.mjs";
import { Reader } from "@p10i/do-md";

test("release metadata and enabled platform matrix describe the canonical package", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, VERSION);
  assert.match(VERSION, /^2\.0\.0-rc\.\d+$/);
  assert.equal(manifest.repository.directory, undefined);
  assert.equal(manifest.dependencies["@p10i/do-md"], "2.0.0-rc.2");
  const ci = await readFile(
    new URL("../.github/workflows/rundown.yml", import.meta.url),
    "utf8",
  );
  const parsed = new Reader("---\n" + ci + "\n---\n").frontmatter().value.data;
  assert.deepEqual(parsed.jobs.check.strategy.matrix.os, [
    "ubuntu-latest",
    "windows-latest",
  ]);
  assert.deepEqual(parsed.jobs.check.strategy.matrix.node.map(String), [
    "22.15.0",
    "24",
    "26",
  ]);
  assert.ok(
    parsed.jobs.check.steps.some((step) => step.run === "npm run check"),
  );
});
test("candidate preflight refuses dirty inputs without running checks or publishing", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const state = await runProcess(
    "git",
    ["status", "--porcelain=v1", "--", "."],
    { cwd },
  );
  const args = [
    fileURLToPath(new URL("../scripts/release-candidate.mjs", import.meta.url)),
    "--verify-inputs",
  ];
  if (state.stdout.trim())
    await assert.rejects(
      runProcess(process.execPath, args, { cwd }),
      /Commit the reviewed package/,
    );
  else {
    const preflight = JSON.parse(
      (await runProcess(process.execPath, args, { cwd })).stdout,
    );
    assert.equal(preflight.clean, true);
    assert.equal(preflight.version, VERSION);
  }
});
