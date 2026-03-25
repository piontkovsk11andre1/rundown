import path from "node:path";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";

export function createNodePathOperationsAdapter(): PathOperationsPort {
  return {
    join(...parts) {
      return path.join(...parts);
    },
    resolve(...parts) {
      return path.resolve(...parts);
    },
    dirname(filePath) {
      return path.dirname(filePath);
    },
    relative(from, to) {
      return path.relative(from, to);
    },
    isAbsolute(filePath) {
      return path.isAbsolute(filePath);
    },
  };
}