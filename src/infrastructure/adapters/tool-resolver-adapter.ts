import type { ConfigDirResult } from "../../domain/ports/config-dir-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";
import type { ToolDefinition, ToolResolverPort } from "../../domain/ports/tool-resolver-port.js";
import type { ToolFrontmatter } from "../../domain/ports/tool-handler-port.js";
import type { InteractiveInputPort } from "../../domain/ports/interactive-input-port.js";
import type { MemoryWriterPort } from "../../domain/ports/memory-writer-port.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../domain/builtin-tools/index.js";
import { createMemoryHandler } from "../../domain/builtin-tools/memory.js";
import { createQuestionHandler } from "../../domain/builtin-tools/question.js";
import { createTemplateToolHandler } from "../../domain/builtin-tools/template-tool.js";

const TOOLS_DIRECTORY_NAME = "tools";
const CONFIG_FILE_NAME = "config.json";
const TOOL_TEMPLATE_EXTENSION = ".md";
const TOOL_JS_EXTENSION = ".js";

const FRONTMATTER_DEFAULTS: Required<Pick<ToolFrontmatter, "kind" | "skipExecution" | "shouldVerify" | "insertChildren">> = {
  kind: "handler",
  skipExecution: false,
  shouldVerify: false,
  insertChildren: true,
};

type ParsedToolFrontmatter = ToolFrontmatter & typeof FRONTMATTER_DEFAULTS;

type ToolConfigOverrides = Record<string, ToolFrontmatter>;

/**
 * Dependencies required to resolve project tool templates.
 */
export interface ToolResolverAdapterDependencies {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  configDir: ConfigDirResult | undefined;
  memoryWriter?: MemoryWriterPort;
  interactiveInput?: InteractiveInputPort;
}

/**
 * Creates a tool resolver adapter that supports four resolution layers:
 *
 * 1. Project `.js` handlers in configured tool directories (always override built-ins)
 * 2. Built-in tool registry (verify, memory, include, profile, etc.)
 * 3. Project `.md` templates in configured tool directories (only for non-built-in names)
 *
 * `.js` handlers can override any built-in. `.md` templates cannot.
 */
