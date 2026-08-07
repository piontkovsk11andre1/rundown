/**
 * Parsed representation of a worker invocation pattern.
 */
export interface ParsedWorkerPattern {
  // Command tokens produced from the pattern string.
  command: string[];
  // True when at least one token contains `$bootstrap`.
  usesBootstrap: boolean;
  // True when at least one token contains `$file`.
  usesFile: boolean;
  // True when neither `$bootstrap` nor `$file` appears and `$file` should be appended.
  appendFile: boolean;
}

/**
 * Parses a worker pattern string into command tokens and substitution metadata.
 */
export function parseWorkerPattern(pattern: string): ParsedWorkerPattern {
  const command = splitPatternTokens(pattern);
  if (command.length === 0) {
    throw new Error("Worker pattern must include at least one command token.");
  }

  const usesBootstrap = command.some((token) => token.includes("$bootstrap"));
  const usesFile = command.some((token) => token.includes("$file"));

  return {
    command,
    usesBootstrap,
    usesFile,
    appendFile: !usesBootstrap && !usesFile,
  };
}

/**
 * Expand a parsed worker pattern into argv tokens by substituting runtime values.
 */
export function expandWorkerPattern(
  parsed: ParsedWorkerPattern,
  bootstrapText: string,
  promptFilePath: string,
): string[] {
  const expanded = parsed.command.map((token) => {
    const withBootstrap = token.split("$bootstrap").join(bootstrapText);
    return withBootstrap.split("$file").join(promptFilePath);
  });

  if (parsed.appendFile) {
    expanded.push(promptFilePath);
  }

  return expanded;
}

/**
 * Infers parsed worker-pattern metadata from already-tokenized command arguments.
 */
export function inferWorkerPatternFromCommand(command: string[]): ParsedWorkerPattern {
  const usesBootstrap = command.some((token) => token.includes("$bootstrap"));
  const usesFile = command.some((token) => token.includes("$file"));

  return {
    command: [...command],
    usesBootstrap,
    usesFile,
    appendFile: !usesBootstrap && !usesFile,
  };
}

function splitPatternTokens(pattern: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escapeNext = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (quote === null) {
      if (/\s/.test(char)) {
        pushCurrent();
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote === '"' && char === "\\") {
      const next = pattern[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }

    current += char;
  }

  if (escapeNext) {
    throw new Error("Invalid worker pattern: trailing escape character.");
  }

  if (quote !== null) {
    throw new Error("Invalid worker pattern: unterminated quoted argument.");
  }

  pushCurrent();
  return tokens;
}
