import type { ApplicationOutputEvent, ApplicationOutputPort } from "../domain/ports/output-port.js";
import pc from "picocolors";

function dim(message: string): string {
  return pc.dim(message);
}

function taskLabel(task: { text: string; file: string; line: number; index: number }): string {
  return `${pc.cyan(task.file)}:${pc.yellow(String(task.line))} ${pc.dim(`[#${task.index}]`)} ${task.text}`;
}

interface TaskLike {
  text: string;
  file: string;
  line: number;
  index: number;
  depth: number;
  children?: unknown;
  subItems?: unknown;
}

interface SubItemLike {
  text: string;
  line: number;
  depth: number;
}

interface TaskDetailLineOptions {
  file: string;
  parentDepth: number;
  children?: unknown;
  subItems?: unknown;
  indentLevel: number;
}

function formatTaskDetailLines(options: TaskDetailLineOptions): string[] {
  const children = Array.isArray(options.children) ? (options.children as TaskLike[]) : [];
  const subItems = Array.isArray(options.subItems) ? (options.subItems as SubItemLike[]) : [];

  const detailGroups: Array<{ line: number; lines: string[] }> = [];

  for (const child of children) {
    const childLines = [
      `${"  ".repeat(options.indentLevel)}${taskLabel(child)}`,
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
      lines: [
        `${"  ".repeat(indent)}${pc.cyan(options.file)}:${pc.yellow(String(subItem.line))} - ${subItem.text}`,
      ],
    });
  }

  detailGroups.sort((left, right) => left.line - right.line);
  return detailGroups.flatMap((group) => group.lines);
}

export const cliOutputPort: ApplicationOutputPort = {
  emit(event: ApplicationOutputEvent): void {
    switch (event.kind) {
      case "info":
        console.log(pc.blue("ℹ") + " " + event.message);
        return;
      case "warn":
        console.log(pc.yellow("⚠") + " " + event.message);
        return;
      case "error":
        console.error(pc.red("✖") + " " + event.message);
        return;
      case "success":
        console.log(pc.green("✔") + " " + event.message);
        return;
      case "task":
        {
          const children = event.children ?? event.task.children;
          const subItems = event.subItems ?? event.task.subItems;
          const lines = [
            taskLabel(event.task)
            + (event.blocked ? dim(" (blocked — has unchecked subtasks)") : ""),
            ...formatTaskDetailLines({
              file: event.task.file,
              parentDepth: event.task.depth,
              children,
              subItems,
              indentLevel: 1,
            }),
          ];
          console.log(lines.join("\n"));
        }
        return;
      case "text":
        console.log(event.text);
        return;
      case "stderr":
        process.stderr.write(event.text);
        return;
      default:
        return;
    }
  },
};
