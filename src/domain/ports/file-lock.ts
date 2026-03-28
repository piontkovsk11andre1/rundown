export interface FileLockMetadata {
  command: string;
}

export interface FileLockHolder {
  pid: number;
  command: string;
  startTime: string;
}

export class FileLockError extends Error {
  readonly holder: FileLockHolder;
  readonly filePath: string;

  constructor(filePath: string, holder: FileLockHolder, message?: string) {
    super(
      message ??
        `File is locked: ${filePath} (held by pid=${holder.pid}, command=${holder.command}, startTime=${holder.startTime})`,
    );
    this.name = "FileLockError";
    this.filePath = filePath;
    this.holder = holder;
  }
}

export interface FileLock {
  acquire(filePath: string, meta: FileLockMetadata): void;
  isLocked(filePath: string): boolean;
  release(filePath: string): void;
  forceRelease(filePath: string): void;
  releaseAll(): void;
}
