/** JSON values emitted as expressions must not acquire object-literal prototype semantics.
 * @param {unknown} value @param {boolean} computedKeys @returns {string}
 */
function encode(value, computedKeys) {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (Array.isArray(value))
    return (
      "[" + value.map((item) => encode(item, computedKeys)).join(",") + "]"
    );
  if (typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .map(
          ([key, item]) =>
            `${computedKeys ? "[" + quote(key) + "]" : quote(key)}:${encode(item, computedKeys)}`,
        )
        .join(",") +
      "}"
    );
  throw new TypeError("Expected a JSON value");
}
/** Keep JSON string data from adding JavaScript source line boundaries.
 * @param {string} value
 */
function quote(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
/** @param {unknown} value */
export const jsonExpression = (value) => encode(value, true);
/** @param {unknown} value */
export const jsonData = (value) => encode(value, false);
