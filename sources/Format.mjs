/** Shared authoring vocabulary consumed by parsers, scaffolds and reference output. */
export const COLUMNS = Object.freeze({
  connections: Object.freeze(["File", "Description"]),
  dependencies: Object.freeze(["Source", "Kind", "Binding", "Description"]),
  constants: Object.freeze(["Name", "Value", "Description"]),
  options: Object.freeze(["Option", "Value"]),
  methodParameters: Object.freeze([
    "Name",
    "Type",
    "Required",
    "Default",
    "Description",
  ]),
  commandParameters: Object.freeze([
    "Name",
    "Type",
    "Required",
    "Default",
    "CLI",
    "Description",
  ]),
  returns: Object.freeze(["Type", "Description"]),
});
export const METHOD_FIELDS = Object.freeze([
  "Options",
  "Parameters",
  "Returns",
  "Implementation",
]);
export const COMMAND_FIELDS = Object.freeze([
  "Options",
  "Parameters",
  "Schema",
  "Returns",
  "Handler",
]);
export const MODULE_OPTIONS = Object.freeze({
  Visibility: Object.freeze(["public", "private"]),
  Execution: Object.freeze(["async", "sync"]),
});
export const SURFACES = Object.freeze(["cli", "http", "mcp", "http-mcp"]);
export const COMMAND_TYPES = Object.freeze({
  string: "string",
  path: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
});
