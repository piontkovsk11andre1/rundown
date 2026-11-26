import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { resolve } from "node:path";
import { RundownError } from "./Error.mjs";
import { COMMAND_TYPES } from "./Format.mjs";

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
/** @type {Record<string,string>} */
const types = COMMAND_TYPES;

/** Compile a callback/command object schema without coercion or mutating inputs.
 * @param {unknown} schema @returns {(input:unknown)=>unknown}
 */
export function validator(schema) {
  if (
    !schema ||
    typeof schema !== "object" ||
    !("type" in schema) ||
    schema.type !== "object"
  )
    throw new RundownError(
      "RUNDOWN_SCHEMA",
      "Input schema must describe an object",
      { status: 400 },
    );
  let validate;
  try {
    validate = ajv.compile(
      /** @type {import('ajv').AnySchemaObject} */ (schema),
    );
  } catch (cause) {
    throw new RundownError(
      "RUNDOWN_SCHEMA",
      cause instanceof Error ? cause.message : String(cause),
      {
        cause,
        status: 400,
      },
    );
  }
  return (input) => {
    if (!validate(input))
      throw new RundownError(
        "RUNDOWN_ARGUMENTS",
        ajv.errorsText(validate.errors),
        { status: 400 },
      );
    return input;
  };
}

/** @param {{parameters:import('./types.mjs').Parameter[],sections:import('./InternalContracts.mjs').MemberSections}} member */
export function commandSchema(member) {
  const extra = member.sections.schema;
  if (
    extra !== undefined &&
    typeof extra !== "boolean" &&
    (typeof extra !== "object" || extra === null || Array.isArray(extra))
  )
    throw new RundownError(
      "RUNDOWN_SCHEMA",
      "Additional Schema must be a JSON Schema object or boolean",
      { status: 400 },
    );
  const extraProperties =
    typeof extra === "object" &&
    extra !== null &&
    "properties" in extra &&
    typeof extra.properties === "object" &&
    extra.properties !== null
      ? /** @type {Record<string,unknown>} */ (extra.properties)
      : {};
  const properties = Object.fromEntries(
    member.parameters.map((p) => {
      const type = types[p.type];
      if (!type)
        throw new RundownError(
          "RUNDOWN_SCHEMA",
          `Command type ${p.type} requires a supported simple Type; use Schema for constraints`,
          { status: 400 },
        );
      return [
        p.name,
        {
          type,
          description: p.description,
          ...(p.hasDefault ? { default: p.default } : {}),
        },
      ];
    }),
  );
  const base = {
    type: /** @type {const} */ ("object"),
    properties,
    required: member.parameters.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
  const schema = Object.hasOwn(member.sections, "schema")
    ? { type: /** @type {const} */ ("object"), allOf: [base, extra] }
    : base;
  const validate = validator(schema);
  for (const p of member.parameters.filter((p) => p.hasDefault)) {
    const test = ajv.compile({
      allOf: [properties[p.name], extraProperties[p.name] ?? {}],
    });
    if (!test(p.default))
      throw new RundownError(
        "RUNDOWN_SCHEMA",
        `Invalid default for ${p.name}`,
        { status: 400 },
      );
  }
  return { schema, validate };
}

/** Surface normalization happens once, before schema validation and handler execution.
 * @param {Pick<import('./types.mjs').Command,'parameters'|'validate'>} command @param {unknown} input @param {string} workdir
 */
export function argumentsFor(command, input, workdir) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new RundownError("RUNDOWN_ARGUMENTS", "Expected an argument object", {
      status: 400,
    });
  const args = /** @type {Record<string,unknown>} */ (structuredClone(input));
  for (const p of command.parameters)
    if (!Object.hasOwn(args, p.name) && p.hasDefault)
      Object.defineProperty(args, p.name, {
        value: structuredClone(p.default),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  command.validate(args);
  // Path types are interpreted by the caller's workdir, not the declaring document.
  for (const p of command.parameters)
    if (p.type === "path" && args[p.name] !== undefined) {
      const value = args[p.name];
      if (typeof value !== "string")
        throw new RundownError(
          "RUNDOWN_ARGUMENTS",
          `Expected a path string: ${p.name}`,
          { status: 400 },
        );
      args[p.name] = resolve(workdir, value);
    }
  return args;
}

/** JSON results must not silently lose functions, bigint, cycles or nonfinite numbers.
 * @param {unknown} value @returns {string}
 */
export function jsonText(value) {
  try {
    const result = JSON.stringify(
      value === undefined ? null : value,
      (_key, item) => {
        if (
          ["bigint", "function", "symbol", "undefined"].includes(typeof item) ||
          (typeof item === "number" && !Number.isFinite(item))
        )
          throw new RundownError(
            "RUNDOWN_SERIALIZATION",
            "Result is not JSON-serializable",
          );
        return item;
      },
    );
    if (result === undefined)
      throw new RundownError(
        "RUNDOWN_SERIALIZATION",
        "Result is not JSON-serializable",
      );
    return result;
  } catch (cause) {
    if (cause instanceof RundownError) throw cause;
    throw new RundownError(
      "RUNDOWN_SERIALIZATION",
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}