export function createToolResolverAdapter(
  dependencies: ToolResolverAdapterDependencies,
): ToolResolverPort {
  // Cache for dynamically imported JS tool handlers.
  const jsToolCache = new Map<string, ToolDefinition>();

  // Construct dynamic built-in tools that require dependencies.
  const memoryAliases = ["memory", "memorize", "remember", "inventory"];
  const memoryHandler = createMemoryHandler(dependencies.memoryWriter);
  const questionHandler = createQuestionHandler(dependencies.interactiveInput);
  const dynamicBuiltins = new Map<string, ToolDefinition>();
  for (const alias of memoryAliases) {
    dynamicBuiltins.set(alias, {
      name: alias,
      kind: "handler",
      handler: memoryHandler,
      frontmatter: { shouldVerify: true },
    });
  }
  dynamicBuiltins.set("question", {
    name: "question",
    kind: "handler",
    handler: questionHandler,
    frontmatter: { skipExecution: true, shouldVerify: false },
  });

  const staticBuiltinToolNames = listBuiltinToolNames();

  function getConfiguredToolOverrides(): ToolConfigOverrides {
    const configDirPath = dependencies.configDir?.configDir;
    if (!configDirPath) {
      return {};
    }

    return readConfiguredToolOverrides(configDirPath, dependencies.fileSystem, dependencies.pathOperations);
  }

  function getConfiguredToolDirectories(): string[] {
    const configDirPath = dependencies.configDir?.configDir;
    if (!configDirPath) {
      return [];
    }

    const configured = readConfiguredToolDirs(configDirPath, dependencies.fileSystem, dependencies.pathOperations);
    if (configured.length > 0) {
      return configured;
    }

    return [dependencies.pathOperations.join(configDirPath, TOOLS_DIRECTORY_NAME)];
  }

  function listKnownToolNames(): readonly string[] {
    const known = new Set<string>([...staticBuiltinToolNames, ...dynamicBuiltins.keys()]);
    for (const toolsDir of getConfiguredToolDirectories()) {
      try {
        for (const entry of dependencies.fileSystem.readdir(toolsDir)) {
          if (!entry.isFile) {
            continue;
          }
          const lowerName = entry.name.toLowerCase();
          if (lowerName.endsWith(TOOL_JS_EXTENSION)) {
            const toolName = lowerName.slice(0, -TOOL_JS_EXTENSION.length).trim();
            if (toolName.length > 0) {
              known.add(toolName);
            }
            continue;
          }
          if (lowerName.endsWith(TOOL_TEMPLATE_EXTENSION)) {
            const toolName = lowerName.slice(0, -TOOL_TEMPLATE_EXTENSION.length).trim();
            if (toolName.length > 0) {
              known.add(toolName);
            }
          }
        }
      } catch {
        // Best-effort enumeration; unresolved directories should not fail execution.
      }
    }

    return Array.from(known);
  }

  return {
    listKnownToolNames,
    resolve(toolName) {
      const normalizedToolName = toolName.trim().toLowerCase();
      if (normalizedToolName.length === 0) {
        return undefined;
      }

      // Layer 1: Check JS tool cache.
      const cached = jsToolCache.get(normalizedToolName);
      if (cached) {
        return applyToolConfigOverrides(cached, getConfiguredToolOverrides()[normalizedToolName]);
      }

      // Layer 1: Project .js handlers from configured directories.
      for (const toolsDir of getConfiguredToolDirectories()) {
        const jsFileName = `${normalizedToolName}${TOOL_JS_EXTENSION}`;
        const matchingJsFile = findTemplateFileName(toolsDir, jsFileName, dependencies.fileSystem);
        if (matchingJsFile) {
          const jsPath = dependencies.pathOperations.join(toolsDir, matchingJsFile);
          // JS tools are loaded lazily on first execution (not at resolve time)
          // because dynamic import is async. We store the path and load later.
            const jsTool: ToolDefinition = {
              name: normalizedToolName,
              kind: "handler",
              handlerPath: jsPath,
            };
            jsToolCache.set(normalizedToolName, jsTool);
            return applyToolConfigOverrides(jsTool, getConfiguredToolOverrides()[normalizedToolName]);
          }
        }

      // Layer 2a: Dynamic built-ins (memory and aliases) — take priority over .md templates.
      const dynamicBuiltin = dynamicBuiltins.get(normalizedToolName);
      if (dynamicBuiltin) {
        return applyToolConfigOverrides(dynamicBuiltin, getConfiguredToolOverrides()[normalizedToolName]);
      }

      // Layer 2b: Static built-ins (verify, include, profile, etc.) — take priority over .md templates.
      const staticBuiltin = resolveBuiltinTool(normalizedToolName);
      if (staticBuiltin) {
        return applyToolConfigOverrides(staticBuiltin, getConfiguredToolOverrides()[normalizedToolName]);
      }

      // Layer 3: Project .md templates from configured directories.
      for (const toolsDir of getConfiguredToolDirectories()) {
        const mdFileName = `${normalizedToolName}${TOOL_TEMPLATE_EXTENSION}`;
        const matchingMdFile = findTemplateFileName(toolsDir, mdFileName, dependencies.fileSystem);
        if (matchingMdFile) {
          const templatePath = dependencies.pathOperations.join(toolsDir, matchingMdFile);
          const rawContent = readFileContent(templatePath, dependencies.fileSystem);
          if (rawContent !== undefined) {
            const parsedFrontmatter = parseFrontmatter(rawContent);
            if (!parsedFrontmatter.ok) {
              return createInvalidToolDefinition(normalizedToolName, templatePath, parsedFrontmatter.error);
            }

            const { frontmatter, body } = parsedFrontmatter.value;
            const resolvedTool: ToolDefinition = {
              name: normalizedToolName,
              kind: frontmatter.kind,
              templatePath,
              template: body,
              handler: createTemplateToolHandler(body),
              frontmatter,
            };
            return applyToolConfigOverrides(resolvedTool, getConfiguredToolOverrides()[normalizedToolName]);
          }
        }
      }

      return undefined;
    },
  };
}

function applyToolConfigOverrides(tool: ToolDefinition, overrides: ToolFrontmatter | undefined): ToolDefinition {
  if (!overrides) {
    return tool;
  }

  const mergedFrontmatter: ToolFrontmatter = {
    ...(tool.frontmatter ?? {}),
    ...overrides,
  };

  return {
    ...tool,
    kind: mergedFrontmatter.kind ?? tool.kind,
    frontmatter: mergedFrontmatter,
  };
}

function readConfiguredToolDirs(
  configDirPath: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): string[] {
  const configPath = pathOperations.join(configDirPath, CONFIG_FILE_NAME);
  const configContent = readFileContent(configPath, fileSystem);
  if (configContent === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const toolDirs = (parsed as { toolDirs?: unknown }).toolDirs;
  if (!Array.isArray(toolDirs)) {
    return [];
  }

  const normalizedDirs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of toolDirs) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const resolvedDir = pathOperations.isAbsolute(trimmed)
      ? trimmed
      : pathOperations.resolve(configDirPath, trimmed);
    const key = resolvedDir.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedDirs.push(resolvedDir);
  }

  return normalizedDirs;
}

function readConfiguredToolOverrides(
  configDirPath: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): ToolConfigOverrides {
  const configPath = pathOperations.join(configDirPath, CONFIG_FILE_NAME);
  const configContent = readFileContent(configPath, fileSystem);
  if (configContent === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const tools = (parsed as { tools?: unknown }).tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    return {};
  }

  const overrides: ToolConfigOverrides = {};
  for (const [toolName, candidate] of Object.entries(tools)) {
    if (typeof toolName !== "string") {
      continue;
    }

    const normalizedToolName = toolName.trim().toLowerCase();
    if (normalizedToolName.length === 0) {
      continue;
    }

    const parsedOverride = parseToolFrontmatterOverride(candidate);
    if (parsedOverride) {
      overrides[normalizedToolName] = parsedOverride;
    }
  }

  return overrides;
}

