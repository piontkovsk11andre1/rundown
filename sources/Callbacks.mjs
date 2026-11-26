import { randomUUID } from "node:crypto";
import { validator } from "./Validation.mjs";
import { RundownError, diagnostic, diagnose } from "./Error.mjs";
import { levels, traceCarrier } from "./Observability.mjs";
import { abortable, bounded, deadlineAfter, remaining } from "./Lifecycle.mjs";
import {
  context as otelContext,
  trace,
  isSpanContextValid,
} from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { withinInvocation } from "./Lifecycle.mjs";

/** @type {AsyncLocalStorage<Registration>} */
const activeCallback = new AsyncLocalStorage();

/** Scope a registration without hiding exposure or application completion policy.
 * @template R
 * @param {CallbackHost} host
 * @param {import('./InternalContracts.mjs').InternalContext} context
 * @param {Record<string,import('./types.mjs').CallbackDefinition<never,unknown>>} definitions
 * @param {{reporting?:import('./types.mjs').Reporting}|((registration:import('./types.mjs').Registration)=>R|Promise<R>)} options
 * @param {(registration:import('./types.mjs').Registration)=>R|Promise<R>} [operation]
 * @returns {Promise<R>}
 */
export async function withCallbacks(
  host,
  context,
  definitions,
  options,
  operation,
) {
  const execute = typeof options === "function" ? options : operation;
  if (typeof execute !== "function")
    throw new TypeError("Expected a callback scope operation");
  const registration = host.register(
    context,
    /** @type {Record<string,import('./types.mjs').CallbackDefinition>} */ (
      definitions
    ),
    typeof options === "function" ? {} : options,
  );
  let failure;
  try {
    return await execute(registration);
  } catch (error) {
    failure = diagnose(error);
    throw failure;
  } finally {
    // A scope uses the invocation's shutdown deadline when one is already active.
    const deadline =
      context.cleanupDeadline ?? deadlineAfter(context.graceMs ?? 5000);
    const cleanup = await bounded(
      Promise.allSettled([
        context.signal.aborted ? registration.cancel() : registration.close(),
      ]),
      remaining(deadline),
    );
    const rejected = cleanup.completed
      ? cleanup.value.find((value) => value.status === "rejected")
      : undefined;
    if (!cleanup.completed || rejected) {
      const error = new RundownError(
        cleanup.completed
          ? "RUNDOWN_CLEANUP_FAILED"
          : "RUNDOWN_CLEANUP_TIMEOUT",
        cleanup.completed
          ? "Callback scope cleanup failed"
          : "Callback scope cleanup deadline expired",
        {
          cause: rejected?.reason,
          related: rejected ? [diagnostic(rejected.reason)] : [],
        },
      );
      error.invocationId = context.id;
      registration.revoke(error);
      if (failure) failure.related.push(diagnostic(error));
      else throw error;
    }
  }
}

function cancelled() {
  return new DOMException("Invocation cancelled", "AbortError");
}

/** @param {import('./types.mjs').Reporting|undefined} reporting @param {import('./InternalContracts.mjs').InternalContext} context */
function reportingDefinitions(reporting, context) {
  /** @type {Record<string,import('./types.mjs').CallbackDefinition>} */
  const definitions = {};
  if (reporting?.logs)
    definitions.report_log = {
      description: "Report a structured log for the current invocation.",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: levels },
          message: { type: "string" },
          fields: { type: "object" },
        },
        required: ["level", "message"],
        additionalProperties: false,
      },
      handler: (input) => {
        const { level, message, fields } =
          /** @type {import('./InternalContracts.mjs').ReportLog} */ (input);
        context.log[level](message, fields);
        return { accepted: true };
      },
    };
  const instruments = reporting?.metrics ?? {};
  const entries = Object.entries(instruments);
  if (entries.length) {
    const variants = entries.map(([alias, instrument]) => {
      if (!instrument || !["counter", "histogram"].includes(instrument.kind))
        throw new RundownError(
          "RUNDOWN_METRIC",
          "Expected a declared instrument",
        );
      return {
        type: "object",
        properties: {
          metric: { const: alias },
          value: {
            type: "number",
            ...(instrument.kind === "counter" ? { minimum: 0 } : {}),
          },
          attributes: {
            type: "object",
            properties: Object.fromEntries(
              instrument.attributeKeys.map((key) => [
                key,
                { type: ["string", "number", "boolean"] },
              ]),
            ),
            additionalProperties: false,
          },
        },
        required: ["metric", "value"],
        additionalProperties: false,
      };
    });
    definitions.report_metric = {
      description:
        "Update a declared metric. " +
        entries
          .map(
            ([alias, instrument]) =>
              `${alias}: ${instrument.description} (${instrument.kind})`,
          )
          .join("; "),
      inputSchema: { type: "object", oneOf: variants },
      handler: (input) => {
        const { metric, value, attributes } =
          /** @type {import('./InternalContracts.mjs').ReportMetric} */ (input);
        const instrument = instruments[metric];
        if (instrument.kind === "counter") instrument.add(value, attributes);
        else instrument.record(value, attributes);
        return { accepted: true };
      },
    };
  }
  return definitions;
}

