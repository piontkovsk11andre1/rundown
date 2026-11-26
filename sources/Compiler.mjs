import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDocumentSpecifier, documentURL, nativeSpecifier } from "./Paths.mjs";
import { Reader, Template, SourceText } from "@p10i/do-md";
import { parse } from "acorn";
import {
  GenMapping,
  addSegment,
  setSourceContent,
  toEncodedMap,
} from "@jridgewell/gen-mapping";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { problem, RundownError, fileFailure } from "./Error.mjs";
import * as support from "./TemplateSupport.mjs";
import { jsonExpression, jsonData } from "./JsonLiteral.mjs";
import {
  COLUMNS,
  MODULE_OPTIONS,
  COMMAND_FIELDS,
  METHOD_FIELDS,
  SURFACES,
} from "./Format.mjs";

const grammars = Object.fromEntries(
  ["module", "commands"].map((kind) => {
    const url = new URL(`../templates/${kind}.md.template`, import.meta.url);
    return [
      kind,
      Template.compile(readFileSync(url, "utf8").trimEnd(), { file: url.href }),
    ];
  }),
);
const runtimeURL = new URL("./Loader.mjs", import.meta.url).href;
const identifiers = /^[A-Za-z_$][\w$]*$/;
const reserved = new Set([
  "arguments",
  "eval",
  "await",
  "yield",
  "rundown",
  "__rundown",
  "default",
  "class",
  "function",
  "return",
  "const",
  "let",
  "var",
  "import",
  "export",
  "new",
  "this",
  "super",
  "delete",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "with",
  "in",
  "instanceof",
  "typeof",
  "void",
  "extends",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "enum",
  "null",
  "true",
  "false",
]);

/** @param {{url:string,source:string}} document @param {string} message @param {import('./InternalContracts.mjs').MetadataPosition} [position] @returns {never} */
function fail(document, message, position) {
  throw problem(message, document, position);
}
/** @param {string} name @param {{url:string,source:string}} document @param {import('./InternalContracts.mjs').MetadataPosition} [position] */
function identifier(name, document, position) {
  if (!identifiers.test(name) || reserved.has(name))
    fail(document, `Invalid or reserved binding: ${name}`, position);
  return name;
}
/** @param {import('./InternalContracts.mjs').Table|undefined} table @param {readonly string[]} columns @param {{url:string,source:string}} document @param {boolean} [required] @returns {Record<string,string>[]} */
function rows(table, columns, document, required = false) {
  if (!table) {
    if (required) fail(document, `Missing ${columns.join(" / ")} table`);
    return [];
  }
  if (table.headers.join("\n") !== columns.join("\n"))
    fail(document, `Expected columns: ${columns.join(", ")}`, table.position);
  return table.rows.map((row) =>
    Object.fromEntries(columns.map((column, i) => [column, row[i] ?? ""])),
  );
}
/** @param {import('./InternalContracts.mjs').Table|undefined} table @param {Record<string,readonly string[]>} allowed @param {{url:string,source:string}} document */
function options(table, allowed, document) {
  /** @type {Record<string,string>} */
  const result = {};
  for (const row of rows(table, COLUMNS.options, document)) {
    if (
      !allowed[row.Option]?.includes(row.Value) &&
      !(row.Option === "Surfaces" && Object.hasOwn(allowed, "Surfaces"))
    )
      fail(
        document,
        `Unknown option or value: ${row.Option}=${row.Value}`,
        table?.position,
      );
    if (Object.hasOwn(result, row.Option))
      fail(document, `Duplicate option: ${row.Option}`, table?.position);
    result[row.Option] = row.Value;
  }
  return result;
}
/** @param {string} value @param {{url:string,source:string}} document @param {import('./InternalContracts.mjs').MetadataPosition} [position] @returns {unknown} */
function json(value, document, position) {
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(value));
    jsonData(parsed);
    return parsed;
  } catch (cause) {
    fail(
      document,
      `Expected JSON literal: ${value}. ${cause instanceof Error ? cause.message : String(cause)}`,
      position,
    );
  }
}

