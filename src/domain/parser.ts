/**
 * Markdown AST-based task parser.
 *
 * Uses mdast to walk the parsed Markdown tree and extract task list items.
 * Fenced code blocks and other non-task structures are naturally excluded
 * by the AST — no regex guessing required.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import {
  gfmTaskListItem,
} from "micromark-extension-gfm-task-list-item";
import {
  gfmTaskListItemFromMarkdown,
} from "mdast-util-gfm-task-list-item";
import type { ListItem, Parent, RootContent } from "mdast";

/** Represents a single task extracted from a Markdown document. */
export interface Task {
  /** The text content of the task item. */
  text: string;
  /** Whether the checkbox is checked. */
  checked: boolean;
  /** Zero-based index among all tasks in the document. */
  index: number;
  /** 1-based line number in the source file. */
  line: number;
  /** Column offset of the checkbox in the source line. */
  column: number;
  /** Byte offset of the start of this node in the source. */
  offsetStart: number;
  /** Byte offset of the end of this node in the source. */
  offsetEnd: number;
  /** The source file path (set later by the caller). */
  file: string;
  /** Whether this is an inline CLI task (starts with "cli: "). */
  isInlineCli: boolean;
  /** If inline CLI, the command string. */
  cliCommand?: string;
  /** Nesting depth (0 = top-level list item). */
  depth: number;
}

const CLI_PREFIX = /^cli:\s*/i;

/**
 * Parse a Markdown source string and return all task list items found.
 *
 * Tasks inside fenced code blocks are naturally excluded because the
 * AST parser treats code blocks as opaque content nodes.
 */
export function parseTasks(source: string, file: string = ""): Task[] {
  const tree = fromMarkdown(source, {
    extensions: [gfmTaskListItem()],
    mdastExtensions: [gfmTaskListItemFromMarkdown()],
  });

  const tasks: Task[] = [];
  walkForTasks(tree, tasks, file, 0);
  return tasks;
}

function walkForTasks(
  node: Parent | RootContent,
  tasks: Task[],
  file: string,
  depth: number,
): void {
  if (isListItem(node) && node.checked !== null && node.checked !== undefined) {
    const text = extractText(node);
    const pos = node.position;
    const isInlineCli = CLI_PREFIX.test(text);

    const task: Task = {
      text,
      checked: node.checked === true,
      index: tasks.length,
      line: pos?.start.line ?? 0,
      column: pos?.start.column ?? 0,
      offsetStart: pos?.start.offset ?? 0,
      offsetEnd: pos?.end?.offset ?? 0,
      file,
      isInlineCli,
      depth,
    };

    if (isInlineCli) {
      task.cliCommand = text.replace(CLI_PREFIX, "").trim();
    }

    tasks.push(task);
  }

  if ("children" in node) {
    const nextDepth = isListItem(node) ? depth + 1 : depth;
    for (const child of (node as Parent).children) {
      walkForTasks(child, tasks, file, nextDepth);
    }
  }
}

function isListItem(node: unknown): node is ListItem {
  return (node as ListItem).type === "listItem";
}

/**
 * Extract plain text content from a list item node.
 *
 * Only collects text from the item's direct paragraph children,
 * not from nested lists (which are separate tasks).
 */
function extractText(node: ListItem): string {
  const parts: string[] = [];
  for (const child of node.children) {
    // Only extract text from paragraphs, not nested lists
    if (child.type === "paragraph") {
      collectText(child, parts);
    }
  }
  return parts.join("").trim();
}

function collectText(node: Parent | RootContent, parts: string[]): void {
  if (node.type === "text" || node.type === "inlineCode") {
    parts.push((node as { value: string }).value);
  }
  if ("children" in node) {
    for (const child of (node as Parent).children) {
      collectText(child, parts);
    }
  }
}
