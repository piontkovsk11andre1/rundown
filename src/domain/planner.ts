import type { Task } from "./parser.js";

/** Re-export the task shape used by planner insertion helpers. */
export type { Task } from "./parser.js";

/** Canonical unchecked TODO line emitted by planner output parsing. */
export type PlannerSubitemLine = string;

/** Represents a Markdown heading discovered during insertion-point analysis. */
interface HeadingLine {
  lineIndex: number;
  level: number;
  text: string;
}

/** Options that control how planner TODO lines are inserted. */
export interface InsertTodoOptions {
  /** Indicates whether the source already contains TODO lines. */
  hasExistingTodos: boolean;
}

/** Result of applying planner output to source Markdown content. */
export interface InsertTodoResult {
  /** Updated Markdown source after insertion succeeds or is skipped. */
  updatedSource: string;
  /** Number of newly inserted TODO lines. */
  insertedCount: number;
  /** Signals that insertion was rejected by additive/syntax guardrails. */
  rejected: boolean;
  /** Optional reason describing why planner output was rejected. */
  rejectionReason?: string;
}

/** Options for normalizing planner additions against existing TODO items. */
export interface NormalizePlannerTodoAdditionsOptions {
  /** Existing TODO lines used to suppress duplicate planner suggestions. */
  existingTodoLines?: Iterable<string>;
}

/**
 * Extracts unchecked Markdown TODO lines from planner stdout.
 *
 * @param output Raw planner output text.
 * @returns Normalized list-item lines that use unchecked checkbox syntax.
 */
export function parsePlannerOutput(output: string): PlannerSubitemLine[] {
  const lines = output.split(/\r?\n/);
  const taskPattern = /^\s*[-*+]\s+\[ \]\s+\S/;

  return lines
    .filter((line) => taskPattern.test(line))
    .map((line) => line.replace(/^\s+/, ""));
}

/**
 * Inserts additive planner TODO lines into a Markdown source document.
 *
 * The insertion path enforces additive-only behavior, validates stdout
 * contract compliance, deduplicates against existing TODOs, and then chooses
 * an insertion position that preserves document structure.
 *
 * @param source Original Markdown source.
 * @param plannerOutput Raw output returned by the planner phase.
 * @param options Controls whether source already has TODO content.
 * @returns Insertion result including updated source and rejection metadata.
 */
export function insertPlannerTodos(
  source: string,
  plannerOutput: string,
  options: InsertTodoOptions,
): InsertTodoResult {
  // Reject outputs that attempt non-additive edits to existing TODO lines.
  const rejectionReason = detectNonAdditivePlannerOutput(source, plannerOutput);
  if (rejectionReason) {
    return {
      updatedSource: source,
      insertedCount: 0,
      rejected: true,
      rejectionReason,
    };
  }

  // Enforce planner stdout contract: only unchecked TODO list lines.
  const stdoutContractReason = validatePlannerStdoutContract(plannerOutput);
  if (stdoutContractReason) {
    return {
      updatedSource: source,
      insertedCount: 0,
      rejected: true,
      rejectionReason: stdoutContractReason,
    };
  }

  // Normalize and remove duplicates against document and planner output.
  const additions = normalizePlannerTodoAdditions(plannerOutput, {
    existingTodoLines: parsePlannerOutput(source),
  });
  if (additions.length === 0) {
    return { updatedSource: source, insertedCount: 0, rejected: false };
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";

  if (options.hasExistingTodos) {
    // Append to existing TODO region while preserving trailing newline rules.
    const prefix = source.length === 0 || source.endsWith("\n") || source.endsWith("\r") ? "" : eol;
    return {
      updatedSource: source + prefix + additions.join(eol) + eol,
      insertedCount: additions.length,
      rejected: false,
    };
  }

  // Use heading-aware heuristics when inserting into a document with no TODOs.
  const insertion = chooseTodoInsertionPoint(source, additions);
  const updatedSource = insertLinesAt(source, additions, insertion, eol);
  return { updatedSource, insertedCount: additions.length, rejected: false };
}

/**
 * Normalizes planner output into deduplicated unchecked TODO list lines.
 *
 * @param plannerOutput Raw planner output text.
 * @param options Optional existing TODO lines used for identity checks.
 * @returns Stable list of TODO additions ready for insertion.
 */
export function normalizePlannerTodoAdditions(
  plannerOutput: string,
  options: NormalizePlannerTodoAdditionsOptions = {},
): string[] {
  const parsed = parsePlannerOutput(plannerOutput);
  if (parsed.length === 0) {
    return [];
  }

  const existing = new Set<string>();
  for (const existingLine of options.existingTodoLines ?? []) {
    const existingIdentity = normalizeTodoIdentity(existingLine);
    if (existingIdentity.length > 0) {
      existing.add(existingIdentity);
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of parsed) {
    const normalized = normalizeTodoLine(line);
    const identity = normalizeTodoIdentity(normalized);
    if (identity.length === 0 || seen.has(identity) || existing.has(identity)) {
      continue;
    }

    seen.add(identity);
    deduped.push(normalized);
  }

  return deduped;
}

/** Normalizes list markers/checkboxes to canonical `- [ ]` TODO syntax. */
function normalizeTodoLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+\[ \]\s+/, "- [ ] ").trim();
}

