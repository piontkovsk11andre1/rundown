import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

const seededFiles = {
  "tasks/01-happy-path.md": "# 01 Happy path\n\n- [ ] Create `outputs/happy-path.txt` with exactly two lines: `rundown manual run: success` and `mode=execute-verify`.\n",
  "tasks/02-nested.md": "# 02 Child-before-parent selection\n\n- [ ] Append a second line `parent-ready` to `outputs/nested-selection.txt` after the child task has created the file.\n  - [ ] Create `outputs/nested-selection.txt` with exactly one line: `child-first`.\n",
  "tasks/03-verify-repair.md": "# 03 Verify-only and repair retry\n\n- [ ] Create `outputs/verify-repair.txt` with exactly one line: `repaired-and-verified`.\n",
  "tasks/04-plan.md": "# 04 Planner flow\n\n- [ ] Plan the manual playground release checklist for a small CLI project.\n",
  "tasks/05-inline-cli.md": "# 05 Inline CLI execution\n\n- [ ] cli: node ./scripts/write-inline-cli-output.mjs\n",
  "tasks/sorting/10-alpha.md": "# Sorting seed A\n\n- [ ] Create `outputs/sort-alpha.txt` with exactly one line: `alpha-first`.\n",
  "tasks/sorting/20-beta.md": "# Sorting seed B\n\n- [ ] Create `outputs/sort-beta.txt` with exactly one line: `beta-second`.\n",
  "tasks/glob/a/10-glob-a.md": "# Glob source A\n\n- [ ] Create `outputs/glob-a.txt` with exactly one line: `glob-a`.\n",
  "tasks/glob/b/20-glob-b.md": "# Glob source B\n\n- [ ] Create `outputs/glob-b.txt` with exactly one line: `glob-b`.\n",
  "sandboxes/init-target/README.md": "# Init sandbox\n\nUse this directory to manually verify `rundown init`.\n\nExpected behavior:\n\n- the first run creates `.rundown/execute.md`, `.rundown/verify.md`, `.rundown/repair.md`, `.rundown/plan.md`, and `.rundown/vars.json`\n- the second run should keep the existing files and report that they already exist\n",
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

for (const [relativeFile, content] of Object.entries(seededFiles)) {
  const absoluteFile = path.join(rootDir, relativeFile);
  ensureDir(path.dirname(absoluteFile));
  fs.writeFileSync(absoluteFile, content, "utf8");
}

removeIfExists(path.join(rootDir, ".rundown", "runs"));
removeIfExists(path.join(rootDir, "sandboxes", "init-target", ".rundown"));
removeIfExists(path.join(rootDir, "tasks", "sorting", "99-generated-newer.md"));

const outputDir = path.join(rootDir, "outputs");
ensureDir(outputDir);
for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
  if (entry.name === ".gitkeep") {
    continue;
  }

  fs.rmSync(path.join(outputDir, entry.name), { recursive: true, force: true });
}

for (const searchDir of [path.join(rootDir, "tasks")]) {
  walk(searchDir);
}

function walk(currentDir) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (entry.name.endsWith(".validation")) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

console.log("Manual playground reset complete.");
