import {
  context as otelContext,
  metrics,
  trace,
  SpanStatusCode,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { RundownError } from "./Error.mjs";
import { VERSION } from "./Metadata.mjs";

/** @type {import('./types.mjs').LogLevel[]} */
export const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
const severity = [1, 5, 9, 13, 17, 21];
const reservedFields = new Set([
  "invocationId",
  "traceId",
  "spanId",
  "level",
  "message",
  "timestamp",
]);
/** @param {Record<string,unknown>} fields @returns {import('@opentelemetry/api').Attributes} */
const attributes = (fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
        ? value
        : (JSON.stringify(value) ?? String(value)),
    ]),
  );

/** Optional process-owned SDK. Embedders can instead configure their own OTel providers.
 * @param {Partial<import('@opentelemetry/sdk-node').NodeSDKConfiguration>} [options]
 */
export async function initializeTelemetry(options = {}) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const sdk = new NodeSDK(options);
  sdk.start();
  return { close: () => sdk.shutdown() };
}

/** Normalize the W3C trace carrier only; application identity is never extracted.
 * @param {Record<string,unknown>} carrier @returns {Record<string,string>}
 */
export function normalizeTraceCarrier(carrier) {
  return Object.fromEntries(
    Object.entries(carrier)
      .filter(
        ([key, value]) =>
          ["traceparent", "tracestate"].includes(key.toLowerCase()) &&
          typeof value === "string",
      )
      .map(([key, value]) => [
        key.toLowerCase(),
        /** @type {string} */ (value),
      ]),
  );
}

/** @param {import('@opentelemetry/api').Context} [parent] @returns {Record<string,string>} */
export function traceCarrier(parent = otelContext.active()) {
  /** @type {Record<string,string>} */
  const carrier = {};
  propagation.inject(parent, carrier);
  return normalizeTraceCarrier(carrier);
}

/** Each incoming request starts from ROOT_CONTEXT, not the listener's creation context.
 * @template T @param {Record<string,unknown>} carrier @param {()=>T} operation @returns {T}
 */
export function withTraceContext(carrier, operation) {
  return otelContext.with(
    propagation.extract(ROOT_CONTEXT, normalizeTraceCarrier(carrier)),
    operation,
  );
}

