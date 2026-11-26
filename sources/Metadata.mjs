import { readFileSync } from "node:fs";
/** Runtime, reference and telemetry identify the exact packaged version. */
export const VERSION = /** @type {{version:string}} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
).version;
