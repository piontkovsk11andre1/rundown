import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMigrateTask,
  discoverMigrationThreads,
  loadMigrationThreadStates,
  materializeMigrationThreadBriefs,
} from "../../src/application/migrate-task.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
  type ExitCode,
} from "../../src/domain/exit-codes.js";
import { formatMigrationFilename } from "../../src/domain/migration-parser.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import { createNoopTraceWriter } from "../../src/infrastructure/adapters/noop-trace-writer.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  InteractiveInputPort,
  SourceResolverPort,
  WorkerExecutorPort,
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

describe("migrate-task", () => {
  it("enriches each created migration and emits no configuration warning", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    let secondMigrationWasPromotedBeforeFirstExplore = false;
    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async (source) => {
      if (source.endsWith(formatMigrationFilename(2, "first-created-migration"))) {
        secondMigrationWasPromotedBeforeFirstExplore = fs.existsSync(
          path.join(workspace, "migrations", formatMigrationFilename(3, "second-created-migration")),
        );
      }
      return EXIT_CODE_SUCCESS;
    });

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "first-created-migration")),
            "# 2. First Created Migration\n\n- [ ] Draft task one\n",
            "utf-8",
          );
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 2, "second-created-migration")),
            "# 3. Second Created Migration\n\n- [ ] Draft task two\n",
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: "drafted migration files",
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const sourceResolver: SourceResolverPort = {
      resolveSources: vi.fn(async () => []),
    };

    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: {
        load: () => undefined,
      },
      sourceResolver,
      workerConfigPort: {
        load: () => undefined,
      },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput,
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runExplore).toHaveBeenNthCalledWith(
        1,
        path.join(workspace, "migrations", formatMigrationFilename(2, "first-created-migration")),
        workspace,
      );
      expect(runExplore).toHaveBeenNthCalledWith(
        2,
        path.join(workspace, "migrations", formatMigrationFilename(3, "second-created-migration")),
        workspace,
      );
      expect(secondMigrationWasPromotedBeforeFirstExplore).toBe(true);
      expect(
        fs.existsSync(path.join(workspace, ".rundown", "runs", "run-test", "drafted-migrations", "rev.1")),
      ).toBe(true);

      const rev1Meta = JSON.parse(
        fs.readFileSync(path.join(workspace, "design", "rev.1.meta.json"), "utf-8"),
      ) as {
        plannedAt?: string | null;
        migrations?: string[];
      };
      expect(rev1Meta.plannedAt).toBeTypeOf("string");
      expect(rev1Meta.migrations ?? []).toEqual([
        path.posix.join("migrations", formatMigrationFilename(2, "first-created-migration")),
        path.posix.join("migrations", formatMigrationFilename(3, "second-created-migration")),
      ]);

      const warningMessages = events
        .filter((event) => event.kind === "warn")
        .map((event) => event.message);
      expect(warningMessages.some((message) => message.includes("Explore integration is not configured"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails before promotion when staged draft filenames are not canonical", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, "2. first-created-migration.md"),
            "# 2. First Created Migration\n\n- [ ] Draft task one\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const sourceResolver: SourceResolverPort = {
      resolveSources: vi.fn(async () => []),
    };

    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: {
        load: () => undefined,
      },
      sourceResolver,
      workerConfigPort: {
        load: () => undefined,
      },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput,
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runExplore).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspace, "migrations", "2. first-created-migration.md"))).toBe(false);

      const errorMessages = events
        .filter((event) => event.kind === "error")
        .map((event) => event.message)
        .join("\n");
      expect(errorMessages).toContain("Drafted migration filenames must be canonical");
      expect(errorMessages).toContain("Invalid filenames: 2. first-created-migration.md");
      expect(errorMessages).not.toContain("rev.1: 2. first-created-migration.md");
      expect(errorMessages).toContain("2. first-created-migration.md");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails before promotion when staged drafts do not cover changed diff areas", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "design", "rev.1", "BillingFlow.md"),
      "# Billing\n\nNew billing workflow requirements.\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "api-migration")),
            "# 2. Api Migration\n\n- [ ] Update API handlers and request contracts for migrated endpoints.\n",
            "utf-8",
          );

          return {
            exitCode: 0,
            stdout: "drafted migration files",
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const sourceResolver: SourceResolverPort = {
      resolveSources: vi.fn(async () => []),
    };

    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: {
        load: () => undefined,
      },
      sourceResolver,
      workerConfigPort: {
        load: () => undefined,
      },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput,
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runExplore).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "api-migration")))).toBe(false);

      const errorMessages = events
        .filter((event) => event.kind === "error")
        .map((event) => event.message)
        .join("\n");
      expect(errorMessages).toContain("Drafted migrations do not appear to cover all changed design areas");
      expect(errorMessages).toContain("BillingFlow.md");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("repairs staged drafts and re-verifies before promotion", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "design", "rev.1", "BillingFlow.md"),
      "# Billing\n\nNew billing workflow requirements.\n",
      "utf-8",
    );

    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);

    let draftedFileName = "";
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          draftedFileName = formatMigrationFilename(position + 1, "api-migration");
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, draftedFileName),
            "# 2. Api Migration\n\n- [ ] Update API handlers only.\n",
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: "drafted migration files",
            stderr: "",
          };
        }

        if (prompt.includes("Repair staged migration drafts")) {
          const draftDirMatch = prompt.match(/Edit only files inside this staging directory:\s*(.+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          fs.writeFileSync(
            path.join(draftDir, draftedFileName),
            "# 2. Api Migration\n\n- [ ] Cover BillingFlow.md changes and billing workflow updates.\n",
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: "repaired staged draft",
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const sourceResolver: SourceResolverPort = {
      resolveSources: vi.fn(async () => []),
    };

    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: {
        load: () => undefined,
      },
      sourceResolver,
      workerConfigPort: {
        load: () => undefined,
      },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput,
      output: {
        emit: () => {},
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const promotedPath = path.join(workspace, "migrations", formatMigrationFilename(2, "api-migration"));
      expect(fs.existsSync(promotedPath)).toBe(true);
      expect(fs.readFileSync(promotedPath, "utf-8")).toContain("BillingFlow.md");
      expect(runExplore).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails when repair mutates real migrations directory instead of staged drafts", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "design", "rev.1", "BillingFlow.md"),
      "# Billing\n\nNew billing workflow requirements.\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    let repairWriteCount = 0;

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "api-migration")),
            "# 2. Api Migration\n\n- [ ] Update API handlers only.\n",
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: "drafted migration files",
            stderr: "",
          };
        }

        if (prompt.includes("Repair staged migration drafts")) {
          repairWriteCount += 1;
          fs.writeFileSync(
            path.join(workspace, "migrations", formatMigrationFilename(900 + repairWriteCount, "bad-repair-write")),
            "# Bad Repair Write\n\n- [ ] should never be written during staged repair\n",
            "utf-8",
          );
          return {
            exitCode: 0,
            stdout: "repaired staged draft",
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const sourceResolver: SourceResolverPort = {
      resolveSources: vi.fn(async () => []),
    };

    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: {
        load: () => undefined,
      },
      sourceResolver,
      workerConfigPort: {
        load: () => undefined,
      },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput,
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runExplore).not.toHaveBeenCalled();
      const errorMessages = events
        .filter((event) => event.kind === "error")
        .map((event) => event.message)
        .join("\n");
      expect(errorMessages).toContain("Repair must mutate staged drafts only");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("discovers thread markdown files and derives stable slugs from filenames", () => {
    const workspace = makeTempWorkspace();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "API Review.md"), "# API Review\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "a-b.md"), "# A B\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "a b.md"), "# A B duplicate slug\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "README.txt"), "not a thread\n", "utf-8");

    const threads = discoverMigrationThreads(createNodeFileSystem(), workspace);

    expect(threads.map((thread) => thread.fileName)).toEqual([
      "a b.md",
      "a-b.md",
      "API Review.md",
    ]);
    expect(threads.map((thread) => thread.threadSlug)).toEqual([
      "a-b",
      "a-b-2",
      "api-review",
    ]);
    expect(threads.map((thread) => thread.sourcePathFromWorkspace)).toEqual([
      ".rundown/threads/a b.md",
      ".rundown/threads/a-b.md",
      ".rundown/threads/API Review.md",
    ]);
  });

  it("returns no threads when .rundown/threads is missing or has no markdown files", () => {
    const workspace = makeTempWorkspace();

    const noneWhenMissing = discoverMigrationThreads(createNodeFileSystem(), workspace);
    expect(noneWhenMissing).toEqual([]);

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "notes.txt"), "no markdown\n", "utf-8");

    const noneWhenNoMarkdown = discoverMigrationThreads(createNodeFileSystem(), workspace);
    expect(noneWhenNoMarkdown).toEqual([]);
  });

  it("reconciles implementation state into design/current before migrate planning", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(workspace, "implementation", "api"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "implementation", "api", "orders.ts"),
      "export const listOrders = () => [];\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "implementation", "README.md"),
      "implementation docs\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "implementation-reconciled-change")),
            "# 2. Implementation Reconciled Change\n\n- [ ] Cover Implementation.reconciled.md updates.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "implementation",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const reconciledPath = path.join(workspace, "design", "current", "Implementation.reconciled.md");
      expect(fs.existsSync(reconciledPath)).toBe(true);
      const reconciledContent = fs.readFileSync(reconciledPath, "utf-8");
      expect(reconciledContent).toContain("This file is generated by `rundown migrate --from implementation`.");
      expect(reconciledContent).toContain("api/orders.ts");
      expect(reconciledContent).toContain("README.md");

      const infoMessages = events
        .filter((event) => event.kind === "info")
        .map((event) => event.message)
        .join("\n");
      expect(infoMessages).toContain("Reconciling design boundary from implementation changes before migration planning.");
      expect(infoMessages).toContain("Implementation reconciliation updated design/current artifact");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses resolved mounted implementation root instead of workspaceDir + implementation", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const mountedImplementationRoot = path.join(workspace, "mounted", "implementation-src");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          mounts: {
            implementation: mountedImplementationRoot,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(mountedImplementationRoot, "api"), { recursive: true });
    fs.writeFileSync(
      path.join(mountedImplementationRoot, "api", "mounted-only.ts"),
      "export const mountedOnly = true;\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(workspace, "implementation", "api"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "implementation", "api", "decoy-only.ts"),
      "export const decoyOnly = true;\n",
      "utf-8",
    );

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "implementation-mounted-source-change")),
            "# 2. Implementation Mounted Source Change\n\n- [ ] Cover Implementation.reconciled.md updates from mounted implementation source reconciliation.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test",
          rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
          cwd: workspace,
          keepArtifacts: false,
          commandName: "migrate",
        })),
        beginPhase: vi.fn(() => {
          throw new Error("not used");
        }),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ""),
        rootDir: vi.fn(() => ""),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "implementation",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const reconciledContent = fs.readFileSync(
        path.join(workspace, "design", "current", "Implementation.reconciled.md"),
        "utf-8",
      );
      expect(reconciledContent).toContain("mounted-only.ts");
      expect(reconciledContent).not.toContain("decoy-only.ts");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails with actionable guidance when implementation source root is missing", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "implementation",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      const errorMessages = events
        .filter((event) => event.kind === "error")
        .map((event) => event.message)
        .join("\n");
      expect(errorMessages).toContain("Cannot run migrate --from implementation: resolved workspace path does not exist at");
      expect(errorMessages).toContain("workspace.mounts.implementation");
      expect(errorMessages).toContain("workspace.directories.implementation");
      expect(errorMessages).toContain("workspace.placement.implementation");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails with actionable guidance when prediction source root is not a directory", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(workspace, "prediction"), "not a directory\n", "utf-8");

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "prediction",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      const errorMessages = events
        .filter((event) => event.kind === "error")
        .map((event) => event.message)
        .join("\n");
      expect(errorMessages).toContain("Cannot run migrate --from prediction: resolved workspace path is not a directory at");
      expect(errorMessages).toContain("workspace.mounts.prediction");
      expect(errorMessages).toContain("workspace.directories.prediction");
      expect(errorMessages).toContain("workspace.placement.prediction");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("reconciles prediction state into design/current before migrate planning", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(workspace, "prediction", "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "prediction", "checkout", "risk.md"),
      "# Checkout Risk\n\nPredict cancellation churn by basket size.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "prediction", "README.md"),
      "prediction docs\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "prediction-reconciled-change")),
            "# 2. Prediction Reconciled Change\n\n- [ ] Cover Prediction.reconciled.md updates.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "prediction",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const reconciledPath = path.join(workspace, "design", "current", "Prediction.reconciled.md");
      expect(fs.existsSync(reconciledPath)).toBe(true);
      const reconciledContent = fs.readFileSync(reconciledPath, "utf-8");
      expect(reconciledContent).toContain("This file is generated by `rundown migrate --from prediction`.");
      expect(reconciledContent).toContain("checkout/risk.md");
      expect(reconciledContent).toContain("README.md");

      const infoMessages = events
        .filter((event) => event.kind === "info")
        .map((event) => event.message)
        .join("\n");
      expect(infoMessages).toContain("Reconciling design boundary from prediction changes before migration planning.");
      expect(infoMessages).toContain("Prediction reconciliation updated design/current artifact");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses resolved mounted prediction root instead of workspaceDir + prediction", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const mountedPredictionRoot = path.join(workspace, "mounted", "prediction-tree");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          mounts: {
            prediction: mountedPredictionRoot,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(mountedPredictionRoot, "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(mountedPredictionRoot, "checkout", "mounted-risk.md"),
      "# Mounted Risk\n\nMounted prediction source path.\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(workspace, "prediction", "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "prediction", "checkout", "decoy-risk.md"),
      "# Decoy Risk\n\nDefault prediction folder should be ignored when mount exists.\n",
      "utf-8",
    );

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "prediction-mounted-source-change")),
            "# 2. Prediction Mounted Source Change\n\n- [ ] Cover Prediction.reconciled.md updates from mounted prediction source reconciliation.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test",
          rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
          cwd: workspace,
          keepArtifacts: false,
          commandName: "migrate",
        })),
        beginPhase: vi.fn(() => {
          throw new Error("not used");
        }),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ""),
        rootDir: vi.fn(() => ""),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "prediction",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const reconciledContent = fs.readFileSync(
        path.join(workspace, "design", "current", "Prediction.reconciled.md"),
        "utf-8",
      );
      expect(reconciledContent).toContain("mounted-risk.md");
      expect(reconciledContent).not.toContain("decoy-risk.md");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses linked workspace resolution with mounted implementation root for --from implementation", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");
    const mountedImplementationRoot = path.join(sandbox, "mounted", "implementation-src");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldReleasedDesignRevisions(sourceWorkspace, "design");
    fs.mkdirSync(path.join(sourceWorkspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(mountedImplementationRoot, "api"), { recursive: true });
    fs.writeFileSync(
      path.join(mountedImplementationRoot, "api", "mounted-only.ts"),
      "export const mountedOnly = true;\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(sourceWorkspace, "implementation", "api"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, "implementation", "api", "decoy-only.ts"),
      "export const decoyOnly = true;\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          mounts: {
            implementation: mountedImplementationRoot,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "linked-mounted-implementation-source-change")),
            "# 2. Linked Mounted Implementation Source Change\n\n- [ ] Cover Implementation.reconciled.md updates from linked mounted implementation source reconciliation.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test",
          rootDir: path.join(linkedInvocationDir, ".rundown", "runs", "run-test"),
          cwd: linkedInvocationDir,
          keepArtifacts: false,
          commandName: "migrate",
        })),
        beginPhase: vi.fn(() => {
          throw new Error("not used");
        }),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ""),
        rootDir: vi.fn(() => ""),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      configDir: path.join(linkedInvocationDir, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(linkedInvocationDir);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "implementation",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      const debugMessages = events.map((event) => `${event.kind}: ${event.message}`).join("\n");
      expect(code, debugMessages).toBe(EXIT_CODE_SUCCESS);
      const reconciledContent = fs.readFileSync(
        path.join(sourceWorkspace, "design", "current", "Implementation.reconciled.md"),
        "utf-8",
      );
      expect(reconciledContent).toContain("mounted-only.ts");
      expect(reconciledContent).not.toContain("decoy-only.ts");
      expect(fs.existsSync(path.join(linkedInvocationDir, "design", "current", "Implementation.reconciled.md"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses linked workspace resolution with mounted prediction root for --from prediction", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");
    const mountedPredictionRoot = path.join(sandbox, "mounted", "prediction-src");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldReleasedDesignRevisions(sourceWorkspace, "design");
    fs.mkdirSync(path.join(sourceWorkspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(mountedPredictionRoot, "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(mountedPredictionRoot, "checkout", "mounted-risk.md"),
      "# Mounted Risk\n\nMounted prediction source path.\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(sourceWorkspace, "prediction", "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, "prediction", "checkout", "decoy-risk.md"),
      "# Decoy Risk\n\nDefault prediction folder should be ignored when mount exists.\n",
      "utf-8",
    );

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          mounts: {
            prediction: mountedPredictionRoot,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "linked-mounted-prediction-source-change")),
            "# 2. Linked Mounted Prediction Source Change\n\n- [ ] Cover Prediction.reconciled.md updates from linked mounted prediction source reconciliation.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test",
          rootDir: path.join(linkedInvocationDir, ".rundown", "runs", "run-test"),
          cwd: linkedInvocationDir,
          keepArtifacts: false,
          commandName: "migrate",
        })),
        beginPhase: vi.fn(() => {
          throw new Error("not used");
        }),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ""),
        rootDir: vi.fn(() => ""),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      configDir: path.join(linkedInvocationDir, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(linkedInvocationDir);
    try {
      const code = await migrateTask({
        dir: "migrations",
        sourceMode: "prediction",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      const debugMessages = events.map((event) => `${event.kind}: ${event.message}`).join("\n");
      expect(code, debugMessages).toBe(EXIT_CODE_SUCCESS);
      const reconciledContent = fs.readFileSync(
        path.join(sourceWorkspace, "design", "current", "Prediction.reconciled.md"),
        "utf-8",
      );
      expect(reconciledContent).toContain("mounted-risk.md");
      expect(reconciledContent).not.toContain("decoy-risk.md");
      expect(fs.existsSync(path.join(linkedInvocationDir, "design", "current", "Prediction.reconciled.md"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("keeps root migrations drafting unchanged when no thread markdown files exist", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "notes.txt"), "not a thread\n", "utf-8");

    const runRootDir = path.join(workspace, ".rundown", "runs", "run-test");
    let plannerArtifactPhaseLabel = "";
    let plannerPrompt = "";
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt, artifactPhaseLabel }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          plannerArtifactPhaseLabel = artifactPhaseLabel ?? "";
          plannerPrompt = prompt;
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "root-only-change")),
            "# 2. Root Only Change\n\n- [ ] Cover Target.md migration updates for the root lane.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: runRootDir,
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(plannerArtifactPhaseLabel).toBe("migrate-plan");
      expect(plannerPrompt).toContain("Thread mode is disabled for this run");
      expect(plannerPrompt).not.toContain("thread-briefs/");
      expect(plannerPrompt).not.toContain("thread mode is enabled");
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "root-only-change")))).toBe(true);
      expect(fs.existsSync(path.join(workspace, "migrations", "threads"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("loads per-thread migration state from migrations/threads/<thread>", () => {
    const workspace = makeTempWorkspace();
    const fileSystem = createNodeFileSystem();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    const migrationsDir = path.join(workspace, "migrations");
    const billingThreadDir = path.join(migrationsDir, "threads", "billing");
    const apiReviewThreadDir = path.join(migrationsDir, "threads", "api-review");

    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "api review.md"), "# API Review\n", "utf-8");

    fs.mkdirSync(path.join(migrationsDir, "threads"), { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, formatMigrationFilename(50, "root-only")), "# 50. Root Only\n", "utf-8");
    fs.mkdirSync(billingThreadDir, { recursive: true });
    fs.writeFileSync(path.join(billingThreadDir, formatMigrationFilename(2, "billing-seed")), "# 2. Billing Seed\n", "utf-8");
    fs.mkdirSync(apiReviewThreadDir, { recursive: true });
    fs.writeFileSync(path.join(apiReviewThreadDir, formatMigrationFilename(7, "api-review-seed")), "# 7. Api Review Seed\n", "utf-8");

    const discoveredThreads = discoverMigrationThreads(fileSystem, workspace);
    const loadedStates = loadMigrationThreadStates({
      fileSystem,
      migrationsDir,
      threads: discoveredThreads,
    });

    expect(loadedStates.map((entry) => entry.thread.threadSlug)).toEqual(["api-review", "billing"]);
    expect(loadedStates.map((entry) => entry.migrationsDir)).toEqual([
      apiReviewThreadDir,
      billingThreadDir,
    ]);
    expect(loadedStates.map((entry) => entry.state.currentPosition)).toEqual([7, 2]);
    expect(loadedStates[0]?.state.migrations.map((migration) => path.basename(migration.filePath))).toEqual([
      formatMigrationFilename(7, "api-review-seed"),
    ]);
    expect(loadedStates[1]?.state.migrations.map((migration) => path.basename(migration.filePath))).toEqual([
      formatMigrationFilename(2, "billing-seed"),
    ]);
  });

  it("merges archived thread migrations with hot thread migrations", () => {
    const workspace = makeTempWorkspace();
    const fileSystem = createNodeFileSystem();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    const migrationsDir = path.join(workspace, "migrations");
    const archivedThreadsDir = path.join(migrationsDir, "archive", "threads");
    const billingHotDir = path.join(migrationsDir, "threads", "billing");
    const billingArchiveDir = path.join(archivedThreadsDir, "billing");

    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.mkdirSync(billingHotDir, { recursive: true });
    fs.mkdirSync(billingArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(billingArchiveDir, formatMigrationFilename(1, "billing-archived-seed")), "# 1. Billing Archived Seed\n", "utf-8");
    fs.writeFileSync(path.join(billingArchiveDir, formatMigrationFilename(2, "billing-archived-followup")), "# 2. Billing Archived Followup\n", "utf-8");
    fs.writeFileSync(path.join(billingHotDir, formatMigrationFilename(3, "billing-hot-current")), "# 3. Billing Hot Current\n", "utf-8");

    const discoveredThreads = discoverMigrationThreads(fileSystem, workspace);
    const loadedStates = loadMigrationThreadStates({
      fileSystem,
      migrationsDir,
      archivedThreadsDir,
      threads: discoveredThreads,
    });

    expect(loadedStates).toHaveLength(1);
    expect(loadedStates[0]?.thread.threadSlug).toBe("billing");
    expect(loadedStates[0]?.state.currentPosition).toBe(3);
    expect(loadedStates[0]?.state.migrations.map((migration) => path.basename(migration.filePath))).toEqual([
      formatMigrationFilename(1, "billing-archived-seed"),
      formatMigrationFilename(2, "billing-archived-followup"),
      formatMigrationFilename(3, "billing-hot-current"),
    ]);
  });

  it("prefers hot thread migration payloads when archived and hot filenames overlap", () => {
    const workspace = makeTempWorkspace();
    const fileSystem = createNodeFileSystem();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    const migrationsDir = path.join(workspace, "migrations");
    const archivedThreadsDir = path.join(migrationsDir, "archive", "threads");
    const billingHotDir = path.join(migrationsDir, "threads", "billing");
    const billingArchiveDir = path.join(archivedThreadsDir, "billing");
    const duplicateFileName = formatMigrationFilename(1, "billing-seed");

    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.mkdirSync(billingHotDir, { recursive: true });
    fs.mkdirSync(billingArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(billingArchiveDir, duplicateFileName), "# 1. Billing Seed\n\n- [x] archive\n", "utf-8");
    fs.writeFileSync(path.join(billingHotDir, duplicateFileName), "# 1. Billing Seed\n\n- [x] hot\n", "utf-8");

    const discoveredThreads = discoverMigrationThreads(fileSystem, workspace);
    const loadedStates = loadMigrationThreadStates({
      fileSystem,
      migrationsDir,
      archivedThreadsDir,
      threads: discoveredThreads,
    });

    expect(loadedStates).toHaveLength(1);
    expect(loadedStates[0]?.state.currentPosition).toBe(1);
    expect(loadedStates[0]?.state.migrations).toHaveLength(1);
    expect(loadedStates[0]?.state.migrations[0]?.filePath).toBe(path.join(billingHotDir, duplicateFileName));
  });

  it("loads empty state for a thread when its migrations directory does not exist", () => {
    const workspace = makeTempWorkspace();
    const fileSystem = createNodeFileSystem();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    const migrationsDir = path.join(workspace, "migrations");

    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n", "utf-8");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const discoveredThreads = discoverMigrationThreads(fileSystem, workspace);
    const loadedStates = loadMigrationThreadStates({
      fileSystem,
      migrationsDir,
      threads: discoveredThreads,
    });

    expect(loadedStates).toHaveLength(1);
    expect(loadedStates[0]?.thread.threadSlug).toBe("ops");
    expect(loadedStates[0]?.migrationsDir).toBe(path.join(migrationsDir, "threads", "ops"));
    expect(loadedStates[0]?.state.currentPosition).toBe(0);
    expect(loadedStates[0]?.state.migrations).toEqual([]);
  });

  it("includes archived root migrations in planning state", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    const migrationsDir = path.join(workspace, "migrations");
    const archiveRootDir = path.join(migrationsDir, "archive", "root");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.mkdirSync(archiveRootDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveRootDir, formatMigrationFilename(1, "archived-seed")),
      "# 1. Archived Seed\n\n- [x] archived root history\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(migrationsDir, formatMigrationFilename(2, "hot-seed")),
      "# 2. Hot Seed\n\n- [x] hot root history\n",
      "utf-8",
    );

    const prompts: string[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        prompts.push(prompt);
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "new-from-merged-state")),
            "# " + String(position + 1) + ". New From Merged State\n\n- [ ] Cover Target.md updates.\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "planned", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore: {
        createContext: vi.fn(() => ({
          runId: "run-test",
          rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
          cwd: workspace,
          keepArtifacts: false,
          commandName: "migrate",
        })),
        beginPhase: vi.fn(() => { throw new Error("not used"); }),
        completePhase: vi.fn(),
        finalize: vi.fn(),
        displayPath: vi.fn(() => ""),
        rootDir: vi.fn(() => ""),
        listSaved: vi.fn(() => []),
        listFailed: vi.fn(() => []),
        latest: vi.fn(() => null),
        find: vi.fn(() => null),
        removeSaved: vi.fn(() => 0),
        removeFailed: vi.fn(() => 0),
        isFailedStatus: vi.fn(() => false),
      },
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      const planningPrompt = prompts.find((prompt) =>
        prompt.includes("Inventory design changes not yet reflected in the current prediction tree."),
      ) ?? "";
      expect(planningPrompt).toContain("Current migration number: 2");
      expect(planningPrompt).toContain("- 1. Archived Seed.md");
      expect(planningPrompt).toContain("- 2. Hot Seed.md");
      expect(fs.existsSync(path.join(migrationsDir, formatMigrationFilename(3, "new-from-merged-state")))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("materializes translated briefs per thread into run artifacts", async () => {
    const workspace = makeTempWorkspace();
    const fileSystem = createNodeFileSystem();
    const threadsDir = path.join(workspace, ".rundown", "threads");
    const runRootDir = path.join(workspace, ".rundown", "runs", "run-test");
    const revisionName = "rev.1";

    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n\nFocus on billing rollout.\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n\nFocus on ops rollout.\n", "utf-8");
    fs.mkdirSync(runRootDir, { recursive: true });

    const threads = discoverMigrationThreads(fileSystem, workspace);
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactExtra }) => {
        const threadSlug = String(artifactExtra?.threadSlug ?? "unknown");
        return {
          exitCode: 0,
          stdout: "# translated " + threadSlug + "\n\nthread-specific brief\n",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const revisionDiff = {
      fromRevision: null,
      toTarget: {
        name: revisionName,
        absolutePath: path.join(workspace, "design", revisionName),
        metadataPath: path.join(workspace, "design", revisionName + ".meta.json"),
        metadata: {
          revision: revisionName,
          index: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          label: "Revision 1",
          plannedAt: null,
          migrations: [],
        },
      },
      hasComparison: true,
      summary: "1 file changed",
      changes: [
        {
          kind: "modified",
          relativePath: "Target.md",
          fromPath: path.join(workspace, "design", "rev.0", "Target.md"),
          toPath: path.join(workspace, "design", revisionName, "Target.md"),
        },
      ],
      addedCount: 0,
      modifiedCount: 1,
      removedCount: 0,
      sourceReferences: [
        path.join(workspace, "design", "rev.0", "Target.md"),
        path.join(workspace, "design", revisionName, "Target.md"),
      ],
    };

    const outputEvents: ApplicationOutputEvent[] = [];
    const briefs = await materializeMigrationThreadBriefs({
      fileSystem,
      workerExecutor,
      output: {
        emit: (event) => {
          outputEvents.push(event);
        },
      },
      workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      workspaceRoot: workspace,
      artifactContext: {
        runId: "run-test",
        rootDir: runRootDir,
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      },
      revisionName,
      revisionDiff,
      threads,
      translateTemplate: "## Source\n\n{{what}}\n\n## Guide\n\n{{how}}\n",
      showAgentOutput: true,
    });

    expect(briefs.map((entry) => entry.thread.threadSlug)).toEqual(["billing", "ops"]);
    expect(briefs.map((entry) => entry.outputPathFromWorkspace)).toEqual([
      ".rundown/runs/run-test/thread-briefs/rev.1/billing.md",
      ".rundown/runs/run-test/thread-briefs/rev.1/ops.md",
    ]);
    expect(fs.readFileSync(path.join(runRootDir, "thread-briefs", revisionName, "billing.md"), "utf-8")).toContain("translated billing");
    expect(fs.readFileSync(path.join(runRootDir, "thread-briefs", revisionName, "ops.md"), "utf-8")).toContain("translated ops");

    const workerCalls = (workerExecutor.runWorker as ReturnType<typeof vi.fn>).mock.calls;
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.[0]).toMatchObject({
      artifactPhase: "translate",
      artifactPhaseLabel: "migrate-thread-translate",
      artifactExtra: expect.objectContaining({
        workflow: "migrate-thread-translate",
        revision: revisionName,
        threadSlug: "billing",
      }),
    });
    expect(workerCalls[1]?.[0]).toMatchObject({
      artifactPhase: "translate",
      artifactPhaseLabel: "migrate-thread-translate",
      artifactExtra: expect.objectContaining({
        workflow: "migrate-thread-translate",
        revision: revisionName,
        threadSlug: "ops",
      }),
    });
    expect(outputEvents).toEqual([]);
  });

  it("creates per-thread staged draft directories under the run artifact root", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "Billing Ops.md"), "# Billing Ops\n", "utf-8");

    const runRootDir = path.join(workspace, ".rundown", "runs", "run-test");
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("Inventory design changes not yet reflected in the current prediction tree.")) {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "billing-ops-change")),
            "# 2. Billing Ops Change\n\n- [ ] Update BillingFlow.md and Target.md handling for the translated thread brief.\n",
            "utf-8",
          );
        }

        return {
          exitCode: 0,
          stdout: "drafted migration files",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: runRootDir,
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => {
        throw new Error("not used");
      }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(fs.existsSync(path.join(runRootDir, "drafted-migrations", "rev.1", "threads", "billing-ops"))).toBe(true);
      expect(fs.existsSync(path.join(runRootDir, "drafted-migrations", "rev.1"))).toBe(true);
      expect(code).not.toBe(EXIT_CODE_FAILURE);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("isolates sibling thread history and keeps numbering independent per lane", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(99, "root-only-seed")),
      "# 99. Root Only Seed\n\n- [x] root lane history should be ignored in thread mode\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n", "utf-8");

    const billingMigrationsDir = path.join(workspace, "migrations", "threads", "billing");
    const opsMigrationsDir = path.join(workspace, "migrations", "threads", "ops");
    fs.mkdirSync(billingMigrationsDir, { recursive: true });
    fs.mkdirSync(opsMigrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(billingMigrationsDir, formatMigrationFilename(4, "billing-seed")),
      "# 4. Billing Seed\n\n- [x] billing history\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(opsMigrationsDir, formatMigrationFilename(1, "ops-seed")),
      "# 1. Ops Seed\n\n- [x] ops history\n",
      "utf-8",
    );

    const promptsByThread = new Map<string, string>();
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt, artifactExtra }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          const threadSlug = String(artifactExtra?.threadSlug ?? "ops");
          return { exitCode: 0, stdout: "# translated " + threadSlug + " brief\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const threadSlug = path.basename(draftDir);
          promptsByThread.set(threadSlug, prompt);
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, threadSlug + "-followup")),
            "# " + String(position + 1) + ". " + threadSlug + " followup\n\n- [ ] Cover Target.md and " + threadSlug + " flow updates.\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "planned " + threadSlug, stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(fs.existsSync(path.join(billingMigrationsDir, formatMigrationFilename(5, "billing-followup")))).toBe(true);
      expect(fs.existsSync(path.join(opsMigrationsDir, formatMigrationFilename(2, "ops-followup")))).toBe(true);

      const billingPrompt = promptsByThread.get("billing") ?? "";
      const opsPrompt = promptsByThread.get("ops") ?? "";
      expect(billingPrompt).toContain("Current migration number: 4");
      expect(opsPrompt).toContain("Current migration number: 1");
      expect(billingPrompt).toContain("- 4. Billing Seed.md");
      expect(billingPrompt).not.toContain("- 1. Ops Seed.md");
      expect(opsPrompt).toContain("- 1. Ops Seed.md");
      expect(opsPrompt).not.toContain("- 4. Billing Seed.md");
      expect(billingPrompt).toContain("translated billing brief");
      expect(billingPrompt).not.toContain("translated ops brief");
      expect(opsPrompt).toContain("translated ops brief");
      expect(opsPrompt).not.toContain("translated billing brief");
      expect(billingPrompt).not.toContain("- 99. Root Only Seed.md");
      expect(opsPrompt).not.toContain("- 99. Root Only Seed.md");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("preserves staged thread artifacts when one lane fails verification", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n", "utf-8");

    const runRootDir = path.join(workspace, ".rundown", "runs", "run-test");
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          const threadSlug = prompt.includes("Billing") ? "billing" : "ops";
          return { exitCode: 0, stdout: "# translated " + threadSlug + "\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          const threadSlug = prompt.includes("thread billing") ? "billing" : "ops";
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(2, threadSlug + "-change")),
            "# 2. " + threadSlug + " change\n\n- [ ] Update " + threadSlug + " flow.\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "planned " + threadSlug, stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-staged-repair-thread") {
          return { exitCode: 0, stdout: "repaired", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: runRootDir,
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(fs.existsSync(path.join(runRootDir, "drafted-migrations", "rev.1", "threads", "billing"))).toBe(true);
      expect(fs.existsSync(path.join(runRootDir, "drafted-migrations", "rev.1", "threads", "ops"))).toBe(true);
      expect(fs.existsSync(path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(2, "billing-change")))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "migrations", "threads", "ops", formatMigrationFilename(2, "ops-change")))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("does not run explore when any thread lane fails drafting", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "design", "rev.1", "BillingFlow.md"),
      "# Billing\n\nNew billing workflow requirements.\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n", "utf-8");

    const runRootDir = path.join(workspace, ".rundown", "runs", "run-test");
    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          const threadSlug = prompt.includes("# Billing") ? "billing" : "ops";
          return { exitCode: 0, stdout: "# translated " + threadSlug + "\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const threadSlug = prompt.includes("thread billing") ? "billing" : "ops";
          fs.mkdirSync(draftDir, { recursive: true });
          if (threadSlug === "billing") {
            fs.writeFileSync(
              path.join(draftDir, formatMigrationFilename(2, "billing-change")),
              "# 2. Billing Change\n\n- [ ] Cover BillingFlow.md and related billing rollout updates.\n",
              "utf-8",
            );
          } else {
            fs.writeFileSync(
              path.join(draftDir, formatMigrationFilename(2, "ops-change")),
              "# 2. Ops Change\n\n- [ ] TODO\n",
              "utf-8",
            );
          }
          return { exitCode: 0, stdout: "planned " + threadSlug, stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: runRootDir,
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runExplore).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("persists promoted thread migration paths when revision is marked planned", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "design");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "design", "rev.1", "BillingFlow.md"),
      "# Billing\n\nReleased billing design updates.\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n", "utf-8");

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          return { exitCode: 0, stdout: "# translated billing\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          const draftDirMatch = prompt.match(/staging directory:\s*(.+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(2, "billing-change")),
            "# 2. Billing Change\n\n- [ ] Cover BillingFlow.md rollout updates and migration steps.\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "planned billing", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);

      const rev1Meta = JSON.parse(
        fs.readFileSync(path.join(workspace, "design", "rev.1.meta.json"), "utf-8"),
      ) as {
        plannedAt?: string | null;
        migrations?: string[];
      };
      expect(rev1Meta.plannedAt).toBeTypeOf("string");
      expect(rev1Meta.migrations ?? []).toEqual([
        path.posix.join("migrations", "threads", "billing", formatMigrationFilename(2, "billing-change")),
      ]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("plans migrations from --from-file without requiring design workspace directories", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] bootstrap\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "Plan.md"),
      "# File input plan\n\nAdd a new billing reconciliation step.\n",
      "utf-8",
    );

    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    let sawFileInputDesignContext = false;
    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt }) => {
        if (artifactPhaseLabel === "migrate-plan") {
          if (prompt.includes("# File input plan") && prompt.includes("Add a new billing reconciliation step.")) {
            sawFileInputDesignContext = true;
          }
          const draftDirMatch = prompt.match(/this staging directory:\s*(.+)/i)
            ?? prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "1", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "file-input-change")),
            "# 2. File Input Change\n\n- [ ] Implement billing reconciliation migration.\n",
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        fromFile: "Plan.md",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(fs.existsSync(path.join(workspace, "design"))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "file-input-change")))).toBe(true);
      expect(runExplore).toHaveBeenCalledWith(
        path.join(workspace, "migrations", formatMigrationFilename(2, "file-input-change")),
        workspace,
      );
      expect(sawFileInputDesignContext).toBe(true);
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("keeps thread-aware lane drafting when planning from --from-file", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations", "threads", "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(3, "billing seed")),
      "# 3. Billing Seed\n\n- [x] Seed lane\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, ".rundown", "threads"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "threads", "billing.md"), "# Billing\n\nFocus on billing.\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, "Plan.md"),
      "# Shared file source\n\nDesign input that should be specialized by thread briefs.\n",
      "utf-8",
    );

    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    let sawThreadBriefInPlanningPrompt = false;
    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, prompt }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          return { exitCode: 0, stdout: "# translated billing brief\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          if (
            prompt.includes("# Shared file source")
            && prompt.includes("Design input that should be specialized")
            && prompt.includes("translated billing brief")
          ) {
            sawThreadBriefInPlanningPrompt = true;
          }
          const draftDirMatch = prompt.match(/this staging directory:\s*(.+)/i)
            ?? prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "3", 10);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, "billing from file")),
            "# 4. Billing From File\n\n- [ ] Apply billing-specialized file-input migration steps.\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        fromFile: "Plan.md",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(
        fs.existsSync(
          path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(4, "billing from file")),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(1, "billing from file")))).toBe(false);
      expect(sawThreadBriefInPlanningPrompt).toBe(true);
      expect(runExplore).toHaveBeenCalledWith(
        path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(4, "billing from file")),
        workspace,
      );
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("promotes file-input migrations into thread lanes without writing root-lane files", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations", "threads", "billing"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations", "threads", "ops"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(2, "billing seed")),
      "# 2. Billing Seed\n\n- [x] Seed lane\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "migrations", "threads", "ops", formatMigrationFilename(4, "ops seed")),
      "# 4. Ops Seed\n\n- [x] Seed lane\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, ".rundown", "threads"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "threads", "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(workspace, ".rundown", "threads", "ops.md"), "# Ops\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, "Plan.md"),
      "# Shared source\n\nPlan content used for per-thread specialization.\n",
      "utf-8",
    );

    const runExplore = vi.fn<(source: string, cwd: string) => Promise<ExitCode>>(async () => EXIT_CODE_SUCCESS);
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ artifactPhaseLabel, artifactExtra, prompt }) => {
        if (artifactPhaseLabel === "migrate-thread-translate") {
          const threadSlug = String(artifactExtra?.threadSlug ?? "unknown");
          return { exitCode: 0, stdout: "# translated " + threadSlug + " brief\n", stderr: "" };
        }

        if (artifactPhaseLabel === "migrate-plan-thread") {
          const draftDirMatch = prompt.match(/this staging directory:\s*(.+)/i)
            ?? prompt.match(/staging directory:\s*(.+)/i);
          const positionMatch = prompt.match(/Current migration number:\s*(\d+)/i);
          const draftDir = draftDirMatch?.[1]?.trim() ?? "";
          const position = Number.parseInt(positionMatch?.[1] ?? "0", 10);
          const threadSlug = path.basename(draftDir);
          fs.mkdirSync(draftDir, { recursive: true });
          fs.writeFileSync(
            path.join(draftDir, formatMigrationFilename(position + 1, threadSlug + " from file")),
            "# " + String(position + 1) + ". " + threadSlug + " from file\n\n- [ ] Thread lane migration\n",
            "utf-8",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        dir: "migrations",
        fromFile: "Plan.md",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(
        fs.existsSync(
          path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(3, "billing from file")),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(workspace, "migrations", "threads", "ops", formatMigrationFilename(5, "ops from file")),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(1, "billing from file")))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(1, "ops from file")))).toBe(false);
      expect(runExplore).toHaveBeenCalledWith(
        path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(3, "billing from file")),
        workspace,
      );
      expect(runExplore).toHaveBeenCalledWith(
        path.join(workspace, "migrations", "threads", "ops", formatMigrationFilename(5, "ops from file")),
        workspace,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("creates exactly one canonical file for `migrate new <title>` without planning", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(7, "existing migration")),
      "# 7. Existing Migration\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        action: "new",
        title: "File name basically",
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(fs.existsSync(path.join(workspace, "migrations", "8. File Name Basically.md"))).toBe(true);
      expect(workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(artifactStore.createContext).not.toHaveBeenCalled();
      expect(events.some((event) => event.kind === "success" && event.message.includes("8. File Name Basically.md"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses archive-aware numbering for `migrate new <title>` in the root lane", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations", "archive", "root"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(9, "latest hot")),
      "# 9. Latest Hot\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "migrations", "archive", "root", formatMigrationFilename(11, "latest archived")),
      "# 11. Latest Archived\n",
      "utf-8",
    );

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        action: "new",
        title: "From archive root",
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(fs.existsSync(path.join(workspace, "migrations", "12. From Archive Root.md"))).toBe(true);
      expect(workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(artifactStore.createContext).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("uses thread-lane archive numbering for `migrate new <title>`", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations", "threads", "billing"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations", "archive", "threads", "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(2, "latest hot thread")),
      "# 2. Latest Hot Thread\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "migrations", "archive", "threads", "billing", formatMigrationFilename(4, "latest archived thread")),
      "# 4. Latest Archived Thread\n",
      "utf-8",
    );

    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: { emit: () => {} },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        action: "new",
        title: "Billing thread followup",
        dir: path.join("migrations", "threads", "billing"),
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(fs.existsSync(path.join(workspace, "migrations", "threads", "billing", "5. Billing Thread Followup.md"))).toBe(true);
      expect(workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(artifactStore.createContext).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails for `migrate new` when title is missing", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });

    const events: ApplicationOutputEvent[] = [];
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(() => ({
        runId: "run-test",
        rootDir: path.join(workspace, ".rundown", "runs", "run-test"),
        cwd: workspace,
        keepArtifacts: false,
        commandName: "migrate",
      })),
      beginPhase: vi.fn(() => { throw new Error("not used"); }),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(() => ""),
      rootDir: vi.fn(() => ""),
      listSaved: vi.fn(() => []),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const migrateTask = createMigrateTask({
      workerExecutor,
      fileSystem: createNodeFileSystem(),
      traceWriter: createNoopTraceWriter(),
      templateLoader: { load: () => undefined },
      sourceResolver: { resolveSources: vi.fn(async () => []) },
      workerConfigPort: { load: () => undefined },
      artifactStore,
      configDir: path.join(workspace, ".rundown"),
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => ({ value: "true", usedDefault: true, interactive: false })),
      },
      output: {
        emit: (event) => {
          events.push(event);
        },
      },
      runExplore: vi.fn(async () => EXIT_CODE_SUCCESS),
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await migrateTask({
        action: "new",
        title: "   ",
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(workerExecutor.runWorker).not.toHaveBeenCalled();
      expect(artifactStore.createContext).not.toHaveBeenCalled();
      expect(events.some((event) => event.kind === "error" && event.message.includes("Missing required title"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

function scaffoldReleasedDesignRevisions(workspace: string, designDir: string): void {
  const designRoot = path.join(workspace, designDir);
  const now = "2026-01-01T00:00:00.000Z";

  fs.mkdirSync(path.join(designRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.0"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.1"), { recursive: true });

  fs.writeFileSync(path.join(designRoot, "current", "Target.md"), "# Design\n\nWorking draft in current/.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.0", "Target.md"), "# Design\n\nBaseline design.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.1", "Target.md"), "# Design\n\nReleased rev.1 design.\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.0.meta.json"), JSON.stringify({
    revision: "rev.0",
    index: 0,
    createdAt: now,
    plannedAt: now,
    migrations: [],
  }, null, 2) + "\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.1.meta.json"), JSON.stringify({
    revision: "rev.1",
    index: 1,
    createdAt: now,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");
}

function makeTempWorkspace(): string {
  const isolatedTempRoot = path.join(path.parse(os.tmpdir()).root, "rundown-test-tmp");
  fs.mkdirSync(isolatedTempRoot, { recursive: true });
  const dirPath = fs.mkdtempSync(path.join(isolatedTempRoot, "rundown-migrate-app-"));
  tempDirs.push(dirPath);
  return dirPath;
}
