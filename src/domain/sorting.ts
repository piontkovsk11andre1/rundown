/**
 * File sorting.
 *
 * Provides sorting strategies for resolved Markdown file paths.
 */

import fs from "node:fs";
import path from "node:path";

export type SortMode = "name-sort" | "none" | "old-first" | "new-first";

/**
 * Sort file paths according to the chosen sort mode.
 *
 * - `name-sort` (default): human-friendly natural sort so "2. X.md" < "10. Y.md"
 * - `none`: leave order as-is from the file matcher
 * - `old-first`: oldest by creation time first
 * - `new-first`: newest by creation time first
 */
export function sortFiles(files: string[], mode: SortMode = "name-sort"): string[] {
  switch (mode) {
    case "none":
      return files;

    case "name-sort":
      return [...files].sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));

    case "old-first":
      return [...files].sort((a, b) => birthtime(a) - birthtime(b));

    case "new-first":
      return [...files].sort((a, b) => birthtime(b) - birthtime(a));

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

function tokenize(s: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /(\d+)|(\D+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      tokens.push(parseInt(m[1], 10));
    } else {
      tokens.push(m[2]!);
    }
  }
  return tokens;
}

function birthtime(filePath: string): number {
  try {
    return fs.statSync(filePath).birthtimeMs;
  } catch {
    return 0;
  }
}
