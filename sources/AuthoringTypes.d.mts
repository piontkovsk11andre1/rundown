import type { DiagnosticLocation } from "@p10i/do-md";
import type { Diagnostic } from "./types.mjs";
export interface AuthoringOptions {
  cwd?: string;
  signal?: AbortSignal;
  commands?: string | URL;
}
export interface InitOptions extends Omit<AuthoringOptions, "commands"> {
  tests?: string | URL;
}
export interface NewCommandOptions extends AuthoringOptions {
  outDir?: string;
}
export interface CheckOptions extends AuthoringOptions {
  file?: string | URL;
  kind?: "module" | "commands" | "view";
  sourceOverrides?: Readonly<Record<string, string>>;
}
export interface DynamicLoad {
  loader: "loadModule" | "loadCommands" | "createView";
  location: DiagnosticLocation;
  reason: string;
}
export interface CheckResult {
  ok: boolean;
  entry: string | null;
  files: { file: string; kind: "module" | "commands" | "view" }[];
  commands: { name: string; file: string }[];
  dependencies: { source: string; resolved: string }[];
  dynamicLoads: DynamicLoad[];
  errors: Diagnostic[];
}
export interface AuthoringResult {
  ok: true;
  created: string[];
  updated: string[];
  next: string[];
}
