# Universal document format

Two bundled do-md templates define separate grammars:
[commands](../templates/commands.md.template) and
[modules](../templates/module.md.template). Every module uses the same universal
module template; command catalogs have their own template. Neither concatenates
every JavaScript fence. Descriptions can contain multiple paragraphs; ordinary
documentation headings, examples, lists and diagrams do not generate execution.
Recognized fields are scoped by heading depth.

The templates use do-md `scope`, `optional`, heading/table/code-block leaves,
binding validators and `.as()` bindings. Their required field order is the order
shown below: method Options (optional), Parameters, Returns, Implementation;
command Options (optional), Parameters, Schema (optional), Returns, Handler.
Ordinary documentation can appear between these fields and after a body under
its own heading. Top-level sections can interleave documentation and definitions.

Do-md's published API does not yet expose a heading-bounded raw-text slot.
`TemplateSupport.mjs` supplies that small adapter using do-md's top-level Markdown
positions and a normal bound text slot. It does not select command/module fields
or assign parsing results. Fences, quotations and lists remain opaque to section
boundary detection. The compiler normalizes template bindings and their slot-map
positions, then checks cross-field semantics and generates ESM/source maps.

## Command catalogs

- One H1 title.
- Optional H2 `Connections`, with `File | Description` columns. Paths resolve
  relative to the containing document; rows recursively load command definitions.
- Repeated H2 `Command: name` definitions. Each has a description and H3 fields.
- Optional `Options`: `Option | Value`, currently `Surfaces` with `*` (default)
  or a comma-separated allowlist of `cli`, `http`, `mcp`, `http-mcp`.
- Required `Parameters`: `Name | Type | Required | Default | CLI | Description`.
- Optional `Schema`: one `json` fence with additional JSON Schema constraints.
- Required `Returns`: one `Type | Description` row.
- Required `Handler`: one `js` fence containing only the async handler body.
  The generated handler receives `args` and `context`.

Command names are identifiers allowing hyphens. Every command has a single
authoritative section; summaries and tool definitions come from that section.
Surfaces enforce restrictions before calling handlers and omit excluded commands
from discovery. The remote MCP bridge preserves the remote MCP restriction.

Simple command types are `string`, `path`, `number`, `integer`, `boolean`, `object`,
`array`, `null`. Complex structures use object/array parameters plus the Schema
section. The parameter table and additional schema both apply. Unknown arguments
are rejected. Defaults are applied before validation. Path parameters become
absolute paths relative to the invocation workdir after validation.

CLI positions are unique contiguous positive integers. Optional positional values
follow required ones. Named options use `--name`; booleans allow `--name` or
`--name=false`. Non-string CLI values use JSON notation. HTTP/MCP always use the
parameter name. Repeat assignments and unknown arguments fail.

## Modules

- One H1 title.
- Optional H2 `Dependencies`: `Source | Kind | Binding | Description`.
  `markdown` emits a static namespace import through the loader; `javascript`
  emits a native namespace import. Dependencies load with the module.
- Optional H2 `Constants`: `Name | Value | Description`. Values are JSON literals.
- Repeated H2 `Method: name` sections with descriptions and H3 fields.
- Optional `Options`: `Option | Value`, supporting `Visibility=public|private`
  and `Execution=async|sync`. Defaults are public and async.
- Required `Parameters`: `Name | Type | Required | Default | Description`.
  A header-only table describes no parameters.
- Required `Returns`: one `Type | Description` row. Async methods document their
  actual callable return type, for example `Promise<string>`.
- Required `Implementation`: exactly one `js` fence containing a method body.

Module types use JSDoc expressions and generate comments, not runtime validators.
Implementation bodies can use declared dependencies, constants, sibling/private
methods, and the owner-bound `rundown.loadModule` / `rundown.loadCommands` binding.
Invocation context is never implicitly injected into module methods: pass it as a
documented argument when needed. There is no module initialization-script section.

## Definition rules

Table column names and order are fixed. Defaults are JSON literals, with inline
code recommended to preserve Markdown punctuation. Blank means no default; `null`
is an actual null default. `Required` is `yes` or `no`; required parameters cannot
declare defaults. Optional parameters without defaults receive undefined when
omitted. Module parameter order is signature order.

Binding names must be JavaScript identifiers, with language keywords and generated
runtime bindings reserved. Duplicate bindings/methods, duplicate recognized
tables/bodies, invalid schemas and contradictory options fail compilation/loading.
Missing required tables or bodies are errors. Source declarations are validated
as JavaScript before Node evaluates them. Schema validation never silently coerces
JSON values. Callback definitions do not appear in this document format: they are
short-lived JavaScript registrations with explicit input schemas.