/** Builds a whitespace-insensitive identity key for TODO deduplication. */
function normalizeTodoIdentity(line: string): string {
  const normalizedLine = normalizeTodoLine(line);
  if (normalizedLine.length === 0) {
    return "";
  }

  const content = normalizedLine.replace(/^- \[ \]\s+/, "").replace(/\s+/g, " ").trim();
  if (content.length === 0) {
    return "";
  }

  return `- [ ] ${content}`;
}

/** Converts checked/unchecked checkbox lines into canonical unchecked form. */
function normalizeTodoCheckboxLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "- [ ] ").trim();
}

/**
 * Validates planner stdout against the TODO-only output contract.
 *
 * @param plannerOutput Raw planner output text.
 * @returns Rejection reason when invalid; otherwise `null`.
 */
function validatePlannerStdoutContract(plannerOutput: string): string | null {
  if (plannerOutput.trim().length === 0) {
    return null;
  }

  const lines = plannerOutput.split(/\r?\n/);
  const uncheckedTodoPattern = /^\s*[-*+]\s+\[ \]\s+\S/;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    if (!uncheckedTodoPattern.test(line)) {
      return "Planner output violated stdout contract. Return only unchecked TODO lines using `- [ ]` syntax.";
    }
  }

  return null;
}

interface ParsedTodoCheckboxLine {
  normalized: string;
  checked: boolean;
}

/**
 * Detects non-additive planner behavior against existing TODO items.
 *
 * Disallows completion-state changes, partial echoing that implies removals,
 * and reordering of existing TODO lines.
 */
function detectNonAdditivePlannerOutput(source: string, plannerOutput: string): string | null {
  const existingTodos = parsePlannerOutput(source).map(normalizeTodoLine);
  if (existingTodos.length === 0) {
    return null;
  }

  const existingSet = new Set(existingTodos);
  const checkboxLines = parseTodoCheckboxLines(plannerOutput);

  for (const line of checkboxLines) {
    if (!line.checked) {
      continue;
    }

    if (existingSet.has(line.normalized)) {
      return "Planner output attempted to change the completion state of existing TODO items. Only additive TODO operations are allowed.";
    }
  }

  const echoedExistingInOutput = checkboxLines
    .filter((line) => !line.checked && existingSet.has(line.normalized))
    .map((line) => line.normalized);

  if (
    echoedExistingInOutput.length > 0
    && !includesAllExistingTodos(existingTodos, echoedExistingInOutput)
  ) {
    return "Planner output attempted to remove existing TODO items. Only additive TODO operations are allowed.";
  }

  if (!isInDocumentOrder(existingTodos, echoedExistingInOutput)) {
    return "Planner output attempted to reorder existing TODO items. Only additive TODO operations are allowed.";
  }

  return null;
}

/** Verifies that planner output echoed every existing TODO item. */
function includesAllExistingTodos(existingInDocumentOrder: string[], echoedExistingInOutput: string[]): boolean {
  const echoedSet = new Set(echoedExistingInOutput);

  for (const existing of existingInDocumentOrder) {
    if (!echoedSet.has(existing)) {
      return false;
    }
  }

  return true;
}

/** Parses checkbox list lines and records normalized content plus checked state. */
function parseTodoCheckboxLines(source: string): ParsedTodoCheckboxLine[] {
  const lines = source.split(/\r?\n/);
  const checkboxPattern = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;
  const parsed: ParsedTodoCheckboxLine[] = [];

  for (const line of lines) {
    const match = line.match(checkboxPattern);
    if (!match) {
      continue;
    }

    parsed.push({
      normalized: normalizeTodoCheckboxLine(line),
      checked: /[xX]/.test(match[1]),
    });
  }

  return parsed;
}

