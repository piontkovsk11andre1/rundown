import { readFile } from "node:fs/promises";
import { Template, Writer } from "@p10i/do-md";
import { resolveDocument } from "./Loader.mjs";
import { diagnose, RundownError, fileFailure } from "./Error.mjs";
import { currentInvocation } from "./Lifecycle.mjs";

/** Copy only JSON values, retaining special own keys and rejecting cycles/classes.
 * @param {unknown} value @param {Set<object>} [parents] @returns {unknown}
 */
function jsonCopy(value, parents = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || parents.has(value))
    throw new RundownError(
      "RUNDOWN_VIEW_DATA",
      "View state must contain only finite JSON values without cycles",
    );
  const prototype = Object.getPrototypeOf(value);
  if (
    (!Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new RundownError(
      "RUNDOWN_VIEW_DATA",
      "View state must contain only JSON objects and arrays",
    );
  parents.add(value);
  try {
    return Array.isArray(value)
      ? Array.from(value, (item) => jsonCopy(item, parents))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            jsonCopy(item, parents),
          ]),
        );
  } finally {
    parents.delete(value);
  }
}

/** @param {unknown} data @returns {Record<string,unknown>} */
function snapshot(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new RundownError(
      "RUNDOWN_VIEW_DATA",
      "View state must be a JSON object",
    );
  return /** @type {Record<string,unknown>} */ (jsonCopy(data));
}

/** Validate surface-supplied layout independently of application state.
 * @param {Partial<import('./ViewTypes.mjs').ViewDisplay>} [input]
 * @returns {import('./ViewTypes.mjs').ViewDisplay}
 */
export function viewDisplay({ width = 80, height = 24 } = {}) {
  for (const value of [width, height])
    if (!Number.isInteger(value) || value < 1 || value > 10000)
      throw new RundownError(
        "RUNDOWN_VIEW_DISPLAY",
        "Display dimensions must be integers between 1 and 10000",
        { status: 400 },
      );
  return { width, height };
}

/** A live document. State changes are explicit; rendering never exposes mutable state. */
export class View {
  /** @type {Record<string,unknown>} */ #data;
  #revision = 0;
  /** @type {import('./ViewTypes.mjs').LiveView['state']} */ #state = "open";
  /** @type {Set<()=>void>} */ #listeners = new Set();
  /** @type {Set<Promise<unknown>>} */ #pending = new Set();
  /** @type {import('./Error.mjs').RundownError|undefined} */ #failure;
  /** @type {string|undefined} */ #owner;
  /** @type {((error:unknown)=>void)|undefined} */ #ownerFailure;
  /** @type {unknown} */ #cancellation;
  /** @type {()=>void} */ #resolve = () => {};
  /** @type {(reason:unknown)=>void} */ #reject = () => {};
  /** @type {import('./ViewTypes.mjs').ViewPresentation} */ #presentation;
  /** @type {Promise<void>} */ #done;
  /** @type {import('@p10i/do-md').TemplateFunction<Record<string,unknown>>} */ #template;

