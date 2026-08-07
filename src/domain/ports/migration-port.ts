import type { MigrationState } from "../migration-types.js";

export interface MigrationPort {
  scanDirectory(dir: string): MigrationState;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  removeFile(path: string): void;
}
