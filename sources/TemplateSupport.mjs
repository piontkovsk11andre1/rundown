import { flattenInlines } from "@p10i/do-md/markdown";

/**
 * Heading-bounded raw slots are not exposed by do-md 2.0.0-rc.2. Adapt its
 * top-level Markdown positions to a regular bound slot, preserving original text.
 * This helper knows block boundaries, not Rundown sections or document state.
 */
/** @type {WeakMap<import('@p10i/do-md').SourceText,import('@p10i/do-md').MarkdownBlockNode[]>} */
const documents = new WeakMap();
/** @param {import('@p10i/do-md').Reader} reader */
function blocks(reader) {
  const source = reader.sourceText;
  if (!documents.has(source))
    documents.set(source, reader.parseDocument().children);
  return documents.get(source) ?? [];
}

/** Bind documentation up to a sibling/ancestor heading or a requested block.
 * @param {import('@p10i/do-md').Reader} reader @param {number} level
 * @param {{names?:readonly string[],stopAt?:string}} [options]
 */
export function untilHeading(reader, level, { names, stopAt } = {}) {
  const remaining = blocks(reader).filter(
    (node) =>
      node.position != null && node.position.start.offset >= reader.offset,
  );
  const boundary = remaining.find((node, index) => {
    if (node.type === "heading") {
      return (
        node.level < level ||
        (node.level === level &&
          (!names || names.includes(flattenInlines(node.children))))
      );
    }
    // A new documentation heading owns its own examples/tables. Stop duplicate
    // structural blocks only before such a heading, not inside documentation.
    return (
      node.type === stopAt &&
      !remaining.slice(0, index).some((block) => block.type === "heading")
    );
  });
  const end = boundary?.position?.start.offset ?? reader.sourceText.length;
  return reader.regexp(new RegExp(`[\\s\\S]{${end - reader.offset}}`));
}

/** Bind section introduction without crossing its next sibling/ancestor heading.
 * @param {import('@p10i/do-md').Reader} reader @param {string} type @param {number} level
 */
export function untilElement(reader, type, level) {
  return untilHeading(reader, level, { stopAt: type });
}

/** Non-consuming optional-heading guard; all real consumption stays in the template.
 * @param {import('@p10i/do-md').Reader} reader @param {1|2|3|4|5|6} level @param {string} name
 */
export function atHeading(reader, level, name) {
  const probe = reader.fork();
  return probe.heading(level).value === name;
}

/** Binding validators report named format expectations through do-md diagnostics.
 * @param {string} name @returns {(value:unknown)=>void}
 */
export function named(name) {
  return (value) => {
    if (value !== name) throw new Error(`Expected heading: ${name}`);
  };
}
/** @param {readonly string[]} expected @returns {(value:import('@p10i/do-md').TableValue|null|undefined)=>void} */
export function columns(expected) {
  return (value) => {
    if (!value)
      throw new Error(
        `Missing definition table; expected columns: ${expected.join(", ")}`,
      );
    if (value.headers.join("\n") !== expected.join("\n"))
      throw new Error(`Expected columns: ${expected.join(", ")}`);
  };
}
/** @param {string} language @returns {(value:{language:string|null,meta:string}|null|undefined)=>void} */
export function code(language) {
  return (value) => {
    if (!value || value.language !== language || value.meta !== "")
      throw new Error(`Expected a ${language} implementation fence`);
  };
}
