import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const outputDir = path.join(rootDir, "outputs");
const outputFile = path.join(outputDir, "inline-cli.txt");

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, "inline-cli: success\ntransport=direct-shell\n", "utf8");
console.log(`Wrote ${path.relative(rootDir, outputFile)}`);
