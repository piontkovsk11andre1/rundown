import { DoMdError, sourcePoint, SourceText } from "@p10i/do-md";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { pathToFileURL } from "node:url";
import { findSourceMap } from "node:module";

/** @type {Map<string,import('./types.mjs').SourceMap>} */
const maps = new Map();
/** @param {string} url @param {import('./types.mjs').SourceMap} map */
export function rememberMap(url, map) {
  maps.set(url, map);
}

/** A diagnostic error retaining native causes and do-md-compatible locations. */
export class RundownError extends Error {
  /** @param {string} code @param {string} message @param {import('./InternalContracts.mjs').ErrorOptions} [options] */
  constructor(
    code,
    message,
    { cause, locations = [], status = 500, related = [] } = {},
  ) {
    super(message, { cause });
    this.code = code;
    this.name = "RundownError";
    this.locations = structuredClone(locations);
    this.status = status;
    /** @type {import('./types.mjs').Diagnostic[]} */
    this.related = structuredClone(related);
    /** @type {string|undefined} */
    this.invocationId = undefined;
  }
}

/** Produce a document location with UTF-16 coordinates.
 * @param {string} file @param {string} source @param {number} [offset]
 * @param {import('@p10i/do-md').DiagnosticLocation['precision']} [precision]
 * @returns {import('@p10i/do-md').DiagnosticLocation}
 */
export function location(file, source, offset = 0, precision = "context") {
  const text = new SourceText(source, file);
  const point = sourcePoint(source, offset);
  return {
    role: "document",
    relation: "origin",
    source: file,
    range: { start: point, end: null },
    precision,
    snippet: text.lineAt(point.line) ?? null,
  };
}

/** @param {string} message @param {{url:string,source:string}} document @param {import('./InternalContracts.mjs').MetadataPosition} [position] */
export function problem(message, document, position) {
  return new RundownError("RUNDOWN_DEFINITION", message, {
    status: 400,
    locations: [
      location(document.url, document.source, position?.start.offset ?? 0),
    ],
  });
}

/** Normalize native exceptions, retaining causes and any mapped Markdown frames.
 * @param {unknown} error @returns {RundownError}
 */
export function diagnose(error) {
  if (error instanceof RundownError)
    return Object.isFrozen(error)
      ? new RundownError(error.code, error.message, {
          cause: error,
          locations: error.locations,
          status: error.status,
          related: error.related,
        })
      : error;
  if (error instanceof DoMdError)
    return new RundownError(error.code, error.message, {
      cause: error,
      locations: error.locations,
      status: 400,
    });
  /** @type {import('@p10i/do-md').DiagnosticLocation[]} */
  const locations = [];
  for (const line of (error instanceof Error ? (error.stack ?? "") : "").split(
    "\n",
  )) {
    const match =
      /(?:\(|\s)((?:file:\/\/|\/|[A-Za-z]:\\).*?):(\d+):(\d+)\)?$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const url = match[1].startsWith("file:")
      ? match[1]
      : pathToFileURL(match[1]).href;
    if (!maps.has(url)) continue;
    const map = maps.get(url);
    if (!map) continue;
    // Node prints already-mapped file locations as paths; do not map them twice.
    const nativeMapped =
      process.sourceMapsEnabled &&
      !match[1].startsWith("file:") &&
      findSourceMap(url);
    const mapped = nativeMapped
      ? { source: url, line: Number(match[2]), column: Number(match[3]) - 1 }
      : originalPositionFor(new TraceMap(map), {
          line: Number(match[2]),
          column: Number(match[3]) - 1,
        });
    if (!mapped.source || !mapped.line) continue;
    const index = map.sources.indexOf(mapped.source);
    const source = map.sourcesContent[index];
    if (source == null || mapped.column == null) continue;
    const sourceLines = source.split(/\r\n|\n|\r/);
    locations.push({
      role: "document",
      relation: "origin",
      source: mapped.source,
      range: {
        start: {
          offset: new SourceText(source).offsetAt(
            mapped.line,
            mapped.column + 1,
          ),
          line: mapped.line,
          column: mapped.column + 1,
        },
        end: null,
      },
      precision: "exact",
      snippet: sourceLines[mapped.line - 1] ?? null,
    });
  }
  const nativeCode =
    error instanceof Error && "code" in error ? String(error.code) : "";
  const resolution = [
    "ERR_MODULE_NOT_FOUND",
    "MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_UNSUPPORTED_DIR_IMPORT",
    "ERR_UNKNOWN_FILE_EXTENSION",
    "ERR_INVALID_MODULE_SPECIFIER",
  ].includes(nativeCode);
  return new RundownError(
    error instanceof Error && error.name === "AbortError"
      ? "RUNDOWN_CANCELLED"
      : resolution
        ? "RUNDOWN_RESOLUTION"
        : "RUNDOWN_EXECUTION",
    error instanceof Error ? error.message : String(error),
    {
      cause: error,
      locations,
      status: resolution ? (nativeCode.endsWith("NOT_FOUND") ? 404 : 400) : 500,
    },
  );
}

/** @param {unknown} error @param {string} [invocationId] @returns {import('./types.mjs').Diagnostic} */
export function diagnostic(error, invocationId) {
  const value = diagnose(error);
  return {
    code: value.code,
    message: value.message,
    locations: value.locations ?? [],
    ...((invocationId ?? value.invocationId)
      ? { invocationId: invocationId ?? value.invocationId }
      : {}),
    ...(value.related.length
      ? { related: structuredClone(value.related) }
      : {}),
  };
}

/** An unavailable file has identity but no fabricated exact source position.
 * @param {string} url @returns {import('@p10i/do-md').DiagnosticLocation}
 */
export function unavailableLocation(url) {
  return {
    role: "document",
    relation: "processing",
    source: url,
    range: { start: { offset: null, line: 1, column: 1 }, end: null },
    precision: "context",
    snippet: null,
  };
}

/** Preserve the original failure while appending a caller's document context.
 * @param {unknown} cause @param {import('@p10i/do-md').DiagnosticLocation} entry
 */
export function processingError(cause, entry) {
  const error = diagnose(cause);
  const context = { ...entry, relation: /** @type {const} */ ("processing") };
  if (
    !error.locations.some(
      (existing) =>
        existing.source === context.source &&
        existing.relation === "processing" &&
        existing.range.start.offset === context.range.start.offset,
    )
  )
    error.locations.push(context);
  return error;
}

/** @param {string} url @returns {import('@p10i/do-md').DiagnosticLocation} */
export function processingLocation(url) {
  const map = maps.get(url);
  const source = map?.sourcesContent[map.sources.indexOf(url)];
  return source == null
    ? unavailableLocation(url)
    : { ...location(url, source), relation: "processing" };
}

/** Normalize filesystem failures at every loader/compile boundary.
 * @param {unknown} cause @param {string} url
 */
export function fileFailure(cause, url) {
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  const status =
    code === "ENOENT" || code === "ENOTDIR"
      ? 404
      : code === "EACCES" || code === "EPERM"
        ? 403
        : 400;
  return new RundownError(
    "RUNDOWN_RESOLUTION",
    `Cannot access document ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause, status, locations: [unavailableLocation(url)] },
  );
}
