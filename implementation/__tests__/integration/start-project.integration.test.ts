import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMigrationFilename } from "../../src/domain/migration-parser.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

const CLI_FILE_PATH = path.resolve(process.cwd(), "src/presentation/cli.ts");
const START_TASK_FILE_PATH = path.resolve(process.cwd(), "src/application/start-project.ts");
const cliSource = fs.existsSync(CLI_FILE_PATH)
  ? fs.readFileSync(CLI_FILE_PATH, "utf-8")
  : "";
const hasStartCommand = fs.existsSync(CLI_FILE_PATH)
  && cliSource.includes('.command("start")');
const hasStartTaskUseCase = fs.existsSync(START_TASK_FILE_PATH);
const describeIfStartAvailable = hasStartCommand && hasStartTaskUseCase ? describe : describe.skip;

describeIfStartAvailable("start-project integration", () => {
  it("writes workspace link metadata to both source and target when started from an existing workspace", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "linked-target";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), "{}\n", "utf-8");

    const result = await runCli([
      "start",
      "Linked target",
      "--dir",
      projectDirName,
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(projectDir, ".rundown", "workspace.link"))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, ".rundown", "workspace.link"), "utf-8").trim()).toBe("..");

    const sourceWorkspaceLinkPath = path.join(workspace, ".rundown", "workspace.link");
    expect(fs.existsSync(sourceWorkspaceLinkPath)).toBe(true);
    const sourceLink = JSON.parse(fs.readFileSync(sourceWorkspaceLinkPath, "utf-8")) as {
      schemaVersion: number;
      records: Array<{ id: string; workspacePath: string; default?: boolean }>;
      defaultRecordId?: string;
    };

    expect(sourceLink.schemaVersion).toBe(1);
    expect(sourceLink.records).toHaveLength(1);
    expect(sourceLink.records[0]?.workspacePath).toBe(projectDirName);
    expect(sourceLink.defaultRecordId).toBeUndefined();
  });

  it("preserves existing source link records and writes target metadata for new starts", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "linked-target";
    const projectDir = path.join(workspace, projectDirName);
    const existingLinkedDirName = "existing-linked";

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.mkdirSync(path.join(workspace, existingLinkedDirName), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: 1,
        defaultRecordId: "existing",
        records: [{ id: "existing", workspacePath: existingLinkedDirName, default: true }],
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "start",
      "Linked target",
      "--dir",
      projectDirName,
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(projectDir, ".rundown", "workspace.link"))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, ".rundown", "workspace.link"), "utf-8").trim()).toBe("..");

    const sourceWorkspaceLinkPath = path.join(workspace, ".rundown", "workspace.link");
    expect(fs.existsSync(sourceWorkspaceLinkPath)).toBe(true);
    const sourceLink = JSON.parse(fs.readFileSync(sourceWorkspaceLinkPath, "utf-8")) as {
      schemaVersion: number;
      records: Array<{ id: string; workspacePath: string; default?: boolean }>;
      defaultRecordId?: string;
    };

    expect(sourceLink.schemaVersion).toBe(1);
    expect(sourceLink.defaultRecordId).toBe("existing");
    expect(sourceLink.records.map((record) => record.workspacePath)).toEqual([
      existingLinkedDirName,
      projectDirName,
    ]);
  });

  it("does not create nested .git when scaffolding inside an existing repository", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "prediction-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "Test prediction project",
      "--dir",
      projectDirName,
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(false);

    expect(fs.existsSync(path.join(projectDir, "Design.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "prediction"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "migrations", formatMigrationFilename(1, "initialize")))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".rundown", "workspace.link"))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, ".rundown", "workspace.link"), "utf-8").trim()).toBe("..");

    const initialMigrationPath = path.join(projectDir, "migrations", formatMigrationFilename(1, "initialize"));
    const initialMigrationSource = fs.readFileSync(initialMigrationPath, "utf-8");
    expect(initialMigrationSource).toContain("- [ ] Document initial architecture assumptions");
    expect(initialMigrationSource).toContain("- [ ] Establish baseline project structure");
    expect(initialMigrationSource).toContain("- [ ] Capture first validation checkpoints");
    expect(initialMigrationSource).not.toContain("Research target documents and existing project materials");
    expect(initialMigrationSource).not.toContain("Create the revision-0 baseline target");

    const defaultConfig = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
        placement?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };
    expect(defaultConfig.workspace?.directories).toEqual({
      design: "design",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(defaultConfig.workspace?.placement).toEqual({
      design: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("writes workspace.link as current directory for in-place start", async () => {
    const workspace = makeTempWorkspace();

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "In place project",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "prediction"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, ".rundown", "workspace.link"), "utf-8").trim()).toBe(".");

    const config = JSON.parse(
      fs.readFileSync(path.join(workspace, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
        placement?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };
    expect(config.workspace?.directories).toEqual({
      design: "design",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(config.workspace?.placement).toEqual({
      design: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("fails when --design-dir is absolute", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "Absolute design dir",
      "--design-dir",
      path.join(workspace, "outside-design"),
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --design-dir value");
    expect(stderr).toContain("relative to the project root");
  });

  it("fails when --design-placement is invalid", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "Invalid placement",
      "--design-placement",
      "source",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --design-placement value");
    expect(stderr).toContain("Allowed values: sourcedir, workdir");
  });

  it("fails when override escapes project root", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "Traversal design dir",
      "--design-dir",
      "../outside",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --design-dir value");
    expect(stderr).toContain("escapes the project root");
  });

  it("fails when workspace directories resolve to duplicate targets", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "Duplicate dirs",
      "--design-dir",
      "work",
      "--specs-dir",
      "work",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid workspace directory overrides");
    expect(stderr).toContain("both resolve to \"work\"");
  });

  it("fails when workspace directories overlap via nested paths", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "Nested dirs",
      "--design-dir",
      "workspace/design",
      "--specs-dir",
      "workspace",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid workspace directory overrides");
    expect(stderr).toContain("overlap");
  });

  it("persists custom workspace directory mapping in .rundown/config.json", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "custom-layout");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "Custom directory layout",
      "--dir",
      "custom-layout",
      "--design-dir",
      "docs/design",
      "--specs-dir",
      "quality/specs",
      "--migrations-dir",
      "changesets",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "docs", "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "quality", "specs"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "changesets"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "prediction"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "changesets", formatMigrationFilename(1, "initialize")))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.directories).toEqual({
      design: "docs/design",
      specs: "quality/specs",
      migrations: "changesets",
      prediction: "prediction",
    });
  });

  it("persists explicit workspace placement mapping in .rundown/config.json", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "custom-placement");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "Custom placement layout",
      "--dir",
      "custom-placement",
      "--design-placement",
      "workdir",
      "--specs-placement",
      "sourcedir",
      "--migrations-placement",
      "workdir",
    ], workspace);

    expect(result.code).toBe(0);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        placement?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.placement).toEqual({
      design: "workdir",
      specs: "sourcedir",
      migrations: "workdir",
      prediction: "sourcedir",
    });
  });

  it("seeds first migration for existing directories with research and revision-0 baseline tasks", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "existing-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Existing project\n", "utf-8");

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "Existing directory start",
      "--dir",
      projectDirName,
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    const initialMigrationPath = path.join(projectDir, "migrations", formatMigrationFilename(1, "initialize"));
    const initialMigrationSource = fs.readFileSync(initialMigrationPath, "utf-8");
    expect(initialMigrationSource).toContain("- [ ] Research target documents and existing project materials");
    expect(initialMigrationSource).toContain("- [ ] Create the revision-0 baseline target from design/current/Target.md");

    const targetDesignPath = path.join(projectDir, "design", "current", "Target.md");
    const targetDesignSource = fs.readFileSync(targetDesignPath, "utf-8");
    expect(targetDesignSource).toContain("# Existing directory start");
    expect(targetDesignSource).toContain("Bootstrapped from existing implementation. Replace with target description in domain language; do not list implementation details.");
  });

  it("mirrors existing workspace files into prediction byte-for-byte when bootstrap fires", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "existing-project-mirror";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "foo.ts"), "export const foo = 1;\n", "utf-8");
    fs.writeFileSync(path.join(projectDir, "package.json"), "{\"name\":\"mirror-test\"}\n", "utf-8");
    const binarySource = Buffer.from([0, 255, 10, 13, 128, 42]);
    fs.writeFileSync(path.join(projectDir, "assets", "sample.bin"), binarySource);
    fs.writeFileSync(path.join(projectDir, "dist", "bundle.js"), "ignored output\n", "utf-8");

    const result = await runCli([
      "start",
      "Existing mirror start",
      "--dir",
      projectDirName,
    ], workspace);

    expect(result.code).toBe(0);

    const sourceTs = fs.readFileSync(path.join(projectDir, "src", "foo.ts"));
    const mirroredTs = fs.readFileSync(path.join(projectDir, "prediction", "src", "foo.ts"));
    expect(mirroredTs.equals(sourceTs)).toBe(true);

    const sourcePackageJson = fs.readFileSync(path.join(projectDir, "package.json"));
    const mirroredPackageJson = fs.readFileSync(path.join(projectDir, "prediction", "package.json"));
    expect(mirroredPackageJson.equals(sourcePackageJson)).toBe(true);

    const mirroredBinary = fs.readFileSync(path.join(projectDir, "prediction", "assets", "sample.bin"));
    expect(mirroredBinary.equals(binarySource)).toBe(true);

    expect(fs.existsSync(path.join(projectDir, "prediction", "dist", "bundle.js"))).toBe(false);
  });

  it("fails with a clear error when bootstrap mirror exceeds the 50MB cap", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "existing-project-too-large";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "src", "large.bin"),
      Buffer.alloc(50 * 1024 * 1024 + 1, 7),
    );

    const result = await runCli([
      "start",
      "Existing mirror start too large",
      "--dir",
      projectDirName,
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Bootstrap aborted: implementation tree exceeds limit");
    expect(stderr).toContain("Limit is 5000 files or 50MB");
    expect(stderr).toContain("Use --no-bootstrap");

    expect(fs.existsSync(path.join(projectDir, "prediction", "src", "large.bin"))).toBe(false);
  });

  it("uses configured design directory path in non-empty workspace migration seed", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "existing-custom-design";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Existing project\n", "utf-8");

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "Existing directory start",
      "--dir",
      projectDirName,
      "--design-dir",
      "docs/design",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    const initialMigrationPath = path.join(projectDir, "migrations", formatMigrationFilename(1, "initialize"));
    const initialMigrationSource = fs.readFileSync(initialMigrationPath, "utf-8");
    expect(initialMigrationSource).toContain("- [ ] Research target documents and existing project materials");
    expect(initialMigrationSource).toContain("- [ ] Create the revision-0 baseline target from docs/design/current/Target.md");
  });

  it("seeds existing-directory migration with custom workspace mapping and persists it in config", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "existing-custom-workspace";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Existing project\n", "utf-8");

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "Existing directory with custom layout",
      "--dir",
      projectDirName,
      "--design-dir",
      "docs/design",
      "--specs-dir",
      "quality/specs",
      "--migrations-dir",
      "changesets",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    const initialMigrationPath = path.join(projectDir, "changesets", formatMigrationFilename(1, "initialize"));
    const initialMigrationSource = fs.readFileSync(initialMigrationPath, "utf-8");
    expect(initialMigrationSource).toContain("- [ ] Research target documents and existing project materials");
    expect(initialMigrationSource).toContain("- [ ] Create the revision-0 baseline target from docs/design/current/Target.md");

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.directories).toEqual({
      design: "docs/design",
      specs: "quality/specs",
      migrations: "changesets",
      prediction: "prediction",
    });
  });
});

