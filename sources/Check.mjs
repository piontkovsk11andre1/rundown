import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { extname } from "node:path";
import { parse } from "acorn";
import { resolve as resolveImport } from "import-meta-resolve";
import { parseMarkdown, flattenInlines } from "@p10i/do-md/markdown";
import { SourceText, Template } from "@p10i/do-md";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { compileFile, compile } from "./Compiler.mjs";
import { discover } from "./Catalog.mjs";
import { resolveDocument } from "./Loader.mjs";
import { commandSchema } from "./Validation.mjs";
import { isDocumentSpecifier, nativeSpecifier } from "./Paths.mjs";
import {
  RundownError,
  diagnostic,
  processingError,
  location,
} from "./Error.mjs";

/** @typedef {ReturnType<typeof compileFile>} Unit */
/** @param {unknown} value @returns {Record<string,unknown>|null} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value)
    : null;
}

/** Walk JavaScript syntax, not Markdown text; comments and usage examples cannot become loads.
 * @param {unknown} node @param {(node:Record<string,unknown>)=>void} visit
 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const value = object(node);
  if (!value || typeof value.type !== "string") return;
  visit(value);
  for (const [key, child] of Object.entries(value))
    if (!["loc", "start", "end"].includes(key)) walk(child, visit);
}

/** Binding patterns are conservative: shadowed owner-loader calls become warnings.
 * @param {unknown} pattern @returns {boolean}
 */
function bindsLoader(pattern) {
  const node = object(pattern);
  if (!node) return false;
  if (node.type === "Identifier") return node.name === "rundown";
  if (node.type === "AssignmentPattern") return bindsLoader(node.left);
  if (node.type === "RestElement") return bindsLoader(node.argument);
  if (node.type === "ArrayPattern" && Array.isArray(node.elements))
    return node.elements.some(bindsLoader);
  if (node.type === "ObjectPattern" && Array.isArray(node.properties))
    return node.properties.some((property) => {
      const value = object(property);
      return bindsLoader(
        value?.type === "RestElement" ? value.argument : value?.value,
      );
    });
  return false;
}

/** @param {Unit} unit */
function loaderReferences(unit) {
  const ast = parse(unit.code, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  let shadowed = false;
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && bindsLoader(node.id)) {
      const init = object(node.init);
      if (object(init?.callee)?.name !== "__rundown") shadowed = true;
    }
    if (
      [
        "FunctionExpression",
        "FunctionDeclaration",
        "ArrowFunctionExpression",
      ].includes(String(node.type)) &&
      (bindsLoader(node.id) ||
        (Array.isArray(node.params) && node.params.some(bindsLoader)))
    )
      shadowed = true;
    if (node.type === "CatchClause" && bindsLoader(node.param)) shadowed = true;
    if (node.type === "ClassDeclaration" && bindsLoader(node.id))
      shadowed = true;
  });
  /** @type {{loader:'loadModule'|'loadCommands'|'createView',target:string|null,location:import('@p10i/do-md').DiagnosticLocation,reason:string}[]} */
  const result = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = object(node.callee);
    if (
      callee?.type !== "MemberExpression" ||
      object(callee.object)?.name !== "rundown"
    )
      return;
    const property = object(callee.property);
    const loader = callee.computed ? property?.value : property?.name;
    if (
      loader !== "loadModule" &&
      loader !== "loadCommands" &&
      loader !== "createView"
    )
      return;
    const arg = Array.isArray(node.arguments)
      ? object(node.arguments[0])
      : null;
    let target =
      arg?.type === "Literal" && typeof arg.value === "string"
        ? arg.value
        : null;
    if (
      arg?.type === "TemplateLiteral" &&
      Array.isArray(arg.expressions) &&
      !arg.expressions.length &&
      Array.isArray(arg.quasis)
    ) {
      const value = object(object(arg.quasis[0])?.value);
      if (typeof value?.cooked === "string") target = value.cooked;
    }
    const loc = object(node.loc),
      start = object(loc?.start);
    const mapped =
      typeof start?.line === "number" && typeof start.column === "number"
        ? originalPositionFor(new TraceMap(unit.map), {
            line: start.line,
            column: start.column,
          })
        : null;
    const text = new SourceText(unit.document.source, unit.document.url);
    const offset =
      mapped?.line != null && mapped.column != null
        ? text.offsetAt(mapped.line, mapped.column + 1)
        : null;
    const entry = text.location(offset ?? 0, null, {
      relation: "processing",
      precision: offset === null ? "context" : "exact",
    });
    result.push({
      loader,
      target: shadowed ? null : target,
      location: entry,
      reason: shadowed
        ? "A local rundown binding prevents reliable owner-loader analysis"
        : "The loader target is selected at runtime",
    });
  });
  return result;
}

