// @ts-nocheck
import fs from "node:fs";
import path from "node:path";

export type RootWorkspaceState = {
  isEmptyBootstrap: boolean;
  hasWorkersConfigured: boolean;
};

const DEFAULT_WORKSPACE_DIRECTORIES = Object.freeze({
  design: "design",
  implementation: "implementation",
  specs: "specs",
  migrations: "migrations",
});

const IGNORED_ROOT_ENTRIES = new Set([
  ".git",
  ".DS_Store",
  "Thumbs.db",
]);

function readConfigDocument(cwd: string): Record<string, unknown> | undefined {
  const configPath = path.join(cwd, ".rundown", "config.json");
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function readDirectoryEntriesSafe(cwd: string): string[] {
  try {
    return fs.readdirSync(cwd);
  } catch {
    return [];
  }
}

function hasUserVisibleRootEntries(cwd: string): boolean {
  const entries = readDirectoryEntriesSafe(cwd);
  return entries.some((entry) => !IGNORED_ROOT_ENTRIES.has(entry));
}

function normalizeWorkspaceDirectoryName(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed;
}

function resolveWorkspaceDirectories(configDocument: Record<string, unknown> | undefined): {
  design: string;
  implementation: string;
  specs: string;
  migrations: string;
} {
  const workspace = configDocument?.workspace;
  const workspaceObject = workspace && typeof workspace === "object" && !Array.isArray(workspace)
    ? workspace as Record<string, unknown>
    : undefined;
  const directories = workspaceObject?.directories;
  const directoriesObject = directories && typeof directories === "object" && !Array.isArray(directories)
    ? directories as Record<string, unknown>
    : undefined;

  return {
    design: normalizeWorkspaceDirectoryName(directoriesObject?.design, DEFAULT_WORKSPACE_DIRECTORIES.design),
    implementation: normalizeWorkspaceDirectoryName(
      directoriesObject?.implementation,
      DEFAULT_WORKSPACE_DIRECTORIES.implementation,
    ),
    specs: normalizeWorkspaceDirectoryName(directoriesObject?.specs, DEFAULT_WORKSPACE_DIRECTORIES.specs),
    migrations: normalizeWorkspaceDirectoryName(directoriesObject?.migrations, DEFAULT_WORKSPACE_DIRECTORIES.migrations),
  };
}

function isDirectory(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function hasInitializedWorkspaceStructure(cwd: string, configDocument: Record<string, unknown> | undefined): boolean {
  const configPath = path.join(cwd, ".rundown", "config.json");
  if (!fs.existsSync(configPath) || !configDocument) {
    return false;
  }

  const directories = resolveWorkspaceDirectories(configDocument);
  return isDirectory(path.join(cwd, directories.design))
    && isDirectory(path.join(cwd, directories.specs))
    && isDirectory(path.join(cwd, directories.migrations));
}

function hasWorkerList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function detectWorkersConfigured(configDocument: Record<string, unknown> | undefined): boolean {
  if (!configDocument) {
    return false;
  }
  const workers = configDocument.workers;
  if (!workers || typeof workers !== "object" || Array.isArray(workers)) {
    return false;
  }
  const workerConfig = workers as Record<string, unknown>;
  return hasWorkerList(workerConfig.default)
    || hasWorkerList(workerConfig.tui)
    || hasWorkerList(workerConfig.fallbacks);
}

export function detectRootWorkspaceState(cwd: string): RootWorkspaceState {
  const configDocument = readConfigDocument(cwd);
  const hasInitializedWorkspace = hasInitializedWorkspaceStructure(cwd, configDocument);
  const hasAnyUserEntries = hasUserVisibleRootEntries(cwd);

  return {
    isEmptyBootstrap: !hasInitializedWorkspace || !hasAnyUserEntries,
    hasWorkersConfigured: detectWorkersConfigured(configDocument),
  };
}