/** Confirms planner-echoed existing TODO lines preserve original document order. */
function isInDocumentOrder(existingInDocumentOrder: string[], echoedExistingInOutput: string[]): boolean {
  if (echoedExistingInOutput.length <= 1) {
    return true;
  }

  let fromIndex = 0;
  for (const echoed of echoedExistingInOutput) {
    const position = existingInDocumentOrder.indexOf(echoed, fromIndex);
    if (position === -1) {
      return false;
    }
    fromIndex = position + 1;
  }

  return true;
}

// Common non-discriminative words excluded from semantic token matching.
const SEMANTIC_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "todo",
  "task",
  "tasks",
  "item",
  "items",
  "step",
  "steps",
  "plan",
]);

/** Aggregated heading score used to choose an insertion section. */
interface HeadingScore {
  heading: HeadingLine;
  semanticScore: number;
  proximityScore: number;
  totalScore: number;
}

/**
 * Chooses the most appropriate insertion line for new TODO additions.
 *
 * The algorithm prefers semantically relevant sections, falls back to explicit
 * task-oriented headings, and appends to document end when no headings exist.
 */
function chooseTodoInsertionPoint(source: string, additions: string[]): number {
  const lines = source.split(/\r?\n/);
  const headings = findHeadingLines(lines);
  if (headings.length === 0) {
    return lines.length;
  }

  const fallbackHeading = findExplicitFallbackHeading(headings);
  const fallbackHeadingIndex = fallbackHeading
    ? headings.findIndex((heading) => heading.lineIndex === fallbackHeading.lineIndex)
    : -1;

  const scored = scoreHeadingCandidates(headings, additions, fallbackHeadingIndex);
  const best = scored[0];

  if (best && best.totalScore > 0) {
    return findSectionEndLine(lines, best.heading, headings);
  }

  if (fallbackHeading) {
    return findSectionEndLine(lines, fallbackHeading, headings);
  }

  return lines.length;
}

/** Scores heading candidates by semantic relevance and fallback proximity. */
function scoreHeadingCandidates(
  headings: HeadingLine[],
  additions: string[],
  fallbackHeadingIndex: number,
): HeadingScore[] {
  return headings
    .map((heading, headingIndex) => {
      const semanticScore = scoreHeadingSemantics(heading.text, additions);
      const proximityScore = scoreHeadingProximity(headingIndex, fallbackHeadingIndex, headings.length);

      return {
        heading,
        semanticScore,
        proximityScore,
        totalScore: semanticScore * 100 + proximityScore,
      };
    })
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      if (b.semanticScore !== a.semanticScore) {
        return b.semanticScore - a.semanticScore;
      }
      if (b.proximityScore !== a.proximityScore) {
        return b.proximityScore - a.proximityScore;
      }
      return a.heading.lineIndex - b.heading.lineIndex;
    });
}

