// @ts-nocheck
import pc from "picocolors";

type BadgePainter = (text: string) => string;

export type ProgressOperationLabel =
  | "verify"
  | "repair"
  | "resolve"
  | "resolveRepair"
  | "plan"
  | "research"
  | "discuss"
  | "execute"
  | "scan"
  | "finalize";

const PROGRESS_OPERATION_BADGE_COLOR = {
  verify: pc.blue,
  repair: pc.red,
  resolve: pc.magenta,
  resolveRepair: pc.magenta,
  plan: pc.cyan,
  research: pc.cyan,
  discuss: pc.yellow,
  execute: pc.yellow,
  scan: pc.cyan,
  finalize: pc.green,
} satisfies Record<ProgressOperationLabel, BadgePainter>;

const NORMALIZED_PROGRESS_OPERATION_BADGE_COLOR: Record<string, BadgePainter> = {
  verify: PROGRESS_OPERATION_BADGE_COLOR.verify,
  repair: PROGRESS_OPERATION_BADGE_COLOR.repair,
  resolve: PROGRESS_OPERATION_BADGE_COLOR.resolve,
  resolverepair: PROGRESS_OPERATION_BADGE_COLOR.resolveRepair,
  plan: PROGRESS_OPERATION_BADGE_COLOR.plan,
  research: PROGRESS_OPERATION_BADGE_COLOR.research,
  discuss: PROGRESS_OPERATION_BADGE_COLOR.discuss,
  execute: PROGRESS_OPERATION_BADGE_COLOR.execute,
  scan: PROGRESS_OPERATION_BADGE_COLOR.scan,
  finalize: PROGRESS_OPERATION_BADGE_COLOR.finalize,
};

export const OPERATION_BADGE_COLOR: Record<string, BadgePainter> = {
  ...NORMALIZED_PROGRESS_OPERATION_BADGE_COLOR,
  summarize: pc.blue,
  agent: pc.yellow,
};

const BADGE_OPERATION_KEYS = new Set(Object.keys(OPERATION_BADGE_COLOR));

export function normalizeOperationKey(label: unknown): string {
  if (typeof label !== "string" || label.trim().length === 0) {
    return "";
  }
  const firstToken = label.toLowerCase().split(/\s+/)[0] || "";
  return firstToken.replace(/[^a-z]/g, "");
}

export function isBadgeOperationKey(operation: string): boolean {
  return BADGE_OPERATION_KEYS.has(operation);
}

export function paintOperationBadge(operation: unknown, text: unknown): string {
  const key = normalizeOperationKey(operation);
  const painter = OPERATION_BADGE_COLOR[key] ?? pc.dim;
  return painter(String(text));
}
