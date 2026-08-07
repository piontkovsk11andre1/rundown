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
 * Resolves a source string into a list of Markdown file paths.
 *
 * Supports:
 * - single file path
 * - directory (scans recursively for *.md)
 * - glob pattern
 */
export async function resolveSources(source: string): Promise<string[]> {
  // Resolve relative paths early so file and directory checks are stable.
  const resolved = path.resolve(source);

  // Return immediately when the source points to one concrete file.
  if (isFile(resolved)) {
    return [resolved];
  }

  // Expand directories into a recursive Markdown glob.
  if (isDirectory(resolved)) {
    // Normalize separators because glob patterns expect POSIX-style slashes.
    const pattern = path.join(resolved, "**/*.md").replace(/\\/g, "/");
    return await fg(pattern, { absolute: true, onlyFiles: true });
  }

  // Treat any non-file, non-directory input as a glob expression.
  const files = await fg(source.replace(/\\/g, "/"), {
    absolute: true,
    onlyFiles: true,
  });

  // Keep only Markdown files when the glob is broader than *.md.
  return files.filter((f) => f.endsWith(".md"));
}

/**
 * Determines whether the provided path exists and points to a file.
 *
 * Returns `false` for missing paths and inaccessible filesystem entries.
 */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // Missing or inaccessible paths are not treated as files.
    return false;
  }
}

/**
 * Determines whether the provided path exists and points to a directory.
 *
 * Returns `false` for missing paths and inaccessible filesystem entries.
 */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Missing or inaccessible paths are not treated as directories.
    return false;
  }
}
