import type { SubItem, Task } from "./parser.js";
import {
  escapeExtractionMetadataValue,
  unescapeExtractionMetadataValue,
} from "./metadata-escape.js";

const LOOP_HANDLER_SEGMENT_PATTERN = /(^|[;,]\s*)(?:for|each|foreach)\s*:/i;
const FOR_ITEM_PATTERN = /^for-item\s*:\s*(.*)$/i;
const FOR_CURRENT_PATTERN = /^for-current\s*:\s*(.*)$/i;
const FOR_LOOP_PAYLOAD_SPLIT_PATTERN = /[\r\n,]+/;

export const FOR_LOOP_MISSING_CHILDREN_FAILURE_MESSAGE = "For loop task requires nested checkbox child tasks.";
export const FOR_LOOP_MISSING_CHILDREN_FAILURE_REASON = "For loop task has no nested checkbox children.";

export interface ResolvedForLoopItems {
  items: string[];
  source: "metadata" | "payload";
}

export function isForLoopTaskText(taskText: string): boolean {
  return LOOP_HANDLER_SEGMENT_PATTERN.test(taskText.trim());
}

export function hasForLoopCheckboxChildren(task: Pick<Task, "children">): boolean {
  return task.children.length > 0;
}

export function parseForItemValue(text: string): string | undefined {
  const match = text.match(FOR_ITEM_PATTERN);
  if (!match) {
    return undefined;
  }

  return unescapeForLoopMetadataValue((match[1] ?? "").trim());
}

export function parseForCurrentValue(text: string): string | undefined {
  const match = text.match(FOR_CURRENT_PATTERN);
  if (!match) {
    return undefined;
  }

  return unescapeForLoopMetadataValue((match[1] ?? "").trim());
}

export function unescapeForLoopMetadataValue(value: string): string {
  return unescapeExtractionMetadataValue(value);
}

export function normalizeForLoopItemValues(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getForItemValues(subItems: readonly SubItem[]): string[] {
  const values: string[] = [];
  for (const subItem of subItems) {
    const value = parseForItemValue(subItem.text);
    if (value === undefined) {
      continue;
    }
    values.push(value);
  }

  return normalizeForLoopItemValues(values);
}

export function getForCurrentValue(subItems: readonly SubItem[]): string | undefined {
  for (const subItem of subItems) {
    const value = parseForCurrentValue(subItem.text);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export function resolveForLoopItems(subItems: readonly SubItem[], payload: string): ResolvedForLoopItems {
  const metadataItems = getForItemValues(subItems);
  if (metadataItems.length > 0) {
    return {
      items: metadataItems,
      source: "metadata",
    };
  }

  return {
    items: normalizeForLoopItemValues(payload.split(FOR_LOOP_PAYLOAD_SPLIT_PATTERN)),
    source: "payload",
  };
}

export function escapeForLoopMetadataValue(value: string): string {
  return escapeExtractionMetadataValue(value);
}

export function formatForLoopItemMetadataLine(value: string): string {
  return `for-item: ${escapeForLoopMetadataValue(value)}`;
}

export function formatForLoopCurrentMetadataLine(value: string): string {
  return `for-current: ${escapeForLoopMetadataValue(value)}`;
}
