import { traceCarrier } from "./Observability.mjs";
import { RundownError } from "./Error.mjs";
import { withinInvocation } from "./Lifecycle.mjs";

/** @type {WeakMap<object,{adapter:import('./types.mjs').ExternalAdapter<never>,name:string,context:import('./InternalContracts.mjs').InternalContext}>} */
const instrumented = new WeakMap();

/** Execute a binding through the same invocation boundary as injected adapters.
 * @param {import('./types.mjs').ExternalAdapter<never>} adapter
 * @param {string} name
 * @param {import('./InternalContracts.mjs').InternalContext} context
 * @param {import('./types.mjs').ExecutionContext & object} input
 */
export async function runBinding(adapter, name, context, input) {
  for (
    let wrapped = adapter && instrumented.get(adapter);
    wrapped;
    wrapped = instrumented.get(adapter)
  ) {
    if (wrapped.context !== context)
      throw new RundownError(
        "RUNDOWN_ADAPTER_OWNER",
        "An invocation-bound adapter cannot be reused by another invocation",
      );
    adapter = wrapped.adapter;
    name = wrapped.name;
  }
  if (context.finished)
    throw new RundownError(
      "RUNDOWN_INVOCATION_CLOSED",
      "Cannot start a binding after its owning invocation finished",
    );
  if (!adapter || typeof adapter.run !== "function")
    throw new TypeError("A binding must expose run(input)");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RundownError(
      "RUNDOWN_ADAPTER_INPUT",
      "Binding input must be an object",
      { status: 400 },
    );
  const signal = input.signal
    ? AbortSignal.any([context.signal, input.signal])
    : context.signal;
  signal.throwIfAborted();
  return withinInvocation(context, () =>
    context.observability.span(
      "rundown.adapter",
      { invocationId: context.id, adapter: name },
      () => {
        const carrier = traceCarrier();
        return Promise.resolve(
          Reflect.apply(adapter.run, adapter, [
            {
              ...input,
              cwd: input.cwd ?? context.workdir,
              signal,
              traceContext: Object.keys(carrier).length
                ? carrier
                : input.traceContext,
            },
          ]),
        );
      },
    ),
  );
}

/** Trace an adapter without narrowing its domain input or losing prototype/private methods.
 * The facade target has no frozen own run property, so frozen adapters work too.
 * @param {import('./types.mjs').ExternalAdapter<never>} adapter
 * @param {string} name @param {import('./InternalContracts.mjs').InternalContext} context
 */
export function instrumentAdapter(adapter, name, context) {
  const run = async (
    /** @type {import('./types.mjs').ExternalRunInput} */ input,
  ) => runBinding(adapter, name, context, input);
  /** @param {string|symbol} key */
  const read = (key) => {
    if (key === "run") return run;
    const value = /** @type {unknown} */ (Reflect.get(adapter, key, adapter));
    return typeof value === "function" ? value.bind(adapter) : value;
  };
  const proxy = /** @type {import('./types.mjs').ExternalAdapter} */ (
    new Proxy(Object.create(Object.getPrototypeOf(adapter)), {
      get: (_target, key) => read(key),
      set: (_target, key, value) => Reflect.set(adapter, key, value, adapter),
      has: (_target, key) => Reflect.has(adapter, key),
      ownKeys: () => Reflect.ownKeys(adapter),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(adapter, key);
        return descriptor
          ? {
              configurable: true,
              enumerable: descriptor.enumerable,
              writable: true,
              value: read(key),
            }
          : undefined;
      },
    })
  );
  instrumented.set(proxy, { adapter, name, context });
  return proxy;
}
