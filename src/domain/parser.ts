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
  /** CLI args inherited from parent `cli-args:` directive items. */
  directiveCliArgs?: string;
  /** Profile declared as a task-level `profile:` sub-item for prefix-intent tasks. */
  taskProfile?: string;
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
// Matches ATX-style headings (`#` through `######`).
const ATX_HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
// Captures the first YAML frontmatter block in the document.
const FRONTMATTER_BLOCK_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
// Matches simple `key: value` lines within frontmatter.
const FRONTMATTER_KEY_VALUE_PATTERN = /^\s*([^:#\s][^:]*)\s*:\s*(.*)$/;
// Detects directive list items that set a profile context.
const PROFILE_DIRECTIVE_PATTERN = /^profile\s*:\s*(.+)$/i;
// Detects directive list items that append args to nested cli tasks.
const CLI_ARGS_DIRECTIVE_PATTERN = /^cli[-\s]?args\s*:\s*(.*)$/i;
// Detects directive list items that switch tasks to verify-only intent.
const VERIFY_DIRECTIVE_PATTERN = /^(?:verify|confirm|check)\s*:\s*$/i;
// Detects directive list items that switch tasks to fast-execution intent.
const FAST_DIRECTIVE_PATTERN = /^(?:fast|raw)\s*:\s*$/i;
// Detects directive list items that switch tasks to parallel-group intent.
const PARALLEL_DIRECTIVE_PATTERN = /^(?:parallel|concurrent|par)\s*:\s*$/i;
// Detects explicit verify-only task prefixes with payload text.
const VERIFY_TASK_PREFIX_PATTERN = /^(?:verify|confirm|check)\s*:/i;
// Detects memory-capture task prefixes with payload text.
const MEMORY_TASK_PREFIX_PATTERN = /^(?:memory|memorize|remember|inventory)\s*:/i;
// Detects fast-execution task prefixes with payload text.
const FAST_TASK_PREFIX_PATTERN = /^(?:fast|raw)\s*:/i;

/** Context inherited while walking nested directive list items. */
interface DirectiveContext {
  /** Active profile inherited from parent directive items. */
  directiveProfile?: string;
  /** CLI args inherited from parent `cli-args:` directive items. */
  cliArgs?: string;
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
      children: [],
      subItems: [],
    };

    if (directiveContext.intent && !isIntentClassifiedPrefixTaskText(text)) {
      task.intent = directiveContext.intent;
    }
    if (directiveContext.directiveProfile) {
      task.directiveProfile = directiveContext.directiveProfile;
    }

    if (isInlineCli) {
      const inlineCliCommand = text.replace(CLI_PREFIX, "").trim();
      task.cliCommand = directiveContext.cliArgs
        ? [inlineCliCommand, directiveContext.cliArgs].filter(Boolean).join(" ")
        : inlineCliCommand;
      if (directiveContext.cliArgs) {
        task.directiveCliArgs = directiveContext.cliArgs;
      }
    }

    if (parentTask) {
      parentTask.children.push(task);
    }

    tasks.push(task);
    currentParentTask = task;
  } else if (isListItem(node)) {
    const text = extractText(node);
    const directive = parseDirectiveParent(text);
    const isCliArgsDirectiveSubItem = Boolean(directive.cliArgs);

    if (currentParentTask && text.length > 0 && !isCliArgsDirectiveSubItem) {
      currentParentTask.subItems.push({
        text,
        line: node.position?.start.line ?? 0,
        depth,
      });
    }

    const isDirectProfileSubItemOfTask = Boolean(
      currentParentTask
      && directive.directiveProfile
      && depth === currentParentTask.depth + 1,
    );

    if (
      isDirectProfileSubItemOfTask
      && currentParentTask
      && isIntentClassifiedPrefixTaskText(currentParentTask.text)
      && !currentParentTask.taskProfile
    ) {
      currentParentTask.taskProfile = directive.directiveProfile;
    }

    if (directive.intent || directive.cliArgs || (directive.directiveProfile && !isDirectProfileSubItemOfTask)) {
      nextDirectiveContext = {
        intent: directive.intent ?? directiveContext.intent,
        directiveProfile: isDirectProfileSubItemOfTask
          ? directiveContext.directiveProfile
          : (directive.directiveProfile ?? directiveContext.directiveProfile),
        cliArgs: mergeCliArgs(directiveContext.cliArgs, directive.cliArgs),
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
 * Returns true when task text uses a prefix that may be intent-classified.
 *
 * `cli:` items are excluded because they bypass worker profile resolution.
 */
function isIntentClassifiedPrefixTaskText(taskText: string): boolean {
  const normalized = taskText.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (CLI_PREFIX.test(normalized)) {
    return false;
  }

  if (
    VERIFY_TASK_PREFIX_PATTERN.test(normalized)
    || MEMORY_TASK_PREFIX_PATTERN.test(normalized)
    || FAST_TASK_PREFIX_PATTERN.test(normalized)
  ) {
    return true;
  }

  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0) {
    return false;
  }

  const prefixName = normalized.slice(0, separatorIndex).trim();
  return prefixName.length > 0;
}

/**
 * Parse directive-style parent list items and map them to inheritance context.
 *
 * Supported directives currently include profile selection and verify-only
 * intent markers.
 */
export function parseDirectiveParent(text: string): DirectiveContext {
  const profileMatch = text.match(PROFILE_DIRECTIVE_PATTERN);
  if (profileMatch) {
    const profileName = profileMatch[1]?.trim();
    if (profileName) {
      return { directiveProfile: profileName };
    }
  }

  const cliArgsMatch = text.match(CLI_ARGS_DIRECTIVE_PATTERN);
  if (cliArgsMatch) {
    const cliArgs = cliArgsMatch[1]?.trim();
    if (cliArgs && cliArgs.length > 0) {
      return { cliArgs };
    }

    return {};
  }

  if (VERIFY_DIRECTIVE_PATTERN.test(text)) {
    return { intent: "verify-only" };
  }

  if (FAST_DIRECTIVE_PATTERN.test(text)) {
    return { intent: "fast-execution" };
  }

  if (PARALLEL_DIRECTIVE_PATTERN.test(text)) {
    return { intent: "parallel-group" };
  }

  return {};
}

/**
 * Compose nested `cli-args:` directive values in document order.
 *
 * Outer directive args appear first, followed by inner directive args.
 */
function mergeCliArgs(parentCliArgs?: string, childCliArgs?: string): string | undefined {
  const normalizedParent = parentCliArgs?.trim();
  const normalizedChild = childCliArgs?.trim();

  if (normalizedParent && normalizedChild) {
    return [normalizedParent, normalizedChild].join(" ");
  }

  return normalizedChild ?? normalizedParent;
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