  /** Inline templates are useful for embedding; createView loads project files.
   * @param {string} source @param {Record<string,unknown>} data
   * @param {Partial<import('./ViewTypes.mjs').ViewPresentation> & {file?:string}} [options]
   */
  constructor(
    source,
    data,
    {
      file = "view.md.template",
      fullscreen = false,
      logs = fullscreen ? "hide" : "show",
    } = {},
  ) {
    this.#data = snapshot(data);
    this.#presentation = { fullscreen, logs };
    this.#validatePresentation(this.#presentation);
    this.#template = Template.wrap(source, file);
    this.#done = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A view may fail before the handler returns it. Keep that rejection observed.
    this.#done.catch(() => {});
    this.#attach();
  }
  get data() {
    return snapshot(this.#data);
  }
  get revision() {
    return this.#revision;
  }
  get state() {
    return this.#state;
  }
  get done() {
    return this.#done;
  }
  get presentation() {
    return { ...this.#presentation };
  }
  #assertOpen() {
    if (this.#state !== "open")
      throw new RundownError("RUNDOWN_VIEW_CLOSED", "View is no longer open");
  }
  #attach() {
    const context = currentInvocation();
    if (!context) return;
    if (context.finished)
      throw new RundownError(
        "RUNDOWN_INVOCATION_CLOSED",
        "Cannot attach a view after its invocation finished",
      );
    this.claim(context.id);
    context.views.add(this);
  }
  /** @param {Partial<import('./ViewTypes.mjs').ViewPresentation>} options */
  #validatePresentation(options) {
    if (
      typeof options.fullscreen !== "boolean" ||
      !["show", "hide"].includes(options.logs ?? "")
    )
      throw new TypeError("Expected fullscreen boolean and logs show/hide");
  }
  #notify() {
    this.#revision++;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        // A display/subscriber failure must not escape a deferred track handler
        // as an unhandled rejection or prevent other observers from invalidating.
        this.#failure ??= diagnose(error);
        if (this.#state === "open") {
          this.#state = "failed";
          this.#reject(this.#failure);
          this.#ownerFailure?.(this.#failure);
          this.#ownerFailure = undefined;
        }
      }
    }
  }
  /** @param {Record<string,unknown>} patch */
  update(patch) {
    this.replace({ ...this.#data, ...snapshot(patch) });
  }
  /** @param {Record<string,unknown>} data */
  replace(data) {
    this.#assertOpen();
    this.#data = snapshot(data);
    this.#notify();
  }
  /** @param {Partial<import('./ViewTypes.mjs').ViewPresentation>} options */
  configure(options) {
    this.#assertOpen();
    const next = { ...this.#presentation, ...options };
    this.#validatePresentation(next);
    this.#presentation = next;
    this.#notify();
  }
  /** @param {()=>void} listener */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  /** Attach background work without making successful completion close the view.
   * @template R @param {PromiseLike<R>|(()=>R|PromiseLike<R>)} operation @returns {Promise<R>}
   */
  track(operation) {
    this.#assertOpen();
    this.#attach();
    const pending =
      typeof operation === "function"
        ? Promise.resolve().then(operation)
        : Promise.resolve(operation);
    this.#pending.add(pending);
    pending.then(
      () => this.#pending.delete(pending),
      (error) => {
        this.#pending.delete(pending);
        this.#failure ??= diagnose(error);
        this.fail(error);
      },
    );
    return pending;
  }
  close() {
    if (this.#state !== "open") return;
    this.#state = "closed";
    this.#ownerFailure = undefined;
    this.#resolve();
    this.#notify();
  }
  /** @param {unknown} error */
  fail(error) {
    if (this.#state !== "open") return;
    this.#failure = diagnose(error);
    this.#state = "failed";
    this.#reject(this.#failure);
    this.#ownerFailure?.(this.#failure);
    this.#ownerFailure = undefined;
    this.#notify();
  }
  /** Invocation cancellation freezes state and releases waiters. @param {unknown} reason */
  cancel(reason) {
    if (this.#state !== "open") return;
    this.#state = "cancelled";
    this.#cancellation = reason;
    this.#ownerFailure = undefined;
    this.#reject(reason);
    this.#notify();
  }
  /** Only one invocation may own a live document. @param {string} id */
  claim(id) {
    if (this.#owner && this.#owner !== id)
      throw new RundownError(
        "RUNDOWN_VIEW_OWNED",
        "View already belongs to another invocation",
      );
    this.#owner = id;
    const context = currentInvocation();
    if (context?.id === id && this.#state === "open")
      this.#ownerFailure = context.fail;
  }
  /** Called inside the invocation's bounded cleanup, including after close(). */
  /** @param {import('./Error.mjs').RundownError} [primary] */
  async drain(primary) {
    await Promise.allSettled([...this.#pending]);
    if (
      this.#failure &&
      this.#failure !== primary &&
      !(
        this.#state === "cancelled" &&
        (this.#failure.code === "RUNDOWN_CANCELLED" ||
          this.#failure === this.#cancellation ||
          this.#failure.cause === this.#cancellation)
      )
    )
      throw this.#failure;
  }
  /** Surface-neutral current-snapshot rendering. Templates use public do-md APIs.
   * @param {Partial<import('./ViewTypes.mjs').ViewDisplay>} [display]
   */
  render(display = {}) {
    const input = { data: this.data, display: viewDisplay(display) };
    const writer = new Writer(input);
    this.#template(writer, input, input, {}, undefined);
    return writer.toMarkdown();
  }
}

/** Load a trusted do-md presentation template once; paths are explicit or owner-bound.
 * @param {string|URL} specifier @param {Record<string,unknown>} data
 * @param {import('./ViewTypes.mjs').ViewOptions} [options]
 */
export async function createView(specifier, data, options = {}) {
  const url = resolveDocument(specifier, options);
  let source;
  try {
    source = await readFile(url, "utf8");
  } catch (error) {
    throw fileFailure(error, url.href);
  }
  return new View(source, data, { ...options, file: url.href });
}

/** A live capability is never serialized as an arbitrary result object. @param {unknown} value */
export function isView(value) {
  return value instanceof View;
}
