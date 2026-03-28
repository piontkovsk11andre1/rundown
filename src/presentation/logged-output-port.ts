import type {
  GlobalOutputLogEntry,
  GlobalOutputLogLevel,
  GlobalOutputLogStream,
} from "../domain/global-output-log.js";
import type { ApplicationOutputEvent, ApplicationOutputPort } from "../domain/ports/output-port.js";

export interface GlobalOutputEntryWriter {
  write(entry: GlobalOutputLogEntry): void;
}

export interface LoggedOutputContext {
  command: string;
  argv: string[];
  cwd: string;
  pid: number;
  version: string;
  sessionId: string;
}

export interface CreateLoggedOutputPortOptions {
  output: ApplicationOutputPort;
  writer: GlobalOutputEntryWriter;
  context: LoggedOutputContext;
  now?: () => string;
}

export function createLoggedOutputPort(options: CreateLoggedOutputPortOptions): ApplicationOutputPort {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    emit(event) {
      try {
        options.writer.write({
          ts: now(),
          level: resolveLogLevel(event),
          stream: resolveLogStream(event),
          kind: resolveLogKind(event),
          message: resolveLogMessage(event),
          command: options.context.command,
          argv: options.context.argv,
          cwd: options.context.cwd,
          pid: options.context.pid,
          version: options.context.version,
          session_id: options.context.sessionId,
        });
      } catch {
        // best-effort logging: never interrupt output flow on log write failures
      }

      options.output.emit(event);
    },
  };
}

function resolveLogKind(event: ApplicationOutputEvent): string {
  switch (event.kind) {
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "success":
      return "success";
    case "task":
      return "task";
    case "text":
      return "text";
    case "stderr":
      return "stderr";
  }
}

function resolveLogLevel(event: ApplicationOutputEvent): GlobalOutputLogLevel {
  switch (event.kind) {
    case "warn":
      return "warn";
    case "error":
    case "stderr":
      return "error";
    case "info":
    case "success":
    case "task":
    case "text":
    default:
      return "info";
  }
}

function resolveLogStream(event: ApplicationOutputEvent): GlobalOutputLogStream {
  switch (event.kind) {
    case "error":
    case "stderr":
      return "stderr";
    case "info":
    case "warn":
    case "success":
    case "task":
    case "text":
    default:
      return "stdout";
  }
}

function resolveLogMessage(event: ApplicationOutputEvent): string {
  switch (event.kind) {
    case "info":
    case "warn":
    case "error":
    case "success":
      return event.message;
    case "task": {
      const task = formatTaskLine(event.task);
      const parentLine = event.blocked ? `${task} (blocked)` : task;
      const children = event.children ?? event.task.children;
      const subItems = event.subItems ?? event.task.subItems;
      const detailLines = formatTaskDetailLines({
        file: event.task.file,
        parentDepth: event.task.depth,
        children,
        subItems,
        indentLevel: 1,
      });

      if (detailLines.length === 0) {
        return parentLine;
      }

      return [parentLine, ...detailLines].join("\n");
    }
    case "text":
    case "stderr":
      return event.text;
    default:
      return "";
  }
}

function formatTaskLine(task: { file: string; line: number; index: number; text: string }): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

interface TaskDetailLineOptions {
  file: string;
  parentDepth: number;
  children?: unknown;
  subItems?: unknown;
  indentLevel: number;
}

interface TaskLike {
  file: string;
  line: number;
  index: number;
  text: string;
  depth: number;
  children?: unknown;
  subItems?: unknown;
}

interface SubItemLike {
  text: string;
  line: number;
  depth: number;
}

function formatTaskDetailLines(options: TaskDetailLineOptions): string[] {
  const children = Array.isArray(options.children) ? (options.children as TaskLike[]) : [];
  const subItems = Array.isArray(options.subItems) ? (options.subItems as SubItemLike[]) : [];

  const detailGroups: Array<{ line: number; lines: string[] }> = [];

  for (const child of children) {
    const childLines = [
      `${"  ".repeat(options.indentLevel)}${formatTaskLine(child)}`,
      ...formatTaskDetailLines({
        file: child.file,
        parentDepth: child.depth,
        children: child.children,
        subItems: child.subItems,
        indentLevel: options.indentLevel + 1,
      }),
    ];
    detailGroups.push({ line: child.line, lines: childLines });
  }

  for (const subItem of subItems) {
    const extraIndent = Math.max(0, subItem.depth - (options.parentDepth + 1));
    const indent = options.indentLevel + extraIndent;
    detailGroups.push({
      line: subItem.line,
      lines: [`${"  ".repeat(indent)}${options.file}:${subItem.line} - ${subItem.text}`],
    });
  }

  detailGroups.sort((left, right) => left.line - right.line);
  return detailGroups.flatMap((group) => group.lines);
}
