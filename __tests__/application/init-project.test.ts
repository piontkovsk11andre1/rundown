import { describe, expect, it, vi } from "vitest";
import {
  createInitProject,
  type InitProjectDependencies,
} from "../../src/application/init-project.js";
import { DEFAULT_PLAN_LOOP_TEMPLATE } from "../../src/domain/defaults.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/index.js";

describe("init-project", () => {
  it("creates local .rundown in cwd when no explicit config dir is provided", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.exists)).toHaveBeenCalledWith("/workspace/.rundown");
    expect(vi.mocked(fileSystem.exists)).toHaveBeenCalledWith("/workspace/.rundown/tools");
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith("/workspace/.rundown", { recursive: true });
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith("/workspace/.rundown/tools", { recursive: true });
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/^\/workspace\/\.rundown\//),
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      "{}\n",
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/agent.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/help.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/discuss.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/vars.json",
      "{}\n",
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/undo.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/resolve.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/deep-plan.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/plan-loop.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/plan-prepend.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/plan-append.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/research-verify.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/research-repair.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/research-resolve.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/research-output-contract.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/test-verify.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/test-future.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/test-materialized.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate-context.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate-snapshot.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate-backlog.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate-review.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/migrate-ux.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-seed.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-seed-yn.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-seed-success-error.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-execute.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-stream-execute.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/query-aggregate.md",
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
    expect(vi.mocked(fileSystem.exists)).toHaveBeenCalledWith(`${explicitConfigDir}/tools`);
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith(explicitConfigDir, { recursive: true });
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith(`${explicitConfigDir}/tools`, { recursive: true });
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/^\/workspace\/config\/\.rundown-custom\//),
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/config.json",
      "{}\n",
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/agent.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/help.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/discuss.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/vars.json",
      "{}\n",
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/undo.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/resolve.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/deep-plan.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/plan-loop.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/plan-prepend.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/plan-append.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/research-verify.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/research-repair.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/research-resolve.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/research-output-contract.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/test-verify.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/test-future.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/test-materialized.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate-context.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate-snapshot.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate-backlog.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate-review.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/migrate-ux.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-seed.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-seed-yn.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-seed-success-error.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-execute.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-stream-execute.md",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/config/.rundown-custom/query-aggregate.md",
      expect.any(String),
    );
  });

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

  it("is idempotent and preserves existing agent.md on repeated init", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    const initProject = createInitProject(dependencies);

    const firstCode = await initProject();

    expect(firstCode).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/agent.md",
      expect.any(String),
    );

    vi.mocked(fileSystem.writeText).mockClear();
    events.length = 0;

    const secondCode = await initProject();

    expect(secondCode).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.kind === "warn" &&
          event.message.endsWith("/agent.md already exists, skipping."),
      ),
    ).toBe(true);
  });

  it("writes worker into config.json when --default-worker is provided", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject({ defaultWorker: "opencode" });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      JSON.stringify({ workers: { default: ["opencode"] } }, null, 2) + "\n",
    );
  });

  it("writes default empty config.json when --worker is not provided", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      "{}\n",
    );
  });

  it("preserves existing vars.json and config.json by default", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    vi.mocked(fileSystem.exists).mockImplementation((targetPath: string) => {
      return targetPath === "/workspace/.rundown/vars.json"
        || targetPath === "/workspace/.rundown/config.json";
    });
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalledWith(
      "/workspace/.rundown/vars.json",
      expect.any(String),
    );
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      expect.any(String),
    );
    expect(events.some((event) => event.kind === "warn" && event.message.endsWith("/vars.json (already exists)."))).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message.endsWith("/config.json (already exists)."))).toBe(true);
  });

  it("overwrites existing vars.json and config.json when overwriteConfig is enabled", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    vi.mocked(fileSystem.exists).mockImplementation((targetPath: string) => {
      return targetPath === "/workspace/.rundown/vars.json"
        || targetPath === "/workspace/.rundown/config.json";
    });
    const initProject = createInitProject(dependencies);

    const code = await initProject({ overwriteConfig: true });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/vars.json",
      "{}\n",
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.rundown/config.json",
      "{}\n",
    );
    expect(events.some((event) => event.kind === "success" && event.message.startsWith("Updated ") && event.message.endsWith("/vars.json"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.startsWith("Updated ") && event.message.endsWith("/config.json"))).toBe(true);
  });

  it("creates .gitignore with .rundown when --gitignore is set and no .gitignore exists", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject({ gitignore: true });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.gitignore",
      ".rundown\n",
    );
    expect(events).toContainEqual({ kind: "success", message: "Created .gitignore with .rundown" });
  });

  it("appends .rundown to existing .gitignore when not already present", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    // Simulate an existing .gitignore
    const existingContent = "node_modules\ndist\n";
    vi.mocked(fileSystem.exists).mockImplementation((p: string) => p === "/workspace/.gitignore");
    vi.mocked(fileSystem.readText).mockReturnValue(existingContent);
    const initProject = createInitProject(dependencies);

    const code = await initProject({ gitignore: true });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/workspace/.gitignore",
      "node_modules\ndist\n.rundown\n",
    );
    expect(events).toContainEqual({ kind: "success", message: "Added .rundown to .gitignore" });
  });

  it("skips .gitignore update when .rundown is already listed", async () => {
    const { dependencies, fileSystem, events } = createDependencies();
    const existingContent = "node_modules\n.rundown\ndist\n";
    vi.mocked(fileSystem.exists).mockImplementation((p: string) => p === "/workspace/.gitignore");
    vi.mocked(fileSystem.readText).mockReturnValue(existingContent);
    const initProject = createInitProject(dependencies);

    const code = await initProject({ gitignore: true });

    expect(code).toBe(0);
    // Should NOT write to .gitignore
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalledWith(
      "/workspace/.gitignore",
      expect.any(String),
    );
    expect(events).toContainEqual({ kind: "warn", message: ".gitignore already contains .rundown, skipping." });
  });

  it("does not touch .gitignore when --gitignore is not set", async () => {
    const { dependencies, fileSystem } = createDependencies();
    const initProject = createInitProject(dependencies);

    const code = await initProject();

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.exists)).not.toHaveBeenCalledWith("/workspace/.gitignore");
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalledWith(
      "/workspace/.gitignore",
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
