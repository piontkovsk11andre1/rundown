import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const targetFile = path.join(rootDir, "tasks", "sorting", "99-generated-newer.md");

const content = `# Sorting generated file\n\n- [ ] Create \`outputs/sort-generated.txt\` with exactly one line: \`newest-file-selected\`.\n`;

fs.writeFileSync(targetFile, content, "utf8");
console.log(`Created ${path.relative(rootDir, targetFile)}`);