/** @param {import('./InternalContracts.mjs').Table|undefined} table @param {{url:string,source:string}} document @param {'module'|'commands'} kind @returns {import('./types.mjs').Parameter[]} */
function parameters(table, document, kind) {
  const columns =
    kind === "commands" ? COLUMNS.commandParameters : COLUMNS.methodParameters;
  const names = new Set();
  const result = rows(table, columns, document, true).map((row) => {
    identifier(row.Name, document, table?.position);
    if (names.has(row.Name))
      fail(document, `Duplicate parameter: ${row.Name}`, table?.position);
    names.add(row.Name);
    if (!["yes", "no"].includes(row.Required) || !row.Type)
      fail(
        document,
        "Parameters need Type and Required=yes/no",
        table?.position,
      );
    if (row.Required === "yes" && row.Default !== "")
      fail(
        document,
        `Required parameter ${row.Name} cannot have a default`,
        table?.position,
      );
    return {
      name: row.Name,
      type: row.Type,
      required: row.Required === "yes",
      hasDefault: row.Default !== "",
      default:
        row.Default === ""
          ? undefined
          : json(row.Default, document, table?.position),
      cli: kind === "commands" ? row.CLI : undefined,
      description: row.Description,
    };
  });
  if (kind === "commands") {
    const positions = result
      .filter((p) => /^\d+$/.test(p.cli ?? ""))
      .sort((a, b) => Number(a.cli) - Number(b.cli));
    const cli = result.map((p) => p.cli).filter(Boolean);
    if (
      new Set(cli).size !== cli.length ||
      result.some((p) => p.cli && !/^[1-9]\d*$|^--[a-zA-Z][\w-]*$/.test(p.cli))
    )
      fail(
        document,
        "CLI mappings must be unique positions or --options",
        table?.position,
      );
    let optional = false;
    positions.forEach((p, i) => {
      if (Number(p.cli) !== i + 1 || (optional && p.required))
        fail(
          document,
          "CLI positions must be contiguous with required positions first",
          table?.position,
        );
      optional ||= !p.required;
    });
  }
  return result;
}

/** Repackage bound template values; do-md slot metadata owns all source coordinates.
 * @param {import('./InternalContracts.mjs').BoundReader} reader @param {string} source @param {string} url @param {'module'|'commands'} kind
 * @returns {import('./InternalContracts.mjs').DraftDocument}
 */
function boundDocument(reader, source, url, kind) {
  /** @type {import('./InternalContracts.mjs').DraftDocument} */
  const document = {
    title: reader.context.title,
    description: reader.context.description,
    sections: {},
    members: [],
    source,
    url,
    kind,
  };
  const text = new SourceText(source, url);
  const slots = new Map(reader.slotMap.map((slot) => [slot.key, slot]));
  const nodes = new Map(
    reader
      .parseDocument()
      .children.map((node) => [node.position?.start.offset, node]),
  );
  /** @param {string} key */
  const position = (key) => {
    const slot = slots.get(key);
    if (!slot) throw new Error(`Missing do-md source binding: ${key}`);
    return {
      start: text.pointAt(slot.sourceOffsetStart),
      end: text.pointAt(slot.sourceOffsetEnd),
    };
  };
  /** @param {import('./InternalContracts.mjs').BoundSection} section @param {'dependencies'|'constants'|'connections'|'options'|'parameters'|'returns'} field @param {string} prefix */
  const table = (section, field, prefix) => {
    const value = section[field];
    if (!value) return undefined;
    const range = position(`${prefix}.${field}`);
    const node = nodes.get(range.start.offset);
    if (node?.type === "table" && node.extraCells)
      fail(document, `Extra cells in ${field} table`, range);
    return { ...value, position: range };
  };
  const topFields = /** @type {const} */ ([
    ["connections", "Connections"],
    ["dependencies", "Dependencies"],
    ["constants", "Constants"],
  ]);
  for (const [index, section] of reader.context.sections.entries()) {
    const prefix = `sections[${index}]`;
    const other = kind === "commands" ? "Method: " : "Command: ";
    if (section.heading.startsWith(other))
      fail(
        document,
        kind === "commands"
          ? "Command catalogs cannot declare module methods"
          : "Modules cannot declare commands",
        position(`${prefix}.heading`),
      );
    for (const [field, name] of topFields) {
      if (!Object.hasOwn(section, field)) continue;
      if (Object.hasOwn(document.sections, name))
        fail(
          document,
          `Duplicate ${name} section`,
          position(`${prefix}.heading`),
        );
      document.sections[name] = table(section, field, prefix);
    }
    const marker = kind === "commands" ? "Command: " : "Method: ";
    if (!section.heading.startsWith(marker)) continue;
    /** @type {import('./InternalContracts.mjs').MemberSections} */
    const sections = {};
    for (const [field, name] of /** @type {const} */ ([
      ["options", "Options"],
      ["parameters", "Parameters"],
      ["returns", "Returns"],
    ])) {
      const value = table(section, field, prefix);
      if (value) sections[name] = value;
    }
    if (section.schema)
      sections.schema = json(
        section.schema.value,
        document,
        position(`${prefix}.schema`),
      );
    const bodyField = kind === "commands" ? "handler" : "implementation";
    const body = section[bodyField];
    if (body)
      sections.body = {
        ...body,
        position: position(`${prefix}.${bodyField}`),
      };
    document.members.push({
      name: section.heading.slice(marker.length),
      description: section.description ?? "",
      sections,
      position: position(`${prefix}.heading`),
    });
  }
  return document;
}

