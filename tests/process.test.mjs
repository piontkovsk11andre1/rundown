import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../sources/Process.mjs";

test("subprocess timeout, cancellation, output limits and nonzero exit reject", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    }),
    /timed out/,
  );
  const controller = new AbortController();
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  await assert.rejects(
    runProcess(process.execPath, ["-e", 'console.log("x".repeat(10000))'], {
      maxBytes: 100,
    }),
    /output exceeded/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(3)"]),
    /3/,
  );
  await assert.rejects(runProcess("/missing/rundown-executable", []));
});
