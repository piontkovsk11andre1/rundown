import { afterEach, describe, expect, it, vi } from "vitest";
import { cliOutputPort, resetCliOutputPortState, setCliOutputPortQuietMode } from "../../src/presentation/output-port.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetCliOutputPortState();
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
        detail: "checking",
      },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
    expect(output).toContain("⏳");
    expect(output).toContain("Verify phase (2/5 attempts) — checking");
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

  it("renders grouped output with box lines in TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({
        kind: "group-start",
        label: "Add include-cycle protection...",
        counter: { current: 4, total: 10 },
      });
      cliOutputPort.emit({ kind: "info", message: "opencode run [wait]" });
      cliOutputPort.emit({ kind: "group-end", status: "success" });

      expect(logSpy).toHaveBeenCalledTimes(3);
      const lines = logSpy.mock.calls.map((call) => stripAnsi(call[0] as string));
      expect(lines[0]).toBe("┌ [4/10] Add include-cycle protection...");
      expect(lines[1]).toBe("│  ℹ opencode run [wait]");
      expect(lines[2]).toBe("└ ✔ Done");
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

  it("renders nested groups with increasing indentation", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-start", label: "Outer" });
      cliOutputPort.emit({ kind: "info", message: "outer info" });
      cliOutputPort.emit({ kind: "group-start", label: "Inner" });
      cliOutputPort.emit({ kind: "info", message: "inner info" });
      cliOutputPort.emit({ kind: "group-end", status: "success" });
      cliOutputPort.emit({ kind: "group-end", status: "success" });

      expect(logSpy).toHaveBeenCalledTimes(6);
      const lines = logSpy.mock.calls.map((call) => stripAnsi(call[0] as string));
      expect(lines[0]).toBe("┌ Outer");
      expect(lines[1]).toBe("│  ℹ outer info");
      expect(lines[2]).toBe("│  ┌ Inner");
      expect(lines[3]).toBe("│  │  ℹ inner info");
      expect(lines[4]).toBe("│  └ ✔ Done");
      expect(lines[5]).toBe("└ ✔ Done");
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

  it("resets group indentation after a grouped command completes", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-start", label: "Run 1" });
      cliOutputPort.emit({ kind: "info", message: "inside group" });
      cliOutputPort.emit({ kind: "group-end", status: "success" });
      cliOutputPort.emit({ kind: "info", message: "next command" });

      expect(logSpy).toHaveBeenCalledTimes(4);
      const lines = logSpy.mock.calls.map((call) => stripAnsi(call[0] as string));
      expect(lines[0]).toBe("┌ Run 1");
      expect(lines[1]).toBe("│  ℹ inside group");
      expect(lines[2]).toBe("└ ✔ Done");
      expect(lines[3]).toBe("ℹ next command");
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

  it("resets stale group indentation between invocations after an error path", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-start", label: "Run that crashes" });
      resetCliOutputPortState();
      cliOutputPort.emit({ kind: "info", message: "fresh invocation" });

      expect(logSpy).toHaveBeenCalledTimes(2);
      const lines = logSpy.mock.calls.map((call) => stripAnsi(call[0] as string));
      expect(lines[0]).toBe("┌ Run that crashes");
      expect(lines[1]).toBe("ℹ fresh invocation");
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

  it("renders grouped output with flat prefix in non-TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: false,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({
        kind: "group-start",
        label: "Add typed ToolFrontmatter schema parsing/validation...",
        counter: { current: 2, total: 10 },
      });
      cliOutputPort.emit({ kind: "info", message: "opencode run [wait]" });
      cliOutputPort.emit({ kind: "group-end", status: "success" });

      expect(logSpy).toHaveBeenCalledTimes(3);
      const lines = logSpy.mock.calls.map((call) => stripAnsi(call[0] as string));
      expect(lines[0]).toBe("[2/10] Add typed ToolFrontmatter schema parsing/validation...");
      expect(lines[1]).toBe("    ℹ opencode run [wait]");
      expect(lines[2]).toBe("✔ Done");
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

  it("renders group-end success in non-TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    process.env.CI = "true";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-end", status: "success" });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = stripAnsi(logSpy.mock.calls[0]?.[0] as string);
      expect(output).toBe("✔ Done");
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

  it("renders group-end failure to stderr in non-TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    process.env.CI = "true";

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-end", status: "failure", message: "repairs exhausted" });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = stripAnsi(errorSpy.mock.calls[0]?.[0] as string);
      expect(output).toBe("✖ Failed — repairs exhausted");
      expect(logSpy).not.toHaveBeenCalled();
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

  it("renders group-end failure with message in TTY mode", () => {
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
    const previousIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      writable: true,
      value: true,
    });

    const previousCi = process.env.CI;
    delete process.env.CI;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      cliOutputPort.emit({ kind: "group-end", status: "failure", message: "repairs exhausted" });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const output = stripAnsi(errorSpy.mock.calls[0]?.[0] as string);
      expect(output).toBe("└ ✖ Failed — repairs exhausted");
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

  it("renders warn events to stderr", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({ kind: "warn", message: "heads up" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(stripAnsi(errorSpy.mock.calls[0]?.[0] as string)).toContain("heads up");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("styles log-runs text lines in the presentation layer", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "text",
      text: "run-20260328T120 | 2m ago | [completed] | Ship release notes | source=TODO.md:22 | command=run | sha=1234567890ab | revertable=yes",
    });
    cliOutputPort.emit({
      kind: "text",
      text: "run-20260328T110 | 30m ago | [completed] | Plan rollout | source=roadmap.md:9 | command=plan | sha=- | revertable=no",
    });

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(stripAnsi(logSpy.mock.calls[0]?.[0] as string)).toBe(
      "run-20260328T120 | 2m ago | [completed] | Ship release notes | source=TODO.md:22 | command=run | sha=1234567890ab | revertable=yes",
    );
    expect(stripAnsi(logSpy.mock.calls[1]?.[0] as string)).toBe(
      "run-20260328T110 | 30m ago | [completed] | Plan rollout | source=roadmap.md:9 | command=plan | sha=- | revertable=no",
    );
  });

  it("keeps non log-runs text lines unchanged", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({ kind: "text", text: "plain text" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe("plain text");
  });

  it("renders explore-file-summary rows as file statistics lines", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "explore-file-summary",
      summary: {
        file: "tasks.md",
        total: 2,
        checked: 1,
        unchecked: 1,
        percent: 50,
      },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe("tasks.md | 2 tasks | 1 checked | 1 unchecked | 50%");
  });

  it("renders zero-task explore-file-summary rows with a 0 tasks indication", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    cliOutputPort.emit({
      kind: "explore-file-summary",
      summary: {
        file: "empty.md",
        total: 0,
        checked: 0,
        unchecked: 0,
        percent: 0,
      },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe("empty.md | 0 tasks | 0 checked | 0 unchecked | 0%");
  });

  it("suppresses info-level output events in quiet mode", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    setCliOutputPortQuietMode(true);
    cliOutputPort.emit({ kind: "group-start", label: "Group" });
    cliOutputPort.emit({ kind: "info", message: "info" });
    cliOutputPort.emit({ kind: "success", message: "ok" });
    cliOutputPort.emit({ kind: "progress", progress: { label: "working" } });
    cliOutputPort.emit({ kind: "group-end", status: "success" });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still renders warnings and errors in quiet mode", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    setCliOutputPortQuietMode(true);
    cliOutputPort.emit({ kind: "warn", message: "heads up" });
    cliOutputPort.emit({ kind: "error", message: "bad" });

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(stripAnsi(errorSpy.mock.calls[0]?.[0] as string)).toContain("heads up");
    expect(stripAnsi(errorSpy.mock.calls[1]?.[0] as string)).toContain("bad");
  });
});
