import type { SourceResolverPort } from "../../domain/ports/source-resolver-port.js";
import { resolveSources } from "../sources.js";

/**
 * Creates a `SourceResolverPort` adapter backed by the infrastructure source resolver.
 *
 * This adapter keeps domain code decoupled from infrastructure implementation details
 * while delegating source resolution to the shared `resolveSources` utility.
 */
export function createSourceResolverAdapter(): SourceResolverPort {
  return {
    // Delegate source resolution to the infrastructure utility implementation.
    resolveSources(source) {
      return resolveSources(source);
    },
  };
}
