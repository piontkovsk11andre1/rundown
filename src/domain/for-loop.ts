import type { SubItem } from "./parser.js";

const LOOP_HANDLER_SEGMENT_PATTERN = /(^|[;,]\s*)(?:for|each|foreach)\s*:/i;
const FOR_ITEM_PATTERN = /^for-item\s*:\s*(.*)$/i;
const FOR_CURRENT_PATTERN = /^for-current\s*:\s*(.*)$/i;
const FOR_LOOP_PAYLOAD_SPLIT_PATTERN = /[\r\n,]+/;
const FOR_LOOP_METADATA_ESCAPE_PATTERN = /([\\`*_[\]<>])/g;
const FOR_LOOP_METADATA_UNESCAPE_PATTERN = /\\([\\`*_[\]<>])/g;

export interface ResolvedForLoopItems {
  items: string[];
  source: "metadata" | "payload";
}

export function isForLoopTaskText(taskText: string): boolean {
  return LOOP_HANDLER_SEGMENT_PATTERN.test(taskText.trim());
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
  return value.replace(FOR_LOOP_METADATA_UNESCAPE_PATTERN, "$1");
}

export function normalizeForLoopItemValues(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const item = value.trim();
    if (item.length === 0 || seen.has(item)) {
      continue;
    }

    seen.add(item);
    normalized.push(item);
  }

  return normalized;
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
  return value.replace(FOR_LOOP_METADATA_ESCAPE_PATTERN, "\\$1");
}

export function formatForLoopItemMetadataLine(value: string): string {
  return `for-item: ${escapeForLoopMetadataValue(value)}`;
}

export function formatForLoopCurrentMetadataLine(value: string): string {
  return `for-current: ${escapeForLoopMetadataValue(value)}`;
}