/** Finds the highest-confidence fallback heading for TODO insertion. */
function findExplicitFallbackHeading(headings: HeadingLine[]): HeadingLine | null {
  const scored = headings
    .map((heading) => ({ heading, score: scoreFallbackHeading(heading.text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.heading.lineIndex - b.heading.lineIndex;
    });

  return scored[0]?.heading ?? null;
}

/** Assigns keyword-based score to headings commonly used for task sections. */
function scoreFallbackHeading(text: string): number {
  const fallbackKeywords: Array<{ pattern: RegExp; score: number }> = [
    { pattern: /\btodo\b/, score: 100 },
    { pattern: /\bchecklist\b/, score: 95 },
    { pattern: /\bnext steps?\b/, score: 90 },
    { pattern: /\baction items?\b/, score: 85 },
    { pattern: /\btask(s)?\b/, score: 80 },
  ];

  let score = 0;
  for (const keyword of fallbackKeywords) {
    if (keyword.pattern.test(text)) {
      score += keyword.score;
    }
  }

  return score;
}

/** Combines lexical relevance and token overlap for section matching. */
function scoreHeadingSemantics(text: string, additions: string[]): number {
  const headingKeywordScore = scoreHeadingRelevance(text);
  const semanticOverlapScore = scoreSemanticOverlap(text, additions);
  return headingKeywordScore + semanticOverlapScore;
}

/** Applies a lightweight distance bonus relative to fallback heading index. */
function scoreHeadingProximity(
  headingIndex: number,
  fallbackHeadingIndex: number,
  headingCount: number,
): number {
  if (fallbackHeadingIndex < 0 || headingCount <= 1) {
    return 0;
  }

  const maxDistance = headingCount - 1;
  const distance = Math.abs(headingIndex - fallbackHeadingIndex);
  return Math.max(0, maxDistance - distance);
}

/** Scores lexical token overlap between heading text and planned additions. */
function scoreSemanticOverlap(text: string, additions: string[]): number {
  const headingTokens = tokenizeForSemanticMatching(text);
  if (headingTokens.size === 0) {
    return 0;
  }

  const additionTokens = new Set<string>();
  for (const addition of additions) {
    for (const token of tokenizeForSemanticMatching(addition)) {
      additionTokens.add(token);
    }
  }

  if (additionTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of headingTokens) {
    if (additionTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap * 3;
}

/** Tokenizes text for semantic matching while removing short/stop-word noise. */
function tokenizeForSemanticMatching(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens = new Set<string>();

  for (const token of matches) {
    if (token.length < 3 || SEMANTIC_STOP_WORDS.has(token)) {
      continue;
    }
    tokens.add(token);
  }

  return tokens;
}

/** Parses ATX headings and records line index, level, and normalized text. */
function findHeadingLines(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) {
      continue;
    }

    headings.push({
      lineIndex: index,
      level: match[1].length,
      text: match[2].trim().toLowerCase(),
    });
  }

  return headings;
}

/** Scores heading text for common task-planning keywords. */
function scoreHeadingRelevance(text: string): number {
  const keywords: Array<{ pattern: RegExp; score: number }> = [
    { pattern: /\btodo\b/, score: 10 },
    { pattern: /\bchecklist\b/, score: 9 },
    { pattern: /\btask(s)?\b/, score: 8 },
    { pattern: /\bnext steps?\b/, score: 7 },
    { pattern: /\baction items?\b/, score: 7 },
    { pattern: /\bplan\b/, score: 6 },
    { pattern: /\bimplementation\b/, score: 5 },
    { pattern: /\broadmap\b/, score: 4 },
  ];

  let score = 0;
  for (const keyword of keywords) {
    if (keyword.pattern.test(text)) {
      score += keyword.score;
    }
  }

  return score;
}

/** Finds the line index where a heading section should be considered complete. */
function findSectionEndLine(lines: string[], target: HeadingLine, headings: HeadingLine[]): number {
  for (const heading of headings) {
    if (heading.lineIndex <= target.lineIndex) {
      continue;
    }
    if (heading.level <= target.level) {
      return heading.lineIndex;
    }
  }

  return lines.length;
}

/**
 * Inserts TODO lines at a target line while preserving surrounding spacing.
 *
 * @param source Original Markdown source.
 * @param additions Normalized TODO lines to insert.
 * @param insertionLine Zero-based target line index.
 * @param eol End-of-line sequence detected from source.
 * @returns Updated source with inserted TODO block and trailing newline.
 */
function insertLinesAt(source: string, additions: string[], insertionLine: number, eol: string): string {
  const lines = source.split(/\r?\n/);
  let insertionIndex = Math.max(0, Math.min(insertionLine, lines.length));

  // Trim trailing blank lines in the insertion region for stable formatting.
  while (insertionIndex > 0 && (lines[insertionIndex - 1] ?? "").trim().length === 0) {
    if (insertionIndex === lines.length) {
      break;
    }
    lines.splice(insertionIndex - 1, 1);
    insertionIndex -= 1;
  }

  const insertionBlock = ["", ...additions];
  lines.splice(insertionIndex, 0, ...insertionBlock);

  const updated = lines.join(eol);
  return updated.endsWith(eol) ? updated : updated + eol;
}

/**
 * Computes two-space child indentation from a parent list-item line.
 *
 * @param parentLine Parent task line from source Markdown.
 * @returns Child indentation prefix that preserves leading whitespace.
 */
export function computeChildIndent(parentLine: string): string {
  const leadingWhitespace = parentLine.match(/^(\s*)/)?.[1] ?? "";
  const indentUnit = "  ";
  return leadingWhitespace + indentUnit;
}

/**
 * Inserts planner-generated sub-items directly beneath a selected task.
 *
 * @param source Original Markdown source.
 * @param task Task that will receive inserted sub-items.
 * @param subitemLines Planner-generated sub-item list lines.
 * @returns Updated source with correctly indented child list items.
 */
export function insertSubitems(
  source: string,
  task: Task,
  subitemLines: PlannerSubitemLine[],
): string {
  if (subitemLines.length === 0) return source;

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const parentLineIndex = task.line - 1;

  if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range.`);
  }

  const parentLine = lines[parentLineIndex]!;
  const indent = computeChildIndent(parentLine);

  const indented = subitemLines.map((item) => {
    const text = item.replace(/^[-*+]\s+/, "");
    return `${indent}- ${text}`;
  });

  lines.splice(parentLineIndex + 1, 0, ...indented);

  return lines.join(eol);
}
