import { describe, expect, it, vi } from "vitest";
import { createLoggedOutputPort } from "../../src/presentation/logged-output-port.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";

describe("createLoggedOutputPort", () => {
  it("logs each event before forwarding to wrapped output", () => {
    const callOrder: string[] = [];
    const outputEmit = vi.fn(() => {
      callOrder.push("emit");
    });
    const writer = {
      write: vi.fn(() => {
        callOrder.push("write");
      }),
    };

    const port = createLoggedOutputPort({
      output: { emit: outputEmit },
      writer,
      context: {
        command: "rundown",
        argv: ["next", "tasks.md"],
        cwd: "/workspace",
        pid: 123,
        version: "1.2.3",
        sessionId: "session-1",
      },
      now: () => "2026-03-28T00:00:00.000Z",
    });

    port.emit({ kind: "info", message: "hello" });

    expect(callOrder).toEqual(["write", "emit"]);
    expect(writer.write).toHaveBeenCalledWith({
      ts: "2026-03-28T00:00:00.000Z",
      level: "info",
      stream: "stdout",
      kind: "info",
      message: "hello",
      command: "rundown",
      argv: ["next", "tasks.md"],
      cwd: "/workspace",
      pid: 123,
      version: "1.2.3",
      session_id: "session-1",
    });
    expect(outputEmit).toHaveBeenCalledWith({ kind: "info", message: "hello" });
  });

  it("keeps forwarding output when log writing fails", () => {
    const outputEmit = vi.fn();
    const port = createLoggedOutputPort({
      output: { emit: outputEmit },
      writer: {
        write: () => {
          throw new Error("disk full");
        },
      },
      context: {
        command: "rundown",
        argv: [],
        cwd: "/workspace",
        pid: 123,
        version: "1.2.3",
        sessionId: "session-1",
      },
      now: () => "2026-03-28T00:00:00.000Z",
    });

    expect(() => port.emit({ kind: "error", message: "boom" })).not.toThrow();
    expect(outputEmit).toHaveBeenCalledWith({ kind: "error", message: "boom" });
  });

  it("logs expected level, stream, kind, and message for every event kind", () => {
    const outputEmit = vi.fn();
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: outputEmit },
      writer,
      context: {
        command: "rundown",
        argv: ["execute", "TODO.md"],
        cwd: "/workspace",
        pid: 456,
        version: "1.2.3",
        sessionId: "session-2",
      },
      now: () => "2026-03-28T12:34:56.000Z",
    });

    const events: ApplicationOutputEvent[] = [
      { kind: "info", message: "info message" },
      { kind: "warn", message: "warn message" },
      { kind: "error", message: "error message" },
      { kind: "success", message: "success message" },
      {
        kind: "progress",
        progress: {
          label: "Verify phase",
          current: 1,
          total: 3,
          unit: "attempts",
          detail: "running",
        },
      },
      {
        kind: "task",
        task: {
          text: "Verify output mapping",
          checked: false,
          index: 7,
          line: 41,
          column: 3,
          offsetStart: 100,
          offsetEnd: 140,
          file: "TODO.md",
          isInlineCli: false,
          depth: 0,
          children: [],
          subItems: [],
        },
      },
      {
        kind: "task",
        task: {
          text: "Blocked output mapping",
          checked: false,
          index: 8,
          line: 42,
          column: 3,
          offsetStart: 141,
          offsetEnd: 180,
          file: "TODO.md",
          isInlineCli: false,
          depth: 0,
          children: [],
          subItems: [],
        },
        blocked: true,
      },
      { kind: "text", text: "plain text" },
      { kind: "stderr", text: "stderr text" },
    ];

    for (const event of events) {
      port.emit(event);
    }

    expect(outputEmit).toHaveBeenCalledTimes(events.length);
    expect(outputEmit).toHaveBeenNthCalledWith(1, events[0]);
    expect(outputEmit).toHaveBeenNthCalledWith(2, events[1]);
    expect(outputEmit).toHaveBeenNthCalledWith(3, events[2]);
    expect(outputEmit).toHaveBeenNthCalledWith(4, events[3]);
    expect(outputEmit).toHaveBeenNthCalledWith(5, events[4]);
    expect(outputEmit).toHaveBeenNthCalledWith(6, events[5]);
    expect(outputEmit).toHaveBeenNthCalledWith(7, events[6]);
    expect(outputEmit).toHaveBeenNthCalledWith(8, events[7]);
    expect(outputEmit).toHaveBeenNthCalledWith(9, events[8]);

    expect(writer.write).toHaveBeenCalledTimes(events.length);
    expect(writer.write).toHaveBeenNthCalledWith(1, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "info",
      message: "info message",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(2, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "warn",
      stream: "stdout",
      kind: "warn",
      message: "warn message",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(3, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "error",
      stream: "stderr",
      kind: "error",
      message: "error message",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(4, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "success",
      message: "success message",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(5, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "progress",
      message: "Verify phase (1/3 attempts) - running",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(6, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "task",
      message: "TODO.md:41 [#7] Verify output mapping",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(7, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "task",
      message: "TODO.md:42 [#8] Blocked output mapping (blocked)",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(8, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "info",
      stream: "stdout",
      kind: "text",
      message: "plain text",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
    expect(writer.write).toHaveBeenNthCalledWith(9, {
      ts: "2026-03-28T12:34:56.000Z",
      level: "error",
      stream: "stderr",
      kind: "stderr",
      message: "stderr text",
      command: "rundown",
      argv: ["execute", "TODO.md"],
      cwd: "/workspace",
      pid: 456,
      version: "1.2.3",
      session_id: "session-2",
    });
  });

  it("formats progress messages safely when counters are invalid or non-positive", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["run", "TODO.md"],
        cwd: "/workspace",
        pid: 2000,
        version: "1.2.3",
        sessionId: "session-progress",
      },
      now: () => "2026-03-28T20:00:00.000Z",
    });

    port.emit({
      kind: "progress",
      progress: {
        label: "Delegated rundown run",
        current: Number.NaN,
        total: Number.POSITIVE_INFINITY,
        detail: "still running",
      },
    });
    port.emit({
      kind: "progress",
      progress: {
        label: "Verify phase",
        current: 2.8,
        total: 0,
        unit: "attempts",
        detail: "waiting",
      },
    });

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "progress",
      message: "Delegated rundown run - still running",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "progress",
      message: "Verify phase - waiting",
    }));
  });

  it("renders child task lines indented under the parent task", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["list"],
        cwd: "/workspace",
        pid: 999,
        version: "1.2.3",
        sessionId: "session-3",
      },
      now: () => "2026-03-28T18:00:00.000Z",
    });

    port.emit({
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

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task",
      message: "TODO.md:10 [#1] Parent task\n  TODO.md:11 [#2] Child task",
    }));
  });

  it("renders non-checkable sub-items indented under the parent task", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["list"],
        cwd: "/workspace",
        pid: 1000,
        version: "1.2.3",
        sessionId: "session-4",
      },
      now: () => "2026-03-28T18:30:00.000Z",
    });

    port.emit({
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

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task",
      message: "TODO.md:10 [#1] Parent task\n  TODO.md:11 - Parent detail",
    }));
  });

  it("renders children and sub-items in source order", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["list"],
        cwd: "/workspace",
        pid: 1001,
        version: "1.2.3",
        sessionId: "session-5",
      },
      now: () => "2026-03-28T19:00:00.000Z",
    });

    port.emit({
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

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task",
      message: [
        "TODO.md:10 [#1] Parent task",
        "  TODO.md:11 - Comes before child",
        "  TODO.md:12 [#2] Child task",
      ].join("\n"),
    }));
  });
});
