import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartProject } from "../../src/application/start-project.js";
import { EXIT_CODE_SUCCESS } from "../../src/domain/exit-codes.js";
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
    expect(fs.existsSync(predictionPath)).toBe(true);
    expect(fs.statSync(predictionPath).isDirectory()).toBe(true);
  });

  it("bootstraps design target and mirrors existing implementation into prediction", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    const sourceFilePath = path.join(workspace, "src", "foo.ts");
    const packageJsonPath = path.join(workspace, "package.json");
    fs.writeFileSync(sourceFilePath, "export const foo = 1;\n");
    fs.writeFileSync(packageJsonPath, "{\"name\":\"bootstrap-test\"}\n");

    const harness = createHarness(workspace);
    const description = "Bootstrap existing implementation";

    const code = await harness.startProject({ description });

    expect(code).toBe(EXIT_CODE_SUCCESS);

    const targetPath = path.join(workspace, "design", "current", "Target.md");
    const targetSource = fs.readFileSync(targetPath, "utf-8");
    expect(targetSource).toContain(`# ${description}`);
    expect(targetSource).toContain(
      "Bootstrapped from existing implementation. Replace with target description in domain language; do not list implementation details.",
    );

    const mirroredSource = fs.readFileSync(path.join(workspace, "prediction", "src", "foo.ts"));
    const originalSource = fs.readFileSync(sourceFilePath);
    expect(mirroredSource.equals(originalSource)).toBe(true);

    const mirroredPackageJson = fs.readFileSync(path.join(workspace, "prediction", "package.json"));
    expect(mirroredPackageJson.equals(fs.readFileSync(packageJsonPath))).toBe(true);
  });

  it("keeps prediction empty and does not bootstrap when workspace starts fully empty", async () => {
    const workspace = makeTempWorkspace();
    const harness = createHarness(workspace);

    const code = await harness.startProject({ description: "Empty workspace" });

    expect(code).toBe(EXIT_CODE_SUCCESS);

    const targetPath = path.join(workspace, "design", "current", "Target.md");
    const targetSource = fs.readFileSync(targetPath, "utf-8");
    expect(targetSource).toContain("# Empty workspace");
    expect(targetSource).not.toContain("Bootstrapped from existing implementation");

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

    const code = await harness.startProject({ description: "Should not override" });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(fs.readFileSync(existingTargetPath, "utf-8")).toBe("# Existing target\n\nkeep me\n");
    expect(fs.readFileSync(existingPredictionPath, "utf-8")).toBe("existing prediction content\n");
    expect(fs.existsSync(path.join(workspace, "prediction", "src", "foo.ts"))).toBe(false);
  });

  it("supports --no-bootstrap by keeping prediction empty and retaining default target seed", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "foo.ts"), "export const foo = 3;\n");

    const harness = createHarness(workspace);
    const description = "No bootstrap";

    const code = await harness.startProject({ description, noBootstrap: true });

    expect(code).toBe(EXIT_CODE_SUCCESS);

    const targetPath = path.join(workspace, "design", "current", "Target.md");
    const targetSource = fs.readFileSync(targetPath, "utf-8");
    expect(targetSource).toBe(`# ${description}\n\n${description}\n`);
    expect(targetSource).not.toContain("Bootstrapped from existing implementation");

    expect(fs.existsSync(path.join(workspace, "prediction", "src", "foo.ts"))).toBe(false);
    const predictionFiles = listFilesRecursively(path.join(workspace, "prediction"));
    expect(predictionFiles).toEqual([]);
  });
});

function createHarness(workspaceRoot: string): {
  startProject: ReturnType<typeof createStartProject>;
  events: ApplicationOutputEvent[];
  gitClient: GitClient;
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
      workingDirectory,
    }),
    events,
    gitClient,
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
