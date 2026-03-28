import { afterEach, describe, expect, it, vi } from "vitest";
import { cliOutputPort } from "../../src/presentation/output-port.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cliOutputPort", () => {
  it("ignores unknown event kinds", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    cliOutputPort.emit({ kind: "unknown" } as never);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("renders child tasks indented under parent task", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "task",
      task: {
        text: "Parent task",
        checked: false,
        index: 1,
        line: 10,
        column: 1,
        offsetStart: 0,
        offsetEnd: 20,
        file: "TODO.md",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      children: [
        {
          text: "Child task",
          checked: false,
          index: 2,
          line: 11,
          column: 3,
          offsetStart: 21,
          offsetEnd: 40,
          file: "TODO.md",
          isInlineCli: false,
          depth: 1,
          children: [],
          subItems: [],
        },
      ],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
    expect(output).toContain("TODO.md:10");
    expect(output).toContain("[#1]");
    expect(output).toContain("Parent task");
    expect(output).toContain("\n");
    expect(output).toContain("  TODO.md:11");
    expect(output).toContain("[#2]");
    expect(output).toContain("Child task");
  });

  it("renders non-checkable sub-items indented under parent task", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "task",
      task: {
        text: "Parent task",
        checked: false,
        index: 1,
        line: 10,
        column: 1,
        offsetStart: 0,
        offsetEnd: 20,
        file: "TODO.md",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      subItems: [
        {
          text: "Parent detail",
          line: 11,
          depth: 1,
        },
      ],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
    expect(output).toContain("TODO.md:10");
    expect(output).toContain("[#1]");
    expect(output).toContain("Parent task");
    expect(output).toContain("\n");
    expect(output).toContain("  TODO.md:11 - Parent detail");
  });

  it("renders mixed children and sub-items in source order", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "task",
      task: {
        text: "Parent task",
        checked: false,
        index: 1,
        line: 10,
        column: 1,
        offsetStart: 0,
        offsetEnd: 20,
        file: "TODO.md",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      children: [
        {
          text: "Child task",
          checked: false,
          index: 2,
          line: 12,
          column: 3,
          offsetStart: 21,
          offsetEnd: 40,
          file: "TODO.md",
          isInlineCli: false,
          depth: 1,
          children: [],
          subItems: [],
        },
      ],
      subItems: [
        {
          text: "Comes before child",
          line: 11,
          depth: 1,
        },
      ],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
    expect(output).toBe([
      "TODO.md:10 [#1] Parent task",
      "  TODO.md:11 - Comes before child",
      "  TODO.md:12 [#2] Child task",
    ].join("\n"));
  });
});
