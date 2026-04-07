import type { SubItem, Task } from "../domain/parser.js";

type TaskLike = Pick<Task, "file" | "line" | "index" | "text" | "depth"> & {
  children?: unknown;
  subItems?: unknown;
};

type SubItemLike = Pick<SubItem, "text" | "line" | "depth">;

export interface TaskDetailLineFormatters {
  formatTaskLine(task: TaskLike): string;
  formatSubItemLine(subItem: { file: string; line: number; text: string }): string;
}

export interface TaskDetailLineOptions extends TaskDetailLineFormatters {
  file: string;
  parentDepth: number;
  children?: unknown;
  subItems?: unknown;
  indentLevel: number;
}

/**
 * Flattens nested child tasks and sub-items into ordered, indented output lines.
 */
export function formatTaskDetailLines(options: TaskDetailLineOptions): string[] {
  const children = Array.isArray(options.children) ? (options.children as TaskLike[]) : [];
  const subItems = Array.isArray(options.subItems) ? (options.subItems as SubItemLike[]) : [];

  const detailGroups: Array<{ line: number; lines: string[] }> = [];

  for (const child of children) {
    const childLines = [
      `${"  ".repeat(options.indentLevel)}${options.formatTaskLine(child)}`,
      ...formatTaskDetailLines({
        file: child.file,
        parentDepth: child.depth,
        children: child.children,
        subItems: child.subItems,
        indentLevel: options.indentLevel + 1,
        formatTaskLine: options.formatTaskLine,
        formatSubItemLine: options.formatSubItemLine,
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
        `${"  ".repeat(indent)}${options.formatSubItemLine({
          file: options.file,
          line: subItem.line,
          text: subItem.text,
        })}`,
      ],
    });
  }

  detailGroups.sort((left, right) => left.line - right.line);
  return detailGroups.flatMap((group) => group.lines);
}
