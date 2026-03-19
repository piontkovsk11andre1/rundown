import type { DirectoryOpenerPort } from "../../domain/ports/directory-opener-port.js";
import { openDirectory } from "../open-directory.js";

export function createDirectoryOpenerAdapter(): DirectoryOpenerPort {
  return {
    openDirectory,
  };
}
