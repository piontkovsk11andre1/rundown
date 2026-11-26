import { readFile, writeFile } from "node:fs/promises";
import { referenceMarkdown } from "../sources/Knowledge.mjs";
const file = new URL("../docs/reference.md", import.meta.url);
const expected = referenceMarkdown();
if (process.argv.includes("--check")) {
  let actual = "";
  try {
    actual = await readFile(file, "utf8");
  } catch {
    /* A missing generated reference is stale. */
  }
  if (actual !== expected) {
    process.stderr.write("Reference is stale; run npm run docs.\n");
    process.exitCode = 1;
  }
} else await writeFile(file, expected);
