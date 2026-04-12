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

  it("strips ANSI sequences before writing JSONL payloads", () => {
    const ansiRed = "\u001b[31m";
    const ansiReset = "\u001b[0m";
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: `${ansiRed}rundown${ansiReset}`,
        argv: ["run", `${ansiRed}TODO.md${ansiReset}`],
        cwd: `${ansiRed}/workspace${ansiReset}`,
        pid: 321,
        version: `${ansiRed}1.2.3${ansiReset}`,
        sessionId: `${ansiRed}session-ansi${ansiReset}`,
      },
      now: () => `${ansiRed}2026-03-28T00:00:00.000Z${ansiReset}`,
    });

    port.emit({ kind: "text", text: `${ansiRed}colored line${ansiReset}` });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      ts: "2026-03-28T00:00:00.000Z",
      message: "colored line",
      command: "rundown",
      argv: ["run", "TODO.md"],
      cwd: "/workspace",
      version: "1.2.3",
      session_id: "session-ansi",
    }));
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
      stream: "stderr",
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

  it("formats group boundary messages for structured logs", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["all"],
        cwd: "/workspace",
        pid: 789,
        version: "1.2.3",
        sessionId: "session-groups",
      },
      now: () => "2026-03-28T14:00:00.000Z",
    });

    port.emit({
      kind: "group-start",
      label: "Add include-cycle protection",
      counter: { current: 4, total: 10 },
    });
    port.emit({
      kind: "group-end",
      status: "failure",
      message: "repairs exhausted",
    });
    port.emit({
      kind: "group-end",
      status: "success",
    });

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      level: "info",
      stream: "stdout",
      kind: "group-start",
      message: "[4/10] Add include-cycle protection",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      level: "warn",
      stream: "stderr",
      kind: "group-end",
      message: "failure - repairs exhausted",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(3, expect.objectContaining({
      level: "info",
      stream: "stdout",
      kind: "group-end",
      message: "success",
    }));
  });

  it("maps group boundary events to kind, level, stream, and message", () => {
    const outputEmit = vi.fn();
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: outputEmit },
      writer,
      context: {
        command: "rundown",
        argv: ["all"],
        cwd: "/workspace",
        pid: 790,
        version: "1.2.3",
        sessionId: "session-group-mapping",
      },
      now: () => "2026-03-28T14:05:00.000Z",
    });

    const events: ApplicationOutputEvent[] = [
      {
        kind: "group-start",
        label: "Task without counter",
      },
      {
        kind: "group-start",
        label: "Task with counter",
        counter: { current: 2, total: 5 },
      },
      {
        kind: "group-end",
        status: "success",
      },
      {
        kind: "group-end",
        status: "failure",
        message: "repairs exhausted",
      },
    ];

    for (const event of events) {
      port.emit(event);
    }

    expect(outputEmit).toHaveBeenCalledTimes(events.length);
    expect(outputEmit).toHaveBeenNthCalledWith(1, events[0]);
    expect(outputEmit).toHaveBeenNthCalledWith(2, events[1]);
    expect(outputEmit).toHaveBeenNthCalledWith(3, events[2]);
    expect(outputEmit).toHaveBeenNthCalledWith(4, events[3]);

    expect(writer.write).toHaveBeenCalledTimes(events.length);
    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "group-start",
      level: "info",
      stream: "stdout",
      message: "Task without counter",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "group-start",
      level: "info",
      stream: "stdout",
      message: "[2/5] Task with counter",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: "group-end",
      level: "info",
      stream: "stdout",
      message: "success",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(4, expect.objectContaining({
      kind: "group-end",
      level: "warn",
      stream: "stderr",
      message: "failure - repairs exhausted",
    }));
  });

  it("falls back to plain group label when counters are invalid", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["all"],
        cwd: "/workspace",
        pid: 791,
        version: "1.2.3",
        sessionId: "session-group-invalid-counter",
      },
      now: () => "2026-03-28T14:10:00.000Z",
    });

    port.emit({
      kind: "group-start",
      label: "Task with invalid counter",
      counter: { current: Number.NaN, total: Number.POSITIVE_INFINITY },
    });
    port.emit({
      kind: "group-start",
      label: "Task with non-positive total",
      counter: { current: 3, total: 0 },
    });

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "group-start",
      message: "Task with invalid counter",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "group-start",
      message: "Task with non-positive total",
    }));
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

  it("normalizes valid group and progress counters deterministically", () => {
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
        pid: 2001,
        version: "1.2.3",
        sessionId: "session-normalized-counters",
      },
      now: () => "2026-03-28T20:10:00.000Z",
    });

    port.emit({
      kind: "group-start",
      label: "Scan tasks",
      counter: { current: -1.8, total: 3.9 },
    });
    port.emit({
      kind: "progress",
      progress: {
        label: "Verify phase",
        current: -2.4,
        total: 4.7,
        unit: "attempts",
        detail: "running",
      },
    });

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "group-start",
      level: "info",
      stream: "stdout",
      message: "[0/3] Scan tasks",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "progress",
      level: "info",
      stream: "stdout",
      message: "Verify phase (0/4 attempts) - running",
    }));
  });

  it("maps lifecycle and stdout/stderr events to deterministic structured entries", () => {
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
        pid: 2002,
        version: "1.2.3",
        sessionId: "session-lifecycle-mapping",
      },
      now: () => "2026-03-28T20:20:00.000Z",
    });

    const events: ApplicationOutputEvent[] = [
      {
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
        blocked: true,
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
            text: "Detail line",
            line: 11,
            depth: 1,
          },
        ],
      },
      {
        kind: "progress",
        progress: {
          label: "Execute",
          detail: "queued",
        },
      },
      {
        kind: "group-start",
        label: "Run checks",
      },
      {
        kind: "group-end",
        status: "failure",
        message: "timed out",
      },
      {
        kind: "text",
        text: "stdout text line",
      },
      {
        kind: "stderr",
        text: "stderr text line",
      },
    ];

    for (const event of events) {
      port.emit(event);
    }

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "task",
      level: "info",
      stream: "stdout",
      message: [
        "TODO.md:10 [#1] Parent task (blocked)",
        "  TODO.md:11 - Detail line",
        "  TODO.md:12 [#2] Child task",
      ].join("\n"),
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "progress",
      level: "info",
      stream: "stdout",
      message: "Execute - queued",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: "group-start",
      level: "info",
      stream: "stdout",
      message: "Run checks",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(4, expect.objectContaining({
      kind: "group-end",
      level: "warn",
      stream: "stderr",
      message: "failure - timed out",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(5, expect.objectContaining({
      kind: "text",
      level: "info",
      stream: "stdout",
      message: "stdout text line",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(6, expect.objectContaining({
      kind: "stderr",
      level: "error",
      stream: "stderr",
      message: "stderr text line",
    }));
  });

  it("persists plain text task and milestone messages when terminal output is animated", () => {
    const writer = {
      write: vi.fn(),
    };

    const port = createLoggedOutputPort({
      output: { emit: vi.fn() },
      writer,
      context: {
        command: "rundown",
        argv: ["run", "tasks.md"],
        cwd: "/workspace",
        pid: 321,
        version: "1.2.3",
        sessionId: "session-animated",
      },
      now: () => "2026-03-29T00:00:00.000Z",
    });

    port.emit({ kind: "info", message: "Next task: tasks.md:12 [#5] Tighten output tests" });
    port.emit({ kind: "success", message: "All tasks completed (5 total)." });

    expect(writer.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "info",
      message: "Next task: tasks.md:12 [#5] Tighten output tests",
    }));
    expect(writer.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "success",
      message: "All tasks completed (5 total).",
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
