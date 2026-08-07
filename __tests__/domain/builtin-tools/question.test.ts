import { describe, expect, it, vi } from "vitest";
import { checkTaskUsingFileSystem } from "../../../src/application/checkbox-operations.js";
import { createQuestionHandler } from "../../../src/domain/builtin-tools/question.js";
import type { InteractiveInputPort } from "../../../src/domain/ports/interactive-input-port.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

interface CreateContextOptions {
  payload?: string;
  source: string;
  subItems?: Array<{ text: string; line: number; depth: number }>;
  line?: number;
}

function createContext(options: CreateContextOptions): {
  context: ToolHandlerContext;
  writeText: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
} {
  const { payload = "Which module should we improve?", source, subItems = [], line = 1 } = options;
  let fileBody = source;
  const writeText = vi.fn((filePath: string, next: string) => {
    fileBody = next;
    return filePath;
  });
  const emit = vi.fn();

  const context = {
    task: {
      text: "question: Which module should we improve?",
      checked: false,
      line,
      column: 1,
      index: 0,
      offsetStart: 0,
      offsetEnd: 0,
      file: "C:/workspace/todo.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems,
    },
    allTasks: [],
    payload,
    source,
    contextBefore: "",
    fileSystem: {
      readText: vi.fn(() => fileBody),
      writeText,
    },
    pathOperations: {},
    emit,
  } as unknown as ToolHandlerContext;

  return { context, writeText, emit };
}

