import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  cp,
  copyFile,
} from "node:fs/promises";
import { npmInvocation } from "../scripts/Tooling.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace } from "./helpers.mjs";
import { runProcess } from "../sources/Process.mjs";

test(
  "installed tarball includes templates, examples, aliases and public export boundaries",
  { timeout: 120000 },
  async (t) => {
    const directory = await workspace(t);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const runNpm = (args, options) => {
      const npm = npmInvocation(args);
      return runProcess(npm.command, npm.args, options);
    };
    const pack = await runNpm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      { cwd: root },
    );
    const metadata = JSON.parse(pack.stdout)[0];
    assert.ok(
      metadata.files.some(
        (file) => file.path === "examples/callbacks/ai/harness/fake.md",
      ),
    );
    for (const name of ["module", "commands"])
      assert.ok(
        metadata.files.some(
          (file) => file.path === `templates/${name}.md.template`,
        ),
      );
    assert.ok(
      !metadata.files.some(
        (file) => file.path === "templates/document.md.template",
      ),
    );
    assert.ok(
      metadata.files.some(
        (file) => file.path === "examples/greeting/commands.md",
      ),
    );
    for (const file of [
      "sources/Acp.mjs",
      "sources/Acp.d.mts",
      "sources/AcpTypes.d.mts",
      "docs/acp.md",
      "skills/rundown/SKILL.md",
      "sources/Authoring.mjs",
      "sources/Authoring.d.mts",
      "sources/Testing.mjs",
      "sources/Testing.d.mts",
      "sources/TestRunner.mjs",
      "sources/Views.mjs",
      "sources/Views.d.mts",
      "sources/ViewTypes.d.mts",
      "examples/views/reports/report.md.template",
      "templates/starters/command.md.template",
      "templates/starters/module.md.template",
      "docs/reference.md",
    ]) {
      assert.ok(
        metadata.files.some((item) => item.path === file),
        file,
      );
    }
    assert.ok(
      !metadata.files.some(
        (file) =>
          file.path.startsWith("tests/") || file.path.startsWith(".test-tmp/"),
      ),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--install-strategy=nested",
        join(directory, metadata.filename),
      ],
      { cwd: directory, timeoutMs: 90000 },
    );
    const packageRoot = join(directory, "node_modules/@p10i/rundown");
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    assert.equal(manifest.bin.rundown, manifest.bin.rndn);
    await runProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {invokeAcp} from "@p10i/rundown/acp"; if(typeof invokeAcp !== "function")throw Error("Missing ACP export");',
      ],
      { cwd: directory },
    );
    assert.ok(
      !Object.keys(manifest.exports).some((name) =>
        name.startsWith("./harness/"),
      ),
    );
    const dependencyProbe = `import {fileURLToPath} from "node:url";const dependencies=${JSON.stringify(Object.keys(manifest.dependencies))};for(const name of dependencies){const resolved=fileURLToPath(import.meta.resolve(name==="@modelcontextprotocol/sdk"?name+"/client/index.js":name));if(!resolved.startsWith(${JSON.stringify(join(packageRoot, "node_modules"))}))throw new Error("Dependency escaped isolated installation: "+name+" "+resolved);}`;
    await writeFile(join(packageRoot, "dependency-probe.mjs"), dependencyProbe);
    await runProcess(
      process.execPath,
      [join(packageRoot, "dependency-probe.mjs")],
      { cwd: directory },
    );
    const cwd = join(packageRoot, "examples/greeting");
    const tested = await runProcess(
      process.execPath,
      [join(packageRoot, "bin/rundown.mjs"), "--cwd", cwd, "--test", "--json"],
      { cwd: directory, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(JSON.parse(tested.stdout).ok, true);
    assert.equal(JSON.parse(tested.stdout).results.length, 2);
    const viewed = await runProcess(
      process.execPath,
      [
        join(packageRoot, "bin/rundown.mjs"),
        "--cwd",
        join(packageRoot, "examples/views"),
        "--json",
        "report",
      ],
      { cwd: directory },
    );
    assert.equal(JSON.parse(viewed.stdout).status, "Completed");
    for (const alias of ["rundown", "rndn"]) {
      await access(
        join(
          directory,
          "node_modules/.bin",
          alias + (process.platform === "win32" ? ".cmd" : ""),
        ),
      );
      const result = await runProcess(
        process.execPath,
        [
          process.platform === "win32"
            ? join(packageRoot, "bin/rundown.mjs")
            : join(directory, "node_modules/.bin", alias),
          "--cwd",
          cwd,
          "example",
          "Ada",
        ],
        { cwd: directory },
      );
      assert.equal(result.stdout, "Hello, Ada!\n");
    }
    const probe =
      'import {loadModule} from "@p10i/rundown"; import {startHttp} from "@p10i/rundown/http"; import {ProcessAdapter} from "@p10i/rundown/process"; import {Observability} from "@p10i/rundown/observability"; try { await import("@p10i/rundown/sources/Compiler.mjs"); process.exit(9); } catch(error) { if(error.code!=="ERR_PACKAGE_PATH_NOT_EXPORTED")throw error; } console.log(typeof loadModule,typeof startHttp,typeof ProcessAdapter,typeof Observability);';
    const result = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { cwd: directory },
    );
    assert.equal(result.stdout, "function function function function\n");
    const authoringProbe =
      'import {readSkill,reference,checkProject} from "@p10i/rundown/authoring";import {readFile} from "node:fs/promises";const text=await readFile(new URL(import.meta.resolve("@p10i/rundown/skills/rundown/SKILL.md")),"utf8");if(text!==await readSkill())throw new Error("Skill bodies differ");console.log(reference("modules").title,typeof checkProject);';
    assert.equal(
      (
        await runProcess(
          process.execPath,
          ["--input-type=module", "-e", authoringProbe],
          { cwd: directory },
        )
      ).stdout,
      "Modules function\n",
    );
    const project = join(directory, "fresh-project");
    await mkdir(project);
    const run = (...args) =>
      runProcess(
        process.execPath,
        [join(packageRoot, "bin/rundown.mjs"), "--cwd", project, ...args],
        { cwd: directory },
      );
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await cp(
      join(packageRoot, "examples/greeting/example"),
      join(project, "example"),
      { recursive: true },
    );
    await copyFile(
      join(packageRoot, "examples/greeting/commands.md"),
      join(project, "commands.md"),
    );
    const registered = JSON.parse(
      (await run("--init", "commands.md", "--json")).stdout,
    );
    assert.deepEqual(registered.created, []);
    assert.equal(registered.updated.length, 1);
    await run("--new-command", "hello");
    assert.equal(
      (await run("hello", "Installed starter")).stdout,
      "Installed starter\n",
    );
    assert.equal(JSON.parse((await run("--check", "--json")).stdout).ok, true);
    assert.match((await run("--skill")).stdout, /name: rundown/);
    const callbacks = join(packageRoot, "examples/callbacks");
    const callbackResult = await runProcess(
      process.execPath,
      [join(packageRoot, "bin/rundown.mjs"), "--cwd", callbacks, "agent"],
      { cwd: directory },
    );
    assert.deepEqual(JSON.parse(callbackResult.stdout), {
      ok: true,
      summary: "Deterministic callback round trip completed.",
    });
    const documentExample = join(packageRoot, "examples/document-processing");
    assert.deepEqual(
      JSON.parse(
        (
          await runProcess(
            process.execPath,
            [
              join(packageRoot, "bin/rundown.mjs"),
              "--cwd",
              documentExample,
              "pending",
              "Target.md",
            ],
            { cwd: directory },
          )
        ).stdout,
      ),
      { total: 3, completed: 1, pending: 2 },
    );
  },
);
