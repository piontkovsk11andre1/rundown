import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceRootForPathSensitiveCommand } from "../../src/application/workspace-selection.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";

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
    expect(fs.existsSync(path.join(projectDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "prediction"))).toBe(true);
    expect(fs.readdirSync(path.join(projectDir, "migrations"))).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, ".rundown", "workspace.link"))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, ".rundown", "workspace.link"), "utf-8").trim()).toBe("..");

    const defaultConfig = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
        placement?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };
    expect(defaultConfig.workspace?.directories).toEqual({
      design: "design",
      implementation: "implementation",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(defaultConfig.workspace?.placement).toEqual({
      design: "sourcedir",
      implementation: "sourcedir",
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
      "--dir",
      ".",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "prediction"))).toBe(true);
    expect(fs.readdirSync(path.join(workspace, "migrations"))).toEqual([]);
    expect(fs.readFileSync(path.join(workspace, ".rundown", "workspace.link"), "utf-8").trim()).toBe(".");

    const config = JSON.parse(
      fs.readFileSync(path.join(workspace, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
        placement?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };
    expect(config.workspace?.directories).toEqual({
      design: "design",
      implementation: "implementation",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(config.workspace?.placement).toEqual({
      design: "sourcedir",
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("fails when --design-dir is absolute", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
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
    expect(fs.existsSync(path.join(projectDir, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "prediction"))).toBe(true);
    expect(fs.readdirSync(path.join(projectDir, "changesets"))).toEqual([]);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.directories).toEqual({
      design: "docs/design",
      implementation: "implementation",
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
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.placement).toEqual({
      design: "workdir",
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "workdir",
      prediction: "sourcedir",
    });
  });

  it("normalizes CLI mount targets from invocation directory and persists resolved mounts", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "mounted-control";
    const projectDir = path.join(workspace, projectDirName);
    const generatedDir = path.join(workspace, "generated");

    fs.mkdirSync(generatedDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      projectDirName,
      "--mount",
      "implementation=.",
      "--mount",
      "implementation/generated=./generated",
    ], workspace);

    expect(result.code).toBe(0);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        mounts?: Record<string, string>;
      };
    };

    expect(config.workspace?.mounts).toEqual({
      implementation: path.normalize(workspace),
      "implementation/generated": path.normalize(generatedDir),
    });
  });

  it("bootstraps a control workspace with current directory mounted as implementation", async () => {
    const workspace = makeTempWorkspace();
    const invocationDirName = "existing-implementation-app";
    const invocationDir = path.join(workspace, invocationDirName);
    const controlDir = path.join(workspace, "implementation-control");

    fs.mkdirSync(invocationDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      "../implementation-control",
      "--mount",
      "implementation=.",
    ], invocationDir);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        mounts?: Record<string, string>;
      };
    };
    expect(config.workspace?.mounts).toEqual({
      implementation: path.normalize(invocationDir),
    });
  });

  it("bootstraps a control workspace with current directory mounted as specs", async () => {
    const workspace = makeTempWorkspace();
    const invocationDirName = "existing-specs-app";
    const invocationDir = path.join(workspace, invocationDirName);
    const controlDir = path.join(workspace, "specs-control");

    fs.mkdirSync(invocationDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      "../specs-control",
      "--mount",
      "specs=.",
    ], invocationDir);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        mounts?: Record<string, string>;
      };
    };
    expect(config.workspace?.mounts).toEqual({
      specs: path.normalize(invocationDir),
    });
  });

  it("keeps implementation local when only a nested implementation subpath is mounted", async () => {
    const workspace = makeTempWorkspace();
    const controlDirName = "nested-subpath-control";
    const controlDir = path.join(workspace, controlDirName);
    const generatedDir = path.join(workspace, "generated");

    fs.mkdirSync(generatedDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      controlDirName,
      "--mount",
      "implementation/generated=./generated",
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "implementation", "generated"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        mounts?: Record<string, string>;
      };
    };
    expect(config.workspace?.mounts).toEqual({
      "implementation/generated": path.normalize(generatedDir),
    });
  });

  it("keeps attached invocation directories discoverable via workspace.link for mounted bootstrap", async () => {
    const workspace = makeTempWorkspace();
    const invocationDirName = "attached-app";
    const invocationDir = path.join(workspace, invocationDirName);
    const controlDir = path.join(workspace, "control");

    fs.mkdirSync(invocationDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      "../control",
      "--mount",
      "implementation=.",
    ], invocationDir);

    expect(result.code).toBe(0);

    const invocationWorkspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    expect(fs.existsSync(invocationWorkspaceLinkPath)).toBe(true);

    const sourceLink = JSON.parse(fs.readFileSync(invocationWorkspaceLinkPath, "utf-8")) as {
      schemaVersion: number;
      records: Array<{ workspacePath: string }>;
    };
    expect(sourceLink.schemaVersion).toBe(1);
    expect(sourceLink.records.map((record) => record.workspacePath)).toContain("../control");

    const targetWorkspaceLinkPath = path.join(controlDir, ".rundown", "workspace.link");
    expect(fs.existsSync(targetWorkspaceLinkPath)).toBe(true);
    expect(fs.readFileSync(targetWorkspaceLinkPath, "utf-8").trim()).toBe("../attached-app");

    const selection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: createNodeFileSystem(),
      invocationDir,
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) {
      throw new Error(selection.message);
    }

    expect(path.resolve(selection.workspaceRoot)).toBe(path.resolve(controlDir));
    expect(selection.executionContext.isLinkedWorkspace).toBe(true);
  });

  it("materializes only local buckets for bare mounted control workspace", async () => {
    const workspace = makeTempWorkspace();
    const controlDirName = "mounted-control-bare";
    const controlDir = path.join(workspace, controlDirName);
    const externalSpecsDir = path.join(workspace, ".specs");
    const externalDesignDir = path.join(workspace, ".design");
    const externalMigrationsDir = path.join(workspace, ".migrations");
    const externalPredictionDir = path.join(workspace, ".prediction");

    fs.mkdirSync(externalSpecsDir, { recursive: true });
    fs.mkdirSync(externalDesignDir, { recursive: true });
    fs.mkdirSync(externalMigrationsDir, { recursive: true });
    fs.mkdirSync(externalPredictionDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      controlDirName,
      "--mount",
      "implementation=.",
      "--mount",
      "specs=./.specs",
      "--mount",
      "design=./.design",
      "--mount",
      "migrations=./.migrations",
      "--mount",
      "prediction=./.prediction",
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "design"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, ".rundown", "config.json"))).toBe(true);
  });

  it("materializes only unmapped local buckets for mixed mounted start", async () => {
    const workspace = makeTempWorkspace();
    const controlDirName = "mounted-control-mixed";
    const controlDir = path.join(workspace, controlDirName);
    const externalSpecsDir = path.join(workspace, ".specs");

    fs.mkdirSync(externalSpecsDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      controlDirName,
      "--mount",
      "implementation=.",
      "--mount",
      "specs=./.specs",
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(false);

    expect(fs.existsSync(path.join(controlDir, "design", "current", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(true);
  });

  it("adopts current directory into positional control workspace and hands off into migrate", async () => {
    const workspace = makeTempWorkspace();
    const invocationDir = path.join(workspace, "existing-app");
    const controlDir = path.join(workspace, "control");

    fs.mkdirSync(invocationDir, { recursive: true });
    fs.writeFileSync(path.join(invocationDir, "README.md"), "# Existing app\n", "utf-8");
    fs.writeFileSync(path.join(invocationDir, "Target.md"), "# Adopted design\n\nDraft content.\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const migrateWorkerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
      "const fullDocMatch=prompt.match(/## Full document\\n\\n([\\s\\S]*?)\\n\\n## Design context/);",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceDoc=fullDocMatch&&fullDocMatch[1]?fullDocMatch[1]:'';",
      "  console.log(sourceDoc.length>0?sourceDoc:'\\n');",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Verify whether the research output is acceptable.')){",
      "  console.log('OK');",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Diagnose why research verification keeps failing.')){",
      "  console.log('UNRESOLVED: test worker does not need diagnosis');",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
      "  console.log('DONE');",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Verify whether the selected task is complete.')){",
      "  console.log('OK');",
      "  process.exit(0);",
      "}",
      "console.log('applied');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      ".",
      "../control",
      "--",
      "node",
      "-e",
      migrateWorkerScript,
    ], invocationDir);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code, combinedOutput).toBe(0);
    expect(fs.existsSync(path.join(controlDir, ".rundown", "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "implementation"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "prediction"))).toBe(true);

    expect(fs.existsSync(path.join(controlDir, "design", "current", "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, "design", "revisions", "rev.0", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(controlDir, "design", "revisions", "rev.0.meta.json"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        design?: {
          currentPath?: string;
        };
      };
    };
    expect(path.normalize(config.workspace?.design?.currentPath ?? "")).toBe(path.normalize(invocationDir));
    expect(combinedOutput).toContain("Released design revision rev.0 from current design before migration planning.");
    expect(combinedOutput).toContain("Migrations are caught up to rev.0");
  });

  it("fails when --mount declaration is malformed", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "implementation",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --mount value");
    expect(stderr).toContain("logical-path=target-path");
  });

  it("fails when positional design path resolves to an existing file", async () => {
    const workspace = makeTempWorkspace();
    const designFileName = "README.md";
    const designFilePath = path.join(workspace, designFileName);
    fs.writeFileSync(designFilePath, "# Not a directory\n", "utf-8");

    const result = await runCli([
      "start",
      designFileName,
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --from-design value");
    expect(stderr).toContain("expected a directory path");
    expect(stderr).toContain(path.normalize(designFilePath));
  });

  it("creates both positional directories when design-dir and workdir do not exist", async () => {
    const workspace = makeTempWorkspace();
    const invocationDir = path.join(workspace, "invocation");
    const missingDesignDir = path.join(invocationDir, "new-design");
    const controlDir = path.join(workspace, "control");

    fs.mkdirSync(invocationDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "./new-design",
      "../control",
    ], invocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(missingDesignDir)).toBe(true);
    expect(fs.statSync(missingDesignDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(missingDesignDir, "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(controlDir, ".rundown", "config.json"))).toBe(true);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as { workspace?: { design?: { currentPath?: string } } };
    expect(path.normalize(config.workspace?.design?.currentPath ?? "")).toBe(path.normalize(missingDesignDir));
  });

  it("fails when --mount reuses the same logical path", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "implementation=.",
      "--mount",
      "implementation=./src",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --mount declarations");
    expect(stderr).toContain("provided more than once");
  });

  it("fails when --mount logical paths normalize to the same value", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "implementation=.",
      "--mount",
      "implementation/.=./generated",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --mount declarations");
    expect(stderr).toContain("provided more than once");
  });

  it("fails when --mount logical path is invalid", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "../implementation=.",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Invalid --mount logical path");
    expect(stderr).toContain("normalized rundown logical path");
  });

  it("fails when --mount is combined with legacy directory flags", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "implementation=.",
      "--design-dir",
      "docs/design",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Unsupported start option combination");
    expect(stderr).toContain("--mount cannot be combined with --design-dir");
  });

  it("fails when --mount is combined with --from-design", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "start",
      "--mount",
      "implementation=.",
      "--from-design",
      ".",
    ], workspace);

    expect(result.code).toBe(1);
    const stderr = [...result.errors, ...result.stderrWrites].join("\n");
    expect(stderr).toContain("Unsupported start option combination");
    expect(stderr).toContain("--from-design");
  });

  it("creates the same clean scaffold for non-empty directories", async () => {
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
      "--dir",
      projectDirName,
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(projectDir, "implementation"))).toBe(true);
    expect(fs.statSync(path.join(projectDir, "implementation")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(projectDir, "migrations"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "implementation"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "prediction"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "specs"))).toEqual([]);

    const targetDesignPath = path.join(projectDir, "design", "current", "Target.md");
    const targetDesignSource = fs.readFileSync(targetDesignPath, "utf-8");
    expect(targetDesignSource).toBe("");
  });

  it("creates an empty local design target for empty directories", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "empty-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "implementation"))).toBe(true);
    expect(fs.statSync(path.join(projectDir, "implementation")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(projectDir, "migrations"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "implementation"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "prediction"))).toEqual([]);
    expect(fs.readdirSync(path.join(projectDir, "specs"))).toEqual([]);
    expect(fs.readFileSync(path.join(projectDir, "design", "current", "Target.md"), "utf-8")).toBe("");
  });

  it("produces the same no-migration scaffold in empty and non-empty directories", async () => {
    const workspace = makeTempWorkspace();
    const emptyProjectDirName = "empty-baseline";
    const nonEmptyProjectDirName = "existing-baseline";
    const nonEmptyProjectDir = path.join(workspace, nonEmptyProjectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    fs.mkdirSync(nonEmptyProjectDir, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyProjectDir, "README.md"), "# Existing project\n", "utf-8");
    fs.mkdirSync(path.join(nonEmptyProjectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(nonEmptyProjectDir, "src", "index.ts"), "export const value = 1;\n", "utf-8");

    const emptyResult = await runCli([
      "start",
      "--dir",
      emptyProjectDirName,
    ], workspace);
    const nonEmptyResult = await runCli([
      "start",
      "--dir",
      nonEmptyProjectDirName,
    ], workspace);

    expect(emptyResult.code).toBe(0);
    expect(nonEmptyResult.code).toBe(0);

    const emptyScaffold = readScaffoldState(path.join(workspace, emptyProjectDirName));
    const nonEmptyScaffold = readScaffoldState(path.join(workspace, nonEmptyProjectDirName));

    expect(nonEmptyScaffold.readmeSource).toBe("# Existing project\n");
    expect(fs.readFileSync(path.join(nonEmptyProjectDir, "src", "index.ts"), "utf-8")).toBe("export const value = 1;\n");

    const { readmeSource: _emptyReadmeSource, ...emptyScaffoldComparable } = emptyScaffold;
    const { readmeSource: _nonEmptyReadmeSource, ...nonEmptyScaffoldComparable } = nonEmptyScaffold;
    expect(emptyScaffoldComparable).toEqual(nonEmptyScaffoldComparable);
    expect(emptyScaffold.migrationEntries).toEqual([]);
    expect(nonEmptyScaffold.migrationEntries).toEqual([]);
  });

  it("does not overwrite existing local Target.md when start is re-run", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "rerun-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const firstRun = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);
    expect(firstRun.code).toBe(0);

    const targetPath = path.join(projectDir, "design", "current", "Target.md");
    const preservedTarget = "# Existing local target\n\nkeep this content\n";
    fs.writeFileSync(targetPath, preservedTarget, "utf-8");

    const secondRun = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);

    expect(secondRun.code).toBe(0);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe(preservedTarget);
  });

  it("does not overwrite or remove existing implementation/ content when start is re-run", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "rerun-implementation-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const firstRun = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);
    expect(firstRun.code).toBe(0);

    const implementationKeepPath = path.join(projectDir, "implementation", "keep.ts");
    const preservedImplementationSource = "export const keep = true;\n";
    fs.writeFileSync(implementationKeepPath, preservedImplementationSource, "utf-8");

    const secondRun = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);

    expect(secondRun.code).toBe(0);
    expect(fs.readFileSync(implementationKeepPath, "utf-8")).toBe(preservedImplementationSource);
  });

  it("does not overwrite or relocate mounted external implementation content when start is re-run", async () => {
    const workspace = makeTempWorkspace();
    const invocationDirName = "external-implementation-app";
    const invocationDir = path.join(workspace, invocationDirName);
    const controlDir = path.join(workspace, "mounted-control-rerun");

    fs.mkdirSync(path.join(invocationDir, "src"), { recursive: true });
    const implementationFilePath = path.join(invocationDir, "src", "main.ts");
    const originalImplementationSource = "export const mounted = true;\n";
    fs.writeFileSync(implementationFilePath, originalImplementationSource, "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const firstRun = await runCli([
      "start",
      "--dir",
      "../mounted-control-rerun",
      "--mount",
      "implementation=.",
    ], invocationDir);
    expect(firstRun.code).toBe(0);

    const secondRun = await runCli([
      "start",
      "--dir",
      "../mounted-control-rerun",
      "--mount",
      "implementation=.",
    ], invocationDir);

    expect(secondRun.code).toBe(0);
    expect(fs.existsSync(implementationFilePath)).toBe(true);
    expect(fs.readFileSync(implementationFilePath, "utf-8")).toBe(originalImplementationSource);
    expect(fs.existsSync(path.join(controlDir, "implementation", "src", "main.ts"))).toBe(false);

    const config = JSON.parse(
      fs.readFileSync(path.join(controlDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        mounts?: Record<string, string>;
      };
    };

    expect(config.workspace?.mounts).toEqual({
      implementation: path.normalize(invocationDir),
    });
  });

  it("keeps custom design dir while leaving migrations empty in non-empty workspace", async () => {
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

    expect(fs.readdirSync(path.join(projectDir, "migrations"))).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, "docs", "design", "current", "Target.md"))).toBe(true);
  });

  it("uses custom workspace mapping and leaves custom migrations dir empty", async () => {
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

    expect(fs.readdirSync(path.join(projectDir, "changesets"))).toEqual([]);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as {
      workspace?: {
        directories?: {
          design?: string;
          implementation?: string;
          specs?: string;
          migrations?: string;
          prediction?: string;
        };
      };
    };

    expect(config.workspace?.directories).toEqual({
      design: "docs/design",
      implementation: "implementation",
      specs: "quality/specs",
      migrations: "changesets",
      prediction: "prediction",
    });
  });

  it("uses an external directory as design/current when --from-design is provided", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "from-design-target";
    const projectDir = path.join(workspace, projectDirName);
    const externalDesignDir = path.join(workspace, "external-notes");

    fs.mkdirSync(externalDesignDir, { recursive: true });
    fs.writeFileSync(path.join(externalDesignDir, "Notes.md"), "# Existing notes\n", "utf-8");
    fs.writeFileSync(path.join(externalDesignDir, "Plan.md"), "# Plan\n", "utf-8");

    const result = await runCli([
      "start",
      "--dir",
      projectDirName,
      "--from-design",
      externalDesignDir,
    ], workspace);

    expect(result.code).toBe(0);

    // Seed Target.md must NOT be created in the external dir
    expect(fs.existsSync(path.join(externalDesignDir, "Target.md"))).toBe(false);
    // Original notes are untouched
    expect(fs.readFileSync(path.join(externalDesignDir, "Notes.md"), "utf-8")).toBe("# Existing notes\n");

    // No design/current/ scaffolding in the project dir
    expect(fs.existsSync(path.join(projectDir, "design", "current"))).toBe(false);

    // Config persists the absolute external path
    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as { workspace?: { design?: { currentPath?: string } } };
    expect(config.workspace?.design?.currentPath).toBe(path.normalize(externalDesignDir));
  });

  it("does not create a local Target.md when config already defines external design/current", async () => {
    const workspace = makeTempWorkspace();
    const externalDesignDir = path.join(workspace, "external-design");

    fs.mkdirSync(externalDesignDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          design: {
            currentPath: externalDesignDir,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "start",
      "--dir",
      ".",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design", "current", "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(externalDesignDir, "Target.md"))).toBe(false);
  });

  it("does not create local Target.md on rerun after external design was configured", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "external-config-rerun";
    const projectDir = path.join(workspace, projectDirName);
    const externalDesignDir = path.join(workspace, "external-design-rerun");

    fs.mkdirSync(externalDesignDir, { recursive: true });
    fs.writeFileSync(path.join(externalDesignDir, "Notes.md"), "# Existing notes\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

    const initialResult = await runCli([
      "start",
      "--dir",
      projectDirName,
      "--from-design",
      externalDesignDir,
    ], workspace);
    expect(initialResult.code).toBe(0);

    const rerunResult = await runCli([
      "start",
      "--dir",
      projectDirName,
    ], workspace);
    expect(rerunResult.code).toBe(0);

    expect(fs.existsSync(path.join(projectDir, "design", "current", "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(externalDesignDir, "Target.md"))).toBe(false);

    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
    ) as { workspace?: { design?: { currentPath?: string } } };
    expect(config.workspace?.design?.currentPath).toBe(path.normalize(externalDesignDir));
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

function readScaffoldState(projectDir: string): {
  targetSource: string;
  migrationEntries: string[];
  implementationEntries: string[];
  predictionEntries: string[];
  directories: {
    designCurrentExists: boolean;
    implementationExists: boolean;
    specsExists: boolean;
    migrationsExists: boolean;
    predictionExists: boolean;
  };
  configWorkspace: {
    directories?: {
      design?: string;
      implementation?: string;
      specs?: string;
      migrations?: string;
      prediction?: string;
    };
    placement?: {
      design?: string;
      implementation?: string;
      specs?: string;
      migrations?: string;
      prediction?: string;
    };
  };
  readmeSource: string;
} {
  const config = JSON.parse(
    fs.readFileSync(path.join(projectDir, ".rundown", "config.json"), "utf-8"),
  ) as {
    workspace?: {
      directories?: {
        design?: string;
        implementation?: string;
        specs?: string;
        migrations?: string;
        prediction?: string;
      };
      placement?: {
        design?: string;
        implementation?: string;
        specs?: string;
        migrations?: string;
        prediction?: string;
      };
    };
  };

  const readmePath = path.join(projectDir, "README.md");

  return {
    targetSource: fs.readFileSync(path.join(projectDir, "design", "current", "Target.md"), "utf-8"),
    migrationEntries: fs.readdirSync(path.join(projectDir, "migrations")),
    implementationEntries: fs.readdirSync(path.join(projectDir, "implementation")),
    predictionEntries: fs.readdirSync(path.join(projectDir, "prediction")),
    directories: {
      designCurrentExists: fs.existsSync(path.join(projectDir, "design", "current")),
      implementationExists: fs.existsSync(path.join(projectDir, "implementation")),
      specsExists: fs.existsSync(path.join(projectDir, "specs")),
      migrationsExists: fs.existsSync(path.join(projectDir, "migrations")),
      predictionExists: fs.existsSync(path.join(projectDir, "prediction")),
    },
    configWorkspace: {
      directories: config.workspace?.directories,
      placement: config.workspace?.placement,
    },
    readmeSource: fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf-8") : "",
  };
}