/** Live, transport-independent callback capability. Normal close drains; cancel drops queued work. */
export class Registration {
  /** @param {CallbackHost} host @param {import('./InternalContracts.mjs').InternalContext} context @param {Record<string,import('./types.mjs').CallbackDefinition>} definitions @param {{reporting?:import('./types.mjs').Reporting}} [options] */
  constructor(host, context, definitions, options = {}) {
    this.id = randomUUID();
    this.host = host;
    this.context = context;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.parentContext = otelContext.active();
    /** @type {import('./types.mjs').Registration['state']} */
    this.state = "open";
    this.pending = 0;
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve();
    /** @type {Map<string,import('./InternalContracts.mjs').StoredCallback>} */
    this.definitions = new Map();
    /** @type {Promise<void>|undefined} */
    this.closing = undefined;
    const reports = reportingDefinitions(options.reporting, context);
    for (const name of Object.keys(definitions))
      if (name.startsWith("report_"))
        throw new RundownError(
          "RUNDOWN_CALLBACK",
          "report_ names are reserved",
          { status: 400 },
        );
    for (const [name, definition] of Object.entries({
      ...definitions,
      ...reports,
    })) {
      if (
        !/^[a-zA-Z][\w-]*$/.test(name) ||
        typeof definition.handler !== "function"
      )
        throw new RundownError(
          "RUNDOWN_CALLBACK",
          `Invalid callback: ${name}`,
          { status: 400 },
        );
      this.definitions.set(name, {
        ...definition,
        inputSchema: structuredClone(definition.inputSchema),
        validate: validator(definition.inputSchema),
      });
    }
    this.onAbort = () => {
      this.cancel().catch(() => {});
    };
    context.signal.addEventListener("abort", this.onAbort, { once: true });
  }
  get tools() {
    return [...this.definitions].map(([name, d]) => ({
      name,
      description: d.description ?? name,
      inputSchema: structuredClone(d.inputSchema),
    }));
  }
  /** @param {string} name @param {unknown} input @param {{signal?:AbortSignal}} [options] @returns {Promise<unknown>} */
  async call(name, input, { signal } = {}) {
    const callSignal = signal
      ? AbortSignal.any([this.signal, signal])
      : this.signal;
    if (this.state !== "open")
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Callback registration is closed",
        { status: 404 },
      );
    if (callSignal.aborted) throw cancelled();
    const definition = this.definitions.get(name);
    if (!definition)
      throw new RundownError(
        "RUNDOWN_CALLBACK_UNKNOWN",
        `Unknown callback: ${name}`,
        { status: 404 },
      );
    const value = structuredClone(input);
    definition.validate(value);
    if (this.pending >= 1000)
      throw new RundownError(
        "RUNDOWN_CALLBACK_QUEUE",
        "Callback queue is full",
        { status: 429 },
      );
    this.pending++;
    const promise = this.tail
      .then(() => {
        if (this.state === "cancelled" || callSignal.aborted) throw cancelled();
        const incoming = trace.getSpanContext(otelContext.active());
        const owner = trace.getSpanContext(this.parentContext);
        const links =
          incoming &&
          isSpanContextValid(incoming) &&
          incoming.spanId !== owner?.spanId
            ? [{ context: incoming }]
            : [];
        return activeCallback.run(this, () =>
          this.context.observability.span(
            "rundown.callback",
            { invocationId: this.context.id, callback: name },
            () =>
              withinInvocation(this.context, () =>
                definition.handler(value, {
                  signal: callSignal,
                  invocationId: this.context.id,
                  log: this.context.log,
                  metrics: this.context.metrics,
                }),
              ),
            this.parentContext,
            { links },
          ),
        );
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = promise.catch(() => {});
    return abortable(promise, callSignal);
  }
  /** Allocate a listener only when an adapter asks for external connectivity. */
  /** @returns {Promise<import('./types.mjs').Exposure>} */
  async expose() {
    if (this.state !== "open")
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Callback registration is closed",
        { status: 404 },
      );
    return this.host.expose(this);
  }
  /** @returns {Promise<void>} */
  close() {
    if (activeCallback.getStore() === this)
      return Promise.reject(
        new RundownError(
          "RUNDOWN_CALLBACK_LIFECYCLE",
          "A callback cannot close its own registration while executing",
        ),
      );
    if (this.closing) return this.closing;
    if (this.state === "open") this.state = "closing";
    this.closing = this.tail.then(() => {
      this.state = "closed";
      this.context.signal.removeEventListener("abort", this.onAbort);
      this.host.release(this);
    });
    return this.closing;
  }
  /** @param {unknown} [reason] @returns {Promise<void>} */
  cancel(reason) {
    if (this.state === "closed") return this.close();
    this.state = "cancelled";
    this.controller.abort(reason);
    this.host.release(this, false);
    this.context.signal.removeEventListener("abort", this.onAbort);
    return this.close();
  }
  /** Revoke ownership after the owner's deadline, while observing unfinished JS. */
  /** @param {unknown} [reason] */
  revoke(reason) {
    this.cancel(reason).catch(() => {});
    this.host.release(this);
  }
}

