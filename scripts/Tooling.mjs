import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
/** Use npm's JS entry so Windows never needs implicit cmd.exe argument interpretation.
 * @param {string[]} args
 */
export function npmInvocation(args) {
  const entry = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
  ].find(
    (file) =>
      typeof file === "string" && file.endsWith(".js") && existsSync(file),
  );
  if (entry) return { command: process.execPath, args: [entry, ...args] };
  if (process.platform === "win32")
    throw new Error(
      "Cannot locate npm's JavaScript entry; run this check through npm run check",
    );
  return { command: "npm", args };
}