/** Parse a command or module template through do-md, then validate cross-field semantics.
 * @param {string} source @param {string} url @param {'module'|'commands'} [kind]
 */
export function parseDocument(source, url, kind = "module") {
  if (!Object.hasOwn(grammars, kind))
    throw new TypeError(`Unknown document kind: ${kind}`);
  const reader = new Reader(source, { file: url });
  grammars[kind].execute(reader, reader.context, null, {
    support,
    columns: COLUMNS,
    commandFields: COMMAND_FIELDS,
    methodFields: METHOD_FIELDS,
  });
  if (reader.errors.length) throw reader.errors[0];
  const document = boundDocument(
    /** @type {import('./InternalContracts.mjs').BoundReader} */ (reader),
    source,
    url,
    kind,
  );
  const seen = new Set();
  /** @param {string} name @param {import('./InternalContracts.mjs').MetadataPosition} [position] */
  const bind = (name, position) => {
    identifier(name, document, position);
    if (seen.has(name)) fail(document, `Duplicate binding: ${name}`, position);
    seen.add(name);
  };
  const dependencies = rows(
    document.sections.Dependencies,
    COLUMNS.dependencies,
    document,
  ).map((row) => {
    bind(row.Binding, document.sections.Dependencies?.position);
    if (row.Kind !== "markdown" && row.Kind !== "javascript")
      fail(document, `Unknown dependency kind: ${row.Kind}`);
    if (row.Kind === "markdown" && !isDocumentSpecifier(row.Source))
      fail(
        document,
        "Markdown dependencies must be document-relative, absolute or explicit npm: exports",
      );
    return {
      source: row.Source,
      kind: row.Kind,
      binding: row.Binding,
      description: row.Description,
    };
  });
  const constants = rows(
    document.sections.Constants,
    COLUMNS.constants,
    document,
  ).map((row) => {
    bind(row.Name, document.sections.Constants?.position);
    return {
      name: row.Name,
      value: json(row.Value, document, document.sections.Constants?.position),
      description: row.Description,
    };
  });
  const connections = rows(
    document.sections.Connections,
    COLUMNS.connections,
    document,
  ).map((row) => ({
    file: row.File,
    description: row.Description,
    position: document.sections.Connections?.position,
  }));
  const members = document.members.map((member) => {
    if (kind === "commands") {
      if (!/^[a-zA-Z][\w-]*$/.test(member.name) || seen.has(member.name))
        fail(
          document,
          `Invalid or duplicate command: ${member.name}`,
          member.position,
        );
      seen.add(member.name);
    } else bind(member.name, member.position);
    if (!member.description.trim())
      fail(document, `${member.name} requires a description`, member.position);
    const params = parameters(member.sections.Parameters, document, kind);
    const returns = rows(
      member.sections.Returns,
      COLUMNS.returns,
      document,
      true,
    );
    if (returns.length !== 1 || !returns[0].Type)
      fail(
        document,
        "Returns requires exactly one typed result",
        member.position,
      );
    const result = {
      type: returns[0].Type,
      description: returns[0].Description,
    };
    const settings = options(
      member.sections.Options,
      kind === "commands" ? { Surfaces: [] } : MODULE_OPTIONS,
      document,
    );
    const body = member.sections.body;
    if (!body)
      fail(
        document,
        `Missing ${kind === "commands" ? "Handler" : "Implementation"} for ${member.name}`,
        member.position,
      );
    const surfaceText = settings.Surfaces ?? "*";
    const surfaces =
      surfaceText === "*" ? ["*"] : surfaceText.split(",").map((s) => s.trim());
    if (surfaces.some((s) => s !== "*" && !SURFACES.includes(s)))
      fail(document, "Unknown surface restriction", member.position);
    return {
      ...member,
      parameters: params,
      returns: result,
      options: settings,
      body,
      surfaces,
    };
  });
  return { ...document, dependencies, constants, connections, members };
}

/** Emit native ESM; only designated implementation bodies receive exact mappings.
 * @param {string} source @param {string} url @param {{kind?:'module'|'commands',outDir?:string}} [options]
 */
