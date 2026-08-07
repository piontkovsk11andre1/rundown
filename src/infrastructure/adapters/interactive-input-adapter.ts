import readline from "node:readline";
import type {
  InteractiveInputPort,
  InteractivePromptRequest,
  InteractivePromptResult,
  InteractiveSelectPromptRequest,
} from "../../domain/ports/interactive-input-port.js";

export class InteractiveInputInterruptedError extends Error {
  constructor(message = "Input interrupted by user (Ctrl+C).") {
    super(message);
    this.name = "InteractiveInputInterruptedError";
  }
}

/**
 * Creates a terminal-backed interactive input adapter.
 *
 * The adapter uses process stdin/stdout with readline for prompt input and
 * automatically falls back to defaults in non-interactive environments.
 */
export function createTerminalInteractiveInputAdapter(): InteractiveInputPort {
  return {
    isTTY() {
      return isInteractivePromptEnabled();
    },
    prepareForPrompt() {
      process.stdout.write("\n");
    },
    async prompt(request) {
      const interactive = isInteractivePromptEnabled();
      if (!interactive) {
        return resolveNonInteractive(request);
      }

      const value = await askInteractive(request);
      return {
        value,
        usedDefault: false,
        interactive: true,
      };
    },
  };
}

async function askInteractive(request: InteractivePromptRequest): Promise<string> {
  switch (request.kind) {
    case "text": {
      while (true) {
        const suffix = request.defaultValue ? ` [default: ${request.defaultValue}]` : "";
        const raw = await askLine(`${request.message}${suffix}: `);
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return raw;
        }

        if (request.defaultValue !== undefined) {
          return request.defaultValue;
        }

        if (request.required !== true) {
          return "";
        }

        process.stdout.write("Input is required. Please provide a value.\n");
      }
    }
    case "confirm": {
      while (true) {
        const defaultHint = request.defaultValue === undefined
          ? "[y/n]"
          : request.defaultValue
            ? "[Y/n]"
            : "[y/N]";
        const raw = await askLine(`${request.message} ${defaultHint}: `);
        const answer = raw.trim().toLowerCase();
        if (answer.length === 0 && request.defaultValue !== undefined) {
          return request.defaultValue ? "true" : "false";
        }
        if (["y", "yes"].includes(answer)) {
          return "true";
        }
        if (["n", "no"].includes(answer)) {
          return "false";
        }

        process.stdout.write("Please answer with yes or no.\n");
      }
    }
    case "select":
      return askSelectInteractive(request);
    default:
      return assertNever(request);
  }
}

async function askSelectInteractive(request: InteractiveSelectPromptRequest): Promise<string> {
  if (request.choices.length === 0) {
    throw new Error("Interactive select prompt requires at least one choice.");
  }

  request.choices.forEach((choice, index) => {
    const marker = choice.isDefault ? " (default)" : "";
    const label = choice.label ?? choice.value;
    const description = choice.description ? ` - ${choice.description}` : "";
    process.stdout.write(`${index + 1}. ${label}${marker}${description}\n`);
  });

  const defaultValue = request.defaultValue ?? request.choices.find((choice) => choice.isDefault)?.value;

  while (true) {
    const promptSuffix = defaultValue === undefined ? "" : ` [default: ${defaultValue}]`;
    const raw = await askLine(`${request.message}${promptSuffix}: `);
    const trimmed = raw.trim();

    if (trimmed.length === 0 && defaultValue !== undefined) {
      return defaultValue;
    }

    const numericIndex = Number(trimmed);
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= request.choices.length) {
      return request.choices[numericIndex - 1].value;
    }

    const exactMatch = request.choices.find((choice) => choice.value === trimmed || choice.label === trimmed);
    if (exactMatch) {
      return exactMatch.value;
    }

    if (request.allowCustomValue) {
      return raw;
    }

    process.stdout.write("Please select one of the listed options.\n");
  }
}

function resolveNonInteractive(request: InteractivePromptRequest): InteractivePromptResult {
  switch (request.kind) {
    case "text": {
      if (request.defaultValue === undefined) {
        throw new Error("Interactive text prompt requires defaultValue in non-interactive mode.");
      }

      return {
        value: request.defaultValue,
        usedDefault: true,
        interactive: false,
      };
    }
    case "confirm": {
      if (request.defaultValue === undefined) {
        throw new Error("Interactive confirm prompt requires defaultValue in non-interactive mode.");
      }

      return {
        value: request.defaultValue ? "true" : "false",
        usedDefault: true,
        interactive: false,
      };
    }
    case "select": {
      const defaultValue = request.defaultValue
        ?? request.choices.find((choice) => choice.isDefault)?.value;
      if (defaultValue === undefined) {
        throw new Error("Interactive select prompt requires a default option in non-interactive mode.");
      }

      return {
        value: defaultValue,
        usedDefault: true,
        interactive: false,
      };
    }
    default:
      return assertNever(request);
  }
}

function askLine(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const terminal = isInteractivePromptEnabled();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal,
    });

    let settled = false;

    const cleanup = (): void => {
      rl.removeListener("SIGINT", onSigint);
      rl.removeListener("close", onClose);
    };

    const settleResolve = (answer: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      rl.close();
      resolve(answer);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      rl.close();
      reject(error);
    };

    const onSigint = (): void => {
      settleReject(new InteractiveInputInterruptedError());
    };

    const onClose = (): void => {
      settleReject(new Error("Input stream closed before response was received."));
    };

    rl.once("SIGINT", onSigint);
    rl.once("close", onClose);
    rl.question(query, (answer) => {
      settleResolve(answer);
    });
  });
}

function assertNever(value: never): never {
  throw new Error(`Unsupported interactive prompt request: ${JSON.stringify(value)}`);
}

function isInteractivePromptEnabled(): boolean {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return false;
  }

  const ci = process.env["CI"];
  if (typeof ci !== "string") {
    return true;
  }

  const normalized = ci.trim().toLowerCase();
  return normalized === "" || normalized === "0" || normalized === "false";
}