describe("builtin-tools/question createQuestionHandler", () => {
  it.each(["", "  ", "\t\n  "])("fails when payload is empty or whitespace-only: %j", async (payload) => {
    const { context, writeText, emit } = createContext({ payload, source: "- [ ] question:\n" });
    const prompt = vi.fn();
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt,
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toBe("Question tool requires prompt text payload.");
    expect(result.failureReason).toBe("Question payload is empty.");
    expect(prompt).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("reuses existing answer and skips prompting", async () => {
    const { context, writeText } = createContext({
      source: "- [ ] question: Which module?\n  - answer: CliResourceModule\n",
      subItems: [{ text: "answer: CliResourceModule", line: 2, depth: 1 }],
    });
    const prompt = vi.fn();
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt,
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reuses existing answer in non-interactive mode before default resolution", async () => {
    const { context, writeText } = createContext({
      source: "- [ ] question: Which module?\n  - answer: CliResourceModule\n",
      subItems: [{ text: "ANSWER:   CliResourceModule   ", line: 2, depth: 1 }],
    });
    const prompt = vi.fn();
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt,
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses default option in non-interactive mode and writes answer", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n  - option: ParserModule (default)\n";
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "option: CliResourceModule", line: 2, depth: 1 },
        { text: "option: ParserModule (default)", line: 3, depth: 1 },
      ],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\n"
      + "  - option: CliResourceModule\n"
      + "  - option: ParserModule (default)\n"
      + "  - answer: ParserModule\n",
    );
  });

  it("prompts in TTY mode with select request and writes chosen answer", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n  - option: ParserModule (default)\n";
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "option: CliResourceModule", line: 2, depth: 1 },
        { text: "option: ParserModule (default)", line: 3, depth: 1 },
      ],
    });
    const prompt = vi.fn(async () => ({ value: "CliResourceModule", usedDefault: false, interactive: true }));
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt,
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith({
      kind: "select",
      message: "Which module should we improve?",
      choices: [
        { value: "CliResourceModule", label: "CliResourceModule", isDefault: false },
        { value: "ParserModule", label: "ParserModule", isDefault: true },
      ],
      defaultValue: "ParserModule",
      allowCustomValue: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\n"
      + "  - option: CliResourceModule\n"
      + "  - option: ParserModule (default)\n"
      + "  - answer: CliResourceModule\n",
    );
  });

  it("inserts answer directly beneath question when no options are defined", async () => {
    const source = "- [ ] question: Which module?\n  - note: keep context\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "note: keep context", line: 2, depth: 1 }],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: "CliResourceModule", usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\n"
      + "  - answer: CliResourceModule\n"
      + "  - note: keep context\n",
    );
  });

  it.each([
    {
      name: "colons",
      answer: "domain:parser:question",
      expected: "domain:parser:question",
    },
    {
      name: "markdown syntax",
      answer: "**ParserModule** with `question:` support",
      expected: "**ParserModule** with `question:` support",
    },
    {
      name: "leading and trailing whitespace",
      answer: "   CliResourceModule   ",
      expected: "CliResourceModule",
    },
  ])("preserves special answer characters and normalization for $name", async ({ answer, expected }) => {
    const source = "- [ ] question: Which module?\n";
    const { context, writeText } = createContext({
      source,
      subItems: [],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: answer, usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\n"
      + `  - answer: ${expected}\n`,
    );
  });

  it("uses child indentation derived from parent line for nested questions", async () => {
    const source = "- [ ] parent task\n  - [ ] question: Which module?\n    - note: keep context\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "note: keep context", line: 3, depth: 2 }],
      line: 2,
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: "CliResourceModule", usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] parent task\n"
      + "  - [ ] question: Which module?\n"
      + "    - answer: CliResourceModule\n"
      + "    - note: keep context\n",
    );
  });

  it("preserves CRLF line endings when writing answer sub-item", async () => {
    const source = "- [ ] question: Which module?\r\n  - option: CliResourceModule\r\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "option: CliResourceModule", line: 2, depth: 1 }],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: "CliResourceModule", usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\r\n"
      + "  - option: CliResourceModule\r\n"
      + "  - answer: CliResourceModule\r\n",
    );
  });

  it("updates existing answer line instead of adding a duplicate", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n  - answer: OldModule\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "option: CliResourceModule", line: 2, depth: 1 }],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: "NewModule", usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] question: Which module?\n"
      + "  - option: CliResourceModule\n"
      + "  - answer: NewModule\n",
    );
    expect((writtenSource.match(/- answer:/g) ?? []).length).toBe(1);
  });

  it("writes answer before task is marked checked", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "option: CliResourceModule", line: 2, depth: 1 }],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => ({ value: "CliResourceModule", usedDefault: false, interactive: true })),
    };

    const result = await createQuestionHandler(interactiveInput)(context);
    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });

    checkTaskUsingFileSystem(context.task, context.fileSystem);

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[0]?.[1]).toBe(
      "- [ ] question: Which module?\n"
      + "  - option: CliResourceModule\n"
      + "  - answer: CliResourceModule\n",
    );
    expect(writeText.mock.calls[1]?.[1]).toBe(
      "- [x] question: Which module?\n"
      + "  - option: CliResourceModule\n"
      + "  - answer: CliResourceModule\n",
    );
  });

  it("parses option sub-items and detects default marker", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n  - OPTION: ParserModule (default)\n  - option:    RunnerModule   \n";
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "option: CliResourceModule", line: 2, depth: 1 },
        { text: "OPTION: ParserModule (default)", line: 3, depth: 1 },
        { text: "option:    RunnerModule", line: 4, depth: 1 },
      ],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toContain("  - answer: ParserModule");
  });

  it("parses option sub-items without default marker", async () => {
    const source = "- [ ] question: Which module?\n  - option:  CliResourceModule  \n  - OPTION: ParserModule\n  - note: ignore this\n";
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "option:  CliResourceModule", line: 2, depth: 1 },
        { text: "OPTION: ParserModule", line: 3, depth: 1 },
        { text: "note: ignore this", line: 4, depth: 1 },
      ],
    });
    const prompt = vi.fn(async () => ({ value: "ParserModule", usedDefault: false, interactive: true }));
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt,
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(prompt).toHaveBeenCalledWith({
      kind: "select",
      message: "Which module should we improve?",
      choices: [
        { value: "CliResourceModule", label: "CliResourceModule", isDefault: false },
        { value: "ParserModule", label: "ParserModule", isDefault: false },
      ],
      defaultValue: undefined,
      allowCustomValue: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toContain("  - answer: ParserModule");
  });

  it("fails in non-interactive mode when no default option exists", async () => {
    const source = "- [ ] question: Which module?\n  - option: CliResourceModule\n  - option: ParserModule\n";
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "option: CliResourceModule", line: 2, depth: 1 },
        { text: "option: ParserModule", line: 3, depth: 1 },
      ],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toBe("Question options have no default answer for non-interactive execution.");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("fails in non-interactive mode when no options exist", async () => {
    const source = "- [ ] question: Which module?\n";
    const { context, writeText } = createContext({
      source,
      subItems: [],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => false,
      prompt: vi.fn(),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toBe("Question has neither options nor a default answer for non-interactive execution.");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("propagates aborted prompt as interrupted failure", async () => {
    const { context, writeText } = createContext({
      source: "- [ ] question: Which module?\n",
      subItems: [],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => {
        throw new Error("Prompt aborted by user.");
      }),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(130);
    expect(result.failureMessage).toBe("Question prompt interrupted by user.");
    expect(result.failureReason).toBe("Question input interrupted.");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("propagates canceled prompt as interrupted failure", async () => {
    const { context, writeText } = createContext({
      source: "- [ ] question: Which module?\n",
      subItems: [],
    });
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => {
        throw new Error("User canceled input.");
      }),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(130);
    expect(result.failureMessage).toBe("Question prompt interrupted by user.");
    expect(result.failureReason).toBe("Question input interrupted.");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("propagates AbortError as interrupted failure", async () => {
    const { context, writeText } = createContext({
      source: "- [ ] question: Which module?\n",
      subItems: [],
    });
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    const interactiveInput: InteractiveInputPort = {
      isTTY: () => true,
      prompt: vi.fn(async () => {
        throw abortError;
      }),
    };

    const result = await createQuestionHandler(interactiveInput)(context);

    expect(result.exitCode).toBe(130);
    expect(result.failureMessage).toBe("Question prompt interrupted by user.");
    expect(result.failureReason).toBe("Question input interrupted.");
    expect(writeText).not.toHaveBeenCalled();
  });
});
