import type {
  AuthoringOptions,
  InitOptions,
  NewCommandOptions,
  AuthoringResult,
  CheckOptions,
  CheckResult,
} from "./AuthoringTypes.mjs";
export type * from "./AuthoringTypes.mjs";
export function initProject(
  catalog: string | URL,
  options?: InitOptions,
): Promise<AuthoringResult>;
export function newCommand(
  name: string,
  options?: NewCommandOptions,
): Promise<AuthoringResult>;
export function newModule(
  file: string,
  options?: AuthoringOptions,
): Promise<AuthoringResult>;
export function connectCatalog(
  file: string,
  options?: AuthoringOptions,
): Promise<AuthoringResult>;
export function checkProject(options?: CheckOptions): Promise<CheckResult>;
export function readSkill(): Promise<string>;
export const TOPICS: readonly string[];
export function reference(topic?: string): Record<string, unknown>;
export function renderReference(
  topic?: string,
  format?: "markdown" | "text" | "json",
): string;