/** @param {NodeJS.ProcessEnv} [env] @returns {Record<string,string>} */
export function environmentTraceContext(env = process.env) {
  if (!env.RUNDOWN_TRACE_CONTEXT) return {};
  let value;
  try {
    value = /** @type {unknown} */ (JSON.parse(env.RUNDOWN_TRACE_CONTEXT));
  } catch (cause) {
    throw new RundownError(
      "RUNDOWN_CONFIGURATION",
      "RUNDOWN_TRACE_CONTEXT must be a JSON object",
      { cause, status: 400 },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RundownError(
      "RUNDOWN_CONFIGURATION",
      "RUNDOWN_TRACE_CONTEXT must be a JSON object",
      { status: 400 },
    );
  return normalizeTraceCarrier(/** @type {Record<string,unknown>} */ (value));
}

/** Standard HTTP forwarding without overriding unrelated headers or signals.
 * @type {typeof globalThis.fetch}
 */
export const tracedFetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  for (const [key, value] of Object.entries(traceCarrier()))
    headers.set(key, value);
  return globalThis.fetch(input, { ...init, headers });
};

/** Invocation-aware logging/metrics facade. Sink injection supports deterministic tests. */
export class Observability {
  /** @param {{sink?:(record:Record<string,unknown>&{timestamp:string,level:import('./types.mjs').LogLevel,message:string,invocationId:string})=>void,env?:NodeJS.ProcessEnv}} [options] */
  constructor({ sink, env = process.env } = {}) {
    this.sink = sink;
    this.level = /** @type {import('./types.mjs').LogLevel} */ (
      env.RUNDOWN_LOG_LEVEL ?? "info"
    );
    this.format =
      env.RUNDOWN_LOG_FORMAT ?? (process.stderr.isTTY ? "human" : "json");
    if (
      !levels.includes(this.level) ||
      !["human", "json"].includes(this.format)
    )
      throw new RundownError(
        "RUNDOWN_CONFIGURATION",
        "Invalid log level or format",
        { status: 400 },
      );
    this.tracer = trace.getTracer("@p10i/rundown", VERSION);
    this.meter = metrics.getMeter("@p10i/rundown", VERSION);
    this.logger = logs.getLogger("@p10i/rundown", VERSION);
    /** @type {Map<string,import('./types.mjs').Counter|import('./types.mjs').Histogram>} */
    this.instruments = new Map();
  }
  /** @param {string} invocationId @returns {{log:import('./types.mjs').Logger,metrics:import('./types.mjs').Metrics}} */
  scoped(invocationId) {
    const log = /** @type {import('./types.mjs').Logger} */ (
      Object.fromEntries(
        levels.map((level) => [
          level,
          (
            /** @type {string} */ message,
            /** @type {Record<string,unknown>} */ fields = {},
          ) => this.emit(invocationId, level, message, fields),
        ]),
      )
    );
    return {
      log,
      metrics: {
        counter: (name, options) => this.instrument("counter", name, options),
        histogram: (name, options) =>
          this.instrument("histogram", name, options),
      },
    };
  }
  /** @param {string} invocationId @param {import('./types.mjs').LogLevel} level @param {string} message @param {Record<string,unknown>} [fields] */
  emit(invocationId, level, message, fields = {}) {
    if (levels.indexOf(level) < levels.indexOf(this.level)) return;
    const span = trace.getSpanContext(otelContext.active());
    const clean = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !reservedFields.has(key)),
    );
    const record = {
      ...clean,
      timestamp: new Date().toISOString(),
      level,
      message: String(message),
      invocationId,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
    };
    this.logger.emit({
      severityNumber: severity[levels.indexOf(level)],
      severityText: level.toUpperCase(),
      body: String(message),
      attributes: attributes({ ...clean, invocationId }),
    });
    if (this.sink) this.sink(record);
    else
      process.stderr.write(
        this.format === "json"
          ? JSON.stringify(record) + "\n"
          : `${record.timestamp} ${level.toUpperCase()} [${invocationId}] ${message}${Object.keys(clean).length ? " " + JSON.stringify(clean) : ""}\n`,
      );
  }
  /** @overload @param {'counter'} kind @param {string} name @param {import('./types.mjs').MetricOptions} [options] @returns {import('./types.mjs').Counter} */
  /** @overload @param {'histogram'} kind @param {string} name @param {import('./types.mjs').MetricOptions} [options] @returns {import('./types.mjs').Histogram} */
  /** @param {'counter'|'histogram'} kind @param {string} name @param {import('./types.mjs').MetricOptions} [options] @returns {import('./types.mjs').Counter|import('./types.mjs').Histogram} */
  instrument(kind, name, options = {}) {
    if (!/^[a-zA-Z][\w.\-/]{0,254}$/.test(name))
      throw new RundownError("RUNDOWN_METRIC", "Invalid metric name");
    const key = JSON.stringify([kind, name, options]);
    const previous = this.instruments.get(key);
    if (previous) return previous;
    const native =
      kind === "counter"
        ? this.meter.createCounter(name, options)
        : this.meter.createHistogram(name, options);
    /** @param {number} value @param {import('./types.mjs').MetricAttributes} [attrs] */
    const update = (value, attrs = {}) => {
      if (!Number.isFinite(value) || (kind === "counter" && value < 0))
        throw new RundownError("RUNDOWN_METRIC", "Invalid metric value", {
          status: 400,
        });
      if ("add" in native) native.add(value, attrs);
      else native.record(value, attrs);
    };
    const instrument = Object.freeze({
      name,
      description: options.description ?? "",
      attributeKeys: Object.freeze([...(options.attributeKeys ?? [])]),
      ...(kind === "counter"
        ? { kind: /** @type {const} */ ("counter"), add: update }
        : { kind: /** @type {const} */ ("histogram"), record: update }),
    });
    this.instruments.set(key, instrument);
    return instrument;
  }
  /** @template T @param {string} name @param {Record<string,unknown>} fields @param {()=>T|Promise<T>} operation @param {import('@opentelemetry/api').Context} [parentContext] @param {{kind?:import('@opentelemetry/api').SpanKind,links?:import('@opentelemetry/api').Link[]}} [options] @returns {Promise<T>} */
  async span(
    name,
    fields,
    operation,
    parentContext = otelContext.active(),
    options = {},
  ) {
    return this.tracer.startActiveSpan(
      name,
      { ...options, attributes: attributes(fields) },
      parentContext,
      async (span) => {
        try {
          return await operation();
        } catch (error) {
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
