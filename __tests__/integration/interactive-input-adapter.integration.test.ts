import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTerminalInteractiveInputAdapter } from "../../src/infrastructure/adapters/interactive-input-adapter.js";

class CapturedOutput extends Writable {
  public readonly chunks: string[] = [];
  public isTTY = true;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createMockInput(isTTY: boolean): PassThrough & { isTTY: boolean } {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = isTTY;
  return input;
}

describe("interactive input adapter integration", () => {
  let originalStdin: PropertyDescriptor | undefined;
  let originalStdout: PropertyDescriptor | undefined;
  let originalCi: string | undefined;

  beforeEach(() => {
    originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
    originalCi = process.env.CI;
    process.env.CI = "false";
  });

  afterEach(() => {
    if (originalStdin) {
      Object.defineProperty(process, "stdin", originalStdin);
    }
    if (originalStdout) {
      Object.defineProperty(process, "stdout", originalStdout);
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it("reads text prompt input from mocked stdin/stdout", async () => {
    const input = createMockInput(true);
    const output = new CapturedOutput();

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "text",
      message: "Which module?",
      required: true,
    });

    setImmediate(() => {
      input.write("CliResourceModule\n");
    });

    await expect(promptPromise).resolves.toEqual({
      value: "CliResourceModule",
      usedDefault: false,
      interactive: true,
    });
    expect(output.toString()).toContain("Which module?");
  });

  it("renders select options and resolves numeric choice", async () => {
    const input = createMockInput(true);
    const output = new CapturedOutput();

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "select",
      message: "Which module?",
      choices: [
        { value: "CliResourceModule", label: "CliResourceModule" },
        { value: "ParserModule", label: "ParserModule" },
      ],
      allowCustomValue: false,
    });

    setImmediate(() => {
      input.write("2\n");
    });

    await expect(promptPromise).resolves.toEqual({
      value: "ParserModule",
      usedDefault: false,
      interactive: true,
    });
    expect(output.toString()).toContain("1. CliResourceModule");
    expect(output.toString()).toContain("2. ParserModule");
  });

  it("re-prompts after invalid select input until a valid option is chosen", async () => {
    const input = createMockInput(true);
    const output = new CapturedOutput();

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "select",
      message: "Which module?",
      choices: [
        { value: "CliResourceModule", label: "CliResourceModule" },
        { value: "ParserModule", label: "ParserModule" },
      ],
      allowCustomValue: false,
    });

    setImmediate(() => {
      input.write("9\n");
      setTimeout(() => {
        input.write("ParserModule\n");
      }, 10);
    });

    await expect(promptPromise).resolves.toEqual({
      value: "ParserModule",
      usedDefault: false,
      interactive: true,
    });

    const renderedOutput = output.toString();
    expect(renderedOutput).toContain("Please select one of the listed options.");
    expect(renderedOutput).toContain("1. CliResourceModule");
    expect(renderedOutput).toContain("2. ParserModule");
    expect(renderedOutput.match(/Which module\?/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("re-prompts after unrecognized text input until a valid option is chosen", async () => {
    const input = createMockInput(true);
    const output = new CapturedOutput();

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "select",
      message: "Which module?",
      choices: [
        { value: "CliResourceModule", label: "CliResourceModule" },
        { value: "ParserModule", label: "ParserModule" },
      ],
      allowCustomValue: false,
    });

    setImmediate(() => {
      input.write("UnknownModule\n");
      setTimeout(() => {
        input.write("1\n");
      }, 10);
    });

    await expect(promptPromise).resolves.toEqual({
      value: "CliResourceModule",
      usedDefault: false,
      interactive: true,
    });

    const renderedOutput = output.toString();
    expect(renderedOutput).toContain("Please select one of the listed options.");
    expect(renderedOutput).toContain("1. CliResourceModule");
    expect(renderedOutput).toContain("2. ParserModule");
    expect(renderedOutput.match(/Which module\?/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("uses default option in non-interactive mode", async () => {
    const input = createMockInput(false);
    const output = new CapturedOutput();
    output.isTTY = false;

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    const adapter = createTerminalInteractiveInputAdapter();

    await expect(
      adapter.prompt({
        kind: "select",
        message: "Which module?",
        choices: [
          { value: "CliResourceModule", isDefault: true },
          { value: "ParserModule" },
        ],
      }),
    ).resolves.toEqual({
      value: "CliResourceModule",
      usedDefault: true,
      interactive: false,
    });
  });
});
