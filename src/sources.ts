/**
 * Source resolution.
 *
 * Resolves a user-provided source (file path, directory, or glob)
 * into a list of Markdown file paths ready for scanning.
 */

import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

/**
 * Resolve a source string into a sorted list of Markdown file paths.
 *
 * Supports:
 * - single file path
 * - directory (scans recursively for *.md)
 * - glob pattern
 */
export async function resolveSources(source: string): Promise<string[]> {
  const resolved = path.resolve(source);

  // Single file
  if (isFile(resolved)) {
    return [resolved];
  }

  // Directory
  if (isDirectory(resolved)) {
    const pattern = path.join(resolved, "**/*.md").replace(/\\/g, "/");
    return await fg(pattern, { absolute: true, onlyFiles: true });
  }

  // Glob
  const files = await fg(source.replace(/\\/g, "/"), {
    absolute: true,
    onlyFiles: true,
  });

  // Filter to only .md files
  return files.filter((f) => f.endsWith(".md"));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
