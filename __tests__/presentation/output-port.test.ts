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

  it("renders structured progress events as one-line status updates", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "progress",
      progress: {
        label: "Verify phase",
        current: 2,
        total: 5,
        unit: "attempts",
        detail: "running verification",
      },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
    expect(output).toContain("⏳");
    expect(output).toContain("Verify phase (2/5 attempts) — running verification");
  });

  it("renders interactive spinner/progress updates in TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });
    const previousCi = process.env.CI;
    delete process.env.CI;

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({
        kind: "progress",
        progress: {
          label: "Delegated rundown run",
          detail: "still running",
        },
      });
      cliOutputPort.emit({
        kind: "progress",
        progress: {
          label: "Verify phase",
          current: 2,
          total: 4,
          unit: "attempts",
          detail: "checking",
        },
      });
      cliOutputPort.emit({ kind: "info", message: "done" });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const infoOutput = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
      expect(infoOutput).toContain("done");

      const writes = writeSpy.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
      expect(writes.some((line) => line.includes("Delegated rundown run") && line.includes("still running"))).toBe(true);
      expect(writes.some((line) => line.includes("Verify phase") && line.includes("2/4 attempts") && line.includes("["))).toBe(true);
      expect(writes.some((line) => line === "\n")).toBe(true);
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }

      if (hadIsTTY) {
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          writable: true,
          value: previousIsTTY,
        });
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("degrades progress rendering to stable lines in CI even with TTY", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    process.env.CI = "true";

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({
        kind: "progress",
        progress: {
          label: "Delegated rundown run",
          detail: "still running",
        },
      });

      expect(writeSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
      expect(output).toContain("⏳");
      expect(output).toContain("Delegated rundown run — still running");
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }

      if (hadIsTTY) {
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          writable: true,
          value: previousIsTTY,
        });
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
