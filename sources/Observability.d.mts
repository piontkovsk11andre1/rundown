import type { Context, Tracer, Meter } from "@opentelemetry/api";
import type {
  Fields,
  LogLevel,
  Logger,
  Metrics,
  MetricOptions,
  Counter,
  Histogram,
} from "./types.mjs";
export const levels: LogLevel[];
export function initializeTelemetry(
  options?: Partial<import("@opentelemetry/sdk-node").NodeSDKConfiguration>,
): Promise<{ close(): Promise<void> }>;
export function normalizeTraceCarrier(
  carrier: Record<string, unknown>,
): Record<string, string>;
export function traceCarrier(parent?: Context): Record<string, string>;
export function withTraceContext<T>(
  carrier: Record<string, unknown>,
  operation: () => T,
): T;
export function environmentTraceContext(
  env?: NodeJS.ProcessEnv,
): Record<string, string>;
export const tracedFetch: typeof globalThis.fetch;
export class Observability {
  constructor(options?: {
    sink?: (
      record: Fields & {
        timestamp: string;
        level: LogLevel;
        message: string;
        invocationId: string;
      },
    ) => void;
    env?: NodeJS.ProcessEnv;
  });
  readonly tracer: Tracer;
  readonly meter: Meter;
  scoped(invocationId: string): { log: Logger; metrics: Metrics };
  emit(
    invocationId: string,
    level: LogLevel,
    message: string,
    fields?: Fields,
  ): void;
  instrument(kind: "counter", name: string, options?: MetricOptions): Counter;
  instrument(
    kind: "histogram",
    name: string,
    options?: MetricOptions,
  ): Histogram;
  span<T>(
    name: string,
    fields: Fields,
    operation: () => T | Promise<T>,
    parentContext?: Context,
    options?: {
      kind?: import("@opentelemetry/api").SpanKind;
      links?: import("@opentelemetry/api").Link[];
    },
  ): Promise<T>;
}
