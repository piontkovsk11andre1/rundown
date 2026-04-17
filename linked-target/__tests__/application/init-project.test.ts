import { describe, expect, it, vi } from "vitest";
import {
  createInitProject,
  type InitProjectDependencies,
} from "../../../src/application/init-project.js";
import { DEFAULT_PLAN_LOOP_TEMPLATE } from "../../../src/domain/defaults.js";
import type { ApplicationOutputEvent } from "../../../src/domain/ports/index.js";

describe("init-project", () => {
  it("scaffolds plan-loop.md with the built-in loop template", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/plan-loop.md",
      DEFAULT_PLAN_LOOP_TEMPLATE,
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
