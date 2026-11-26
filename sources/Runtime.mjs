import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { NodeFilesystem } from "@p10i/do-md";
import { CallbackHost, withCallbacks } from "./Callbacks.mjs";
import { Observability } from "./Observability.mjs";
import { instrumentAdapter, runBinding } from "./Adapters.mjs";
import { context as otelContext, SpanKind } from "@opentelemetry/api";
import { permits } from "./Catalog.mjs";
import { argumentsFor } from "./Validation.mjs";
import { diagnose, diagnostic, RundownError } from "./Error.mjs";
import {
  bounded,
  abortable,
  deadlineAfter,
  remaining,
  withinInvocation,
} from "./Lifecycle.mjs";
import { View } from "./Views.mjs";

/** Shared request-scoped dispatcher used by every surface. */
export class Runtime {
  /** @param {import('./types.mjs').Catalog} catalog @param {import('./InternalContracts.mjs').InternalRuntimeOptions} [options] */
  constructor(
    catalog,
    {
      cwd = process.cwd(),
      io = new NodeFilesystem(),
      observability = new Observability(),
      callbackHost = new CallbackHost(),
      adapters = {},
      graceMs = 5000,
    } = {},
  ) {
    if (!Number.isFinite(graceMs) || graceMs < 0)
      throw new TypeError("graceMs must be finite and nonnegative");
    this.catalog = catalog;
    this.cwd = resolve(cwd);
    this.io = io;
    this.observability = observability;
    this.callbackHost = callbackHost;
    this.adapters = adapters;
    this.graceMs = graceMs;
    /** @type {Map<string,import('./InternalContracts.mjs').ActiveInvocation>} */
    this.active = new Map();
    this.closed = false;
    /** @type {Promise<void>|undefined} */
    this.closing = undefined;
  }
  /** @param {string} name @param {unknown} [input] @param {import('./types.mjs').InvokeOptions} [options] @returns {Promise<unknown>} */
  async invoke(name, input = {}, { surface = "cli", signal, onView } = {}) {
    if (this.closed)
      throw new RundownError("RUNDOWN_SHUTDOWN", "Runtime is shutting down", {
        status: 503,
      });
    const command = this.catalog.commands.get(name);
    if (!command)
      throw new RundownError(
        "RUNDOWN_COMMAND_UNKNOWN",
        `Unknown command: ${name}`,
        { status: 404 },
      );
    if (!permits(command, surface))
      throw new RundownError(
        "RUNDOWN_SURFACE",
        `Command ${name} is unavailable on ${surface}`,
        { status: 403 },
      );
    const args = argumentsFor(command, input, this.cwd);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const id = randomUUID();
    /** @type {RundownError|undefined} */
    let resourceFailure;
    const scoped = this.observability.scoped(id);
    /** @type {import('./InternalContracts.mjs').InternalContext} */
    const context = {
      id,
      invocationId: id,
      workdir: this.cwd,
      io: this.io,
      signal: controller.signal,
      ...scoped,
      adapters: this.adapters,
      observability: this.observability,
      registrations: new Set(),
      views: new Set(),
      fail: (error) => {
        if (controller.signal.aborted) return;
        resourceFailure ??= diagnose(error);
        controller.abort(resourceFailure);
      },
      finished: false,
      graceMs: this.graceMs,
      run: (binding, input) => runBinding(binding, "binding", context, input),
      callbacks: Object.freeze({
        register: (
          /** @type {Record<string,import('./types.mjs').CallbackDefinition>} */ definitions,
          /** @type {{reporting?:import('./types.mjs').Reporting}|undefined} */ options,
        ) => this.callbackHost.register(context, definitions, options),
        with: /** @type {import('./types.mjs').CallbackRegistrar['with']} */ (
          (
            /** @type {Record<string,import('./types.mjs').CallbackDefinition<never,unknown>>} */ definitions,
            /** @type {Parameters<typeof withCallbacks>[3]} */ options,
            /** @type {Parameters<typeof withCallbacks>[4]} */ operation,
          ) =>
            withCallbacks(
              this.callbackHost,
              context,
              definitions,
              options,
              operation,
            )
        ),
      }),
    };
    context.adapters = Object.fromEntries(
      Object.entries(this.adapters).map(([name, adapter]) => [
        name,
        adapter && typeof adapter.run === "function"
          ? instrumentAdapter(adapter, name, context)
          : adapter,
      ]),
    );
    const operation = withinInvocation(context, () =>
      this.observability.span(
        "rundown.command",
        { invocationId: id, command: name, surface },
        async () => {
          /** @type {RundownError|undefined} */
          let failure;
          /** @type {View|undefined} */
          let view;
          /** @type {ReturnType<typeof setInterval>|undefined} */
          let viewLifetime;
          try {
            controller.signal.throwIfAborted();
            const result = await abortable(
              Promise.resolve().then(() => command.handler(args, context)),
              controller.signal,
            );
            if (result instanceof View) {
              result.claim(id);
              context.views.add(result);
              view = result;
              // Waiting on a promise alone does not keep Node alive. An open,
              // returned view explicitly owns the run, even between external events.
              viewLifetime = setInterval(() => {}, 2 ** 30);
              if (onView)
                await abortable(
                  Promise.resolve().then(() => onView(result)),
                  controller.signal,
                );
              await abortable(view.done, controller.signal);
            }
            return result;
          } catch (cause) {
            const error =
              resourceFailure ??
              (controller.signal.aborted
                ? new RundownError(
                    "RUNDOWN_CANCELLED",
                    "Invocation cancelled",
                    {
                      cause,
                      locations: diagnose(cause).locations,
                    },
                  )
                : diagnose(cause));
            error.invocationId = id;
            failure = error;
            for (const owned of context.views) {
              if (controller.signal.aborted) owned.cancel(error);
              else owned.fail(error);
            }
            // Already-started work must see failure even if no view was returned.
            controller.abort(error);
            throw error;
          } finally {
            clearInterval(viewLifetime);
            context.finished = true;
            const views = [...context.views];
            if (views.some((owned) => owned !== view && owned.state === "open"))
              controller.abort(
                new RundownError(
                  "RUNDOWN_INVOCATION_CLOSED",
                  "Invocation finished without returning its open view",
                ),
              );
            for (const owned of views)
              if (owned.state === "open")
                owned.cancel(controller.signal.reason);
            signal?.removeEventListener("abort", abort);
            const registrations = [...context.registrations];
            const result = await bounded(
              Promise.allSettled([
                ...registrations.map((reg) =>
                  controller.signal.aborted ? reg.cancel() : reg.close(),
                ),
                ...views.map((owned) => owned.drain(failure)),
              ]),
              remaining(context.cleanupDeadline ?? deadlineAfter(this.graceMs)),
            );
            this.active.delete(id);
            context.views.clear();
            /** @type {RundownError|undefined} */
            let cleanupError;
            if (!result.completed) {
              cleanupError = new RundownError(
                "RUNDOWN_CLEANUP_TIMEOUT",
                `Invocation cleanup exceeded ${this.graceMs}ms; unfinished work was revoked`,
                {
                  locations: command.location
                    ? [{ ...command.location, relation: "processing" }]
                    : [],
                },
              );
              cleanupError.invocationId = id;
              controller.abort(cleanupError);
              for (const registration of registrations)
                registration.revoke(cleanupError);
            } else {
              const rejected = result.value.filter(
                (value) => value.status === "rejected",
              );
              if (rejected.length) {
                cleanupError = new RundownError(
                  "RUNDOWN_CLEANUP_FAILED",
                  "Invocation cleanup failed",
                );
                cleanupError.related = rejected.map((value) =>
                  diagnostic(value.reason, id),
                );
              }
            }
            if (cleanupError) {
              try {
                context.log.warn(cleanupError.message, {
                  code: cleanupError.code,
                });
              } catch (cause) {
                cleanupError.related.push(diagnostic(cause, id));
              }
              if (failure) failure.related.push(diagnostic(cleanupError, id));
              else throw cleanupError;
            }
          }
        },
        otelContext.active(),
        {
          kind:
            surface === "http" || surface === "http-mcp"
              ? SpanKind.SERVER
              : SpanKind.INTERNAL,
        },
      ),
    );
    this.active.set(id, { controller, operation, context });
    return operation;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const deadline = deadlineAfter(this.graceMs);
      const active = [...this.active.values()];
      for (const { controller, context } of active) {
        context.cleanupDeadline = deadline;
        controller.abort();
      }
      const result = await bounded(
        Promise.allSettled(active.map((a) => a.operation)),
        remaining(deadline),
      );
      if (!result.completed)
        for (const { context } of active)
          for (const reg of context.registrations)
            reg.revoke(
              new RundownError(
                "RUNDOWN_CLEANUP_TIMEOUT",
                "Runtime cleanup deadline expired",
              ),
            );
      await this.callbackHost.close({ deadline });
      if (!result.completed)
        throw new RundownError(
          "RUNDOWN_CLEANUP_TIMEOUT",
          "Runtime shutdown deadline expired; remaining work was revoked",
        );
      const failed = result.value
        .filter((value) => value.status === "rejected")
        .map((value) => diagnose(value.reason))
        .find(
          (error) =>
            error.code === "RUNDOWN_CLEANUP_TIMEOUT" ||
            error.related.some(
              (related) => related.code === "RUNDOWN_CLEANUP_TIMEOUT",
            ),
        );
      if (failed)
        throw new RundownError(
          "RUNDOWN_CLEANUP_TIMEOUT",
          "Runtime shutdown left unfinished callback work",
          { cause: failed },
        );
    })();
    return this.closing;
  }
}
