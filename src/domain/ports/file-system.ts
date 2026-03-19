export interface FileSystemStat {
  isFile: boolean;
  isDirectory: boolean;
  birthtimeMs?: number;
  mtimeMs?: number;
}

export interface FileSystemDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystem {
  exists(path: string): boolean;
  readText(filePath: string): string;
  writeText(filePath: string, content: string): void;
  mkdir(dirPath: string, options?: { recursive?: boolean }): void;
  readdir(dirPath: string): FileSystemDirent[];
  stat(path: string): FileSystemStat | null;
  unlink(filePath: string): void;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
