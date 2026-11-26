import type { IOAdapter, DiagnosticLocation } from "@p10i/do-md";
import type { Observability } from "./Observability.mjs";

export type Surface = "cli" | "http" | "mcp" | "http-mcp";
export interface InvokeOptions {
  surface?: Surface;
  signal?: AbortSignal;
  onView?: (view: import("./ViewTypes.mjs").LiveView) => void | Promise<void>;
}
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type Fields = Record<string, unknown>;
export type Logger = Record<
  LogLevel,
  (message: string, fields?: Fields) => void
>;
export type InputSchema = { type: "object" } & Record<string, unknown>;
export interface MetricOptions {
  description?: string;
  unit?: string;
  attributeKeys?: readonly string[];
}
export type MetricAttributes = Record<string, string | number | boolean>;
export interface Counter {
  readonly kind: "counter";
  readonly name: string;
  readonly description: string;
  readonly attributeKeys: readonly string[];
  add(value: number, attributes?: MetricAttributes): void;
}
export interface Histogram {
  readonly kind: "histogram";
  readonly name: string;
  readonly description: string;
  readonly attributeKeys: readonly string[];
  record(value: number, attributes?: MetricAttributes): void;
}
export interface Metrics {
  counter(name: string, options?: MetricOptions): Counter;
  histogram(name: string, options?: MetricOptions): Histogram;
}
export interface CallbackContext {
  signal: AbortSignal;
  invocationId: string;
  log: Logger;
  metrics: Metrics;
}
export interface CallbackDefinition<T = unknown, R = unknown> {
  description?: string;
  inputSchema: InputSchema;
  handler(input: T, context: CallbackContext): R | Promise<R>;
}
export interface Reporting {
  logs?: boolean;
  metrics?: Record<string, Counter | Histogram>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
}
export interface Exposure {
  url: string;
  mcp: {
    type: "remote";
    url: string;
    enabled: true;
    headers?: Record<string, string>;
  };
  tools: ToolDefinition[];
}
export interface Registration {
  readonly id: string;
  readonly state: "open" | "closing" | "cancelled" | "closed";
  readonly tools: ToolDefinition[];
  call(
    name: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  expose(): Promise<Exposure>;
  close(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}
export interface CallbackRegistrar {
  with<R>(
    definitions: Record<string, CallbackDefinition<never, unknown>>,
    operation: (registration: Registration) => R | Promise<R>,
  ): Promise<R>;
  with<R>(
    definitions: Record<string, CallbackDefinition<never, unknown>>,
    options: { reporting?: Reporting },
    operation: (registration: Registration) => R | Promise<R>,
  ): Promise<R>;
  register<T extends Record<string, CallbackDefinition<never, unknown>>>(
    definitions: T,
    options?: { reporting?: Reporting },
  ): Registration;
}
export interface ExecutionContext {
  cwd?: string;
  signal?: AbortSignal;
  traceContext?: Record<string, string>;
}
export type ExternalRunInput = ExecutionContext & Record<string, unknown>;
export interface ExternalAdapter<
  Input extends object = ExternalRunInput,
  Output = unknown,
> {
  run(input: Input & ExecutionContext): Promise<Output>;
}
export type AdapterRegistry = Record<string, ExternalAdapter<never>>;
export interface InvocationContext<
  Adapters extends AdapterRegistry = Record<string, ExternalAdapter>,
> extends CallbackContext {
  id: string;
  workdir: string;
  io: IOAdapter;
  callbacks: CallbackRegistrar;
  adapters: Adapters;
  observability: Observability;
  run<Input extends object, Output>(
    binding: ExternalAdapter<Input, Output>,
    input: Input & ExecutionContext,
  ): Promise<Output>;
}
export interface Parameter {
  name: string;
  type: string;
  required: boolean;
  hasDefault: boolean;
  default?: unknown;
  cli?: string;
  description: string;
}
export interface Command {
  name: string;
  description: string;
  parameters: Parameter[];
  returns: { type: string; description: string };
  surfaces: readonly (Surface | "*")[];
  url: string;
  location: DiagnosticLocation;
  schema: InputSchema;
  validate(input: unknown): unknown;
  handler(
    args: Record<string, unknown>,
    context: InvocationContext,
  ): unknown | Promise<unknown>;
}
export interface Catalog {
  readonly entry: string;
  readonly commands: ReadonlyMap<string, Command>;
}
export interface LoadOptions {
  baseURL?: string | URL;
  cwd?: string;
  signal?: AbortSignal;
  outDir?: string;
}
export interface RuntimeOptions {
  cwd?: string;
  io?: IOAdapter;
  observability?: Observability;
  callbackHost?: import("./index.mjs").CallbackHost;
  adapters?: AdapterRegistry;
  graceMs?: number;
}
export interface Diagnostic {
  code: string;
  message: string;
  locations: DiagnosticLocation[];
  invocationId?: string;
  related?: Diagnostic[];
}
export interface SourcePosition {
  start: { offset: number; line: number; column: number };
  end: { offset: number; line: number; column: number };
}
export interface DocumentMember {
  name: string;
  description: string;
  parameters: Parameter[];
  returns: { type: string; description: string };
  options: Record<string, string>;
  body: {
    language: string;
    meta: string;
    value: string;
    position: SourcePosition;
  };
  position: SourcePosition;
  surfaces: string[];
  sections: Record<string, unknown>;
}
export interface ParsedDocument {
  title: string;
  description: string;
  source: string;
  url: string;
  kind: "module" | "commands";
  members: DocumentMember[];
  sections: Record<string, unknown>;
  connections: {
    file: string;
    description: string;
    position: SourcePosition;
  }[];
  dependencies: {
    source: string;
    kind: "markdown" | "javascript";
    binding: string;
    description: string;
  }[];
  constants: { name: string; value: unknown; description: string }[];
}
export interface SourceMap {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}
