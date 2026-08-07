import type { Task } from "../domain/parser.js";
import type {
  ConfigDirResult,
  PathOperationsPort,
  TemplateLoader,
} from "../domain/ports/index.js";

const COMMAND_SPECIFIC_REPAIR_TEMPLATE_FILES: Record<string, string> = {
  research: "research-repair.md",
};

const COMMAND_SPECIFIC_RESOLVE_TEMPLATE_FILES: Record<string, string> = {
  research: "research-resolve.md",
};

const RUNDOWN_SUBCOMMAND_PATTERN = /(?:^|\s)(?:\S*[\\/])?rundown(?:\.(?:cmd|ps1|bat|exe))?\s+([a-z0-9-]+)/i;

/**
 * Resolves the effective repair template for a task, with command-specific
 * overrides for inline `rundown <command>` tasks.
 */
export function resolveRepairTemplateForTask(params: {
  task: Task;
  configDir: ConfigDirResult | undefined;
  templateLoader: TemplateLoader;
  pathOperations: PathOperationsPort;
  defaultRepairTemplate: string;
}): string {
  const {
    task,
    configDir,
    templateLoader,
    pathOperations,
    defaultRepairTemplate,
  } = params;

  if (!task.isInlineCli || !configDir?.configDir) {
    return defaultRepairTemplate;
  }

  const command = extractRundownSubcommand(task.cliCommand ?? "");
  if (!command) {
    return defaultRepairTemplate;
  }

  const repairTemplateFile = COMMAND_SPECIFIC_REPAIR_TEMPLATE_FILES[command];
  if (!repairTemplateFile) {
    return defaultRepairTemplate;
  }

  return templateLoader.load(pathOperations.join(configDir.configDir, repairTemplateFile))
    ?? defaultRepairTemplate;
}

/**
 * Resolves the effective resolve template for a task.
 *
 * Fallback order:
 * 1) command-specific resolve template (for inline `rundown <command>` tasks)
 * 2) project-level `.rundown/resolve.md`
 * 3) built-in default resolve template provided by caller
 */
export function resolveResolveTemplateForTask(params: {
  task: Task;
  configDir: ConfigDirResult | undefined;
  templateLoader: TemplateLoader;
  pathOperations: PathOperationsPort;
  defaultResolveTemplate: string;
}): string {
  const {
    task,
    configDir,
    templateLoader,
    pathOperations,
    defaultResolveTemplate,
  } = params;

  if (!configDir?.configDir) {
    return defaultResolveTemplate;
  }

  if (task.isInlineCli) {
    const command = extractRundownSubcommand(task.cliCommand ?? "");
    if (command) {
      const resolveTemplateFile = COMMAND_SPECIFIC_RESOLVE_TEMPLATE_FILES[command];
      if (resolveTemplateFile) {
        const commandSpecificTemplate = templateLoader.load(
          pathOperations.join(configDir.configDir, resolveTemplateFile),
        );
        if (commandSpecificTemplate !== null) {
          return commandSpecificTemplate;
        }
      }
    }
  }

  return templateLoader.load(pathOperations.join(configDir.configDir, "resolve.md"))
    ?? defaultResolveTemplate;
}

export function extractRundownSubcommand(command: string): string | null {
  const match = command.match(RUNDOWN_SUBCOMMAND_PATTERN);
  const subcommand = match?.[1]?.toLowerCase();
  return subcommand && subcommand.length > 0 ? subcommand : null;
}

export function resolveInlineRundownTargetArtifactPath(params: {
  task: Task;
  pathOperations: PathOperationsPort;
}): string | null {
  const { task, pathOperations } = params;
  if (!task.isInlineCli) {
    return null;
  }

  const command = task.cliCommand ?? "";
  const subcommand = extractRundownSubcommand(command);
  if (subcommand !== "research") {
    return null;
  }

  const target = extractRundownSubcommandTarget(command, "research");
  if (!target) {
    return null;
  }

  const taskDir = pathOperations.dirname(pathOperations.resolve(task.file));
  return pathOperations.isAbsolute(target)
    ? pathOperations.resolve(target)
    : pathOperations.resolve(taskDir, target);
}

export function serializeSelectedTaskMetadata(params: {
  task: Task;
  controllingTaskPath: string;
}): string {
  const { task, controllingTaskPath } = params;
  return JSON.stringify({
    text: task.text,
    index: task.index,
    line: task.line,
    file: task.file,
    controllingTaskPath,
    depth: task.depth,
    isInlineCli: task.isInlineCli,
    cliCommand: task.cliCommand ?? "",
    childrenCount: task.children.length,
    subItemsCount: task.subItems.length,
  });
}

export function normalizeRepairPathForDisplay(params: {
  absolutePath: string;
  cwd: string;
  pathOperations: PathOperationsPort;
}): string {
  const { absolutePath, cwd, pathOperations } = params;
  const normalizedAbsolutePath = pathOperations.resolve(absolutePath);
  const normalizedCwd = pathOperations.resolve(cwd);

  const relativePath = pathOperations.relative(normalizedCwd, normalizedAbsolutePath);
  if (relativePath.length === 0) {
    return ".";
  }

  if (pathOperations.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return normalizedAbsolutePath;
  }

  return relativePath;
}

function extractRundownSubcommandTarget(command: string, subcommand: string): string | null {
  const tokens = tokenizeShellLikeCommand(command);
  if (tokens.length === 0) {
    return null;
  }

  const rundownIndex = tokens.findIndex((token) => /(?:^|[\\/])rundown(?:\.(?:cmd|ps1|bat|exe))?$/i.test(token));
  if (rundownIndex < 0) {
    return null;
  }

  const commandIndex = rundownIndex + 1;
  if (tokens[commandIndex]?.toLowerCase() !== subcommand.toLowerCase()) {
    return null;
  }

  const target = tokens.slice(commandIndex + 1).find((token) => !token.startsWith("-"));
  return target ?? null;
}

function tokenizeShellLikeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
