import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readline from "node:readline";
import type { Interface } from "node:readline";
import {
  createTerminalInteractiveInputAdapter,
  InteractiveInputInterruptedError,
} from "../../../src/infrastructure/adapters/interactive-input-adapter.js";

type Listener = (...args: unknown[]) => void;

function createReadlineMock() {
  const listeners = new Map<string, Listener>();
  let questionHandler: ((answer: string) => void) | undefined;

  const api = {
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return api;
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
      return api;
    }),
    question: vi.fn((_query: string, cb: (answer: string) => void) => {
      questionHandler = cb;
      return api;
    }),
    close: vi.fn(() => {
      const closeHandler = listeners.get("close");
      if (closeHandler) {
        closeHandler();
      }
      return api;
    }),
    emit(event: string) {
      const listener = listeners.get(event);
      if (listener) {
        listener();
      }
    },
    answer(value: string) {
      questionHandler?.(value);
    },
  };

  return api;
}

describe("createTerminalInteractiveInputAdapter", () => {
  let originalStdoutIsTTY: PropertyDescriptor | undefined;
  let originalStdinIsTTY: PropertyDescriptor | undefined;
  let originalCI: string | undefined;

  beforeEach(() => {
    originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    originalCI = process.env.CI;

    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    process.env.CI = "false";
  });

  afterEach(() => {
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }

    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }

    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }

    vi.restoreAllMocks();
  });

  it("rejects with interruption error on Ctrl+C during prompt", async () => {
    const rl = createReadlineMock();
    vi.spyOn(readline, "createInterface").mockReturnValue(rl as unknown as Interface);

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "text",
      message: "Which module?",
      required: true,
    });

    rl.emit("SIGINT");

    await expect(promptPromise).rejects.toBeInstanceOf(InteractiveInputInterruptedError);
    await expect(promptPromise).rejects.toThrow("Input interrupted by user (Ctrl+C).");
  });

  it("rejects when input stream closes before answer", async () => {
    const rl = createReadlineMock();
    vi.spyOn(readline, "createInterface").mockReturnValue(rl as unknown as Interface);

    const adapter = createTerminalInteractiveInputAdapter();
    const promptPromise = adapter.prompt({
      kind: "text",
      message: "Which module?",
      required: true,
    });

    rl.emit("close");

    await expect(promptPromise).rejects.toThrow("Input stream closed before response was received.");
  });

  it("re-prompts for invalid numeric option before accepting valid selection", async () => {
    const first = createReadlineMock();
    const second = createReadlineMock();
    const createInterface = vi.spyOn(readline, "createInterface");
    createInterface
      .mockReturnValueOnce(first as unknown as Interface)
      .mockReturnValueOnce(second as unknown as Interface);

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

    first.answer("99");
    await Promise.resolve();
    second.answer("2");

    await expect(promptPromise).resolves.toMatchObject({
      value: "ParserModule",
      interactive: true,
      usedDefault: false,
    });
    expect(createInterface).toHaveBeenCalledTimes(2);
  });

  it("re-prompts for unrecognized text before accepting valid option text", async () => {
    const first = createReadlineMock();
    const second = createReadlineMock();
    const createInterface = vi.spyOn(readline, "createInterface");
    createInterface
      .mockReturnValueOnce(first as unknown as Interface)
      .mockReturnValueOnce(second as unknown as Interface);

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

    first.answer("UnknownModule");
    await Promise.resolve();
    second.answer("CliResourceModule");

    await expect(promptPromise).resolves.toMatchObject({
      value: "CliResourceModule",
      interactive: true,
      usedDefault: false,
    });
    expect(createInterface).toHaveBeenCalledTimes(2);
  });
});