/** Registrations belong to invocations; network servers only route to this registry. */
export class CallbackHost {
  /** @param {{bind?:string,port?:number,publicURL?:string}} [options] */
  constructor({ bind = "127.0.0.1", port = 0, publicURL } = {}) {
    /** @type {Map<string,Registration>} */
    this.registrations = new Map();
    this.bind = bind;
    this.port = port;
    this.publicURL = publicURL;
    this.closed = false;
    this.owned = false;
    /** @type {import('./InternalContracts.mjs').HttpHandle|undefined} */
    this.server = undefined;
    /** @type {Promise<import('./InternalContracts.mjs').HttpHandle>|undefined} */
    this.starting = undefined;
    /** @type {Promise<void>|undefined} */
    this.closing = undefined;
  }
  /** @param {import('./InternalContracts.mjs').InternalContext} context @param {Record<string,import('./types.mjs').CallbackDefinition>} definitions @param {{reporting?:import('./types.mjs').Reporting}} [options] */
  register(context, definitions, options) {
    if (this.closed)
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Callback host is closed",
      );
    context.signal.throwIfAborted();
    if (context.finished)
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Invocation has finished",
      );
    const registration = new Registration(this, context, definitions, options);
    this.registrations.set(registration.id, registration);
    context.registrations.add(registration);
    return registration;
  }
  /** @param {Registration} registration @param {boolean} [finished] */
  release(registration, finished = true) {
    this.registrations.delete(registration.id);
    this.server?.releaseRegistration(registration.id);
    if (finished) registration.context.registrations.delete(registration);
  }
  /** @param {Registration} registration @returns {Promise<import('./types.mjs').Exposure>} */
  async expose(registration) {
    if (this.closed)
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Callback host is closed",
      );
    if (!this.server) {
      this.owned = true;
      this.starting ??= import("./Http.mjs").then(({ startHttp }) =>
        startHttp({
          callbackHost: this,
          bind: this.bind,
          port: this.port,
          publicURL: this.publicURL,
        }),
      );
      this.server = await this.starting;
    }
    if (this.closed || registration.state !== "open")
      throw new RundownError(
        "RUNDOWN_CALLBACK_CLOSED",
        "Callback registration is closed",
      );
    const url = `${this.server.url}/callbacks/${registration.id}`;
    return {
      url,
      mcp: {
        type: "remote",
        url: url + "/mcp",
        enabled: true,
        headers: traceCarrier(),
      },
      tools: registration.tools,
    };
  }
  /** @param {{deadline?:number,graceMs?:number}} [options] @returns {Promise<void>} */
  close({ graceMs = 5000, deadline = deadlineAfter(graceMs) } = {}) {
    return (this.closing ??= (async () => {
      this.closed = true;
      const registrations = [...this.registrations.values()];
      const result = await bounded(
        Promise.allSettled(registrations.map((reg) => reg.cancel())),
        remaining(deadline),
      );
      let expired = !result.completed;
      const failures = result.completed
        ? result.value
            .filter((value) => value.status === "rejected")
            .map((value) => value.reason)
        : [];
      if (expired)
        for (const registration of registrations)
          registration.revoke(
            new RundownError(
              "RUNDOWN_CLEANUP_TIMEOUT",
              "Callback host cleanup deadline expired",
            ),
          );
      if (this.starting) {
        const startup = await bounded(
          this.starting.catch(() => undefined),
          remaining(deadline),
        );
        if (!startup.completed) {
          expired = true;
          this.starting.then((server) => server.close()).catch(() => {});
        }
      }
      const server = this.server;
      if (this.owned && server) {
        const stopped = await bounded(
          Promise.allSettled([Promise.resolve().then(() => server.close())]),
          remaining(deadline),
        );
        expired ||= !stopped.completed;
        if (stopped.completed)
          for (const value of stopped.value)
            if (value.status === "rejected") failures.push(value.reason);
      }
      this.server = undefined;
      this.starting = undefined;
      if (expired || failures.length)
        throw new RundownError(
          expired ? "RUNDOWN_CLEANUP_TIMEOUT" : "RUNDOWN_CLEANUP_FAILED",
          expired
            ? "Callback host shutdown deadline expired; registrations were revoked"
            : "Callback host cleanup failed",
          {
            cause: failures[0],
            related: failures.map((failure) => diagnostic(failure)),
          },
        );
    })());
  }
}
