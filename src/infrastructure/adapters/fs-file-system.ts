import fs from "node:fs";
import type { FileSystem, FileSystemDirent, FileSystemStat } from "../../domain/ports/file-system.js";

/**
 * Creates a synchronous Node.js-backed implementation of the file-system port.
 *
 * @returns A `FileSystem` adapter that delegates all operations to `node:fs`.
 */
export function createNodeFileSystem(): FileSystem {
  return {
    // Checks whether a file-system path currently exists.
    exists(filePath) {
      return fs.existsSync(filePath);
    },
    // Reads a UTF-8 text file from disk.
    readText(filePath) {
      return fs.readFileSync(filePath, "utf-8");
    },
    // Writes UTF-8 text content to a file.
    writeText(filePath, content) {
      fs.writeFileSync(filePath, content, "utf-8");
    },
    // Creates a directory using optional recursive settings.
    mkdir(dirPath, options) {
      fs.mkdirSync(dirPath, options);
    },
    // Lists directory entries and maps Node dirents to domain dirents.
    readdir(dirPath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((entry): FileSystemDirent => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
      }));
    },
    // Returns file metadata, or `null` when the path cannot be stat'ed.
    stat(filePath) {
      try {
        const stats = fs.statSync(filePath);
        const value: FileSystemStat = {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          birthtimeMs: stats.birthtimeMs,
          mtimeMs: stats.mtimeMs,
        };
        return value;
      } catch {
        return null;
      }
    },
    // Removes a single file.
    unlink(filePath) {
      fs.unlinkSync(filePath);
    },
    // Removes files or directories according to provided options.
    rm(filePath, options) {
      fs.rmSync(filePath, options);
    },
    // Renames or moves a file-system path.
    rename(fromPath, toPath) {
      fs.renameSync(fromPath, toPath);
    },
  };
}
