import type { WorkingDirectoryPort } from "../../domain/ports/working-directory-port.js";

export function createWorkingDirectoryAdapter(): WorkingDirectoryPort {
  return {
    cwd() {
      return process.cwd();
    },
  };
}
