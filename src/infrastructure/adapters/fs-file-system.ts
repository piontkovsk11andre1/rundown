import fs from "node:fs";
import type { FileSystem, FileSystemDirent, FileSystemStat } from "../../domain/ports/file-system.js";

export function createNodeFileSystem(): FileSystem {
  return {
    exists(filePath) {
      return fs.existsSync(filePath);
    },
    readText(filePath) {
      return fs.readFileSync(filePath, "utf-8");
    },
    writeText(filePath, content) {
      fs.writeFileSync(filePath, content, "utf-8");
    },
    mkdir(dirPath, options) {
      fs.mkdirSync(dirPath, options);
    },
    readdir(dirPath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((entry): FileSystemDirent => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
      }));
    },
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
    unlink(filePath) {
      fs.unlinkSync(filePath);
    },
    rm(filePath, options) {
      fs.rmSync(filePath, options);
    },
  };
}