function parseToolFrontmatterOverride(candidate: unknown): ToolFrontmatter | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }

  const value = candidate as Record<string, unknown>;
  const parsed: ToolFrontmatter = {};

  if (value.kind === "modifier" || value.kind === "handler") {
    parsed.kind = value.kind;
  }

  if (typeof value.skipExecution === "boolean") {
    parsed.skipExecution = value.skipExecution;
  }

  if (typeof value.shouldVerify === "boolean") {
    parsed.shouldVerify = value.shouldVerify;
  }

  if (typeof value.autoComplete === "boolean") {
    parsed.autoComplete = value.autoComplete;
  }

  if (typeof value.insertChildren === "boolean") {
    parsed.insertChildren = value.insertChildren;
  }

  if (typeof value.profile === "string") {
    const trimmed = value.profile.trim();
    if (trimmed.length > 0) {
      parsed.profile = trimmed;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function createInvalidToolDefinition(
  toolName: string,
  templatePath: string,
  errorMessage: string,
): ToolDefinition {
  return {
    name: toolName,
    kind: "handler",
    templatePath,
    frontmatter: {
      ...FRONTMATTER_DEFAULTS,
    },
    handler: async () => ({
      exitCode: 1,
      failureMessage: `Invalid tool frontmatter for "${toolName}" in ${templatePath}: ${errorMessage}`,
      failureReason: "Tool frontmatter is malformed.",
    }),
  };
}

function findTemplateFileName(
  toolsDir: string,
  expectedFileName: string,
  fileSystem: FileSystem,
): string | undefined {
  try {
    for (const entry of fileSystem.readdir(toolsDir)) {
      if (entry.isFile && entry.name.toLowerCase() === expectedFileName.toLowerCase()) {
        return entry.name;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readFileContent(filePath: string, fileSystem: FileSystem): string | undefined {
  try {
    return fileSystem.readText(filePath);
  } catch {
    return undefined;
  }
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FRONTMATTER_START_REGEX = /^---(?:\r?\n|$)/;

/**
 * Parses optional YAML-like frontmatter from a template file.
 *
 * Supports simple `key: value` pairs on separate lines. Complex YAML features
 * (nested objects, arrays, multiline strings) are not supported; use config.json
 * for those cases.
 */
function parseFrontmatter(content: string):
  | { ok: true; value: { frontmatter: ParsedToolFrontmatter; body: string } }
  | { ok: false; error: string } {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    if (FRONTMATTER_START_REGEX.test(content)) {
      return { ok: false, error: "frontmatter block is not closed with '---'." };
    }

    return {
      ok: true,
      value: {
        frontmatter: { ...FRONTMATTER_DEFAULTS },
        body: content,
      },
    };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: ParsedToolFrontmatter = { ...FRONTMATTER_DEFAULTS };
  const seenKeys = new Set<string>();

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      return { ok: false, error: `invalid frontmatter line "${trimmed}".` };
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const normalizedKey = key.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      return { ok: false, error: `duplicate frontmatter key "${key}".` };
    }
    seenKeys.add(normalizedKey);

    const value = normalizeFrontmatterValue(trimmed.slice(colonIndex + 1).trim());

    switch (normalizedKey) {
      case "kind":
        if (value !== "modifier" && value !== "handler") {
          return { ok: false, error: `"kind" must be "modifier" or "handler", received "${value}".` };
        }
        frontmatter.kind = value;
        break;
      case "skipexecution":
        if (value !== "true" && value !== "false") {
          return { ok: false, error: `"skipExecution" must be true or false, received "${value}".` };
        }
        frontmatter.skipExecution = value === "true";
        break;
      case "shouldverify":
        if (value !== "true" && value !== "false") {
          return { ok: false, error: `"shouldVerify" must be true or false, received "${value}".` };
        }
        frontmatter.shouldVerify = value === "true";
        break;
      case "autocomplete":
        if (value !== "true" && value !== "false") {
          return { ok: false, error: `"autoComplete" must be true or false, received "${value}".` };
        }
        frontmatter.autoComplete = value === "true";
        break;
      case "insertchildren":
        if (value !== "true" && value !== "false") {
          return { ok: false, error: `"insertChildren" must be true or false, received "${value}".` };
        }
        frontmatter.insertChildren = value === "true";
        break;
      case "profile":
        if (value !== "null" && value.length > 0) {
          frontmatter.profile = value;
        } else {
          delete frontmatter.profile;
        }
        break;
      default:
        return { ok: false, error: `unknown frontmatter key "${key}".` };
    }
  }

  return {
    ok: true,
    value: {
      frontmatter,
      body,
    },
  };
}

function normalizeFrontmatterValue(value: string): string {
  if (value.length >= 2) {
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
  }

  return value;
}
