import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";
/** Explicit package references avoid ambiguity with invocation-relative filenames. @param {string} value */
export const isPackageSpecifier = (value) => value.startsWith("npm:");
/** @param {string} value */
export function isDocumentSpecifier(value) {
  return (
    isAbsolute(value) ||
    value.startsWith("file:") ||
    isPackageSpecifier(value) ||
    /^\.\.?[\\/]/.test(value)
  );
}
/** Resolve without reading files, including drive-letter and UNC paths on Windows.
 * @param {string|URL} value @param {string|URL} [baseURL] @param {string} [cwd]
 */
export function documentURL(value, baseURL, cwd) {
  if (value instanceof URL) return new URL(value);
  if (isPackageSpecifier(value)) {
    const specifier = value.slice(4);
    if (
      !/^(?:@[a-zA-Z0-9_.~-]+\/)?[a-zA-Z0-9_~][a-zA-Z0-9_.~-]*(?:\/[^?#\\]*)?$/.test(
        specifier,
      )
    )
      throw new TypeError(
        "Expected npm:package[/export] without query or fragment",
      );
    const parent = baseURL
      ? new URL(baseURL).href
      : cwd
        ? pathToFileURL(resolve(cwd, "package.json")).href
        : undefined;
    if (!parent)
      throw new TypeError("Package documents require baseURL or cwd");
    return new URL(resolveImport(specifier, parent));
  }
  if (value.startsWith("file:")) return new URL(value);
  if (isAbsolute(value)) return pathToFileURL(value);
  if (baseURL) return new URL(value, baseURL);
  if (cwd) return pathToFileURL(resolve(cwd, value));
  throw new TypeError("Relative paths require baseURL or cwd");
}
/** @param {string} value */
export const nativeSpecifier = (value) =>
  isAbsolute(value) ? pathToFileURL(value).href : value;
