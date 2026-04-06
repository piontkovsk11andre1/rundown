import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../../../src/infrastructure/adapters/node-path-operations-adapter.js";
import { createToolResolverAdapter } from "../../../src/infrastructure/adapters/tool-resolver-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tool-resolver-"));
  tempDirs.push(dir);
  return dir;
}

describe("createToolResolverAdapter", () => {
  it("returns undefined when config directory is unavailable", () => {
    const resolver = createToolResolverAdapter({
      configDir: undefined,
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("post-on-gitea")).toBeUndefined();
  });

  it("resolves and loads a matching tool template from .rundown/tools", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "post-on-gitea.md");
    const templateBody = "You are a helper.\n\nRequest: {{payload}}\n";

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(templatePath, templateBody, "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("post-on-gitea")).toMatchObject({
      name: "post-on-gitea",
      templatePath,
      template: templateBody,
      kind: "handler",
      frontmatter: {
        kind: "handler",
        skipExecution: false,
        shouldVerify: false,
        insertChildren: true,
      },
    });
  });

  it("parses valid tool frontmatter with typed fields", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "strict-tool.md");
    const templateBody = "run {{payload}}\n";

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(
      templatePath,
      [
        "---",
        "kind: modifier",
        "skipExecution: true",
        "shouldVerify: false",
        "insertChildren: false",
        "profile: fast",
        "---",
        templateBody,
      ].join("\n"),
      "utf-8",
    );

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("strict-tool")).toMatchObject({
      name: "strict-tool",
      templatePath,
      template: templateBody,
      kind: "modifier",
      frontmatter: {
        kind: "modifier",
        skipExecution: true,
        shouldVerify: false,
        insertChildren: false,
        profile: "fast",
      },
    });
  });

  it("fails predictably for malformed frontmatter and returns a failing handler", async () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "bad-frontmatter.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(
      templatePath,
      [
        "---",
        "kind: invalid-kind",
        "---",
        "body",
      ].join("\n"),
      "utf-8",
    );

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const tool = resolver.resolve("bad-frontmatter");
    expect(tool).toMatchObject({
      name: "bad-frontmatter",
      kind: "handler",
      templatePath,
      frontmatter: {
        kind: "handler",
        skipExecution: false,
        shouldVerify: false,
        insertChildren: true,
      },
    });

    expect(typeof tool?.handler).toBe("function");
    const result = await tool?.handler?.({
      task: {
        text: "bad-frontmatter: payload",
        checked: false,
        line: 1,
        column: 1,
        index: 0,
        offsetStart: 0,
        offsetEnd: 0,
        file: "task.md",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      payload: "payload",
      source: "",
      contextBefore: "",
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
      emit: () => undefined,
      configDir,
      workerExecutor: {
        runWorker: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        executeInlineCli: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        executeRundownTask: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
      workerPattern: {
        command: ["node", "script.js"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      workerCommand: ["node", "script.js"],
      mode: "wait",
      trace: false,
      cwd: rootDir,
      artifactContext: {
        runId: "test-run",
        rootDir,
        cwd: rootDir,
        keepArtifacts: false,
        commandName: "run",
      },
      keepArtifacts: false,
      templateVars: {
        task: "bad-frontmatter: payload",
        payload: "payload",
        file: "task.md",
        context: "",
        taskIndex: 0,
        taskLine: 1,
        source: "",
      },
      showAgentOutput: false,
    });

    expect(result).toMatchObject({
      exitCode: 1,
      failureReason: "Tool frontmatter is malformed.",
    });
    expect(result?.failureMessage).toContain("Invalid tool frontmatter for \"bad-frontmatter\"");
    expect(result?.failureMessage).toContain("\"kind\" must be \"modifier\" or \"handler\"");
  });

  it("does not resolve unknown tool names", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "summarize.md"), "Summarize task", "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("post-on-gitea")).toBeUndefined();
  });

  it("enumerates built-in and project tool names for boundary detection", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "custom-handler.js"), "export default async () => ({})", "utf-8");
    fs.writeFileSync(path.join(toolsDir, "custom-template.md"), "Template body", "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const knownToolNames = resolver.listKnownToolNames();
    expect(knownToolNames).toContain("verify");
    expect(knownToolNames).toContain("memory");
    expect(knownToolNames).toContain("end");
    expect(knownToolNames).toContain("return");
    expect(knownToolNames).toContain("skip");
    expect(knownToolNames).toContain("quit");
    expect(knownToolNames).toContain("custom-handler");
    expect(knownToolNames).toContain("custom-template");
  });

  it("resolves tools using configured toolDirs in order", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const firstToolsDir = path.join(configDir, "first-tools");
    const secondToolsDir = path.join(configDir, "second-tools");

    fs.mkdirSync(firstToolsDir, { recursive: true });
    fs.mkdirSync(secondToolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["first-tools", "second-tools"] }),
      "utf-8",
    );
    fs.writeFileSync(path.join(firstToolsDir, "summarize.md"), "First tool body", "utf-8");
    fs.writeFileSync(path.join(secondToolsDir, "summarize.md"), "Second tool body", "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("summarize")).toMatchObject({
      name: "summarize",
      templatePath: path.join(firstToolsDir, "summarize.md"),
      template: "First tool body",
      kind: "handler",
    });
  });

  it("lists tool names from configured toolDirs", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const firstToolsDir = path.join(configDir, "first-tools");
    const secondToolsDir = path.join(configDir, "second-tools");

    fs.mkdirSync(firstToolsDir, { recursive: true });
    fs.mkdirSync(secondToolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDirs: ["first-tools", "second-tools"] }),
      "utf-8",
    );
    fs.writeFileSync(path.join(firstToolsDir, "alpha.md"), "alpha", "utf-8");
    fs.writeFileSync(path.join(secondToolsDir, "beta.js"), "export default async () => ({})", "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const knownToolNames = resolver.listKnownToolNames();
    expect(knownToolNames).toContain("alpha");
    expect(knownToolNames).toContain("beta");
  });

  it("applies config.json tools override over .md frontmatter defaults", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "summarize.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        tools: {
          summarize: {
            kind: "handler",
            skipExecution: false,
            shouldVerify: true,
            insertChildren: true,
            profile: "release",
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      templatePath,
      [
        "---",
        "kind: modifier",
        "skipExecution: true",
        "shouldVerify: false",
        "insertChildren: false",
        "profile: fast",
        "---",
        "Body",
      ].join("\n"),
      "utf-8",
    );

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("summarize")).toMatchObject({
      name: "summarize",
      templatePath,
      kind: "handler",
      frontmatter: {
        kind: "handler",
        skipExecution: false,
        shouldVerify: true,
        insertChildren: true,
        profile: "release",
      },
    });
  });

  it("returns undefined when tools directory cannot be read", () => {
    const resolver = createToolResolverAdapter({
      configDir: {
        configDir: path.join(makeTempDir(), ".rundown"),
        isExplicit: false,
      },
      fileSystem: {
        exists() {
          throw new Error("not implemented");
        },
        readText() {
          throw new Error("not implemented");
        },
        writeText() {
          throw new Error("not implemented");
        },
        mkdir() {
          throw new Error("not implemented");
        },
        readdir() {
          throw new Error("filesystem unavailable");
        },
        stat() {
          throw new Error("not implemented");
        },
        unlink() {
          throw new Error("not implemented");
        },
        rm() {
          throw new Error("not implemented");
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("post-on-gitea")).toBeUndefined();
  });

  it("returns undefined when template file exists but cannot be read", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "post-on-gitea.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(templatePath, "Task template", "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: {
        exists() {
          throw new Error("not implemented");
        },
        readText() {
          throw new Error("permission denied");
        },
        writeText() {
          throw new Error("not implemented");
        },
        mkdir() {
          throw new Error("not implemented");
        },
        readdir() {
          return [{
            name: "post-on-gitea.md",
            isFile: true,
            isDirectory: false,
          }];
        },
        stat() {
          throw new Error("not implemented");
        },
        unlink() {
          throw new Error("not implemented");
        },
        rm() {
          throw new Error("not implemented");
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("post-on-gitea")).toBeUndefined();
  });

  it("trims incoming tool name before resolution", () => {
    const rootDir = makeTempDir();
    const configDir = path.join(rootDir, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const templatePath = path.join(toolsDir, "post-on-gitea.md");
    const templateBody = "Return TODOs\n";

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(templatePath, templateBody, "utf-8");

    const resolver = createToolResolverAdapter({
      configDir: {
        configDir,
        isExplicit: false,
      },
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(resolver.resolve("  post-on-gitea  ")).toMatchObject({
      name: "post-on-gitea",
      templatePath,
      template: templateBody,
      kind: "handler",
    });
  });
});
