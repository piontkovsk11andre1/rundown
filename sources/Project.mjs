import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { documentURL, isPackageSpecifier } from "./Paths.mjs";
import {
  RundownError,
  fileFailure,
  location,
  processingError,
  unavailableLocation,
} from "./Error.mjs";

/** Parse project metadata without importing it or executing package scripts.
 * @param {string} source @param {string} file
 * @returns {Record<string,unknown> & {rundown?:{commands?:string,tests?:string}}}
 */
export function parsePackage(source, file) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("package.json must contain an object");
    if (value.rundown !== undefined) {
      if (
        !value.rundown ||
        typeof value.rundown !== "object" ||
        Array.isArray(value.rundown)
      )
        throw new TypeError("rundown must be an object");
      for (const key of ["commands", "tests"]) {
        const path = value.rundown[key];
        if (
          path !== undefined &&
          (typeof path !== "string" ||
            !path.trim() ||
            /[\u0000-\u001f]/.test(path))
        )
          throw new TypeError(`rundown.${key} must be a nonempty path string`);
      }
    }
    return value;
  } catch (cause) {
    throw new RundownError(
      "RUNDOWN_PROJECT_CONFIG",
      `Invalid ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        status: 400,
        locations: [location(pathToFileURL(file).href, source)],
      },
    );
  }
}

/** Stop at the nearest package boundary, even when it declares no Rundown entries.
 * @param {string} cwd
 */
export function findProject(cwd) {
  let root = resolve(cwd);
  for (;;) {
    const file = join(root, "package.json");
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      )
        throw fileFailure(cause, pathToFileURL(file).href);
    }
    if (source !== undefined)
      return { root, file, manifest: parsePackage(source, file) };
    const parent = dirname(root);
    if (parent === root)
      throw new RundownError(
        "RUNDOWN_DISCOVERY",
        `No package.json above ${cwd}; select an explicit document or create a package with npm init`,
        { status: 404 },
      );
    root = parent;
  }
}

/** Resolve a declared entry against its manifest, never against the execution cwd.
 * @param {string} cwd @param {'commands'|'tests'} field
 */
export function projectPath(cwd, field) {
  const project = findProject(cwd);
  const value = project.manifest.rundown?.[field];
  if (!value)
    throw new RundownError(
      "RUNDOWN_DISCOVERY",
      `${project.file} does not declare rundown.${field}; select an explicit ${field === "commands" ? "catalog with --commands" : "test path"}`,
      { status: 404 },
    );
  try {
    return isPackageSpecifier(value)
      ? fileURLToPath(documentURL(value, pathToFileURL(project.file)))
      : resolve(project.root, value);
  } catch (cause) {
    throw processingError(
      fileFailure(cause, value),
      unavailableLocation(pathToFileURL(project.file).href),
    );
  }
}
