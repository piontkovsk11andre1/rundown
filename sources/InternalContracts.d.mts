import type { Reader, TableValue } from "@p10i/do-md";
import type { Server } from "node:http";
import type { Registration, CallbackHost } from "./Callbacks.mjs";
import type {
  InvocationContext,
  RuntimeOptions,
  Parameter,
  SourcePosition,
  InputSchema,
  Diagnostic,
} from "./types.mjs";

export interface InternalContext extends InvocationContext {
  registrations: Set<Registration>;
  views: Set<import("./Views.mjs").View>;
  fail(error: unknown): void;
  finished: boolean;
  graceMs?: number;
  cleanupDeadline?: number;
}
export type InternalRuntimeOptions = Omit<RuntimeOptions, "callbackHost"> & {
  callbackHost?: CallbackHost;
};
export interface HttpHandle {
  server: Server;
  url: string;
  releaseRegistration(id: string): void;
  close(): Promise<void>;
}
export interface Body {
  language: string | null;
  meta: string;
  value: string;
  position: SourcePosition;
}
export interface Table extends TableValue {
  position: SourcePosition;
}
export interface BoundSection {
  heading: string;
  description?: string;
  dependencies?: TableValue;
  constants?: TableValue;
  connections?: TableValue;
  options?: TableValue;
  parameters?: TableValue;
  returns?: TableValue;
  schema?: Omit<Body, "position">;
  handler?: Omit<Body, "position">;
  implementation?: Omit<Body, "position">;
}
export interface BoundContext extends Record<string, unknown> {
  title: string;
  description: string;
  sections: BoundSection[];
}
export type BoundReader = Reader<BoundContext>;
export interface Sections {
  Dependencies?: Table;
  Constants?: Table;
  Connections?: Table;
}
export interface MemberSections {
  Options?: Table;
  Parameters?: Table;
  Returns?: Table;
  body?: Body;
  schema?: unknown;
}
export interface DraftMember {
  name: string;
  description: string;
  sections: MemberSections;
  position: SourcePosition;
  parameters?: Parameter[];
  returns?: { type: string; description: string };
  options?: Record<string, string>;
  body?: Body;
  surfaces?: string[];
}
export interface DraftDocument {
  title: string;
  description: string;
  source: string;
  url: string;
  kind: "module" | "commands";
  sections: Sections;
  members: DraftMember[];
}
export interface ReportLog {
  level: import("./types.mjs").LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}
export interface ReportMetric {
  metric: string;
  value: number;
  attributes?: import("./types.mjs").MetricAttributes;
}
export interface StoredCallback {
  description?: string;
  inputSchema: InputSchema;
  handler(
    input: unknown,
    context: import("./types.mjs").CallbackContext,
  ): unknown | Promise<unknown>;
  validate(input: unknown): unknown;
}
export interface ActiveInvocation {
  controller: AbortController;
  operation: Promise<unknown>;
  context: InternalContext;
}
export interface ErrorOptions {
  cause?: unknown;
  locations?: import("@p10i/do-md").DiagnosticLocation[];
  status?: number;
  related?: Diagnostic[];
}
export interface MetadataPosition {
  start: { offset: number };
}
export interface HttpOptions {
  runtime?: import("./Runtime.mjs").Runtime;
  callbackHost?: CallbackHost;
  bind?: string;
  port?: number;
  publicURL?: string;
  allowedOrigins?: string[];
}
export interface McpOptions {
  runtime?: import("./Runtime.mjs").Runtime;
  registration?: Registration;
  surface?: "mcp" | "http-mcp";
}
export interface McpSession {
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
  transport: import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
  scope: string;
  registrationId?: string;
  active: Set<import("node:http").ServerResponse>;
  lastSeen: number;
  retiring?: boolean;
}
export interface CliOptions {
  cwd: string;
  commands?: string;
  mode:
    | "command"
    | "serve"
    | "mcp"
    | "mcp-http"
    | "compile"
    | "init"
    | "new-command"
    | "new-module"
    | "check"
    | "test"
    | "skill"
    | "reference"
    | "connect";
  bind: string;
  port: number;
  target?: string;
  tests?: string;
  publicURL?: string;
  outDir?: string;
  graceMs?: number;
  jsonErrors?: boolean;
  help?: boolean;
  json?: boolean;
  markdown?: boolean;
  fullscreen?: boolean;
  logs?: "show" | "hide";
  format?: "markdown" | "text" | "json";
}
export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  traceContext?: Record<string, string>;
}
