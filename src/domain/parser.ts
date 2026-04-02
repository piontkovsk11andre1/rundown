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
import type { TaskIntent } from "./task-intent.js";

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
  /** Whether this is a rundown task (starts with "rundown: "). */
  isRundownTask: boolean;
  /** If rundown task, the args string after the prefix. */
  rundownArgs?: string;
  /** Nesting depth (0 = top-level list item). */
  depth: number;
  /** Nested checkbox child tasks. */
  children: Task[];
  /** Nested non-checkbox list items. */
  subItems: SubItem[];
  /** Intent override inherited from directive parents. */
  intent?: TaskIntent;
  /** Profile inherited from directive parent list items. */
  directiveProfile?: string;
}

/** Represents a plain (non-checkbox) list item nested under a task. */
export interface SubItem {
  /** The text content of the list item. */
  text: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Nesting depth (0 = top-level list item). */
  depth: number;
}

/** Document-level TODO item extracted from Markdown. */
export type TodoItem = Task;

/** Represents a Markdown ATX heading with normalized lookup metadata. */
export interface MarkdownHeadingLine {
  /** Zero-based line index where the heading appears. */
  lineIndex: number;
  /** Heading level (`1` to `6`). */
  level: number;
  /** Raw heading text without leading `#` markers. */
  text: string;
  /** Lowercased heading text used for case-insensitive matching. */
  normalizedText: string;
}

/** Describes a heading section as a half-open line range. */
export interface MarkdownSection {
  /** Heading line that starts this section. */
  heading: MarkdownHeadingLine;
  /** Zero-based start line index for this section. */
  startLineIndex: number;
  /** First line index that is outside this section. */
  endLineIndexExclusive: number;
}

/** Minimal frontmatter data consumed by task-planning flows. */
export interface FrontmatterData {
  /** Optional profile declared in YAML frontmatter. */
  profile?: string;
}

// Prefix used to classify inline CLI tasks.
const CLI_PREFIX = /^cli:\s*/i;
// Prefix used to classify rundown sub-command tasks.
const RUNDOWN_PREFIX = /^rundown:\s*/i;
// Matches ATX-style headings (`#` through `######`).
const ATX_HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
// Captures the first YAML frontmatter block in the document.
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
// Matches simple `key: value` lines within frontmatter.
const FRONTMATTER_KEY_VALUE_PATTERN = /^\s*([^:#\s][^:]*)\s*:\s*(.*)$/;
// Detects directive list items that set a profile context.
const PROFILE_DIRECTIVE_PATTERN = /^profile\s*:\s*(.+)$/i;
// Detects directive list items that switch tasks to verify-only intent.
const VERIFY_DIRECTIVE_PATTERN = /^(?:verify|confirm|check)\s*:\s*$/i;

/** Context inherited while walking nested directive list items. */
interface DirectiveContext {
  /** Active profile inherited from parent directive items. */
  directiveProfile?: string;
  /** Active task intent inherited from parent directive items. */
  intent?: TaskIntent;
}

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
  walkForTasks(tree, tasks, file, 0, undefined, {});
  return tasks;
}

/**
 * Extract all TODO items globally across a Markdown document.
 *
 * This is a document-level helper used by planning flows that only care about
 * TODO coverage and not task-selection semantics.
 */
export function extractTodoItems(source: string, file: string = ""): TodoItem[] {
  return parseTasks(source, file);
}

/** Return true when the Markdown document contains at least one TODO item. */
export function hasTodoItems(source: string): boolean {
  return extractTodoItems(source).length > 0;
}

/** Count TODO items globally across a Markdown document. */
export function countTodoItems(source: string): number {
  return extractTodoItems(source).length;
}

/**
 * Parse YAML-style frontmatter and return supported metadata fields.
 *
 * Unknown keys are ignored intentionally so the parser remains tolerant of
 * unrelated document metadata.
 */
export function extractFrontmatter(source: string): FrontmatterData {
  const match = source.match(FRONTMATTER_BLOCK_PATTERN);
  if (!match) {
    return {};
  }

  const block = match[1] ?? "";
  const result: FrontmatterData = {};

  for (const rawLine of block.split(/\r?\n/)) {
    const keyValueMatch = rawLine.match(FRONTMATTER_KEY_VALUE_PATTERN);
    if (!keyValueMatch) {
      continue;
    }

    const key = keyValueMatch[1]?.trim().toLowerCase();
    const value = keyValueMatch[2]?.trim();
    if (key === "profile" && value) {
      result.profile = value;
    }
  }

  return result;
}

/**
 * Extract all ATX heading lines from a Markdown document.
 *
 * These heading descriptors are used by section-aware insertion heuristics.
 */
export function extractHeadingLines(source: string): MarkdownHeadingLine[] {
  const lines = source.split(/\r?\n/);
  const headings: MarkdownHeadingLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(ATX_HEADING_PATTERN);
    if (!match) {
      continue;
    }

    const text = match[2].trim();
    headings.push({
      lineIndex: index,
      level: match[1].length,
      text,
      normalizedText: text.toLowerCase(),
    });
  }

  return headings;
}

