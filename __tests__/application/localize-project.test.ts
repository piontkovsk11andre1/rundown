import { describe, expect, it, vi } from "vitest";
import { createLocalizeProject } from "../../src/application/localize-project.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../../src/domain/exit-codes.js";
import { MESSAGES } from "../../src/domain/messages.js";
import type {
  ConfigDirResult,
  FileSystem,
  TemplateLoader,
  WorkerConfigPort,
  WorkerExecutorPort,
} from "../../src/domain/ports/index.js";
import type { ApplicationOutputPort } from "../../src/domain/ports/output-port.js";

function createFileSystemMock(): FileSystem {
  return {
    exists: vi.fn(() => false),
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createWorkerExecutorMock(): WorkerExecutorPort {
  return {
    runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
}

describe("localize-project", () => {
  it("fails gracefully before translation work when no worker is configured", async () => {
    const fileSystem = createFileSystemMock();
    const workerExecutor = createWorkerExecutorMock();
    const workerConfigPort: WorkerConfigPort = {
      load: vi.fn(() => undefined),
    };
    const output: ApplicationOutputPort = {
      emit: vi.fn(),
    };
    const templateLoader: TemplateLoader = {
      load: vi.fn(() => null),
    };
    const configDir: ConfigDirResult = {
      configDir: "/repo/.rundown",
      isExplicit: false,
    };

    const localizeProject = createLocalizeProject({
      fileSystem,
      workerExecutor,
      workerConfigPort,
      configDir,
      output,
      templateLoader,
    });

    const exitCode = await localizeProject({ language: "Chinese" });

    expect(exitCode).toBe(EXIT_CODE_FAILURE);
    expect(output.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "error",
        message: expect.stringContaining("No worker command available"),
      }),
    );
    expect(fileSystem.mkdir).not.toHaveBeenCalled();
    expect(fileSystem.writeText).not.toHaveBeenCalled();
    expect(workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("writes locale.json with translated messages block from worker output", async () => {
    const fileWrites = new Map<string, string>();
    const fileSystem: FileSystem = {
      exists: vi.fn(() => false),
      readText: vi.fn(() => ""),
      writeText: vi.fn((filePath: string, content: string) => {
        fileWrites.set(filePath, content);
      }),
      mkdir: vi.fn(),
      readdir: vi.fn(() => []),
      stat: vi.fn(() => null),
      unlink: vi.fn(),
      rm: vi.fn(),
    };
    const workerExecutor: WorkerExecutorPort = {
      runWorker: vi.fn(async ({ prompt }) => {
        if (prompt.includes("localized rundown intent keyword aliases")) {
          return {
            exitCode: 0,
            stdout: '{"记忆:":"memory:","验证:":"verify:"}',
            stderr: "",
          };
        }

        if (prompt.includes("translating a rundown CLI message catalog")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(MESSAGES),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: "translated template",
          stderr: "",
        };
      }),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const workerConfigPort: WorkerConfigPort = {
      load: vi.fn(() => ({ workers: { default: ["test-worker"] } })),
    };
    const output: ApplicationOutputPort = {
      emit: vi.fn(),
    };
    const templateLoader: TemplateLoader = {
      load: vi.fn(() => null),
    };
    const configDir: ConfigDirResult = {
      configDir: "/repo/.rundown",
      isExplicit: false,
    };

    const localizeProject = createLocalizeProject({
      fileSystem,
      workerExecutor,
      workerConfigPort,
      configDir,
      output,
      templateLoader,
    });

    const exitCode = await localizeProject({ language: "Chinese" });

    expect(exitCode).toBe(EXIT_CODE_SUCCESS);
    const localeConfigPath = "/repo/.rundown/locale.json";
    expect(fileWrites.has(localeConfigPath)).toBe(true);

    const rawLocaleConfig = fileWrites.get(localeConfigPath);
    expect(rawLocaleConfig).toBeDefined();
    const localeConfig = JSON.parse(rawLocaleConfig ?? "{}");
    expect(localeConfig.language).toBe("Chinese");
    expect(localeConfig.aliases).toEqual({ "记忆:": "memory:", "验证:": "verify:" });
    expect(Object.keys(localeConfig.messages).sort()).toEqual(Object.keys(MESSAGES).sort());
    expect(fileWrites.has("/repo/.rundown/plan-prepend.md")).toBe(false);
    expect(fileWrites.has("/repo/.rundown/plan-append.md")).toBe(false);
    expect(templateLoader.load).not.toHaveBeenCalledWith("/repo/.rundown/plan-prepend.md");
    expect(templateLoader.load).not.toHaveBeenCalledWith("/repo/.rundown/plan-append.md");
  });
});
