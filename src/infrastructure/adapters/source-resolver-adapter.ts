import type { SourceResolverPort } from "../../domain/ports/source-resolver-port.js";
import { resolveSources } from "../sources.js";

export function createSourceResolverAdapter(): SourceResolverPort {
  return {
    resolveSources(source) {
      return resolveSources(source);
    },
  };
}
