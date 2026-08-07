import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartProject } from "../../src/application/start-project.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
  type ExitCode,
} from "../../src/domain/exit-codes.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import type {
  ApplicationOutputEvent,
  GitClient,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../../src/domain/ports/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dirPath = tempDirs.pop();
    if (dirPath) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }
});

describe("start-project", () => {
  it("creates prediction/ for a fresh start", async () => {
    const workspace = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({ description: "Fresh start" });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    const predictionPath = path.join(workspace, "prediction");
    const implementationPath = path.join(workspace, "implementation");
    expect(fs.existsSync(implementationPath)).toBe(true);
    expect(fs.statSync(implementationPath).isDirectory()).toBe(true);
    expect(fs.existsSync(predictionPath)).toBe(true);
    expect(fs.statSync(predictionPath).isDirectory()).toBe(true);
  });

  it("persists implementation in generated workspace config", async () => {
    const workspace = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({ description: "Config persistence" });

    expect(code).toBe(EXIT_CODE_SUCCESS);

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

  it("creates an empty design target and leaves prediction empty in non-empty workspaces", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "foo.ts"), "export const foo = 1;\n");
    fs.writeFileSync(path.join(workspace, "package.json"), "{\"name\":\"bootstrap-test\"}\n");

    const harness = createHarness(workspace);

    const code = await harness.startProject({ dir: workspace });

    expect(code).toBe(EXIT_CODE_SUCCESS);

    const targetPath = path.join(workspace, "design", "current", "Target.md");
    const targetSource = fs.readFileSync(targetPath, "utf-8");
    expect(targetSource).toBe("");

    const migrationsPath = path.join(workspace, "migrations");
    const implementationPath = path.join(workspace, "implementation");
    expect(fs.existsSync(migrationsPath)).toBe(true);
    expect(fs.statSync(migrationsPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(migrationsPath)).toEqual([]);

    expect(fs.existsSync(implementationPath)).toBe(true);
    expect(fs.statSync(implementationPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(implementationPath)).toEqual([]);

    expect(fs.existsSync(path.join(workspace, "prediction", "src", "foo.ts"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "prediction", "package.json"))).toBe(false);
  });

  it("creates an empty design target and keeps prediction empty when workspace starts fully empty", async () => {
    const workspace = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({ description: "Empty workspace" });

    expect(code).toBe(EXIT_CODE_SUCCESS);

    const targetPath = path.join(workspace, "design", "current", "Target.md");
    const targetSource = fs.readFileSync(targetPath, "utf-8");
    expect(targetSource).toBe("");

    const migrationsPath = path.join(workspace, "migrations");
    const implementationPath = path.join(workspace, "implementation");
    expect(fs.existsSync(migrationsPath)).toBe(true);
    expect(fs.statSync(migrationsPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(migrationsPath)).toEqual([]);

    expect(fs.existsSync(implementationPath)).toBe(true);
    expect(fs.statSync(implementationPath).isDirectory()).toBe(true);
    expect(fs.readdirSync(implementationPath)).toEqual([]);

    const predictionFiles = listFilesRecursively(path.join(workspace, "prediction"));
    expect(predictionFiles).toEqual([]);
  });

  it("does not overwrite existing design target or existing prediction content", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "prediction"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });

    const existingTargetPath = path.join(workspace, "design", "current", "Target.md");
    const existingPredictionPath = path.join(workspace, "prediction", "keep.txt");
    fs.writeFileSync(existingTargetPath, "# Existing target\n\nkeep me\n");
    fs.writeFileSync(existingPredictionPath, "existing prediction content\n");
    fs.writeFileSync(path.join(workspace, "src", "foo.ts"), "export const foo = 2;\n");

    const harness = createHarness(workspace);

    const code = await harness.startProject({ dir: workspace });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(fs.readFileSync(existingTargetPath, "utf-8")).toBe("# Existing target\n\nkeep me\n");
    expect(fs.readFileSync(existingPredictionPath, "utf-8")).toBe("existing prediction content\n");
    expect(fs.existsSync(path.join(workspace, "prediction", "src", "foo.ts"))).toBe(false);
  });

  it("only requests enrichment for files created during start", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "# Existing target\n", "utf-8");
    const harness = createHarness(workspace);

    const code = await harness.startProject({ dir: workspace });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(harness.runExplore).not.toHaveBeenCalled();
  });

  it("does not run explore during start", async () => {
    const workspace = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({ description: "Enriched start" });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(harness.runExplore).not.toHaveBeenCalled();

    const warningMessages = harness.events
      .filter((event) => event.kind === "warn")
      .map((event) => event.message);
    expect(warningMessages.some((message) => message.includes("Explore integration is not configured"))).toBe(false);
  });

  it("does not enrich when using external --from-design", async () => {
    const workspace = makeTempWorkspace();
    const externalDesignDir = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({
      description: "Use external design/current",
      fromDesign: externalDesignDir,
    });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(harness.runExplore).not.toHaveBeenCalled();
  });

  it("creates missing --from-design path as a directory", async () => {
    const workspace = makeTempWorkspace();
    const missingDesignDir = path.join(workspace, "missing-design-input");
    const controlDir = path.join(workspace, "control");
    const harness = createHarness(workspace);

    const code = await harness.startProject({
      description: "Create missing design dir",
      dir: controlDir,
      fromDesign: missingDesignDir,
    });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(fs.existsSync(missingDesignDir)).toBe(true);
    expect(fs.statSync(missingDesignDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(missingDesignDir, "Target.md"))).toBe(false);
  });

  it("does not create local Target.md when external design is already configured", async () => {
    const workspace = makeTempWorkspace();
    const externalDesignDir = makeTempWorkspace();
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

    const harness = createHarness(workspace);

    const code = await harness.startProject({ dir: workspace });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(fs.existsSync(path.join(externalDesignDir, "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "design", "current", "Target.md"))).toBe(false);
  });

  it("fails when --dir resolves to an existing file", async () => {
    const workspace = makeTempWorkspace();
    const filePath = path.join(workspace, "existing-file.txt");
    fs.writeFileSync(filePath, "not a directory\n", "utf-8");
    const harness = createHarness(workspace);

    const code = await harness.startProject({ dir: filePath });

    expect(code).toBe(EXIT_CODE_FAILURE);
    expect(harness.events.some((event) => (
      event.kind === "error"
      && event.message.includes("expected a directory path")
      && event.message.includes(filePath)
    ))).toBe(true);
  });
});

function createHarness(workspaceRoot: string): {
  startProject: ReturnType<typeof createStartProject>;
  events: ApplicationOutputEvent[];
  gitClient: GitClient;
  runExplore: ReturnType<typeof vi.fn<(source: string, cwd: string) => Promise<ExitCode>>>;
} {
  const events: ApplicationOutputEvent[] = [];
  const fileSystem = createNodeFileSystem();

  const gitClient: GitClient = {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true";
      }
      return "";
    }),
  };

  const pathOperations: PathOperationsPort = {
    join: (...parts) => path.join(...parts),
    resolve: (...parts) => path.resolve(...parts),
    dirname: (filePath) => path.dirname(filePath),
    relative: (from, to) => path.relative(from, to),
    isAbsolute: (filePath) => path.isAbsolute(filePath),
  };

  const workingDirectory: WorkingDirectoryPort = {
    cwd: () => workspaceRoot,
  };

  const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);

  return {
    startProject: createStartProject({
      fileSystem,
      gitClient,
      output: {
        emit: (event: ApplicationOutputEvent) => {
          events.push(event);
        },
      },
      pathOperations,
      runExplore,
      workingDirectory,
    }),
    events,
    gitClient,
    runExplore,
  };
}

function listFilesRecursively(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const collected: string[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isFile()) {
        collected.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }

  collected.sort((left, right) => left.localeCompare(right));
  return collected;
}

function makeTempWorkspace(): string {
  const isolatedTempRoot = path.join(path.parse(os.tmpdir()).root, "rundown-test-tmp");
  fs.mkdirSync(isolatedTempRoot, { recursive: true });
  const dirPath = fs.mkdtempSync(path.join(isolatedTempRoot, "rundown-start-app-"));
  tempDirs.push(dirPath);
  return dirPath;
}
