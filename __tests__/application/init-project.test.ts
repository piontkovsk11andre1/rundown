import { describe, expect, it, vi } from "vitest";
import {
  createInitProject,
  type InitProjectDependencies,
} from "../../src/application/init-project.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/index.js";

describe("init-project", () => {
  it("creates local .rundown in cwd when no explicit config dir is provided", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.exists)).toHaveBeenCalledWith("/workspace/.rundown");
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith("/workspace/.rundown", { recursive: true });
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/^\/workspace\/\.rundown\//),
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      expect.any(String),
    );
  });

  it("creates templates inside explicit --config-dir target", async () => {
    const explicitConfigDir = "/workspace/config/.rundown-custom";
    const { dependencies, fileSystem } = createDependencies({
      configDir: {
        configDir: explicitConfigDir,
        isExplicit: true,
      },
    });
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.exists)).toHaveBeenCalledWith(explicitConfigDir);
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith(explicitConfigDir, { recursive: true });
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/^\/workspace\/config\/\.rundown-custom\//),
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/config.json",
      expect.any(String),
    );
  });
});

function createDependencies(overrides: {
  configDir?: InitProjectDependencies["configDir"];
} = {}): {
  dependencies: InitProjectDependencies;
  fileSystem: InitProjectDependencies["fileSystem"];
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  const existingPaths = new Set<string>();

  const fileSystem: InitProjectDependencies["fileSystem"] = {
    exists: vi.fn((targetPath: string) => existingPaths.has(targetPath)),
    readText: vi.fn(),
    writeText: vi.fn((targetPath: string) => {
      existingPaths.add(targetPath);
    }),
    mkdir: vi.fn((dirPath: string) => {
      existingPaths.add(dirPath);
    }),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  return {
    dependencies: {
      fileSystem,
      configDir: overrides.configDir,
      pathOperations: {
        join: vi.fn((...parts: string[]) => parts.join("/").replace(/\/+/g, "/")),
        resolve: vi.fn((...parts: string[]) => {
          const joined = parts.join("/").replace(/\/+/g, "/");
          if (joined.startsWith("/")) {
            return joined;
          }
          return `/workspace/${joined}`.replace(/\/+/g, "/");
        }),
        dirname: vi.fn((filePath: string) => {
          const segments = filePath.split("/").filter(Boolean);
          if (segments.length <= 1) {
            return "/";
          }
          return `/${segments.slice(0, -1).join("/")}`;
        }),
        relative: vi.fn((from: string, to: string) => `${from}->${to}`),
        isAbsolute: vi.fn((filePath: string) => filePath.startsWith("/")),
      },
      output: {
        emit(event) {
          events.push(event);
        },
      },
    },
    fileSystem,
    events,
  };
}