function makeTempWorkspace(): string {
  const isolatedTempRoot = path.join(path.parse(os.tmpdir()).root, "rundown-test-tmp");
  fs.mkdirSync(isolatedTempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(isolatedTempRoot, "rundown-start-int-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}> {
  const previousCwd = process.cwd();
  const previousDisableAutoParse = process.env.RUNDOWN_DISABLE_AUTO_PARSE;
  const previousTestMode = process.env.RUNDOWN_TEST_MODE;

  process.chdir(cwd);
  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-start-home-"));
  tempDirs.push(isolatedHome);
  const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);

  vi.resetModules();

  const logs: string[] = [];
  const errors: string[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map((value) => String(value)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map((value) => String(value)).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw {
      __cliExit: true,
      exitCode: typeof code === "number" ? code : Number(code ?? 0),
    };
  }) as typeof process.exit);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(args);
    return { code: 0, logs, errors, stdoutWrites, stderrWrites };
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && typeof (error as { code?: unknown }).code === "number"
      && "message" in error
      && typeof (error as { message?: unknown }).message === "string"
      && (error as { message: string }).message.startsWith("CLI exited with code ")
    ) {
      return {
        code: (error as { code: number }).code,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    if (
      typeof error === "object"
      && error !== null
      && "__cliExit" in error
      && (error as { __cliExit?: unknown }).__cliExit === true
    ) {
      return {
        code: (error as { exitCode: number }).exitCode,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    errors.push(String(error));
    return { code: 1, logs, errors, stdoutWrites, stderrWrites };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    homedirSpy.mockRestore();
    process.chdir(previousCwd);

    if (previousDisableAutoParse === undefined) {
      delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    } else {
      process.env.RUNDOWN_DISABLE_AUTO_PARSE = previousDisableAutoParse;
    }

    if (previousTestMode === undefined) {
      delete process.env.RUNDOWN_TEST_MODE;
    } else {
      process.env.RUNDOWN_TEST_MODE = previousTestMode;
    }
  }
}
