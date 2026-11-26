/** @param {number} milliseconds @returns {number} Absolute, monotonic cleanup deadline. */
export function deadlineAfter(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new TypeError("Grace period must be finite and nonnegative");
  return performance.now() + milliseconds;
}
/** @param {number} deadline */
export function remaining(deadline) {
  return Math.max(0, deadline - performance.now());
}

/**
 * Bound cooperative work and distinguish expiry from a successful undefined result.
 * The losing promise remains observed; expiry does not forcibly interrupt JS.
 * @template T
 * @param {PromiseLike<T>} promise
 * @param {number} milliseconds
 * @returns {Promise<{completed:true,value:T}|{completed:false}>}
 */
export async function bounded(promise, milliseconds) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({
        completed: /** @type {const} */ (true),
        value,
      })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancellation stops waiting; the underlying promise is still observed.
 * @template T @param {PromiseLike<T>} promise @param {AbortSignal} signal @returns {Promise<T>}
 */
export function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(
      signal.reason ?? new DOMException("Cancelled", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
import { AsyncLocalStorage } from "node:async_hooks";

// Only resource ownership is ambient. Module namespaces and business inputs keep
// their native ESM/explicit-parameter semantics across invocations.
/** @type {AsyncLocalStorage<import('./InternalContracts.mjs').InternalContext>} */
const invocation = new AsyncLocalStorage();
export const currentInvocation = () => invocation.getStore();
/** @template T @param {import('./InternalContracts.mjs').InternalContext} context @param {()=>T} operation */
export const withinInvocation = (context, operation) =>
  invocation.run(context, operation);