/**
 * Build section boundaries from ATX headings.
 *
 * Each section starts at a heading and ends before the next heading
 * whose level is less than or equal to the current heading level.
 */
export function extractHeadingSections(source: string): MarkdownSection[] {
  const lines = source.split(/\r?\n/);
  const headings = extractHeadingLines(source);

  return headings.map((heading, index) => {
    let endLineIndexExclusive = lines.length;

    for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
      const nextHeading = headings[nextIndex]!;
      if (nextHeading.level <= heading.level) {
        endLineIndexExclusive = nextHeading.lineIndex;
        break;
      }
    }

    return {
      heading,
      startLineIndex: heading.lineIndex,
      endLineIndexExclusive,
    };
  });
}

function walkForTasks(
  node: Parent | RootContent,
  tasks: Task[],
  file: string,
  depth: number,
  parentTask: Task | undefined,
  directiveContext: DirectiveContext,
): void {
  let currentParentTask = parentTask;
  let nextDirectiveContext = directiveContext;

  if (isListItem(node) && node.checked !== null && node.checked !== undefined) {
    const text = extractText(node);
    const pos = node.position;
    const isInlineCli = CLI_PREFIX.test(text);
    const isRundownTask = RUNDOWN_PREFIX.test(text);

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
      isRundownTask,
      depth,
      children: [],
      subItems: [],
    };

    if (directiveContext.intent) {
      task.intent = directiveContext.intent;
    }
    if (directiveContext.directiveProfile) {
      task.directiveProfile = directiveContext.directiveProfile;
    }

    if (isInlineCli) {
      task.cliCommand = text.replace(CLI_PREFIX, "").trim();
    }

    if (isRundownTask) {
      task.rundownArgs = text.replace(RUNDOWN_PREFIX, "").trim();
    }

    if (parentTask) {
      parentTask.children.push(task);
    }

    tasks.push(task);
    currentParentTask = task;
  } else if (isListItem(node)) {
    const text = extractText(node);
    if (currentParentTask && text.length > 0) {
      currentParentTask.subItems.push({
        text,
        line: node.position?.start.line ?? 0,
        depth,
      });
    }

    const directive = parseDirectiveParent(text);
    const isDirectProfileSubItemOfTask = Boolean(
      currentParentTask
      && directive.directiveProfile
      && depth === currentParentTask.depth + 1,
    );

    if (directive.intent || (directive.directiveProfile && !isDirectProfileSubItemOfTask)) {
      nextDirectiveContext = {
        intent: directive.intent ?? directiveContext.intent,
        directiveProfile: isDirectProfileSubItemOfTask
          ? directiveContext.directiveProfile
          : (directive.directiveProfile ?? directiveContext.directiveProfile),
      };
    }
  }

  if ("children" in node) {
    const nextDepth = isListItem(node) ? depth + 1 : depth;
    for (const child of (node as Parent).children) {
      walkForTasks(child, tasks, file, nextDepth, currentParentTask, nextDirectiveContext);
    }
  }
}

/**
 * Parse directive-style parent list items and map them to inheritance context.
 *
 * Supported directives currently include profile selection and verify-only
 * intent markers.
 */
function parseDirectiveParent(text: string): DirectiveContext {
  const profileMatch = text.match(PROFILE_DIRECTIVE_PATTERN);
  if (profileMatch) {
    const profileName = profileMatch[1]?.trim();
    if (profileName) {
      return { directiveProfile: profileName };
    }
  }

  if (VERIFY_DIRECTIVE_PATTERN.test(text)) {
    return { intent: "verify-only" };
  }

  return {};
}

/** Type guard for mdast list item nodes. */
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

/** Recursively collect inline text values from supported mdast node types. */
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