/** @param {URL} url @param {string} [source] @returns {Promise<'module'|'commands'|'view'>} */
async function detectKind(url, source) {
  if (url.pathname.endsWith(".md.template")) return "view";
  const document = parseMarkdown(source ?? (await readFile(url, "utf8")));
  const headings = document.children
    .filter((node) => node.type === "heading" && node.level === 2)
    .map((node) =>
      node.type === "heading" ? flattenInlines(node.children) : "",
    );
  if (headings.some((text) => text.startsWith("Method: "))) return "module";
  return url.pathname.endsWith("/commands.md") ||
    headings.some(
      (text) => text.startsWith("Command: ") || text === "Connections",
    )
    ? "commands"
    : "module";
}

/** Compile and resolve a document graph without installing ESM hooks or evaluating user code.
 * @param {import('./AuthoringTypes.mjs').CheckOptions} [options]
 * @returns {Promise<import('./AuthoringTypes.mjs').CheckResult>}
 */
export async function checkProject({
  cwd = process.cwd(),
  file,
  commands,
  kind,
  signal,
  sourceOverrides = {},
} = {}) {
  /** @type {import('./AuthoringTypes.mjs').CheckResult} */
  const result = {
    ok: true,
    entry: null,
    files: [],
    commands: [],
    dependencies: [],
    dynamicLoads: [],
    errors: [],
  };
  /** @type {Map<string,Unit>} */
  const units = new Map();
  const modules = new Set(),
    catalogs = new Set(),
    analyzed = new Set();
  const views = new Set();
  /** Compile presentation templates without executing their JavaScript. @param {URL} url */
  async function visitView(url) {
    if (views.has(url.href)) return;
    signal?.throwIfAborted();
    const source = Object.hasOwn(sourceOverrides, url.href)
      ? sourceOverrides[url.href]
      : await readFile(url, "utf8");
    Template.wrap(source, url.href);
    views.add(url.href);
    result.files.push({ file: url.href, kind: "view" });
  }
  /** @param {unknown} cause @param {import('@p10i/do-md').DiagnosticLocation} [context] */
  function report(cause, context) {
    result.errors.push(
      diagnostic(context ? processingError(cause, context) : cause),
    );
  }
  /** @param {URL} url @param {'module'|'commands'} type */
  function load(url, type) {
    signal?.throwIfAborted();
    const cached = units.get(url.href);
    if (cached) {
      if (cached.document.kind !== type)
        throw new RundownError(
          "RUNDOWN_DEFINITION",
          `Document used as both command catalog and module: ${url.href}`,
          { status: 400 },
        );
      return cached;
    }
    const unit = Object.hasOwn(sourceOverrides, url.href)
      ? compile(sourceOverrides[url.href], url.href, { kind: type })
      : compileFile(url, { kind: type });
    if (type === "commands")
      for (const member of unit.document.members) commandSchema(member);
    units.set(url.href, unit);
    result.files.push({ file: url.href, kind: type });
    return unit;
  }
  /** @param {Unit} unit @param {string} source */
  function resolveJavascript(unit, source) {
    try {
      const resolved = resolveImport(
        nativeSpecifier(source),
        unit.document.url,
      );
      const url = new URL(resolved);
      if (url.protocol === "file:") resolveDocument(url);
      else if (url.protocol === "node:") {
        if (!isBuiltin(resolved))
          throw new RundownError(
            "RUNDOWN_RESOLUTION",
            `Unknown builtin: ${source}`,
            { status: 404 },
          );
      } else if (url.protocol !== "data:")
        throw new RundownError(
          "RUNDOWN_RESOLUTION",
          `Unsupported native import scheme: ${url.protocol}`,
          { status: 400 },
        );
      result.dependencies.push({ source, resolved });
    } catch (cause) {
      if (cause instanceof RundownError) throw cause;
      throw new RundownError(
        "RUNDOWN_RESOLUTION",
        `Cannot resolve JavaScript dependency ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause, status: 400 },
      );
    }
  }
  /** @param {Unit} unit @returns {Promise<void>} */
  async function analyze(unit) {
    if (analyzed.has(unit.document.url)) return;
    analyzed.add(unit.document.url);
    for (const dependency of unit.document.dependencies) {
      try {
        if (dependency.kind === "markdown")
          await visitModule(
            resolveDocument(dependency.source, { baseURL: unit.document.url }),
          );
        else resolveJavascript(unit, dependency.source);
      } catch (cause) {
        report(
          cause,
          location(
            unit.document.url,
            unit.document.source,
            unit.document.sections.Dependencies?.position.start.offset ?? 0,
          ),
        );
      }
    }
    for (const reference of loaderReferences(unit)) {
      if (reference.target === null) {
        result.dynamicLoads.push({
          loader: reference.loader,
          location: reference.location,
          reason: reference.reason,
        });
        continue;
      }
      try {
        const url = resolveDocument(reference.target, {
          baseURL: unit.document.url,
        });
        if (reference.loader === "createView") await visitView(url);
        else if (reference.loader === "loadCommands") await visitCatalog(url);
        else if (extname(url.pathname) === ".md") await visitModule(url);
        else resolveJavascript(unit, url.href);
      } catch (cause) {
        report(cause, reference.location);
      }
    }
  }
  /** @param {URL} url @returns {Promise<void>} */
  async function visitModule(url) {
    if (modules.has(url.href)) return;
    modules.add(url.href);
    await analyze(load(url, "module"));
  }
  /** @param {URL} url @returns {Promise<void>} */
  async function visitCatalog(url) {
    if (catalogs.has(url.href)) return;
    catalogs.add(url.href);
    const seen = new Set();
    /** @type {Map<string,Unit>} */ const names = new Map();
    /** @type {Unit[]} */ const group = [];
    /** @param {URL} current @param {string[]} chain @returns {Promise<void>} */
    async function connections(current, chain) {
      if (chain.includes(current.href))
        throw new RundownError(
          "RUNDOWN_CONNECTION_CYCLE",
          `Command connection cycle: ${[...chain, current.href].join(" -> ")}`,
          { status: 400 },
        );
      if (seen.has(current.href)) return;
      seen.add(current.href);
      const unit = load(current, "commands");
      group.push(unit);
      for (const member of unit.document.members) {
        const prior = names.get(member.name);
        if (prior)
          report(
            new RundownError(
              "RUNDOWN_DEFINITION",
              `Duplicate command ${member.name}; also defined in ${prior.document.url}`,
              { status: 400 },
            ),
            location(
              unit.document.url,
              unit.document.source,
              member.position.start.offset,
            ),
          );
        else {
          names.set(member.name, unit);
          if (
            url.href === result.entry &&
            !result.commands.some(
              (command) =>
                command.name === member.name && command.file === current.href,
            )
          )
            result.commands.push({ name: member.name, file: current.href });
        }
      }
      for (const connection of unit.document.connections) {
        try {
          if (!isDocumentSpecifier(connection.file))
            throw new RundownError(
              "RUNDOWN_RESOLUTION",
              "Connections require relative/absolute paths or explicit npm: exports",
              { status: 400 },
            );
          await connections(
            resolveDocument(connection.file, { baseURL: current.href }),
            [...chain, current.href],
          );
        } catch (cause) {
          report(
            cause,
            location(
              unit.document.url,
              unit.document.source,
              connection.position?.start.offset ?? 0,
            ),
          );
        }
      }
    }
    await connections(url, []);
    for (const unit of group) await analyze(unit);
  }
  try {
    const entry = resolveDocument(file ?? commands ?? discover(cwd), { cwd });
    result.entry = entry.href;
    const type =
      kind ??
      (file
        ? await detectKind(entry, sourceOverrides[entry.href])
        : "commands");
    if (type === "commands") await visitCatalog(entry);
    else if (type === "view") await visitView(entry);
    else await visitModule(entry);
  } catch (cause) {
    report(cause);
  }
  result.ok = !result.errors.length;
  return result;
}
