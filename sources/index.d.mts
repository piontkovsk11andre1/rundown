import type { DiagnosticLocation } from "@p10i/do-md";
import type {
  Catalog,
  LoadOptions,
  RuntimeOptions,
  Surface,
  ParsedDocument,
  SourceMap,
  Diagnostic,
} from "./types.mjs";
export type * from "./types.mjs";

export function loadModule<T extends object = Record<string, unknown>>(
  specifier: string | URL,
  options?: LoadOptions,
): Promise<T>;
export function loadCommands(
  specifier?: string | URL,
  options?: LoadOptions,
): Promise<Catalog>;
export function parseDocument(
  source: string,
  url: string,
  kind?: "module" | "commands",
): ParsedDocument;
export function compile(
  source: string,
  url: string,
  options?: { kind?: "module" | "commands"; outDir?: string },
): { document: ParsedDocument; code: string; map: SourceMap };
export function compileFile(
  url: URL,
  options?: { kind?: "module" | "commands"; outDir?: string },
): ReturnType<typeof compile>;
export class Runtime {
  constructor(catalog: Catalog, options?: RuntimeOptions);
  readonly catalog: Catalog;
  readonly cwd: string;
  readonly callbackHost: CallbackHost;
  invoke(
    name: string,
    args?: Record<string, unknown>,
    options?: import("./types.mjs").InvokeOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}
export class CallbackHost {
  constructor(options?: { bind?: string; port?: number; publicURL?: string });
  close(options?: { graceMs?: number }): Promise<void>;
}
export class RundownError extends Error {
  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      locations?: DiagnosticLocation[];
      status?: number;
      related?: Diagnostic[];
    },
  );
  code: string;
  locations: DiagnosticLocation[];
  status: number;
  invocationId?: string;
  related: Diagnostic[];
}
export function diagnostic(error: unknown, invocationId?: string): Diagnostic;
