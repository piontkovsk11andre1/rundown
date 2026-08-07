import path from "node:path";
import { parseTasks } from "../../domain/parser.js";
import { parseMigrationDirectory } from "../../domain/migration-parser.js";
import type { MigrationPort } from "../../domain/ports/migration-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";

export interface CreateMigrationAdapterDependencies {
  fileSystem: FileSystem;
}

export function createMigrationAdapter({ fileSystem }: CreateMigrationAdapterDependencies): MigrationPort {
  return {
    scanDirectory(dir) {
      const entries = fileSystem.readdir(dir)
        .filter((entry) => entry.isFile)
        .map((entry) => path.join(dir, entry.name));

      const state = parseMigrationDirectory(entries, dir);
      const migrations = state.migrations.map((migration) => {
        const source = fileSystem.readText(migration.filePath);
        const tasks = parseTasks(source, migration.filePath);
        const hasTasks = tasks.length > 0;
        const isApplied = hasTasks && tasks.every((task) => task.checked);

        return {
          ...migration,
          isApplied,
        };
      });

      return {
        ...state,
        migrations,
      };
    },
    readFile(filePath) {
      return fileSystem.readText(filePath);
    },
    writeFile(filePath, content) {
      fileSystem.writeText(filePath, content);
    },
    removeFile(filePath) {
      fileSystem.unlink(filePath);
    },
  };
}
