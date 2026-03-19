import type { FileSystem } from "../domain/ports/file-system.js";

export function getFileBirthtimeMs(
  filePath: string,
  fileSystem: Pick<FileSystem, "stat">,
): number {
  try {
    return fileSystem.stat(filePath)?.birthtimeMs ?? 0;
  } catch {
    return 0;
  }
}
