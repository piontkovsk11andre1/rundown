import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_CONFIG_DIR_NAME = "rundown";
const GLOBAL_CONFIG_FILE_NAME = "config.json";

export interface GlobalConfigPathResolution {
  readonly canonicalPath: string | undefined;
  readonly discoveredPath: string | undefined;
  readonly candidates: readonly string[];
}

interface ResolveGlobalConfigPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  readonly fileExists?: (filePath: string) => boolean;
}

function normalizeNonEmptyPath(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toConfigFilePathForPlatform(configRoot: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return path.win32.join(configRoot, GLOBAL_CONFIG_DIR_NAME, GLOBAL_CONFIG_FILE_NAME);
  }

  return path.posix.join(configRoot, GLOBAL_CONFIG_DIR_NAME, GLOBAL_CONFIG_FILE_NAME);
}

function resolveHomeDir(input: string | undefined): string | undefined {
  try {
    return normalizeNonEmptyPath(input ?? os.homedir());
  } catch {
    return undefined;
  }
}

function resolveGlobalConfigCandidate(platform: NodeJS.Platform, homedir: string | undefined): string | undefined {
  if (!homedir) {
    return undefined;
  }

  if (platform === "win32") {
    return toConfigFilePathForPlatform(path.win32.join(homedir, "AppData", "Roaming"), platform);
  }

  if (platform === "darwin") {
    return toConfigFilePathForPlatform(path.posix.join(homedir, "Library", "Application Support"), platform);
  }

  return toConfigFilePathForPlatform(path.posix.join(homedir, ".config"), platform);
}

/**
 * Resolves the user-level global config path derived from the home directory.
 *
 * The canonical path is platform-specific and discovery checks that path only.
 */
export function resolveGlobalConfigPath(
  options: ResolveGlobalConfigPathOptions = {},
): GlobalConfigPathResolution {
  const platform = options.platform ?? process.platform;
  const homedir = resolveHomeDir(options.homedir);
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));

  const canonicalPath = resolveGlobalConfigCandidate(platform, homedir);
  const discoveredPath = canonicalPath && fileExists(canonicalPath) ? canonicalPath : undefined;
  const candidates = canonicalPath ? [canonicalPath] : [];

  return {
    canonicalPath,
    discoveredPath,
    candidates,
  };
}