export function compile(source, url, { kind = "module", outDir } = {}) {
  const document = parseDocument(source, url, kind);
  const mapping = new GenMapping({ file: url });
  setSourceContent(mapping, url, source);
  let code = "";
  let generatedLine = 0;
  /** @param {string} text */
  const emit = (text) => {
    code += text + "\n";
    generatedLine += text.split("\n").length;
  };
  emit(`import { owner as __rundown } from ${JSON.stringify(runtimeURL)};`);
  emit("const rundown = __rundown(import.meta.url);");
  for (const dependency of document.dependencies)
    emit(
      `import * as ${dependency.binding} from ${JSON.stringify(dependency.kind === "markdown" ? documentURL(dependency.source, url).href : nativeSpecifier(dependency.source))};`,
    );
  for (const constant of document.constants)
    emit(`const ${constant.name} = ${jsonExpression(constant.value)};`);
  const lines = source.split(/\r\n|\n|\r/);
  for (const [index, member] of document.members.entries()) {
    /** @param {string} value */
    const escapeComment = (value) => value.replaceAll("*/", "* /\u200b");
    emit(
      "/** " +
        escapeComment(member.description.trim()).replaceAll("\n", "\n * "),
    );
    if (kind === "commands") emit(" * @param {object} args");
    for (const p of member.parameters) {
      const type =
        kind === "commands"
          ? (/** @type {Record<string,string>} */ ({
              path: "string",
              integer: "number",
              array: "unknown[]",
            })[p.type] ?? p.type)
          : p.type;
      const parameterName = kind === "commands" ? `args.${p.name}` : p.name;
      emit(
        ` * @param {${escapeComment(type)}} ${p.required ? parameterName : `[${parameterName}${p.hasDefault ? "=" + escapeComment(jsonData(p.default)) : ""}]`} ${escapeComment(p.description)}`,
      );
    }
    if (kind === "commands")
      emit(' * @param {import("@p10i/rundown").InvocationContext} context');
    emit(
      ` * @returns {${escapeComment(kind === "commands" ? `Promise<${member.returns.type}>` : member.returns.type)}} ${escapeComment(member.returns.description)}\n */`,
    );
    const name = kind === "commands" ? `__command${index}` : member.name;
    const parametersText =
      kind === "commands"
        ? "args, context"
        : member.parameters
            .map(
              (p) =>
                p.name +
                (p.hasDefault ? " = " + jsonExpression(p.default) : ""),
            )
            .join(", ");
    emit(
      `${kind === "commands" || member.options.Visibility !== "private" ? "export " : ""}${member.options.Execution === "sync" && kind !== "commands" ? "" : "async "}function ${name}(${parametersText}) {`,
    );
    for (const [i, bodyLine] of member.body.value.split("\n").entries()) {
      const originalLine = member.body.position.start.line + i;
      const original = lines[originalLine] ?? "";
      const column = original.indexOf(bodyLine);
      if (column >= 0)
        for (let c = 0; c <= bodyLine.length; c++)
          addSegment(mapping, generatedLine, c, url, originalLine, column + c);
      emit(bodyLine);
    }
    emit("}");
  }
  const encoded = toEncodedMap(mapping);
  if (!encoded.sourcesContent)
    throw new Error("Compiler map lost its source content");
  const map = {
    ...encoded,
    file: url,
    sources: encoded.sources.map((source) => {
      if (source === null)
        throw new Error("Compiler map contains an unidentified source");
      return source;
    }),
    sourcesContent: [...encoded.sourcesContent],
    names: [...encoded.names],
  };
  try {
    parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (cause) {
    if (!(cause instanceof SyntaxError) || !("loc" in cause)) throw cause;
    const syntax =
      /** @type {SyntaxError&{loc:{line:number,column:number}}} */ (cause);
    const mapped = originalPositionFor(new TraceMap(map), {
      line: syntax.loc.line,
      column: syntax.loc.column,
    });
    const error = problem(
      `Invalid generated JavaScript: ${cause.message}`,
      document,
      mapped.line
        ? {
            start: {
              offset:
                source
                  .split(/(?<=\n)/)
                  .slice(0, mapped.line - 1)
                  .join("").length + mapped.column,
            },
          }
        : undefined,
    );
    error.cause = cause;
    throw error;
  }
  if (outDir) writeArtifacts(url, code, map, outDir);
  return {
    document,
    code:
      code +
      `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`,
    map,
  };
}

/** Write inspectable artifacts only when explicitly requested; never execute output.
 * @param {string} url @param {string} code @param {import('./types.mjs').SourceMap} map @param {string} outDir
 */
export function writeArtifacts(url, code, map, outDir) {
  mkdirSync(outDir, { recursive: true });
  const name = `${basename(fileURLToPath(url))}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}.mjs`;
  writeFileSync(join(outDir, name + ".map"), JSON.stringify(map));
  writeFileSync(
    join(outDir, name),
    code + `\n//# sourceMappingURL=${name}.map\n`,
  );
  return { file: join(outDir, name), map: join(outDir, name + ".map") };
}

/** @param {URL} url @param {{kind?:'module'|'commands',outDir?:string}} [options] */
export function compileFile(url, options) {
  if (url.protocol !== "file:")
    throw new RundownError(
      "RUNDOWN_RESOLUTION",
      "Only file-backed Markdown modules are supported",
      { status: 400 },
    );
  let source;
  try {
    source = readFileSync(url, "utf8");
  } catch (cause) {
    throw fileFailure(cause, url.href);
  }
  return compile(source, url.href, options);
}
