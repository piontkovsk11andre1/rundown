/**
 * File sorting.
 *
 * Provides sorting strategies for resolved Markdown file paths.
 */


/**
 * Supported sorting strategies for resolved file paths.
 */
export type SortMode = "name-sort" | "none" | "old-first" | "new-first";

/**
 * Optional dependencies used by file sorting.
 */
export interface SortFilesOptions {
  /**
   * Returns a file birthtime in milliseconds.
   *
   * When omitted, birthtime-based modes use `0` for all files.
   */
  getBirthtimeMs?: (filePath: string) => number;
}

/**
 * Sort file paths according to the chosen sort mode.
 *
 * - `name-sort` (default): human-friendly natural sort so "2. X.md" < "10. Y.md"
 * - `none`: leave order as-is from the file matcher
 * - `old-first`: oldest by creation time first
 * - `new-first`: newest by creation time first
 */
export function sortFiles(
  files: string[],
  mode: SortMode = "name-sort",
  options: SortFilesOptions = {},
): string[] {
  // Apply the selected strategy while preserving immutability for sorted modes.
  switch (mode) {
    case "none":
      return files;

    case "name-sort":
      return [...files].sort((a, b) => naturalCompare(fileName(a), fileName(b)));

    case "old-first":
      return [...files].sort((a, b) => getBirthtime(a, options) - getBirthtime(b, options));

    case "new-first":
      return [...files].sort((a, b) => getBirthtime(b, options) - getBirthtime(a, options));

    default:
      return files;
  }
}

/**
 * Natural comparison — numbers inside strings are compared numerically.
 *
 * "2. Plan.md" comes before "10. Plan.md".
 */
function naturalCompare(a: string, b: string): number {
  // Split each string into alternating text and numeric tokens.
  const ax = tokenize(a);
  const bx = tokenize(b);

  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const ai = ax[i];
    const bi = bx[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;

    const an = typeof ai === "number";
    const bn = typeof bi === "number";

    if (an && bn) {
      // Compare numeric parts as numbers so 2 < 10.
      if (ai !== bi) return (ai as number) - (bi as number);
    } else if (an) {
      return -1;
    } else if (bn) {
      return 1;
    } else {
      const cmp = (ai as string).localeCompare(bi as string, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/**
 * Tokenizes a string into ordered numeric and non-numeric chunks.
 *
 * Example: `"12. Plan.md"` becomes `[12, ". Plan.md"]`.
 */
function tokenize(s: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /(\d+)|(\D+)/g;
  let m: RegExpExecArray | null;
  // Iterate through every regex match and normalize numeric segments.
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      tokens.push(parseInt(m[1], 10));
    } else {
      tokens.push(m[2]!);
    }
  }
  return tokens;
}

/**
 * Resolves a comparable birthtime value for a file path.
 */
function getBirthtime(filePath: string, options: SortFilesOptions): number {
  if (!options.getBirthtimeMs) return 0;
  return options.getBirthtimeMs(filePath);
}

/**
 * Extracts the final path segment for name-based comparison.
 */
function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}
