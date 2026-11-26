import { registerHooks } from "node:module";
import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { documentURL } from "./Paths.mjs";
import { compileFile } from "./Compiler.mjs";
import {
  diagnose,
  RundownError,
  processingError,
  processingLocation,
  fileFailure,
  rememberMap,
} from "./Error.mjs";

let installed = false;
/** @type {Map<string,'module'|'commands'>} */
const kinds = new Map();
/** @type {Map<string,string>} */
const artifactDirectories = new Map();
/** @type {Map<string,ReturnType<typeof compileFile>>} */
const loadedArtifacts = new Map();

/** Canonical file identity. Relative paths require an explicit document base or cwd.
 * @param {string|URL} specifier @param {import('./types.mjs').LoadOptions} [options]
 */
export function resolveDocument(specifier, { baseURL, cwd } = {}) {
  /** @type {URL|undefined} */
  let url;
  try {
    url = documentURL(specifier, baseURL, cwd);
    if (url.protocol !== "file:" || url.search || url.hash)
      throw new RundownError(
        "RUNDOWN_RESOLUTION",
        "Expected a file URL without query or fragment",
        { status: 400 },
      );
    if (!statSync(url).isFile())
      throw new RundownError("RUNDOWN_RESOLUTION", `Not a file: ${url.href}`, {
        status: 400,
      });
    return pathToFileURL(realpathSync(url));
  } catch (cause) {
    if (cause instanceof RundownError) throw cause;
    throw fileFailure(cause, url?.href ?? String(specifier));
  }
}

function install() {
  if (installed) return;
  // Hooks compile only Markdown. JavaScript resolution/evaluation stays native.
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && new URL(url).pathname.endsWith(".md")) {
        kinds.set(url, kinds.get(url) ?? "module");
        const result =
          loadedArtifacts.get(url) ??
          compileFile(new URL(url), {
            kind: kinds.get(url) ?? "module",
            outDir:
              artifactDirectories.get(url) ?? process.env.RUNDOWN_DEBUG_DIR,
          });
        loadedArtifacts.set(url, result);
        rememberMap(url, result.map);
        return { format: "module", source: result.code, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
  installed = true;
}

/** Load a Markdown document as a real, natively cached ESM namespace.
 * @template {object} [T=Record<string,unknown>]
 * @param {string|URL} specifier @param {import('./types.mjs').LoadOptions} [options]
 * @returns {Promise<T>}
 */
export async function loadModule(specifier, options = {}) {
  return /** @type {T} */ (
    /** @type {unknown} */ (await importDocument(specifier, options, "module"))
  );
}

/** @param {string|URL} specifier @param {import('./types.mjs').LoadOptions} options @param {'module'|'commands'} kind @returns {Promise<Record<string,unknown>>} */
export async function importDocument(specifier, options, kind) {
  options.signal?.throwIfAborted();
  install();
  /** @type {URL|undefined} */
  let url;
  try {
    url = resolveDocument(specifier, options);
    if (kinds.has(url.href) && kinds.get(url.href) !== kind)
      throw new RundownError(
        "RUNDOWN_RESOLUTION",
        "Document cannot be both command catalog and module",
      );
    kinds.set(url.href, kind);
    if (options.outDir) artifactDirectories.set(url.href, options.outDir);
    return await import(url.href);
  } catch (cause) {
    const error = url
      ? processingError(cause, processingLocation(url.href))
      : diagnose(cause);
    if (options.baseURL)
      processingError(error, processingLocation(new URL(options.baseURL).href));
    throw error;
  }
}

/** Load metadata and handlers from the same cached native module artifact.
 * @param {URL} url @param {import('./types.mjs').LoadOptions} options
 */
export async function commandArtifact(url, options) {
  if (!url.pathname.endsWith(".md"))
    throw new RundownError(
      "RUNDOWN_RESOLUTION",
      "Command catalogs must be Markdown files",
      { status: 400 },
    );
  const namespace = await importDocument(url, options, "commands");
  const artifact = loadedArtifacts.get(url.href);
  if (!artifact)
    throw new RundownError(
      "RUNDOWN_INTERNAL",
      "Loaded catalog has no compilation artifact",
    );
  return { artifact, namespace };
}

/** Compiler-injected binding scoped to the original Markdown URL, never an invocation.
 * @param {string} baseURL
 */
export function owner(baseURL) {
  return Object.freeze({
    /** @param {string|URL} specifier @param {import('./types.mjs').LoadOptions} [options] */
    loadModule: (specifier, options = {}) =>
      loadModule(specifier, { ...options, baseURL }),
    /** @param {string|URL} specifier @param {import('./types.mjs').LoadOptions} [options] */
    loadCommands: async (specifier, options = {}) =>
      (await import("./Catalog.mjs")).loadCommands(specifier, {
        ...options,
        baseURL,
      }),
    /** @param {string|URL} specifier @param {Record<string,unknown>} data @param {import('./ViewTypes.mjs').ViewOptions} [options] */
    createView: async (specifier, data, options = {}) =>
      (await import("./Views.mjs")).createView(specifier, data, {
        ...options,
        baseURL,
      }),
  });
}
