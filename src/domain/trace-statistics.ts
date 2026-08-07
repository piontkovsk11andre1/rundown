import {
  TRACE_STATISTICS_FIELD_REGISTRY,
  type TraceStatisticsField,
} from "./worker-config.js";

export interface TraceStatisticsSnapshot {
  fields: Record<TraceStatisticsField, number | null>;
}

const DURATION_FIELDS = new Set<TraceStatisticsField>([
  "total_time",
  "execution_time",
  "verify_time",
  "repair_time",
  "idle_time",
]);

const PHASE_DURATION_FIELDS = new Set<TraceStatisticsField>([
  "execution_time",
  "verify_time",
  "repair_time",
]);

const VALID_FIELDS = new Set<string>(TRACE_STATISTICS_FIELD_REGISTRY);
const CHILD_INDENT = "    ";
const GRANDCHILD_INDENT = "        ";

function isTraceStatisticsField(value: string): value is TraceStatisticsField {
  return VALID_FIELDS.has(value);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatDurationMs(valueMs: number): string {
  if (valueMs < 1000) {
    return "<1s";
  }

  return `${Math.round(valueMs / 1000)}s`;
}

function formatFieldValue(field: TraceStatisticsField, value: number): string {
  if (DURATION_FIELDS.has(field)) {
    return formatDurationMs(value);
  }

  return Math.round(value).toString(10);
}

function formatFieldLabel(field: TraceStatisticsField): string {
  switch (field) {
    case "total_time":
      return "total time";
    case "execution_time":
      return "execution";
    case "verify_time":
      return "verify";
    case "repair_time":
      return "repair";
    case "idle_time":
      return "idle";
    case "tokens_estimated":
      return "tokens estimated";
    case "phases_count":
      return "phases";
    case "verify_attempts":
      return "verify attempts";
    case "repair_attempts":
      return "repair attempts";
  }
}

export function formatStatisticsLines(
  snapshot: TraceStatisticsSnapshot,
  fields: string[],
): string[] {
  if (fields.length === 0) {
    return [];
  }

  const requestedFields = fields.filter(isTraceStatisticsField);
  if (requestedFields.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const nestedPhaseFields = new Set<TraceStatisticsField>();

  for (let index = 0; index < requestedFields.length; index++) {
    const field = requestedFields[index];
    if (nestedPhaseFields.has(field)) {
      continue;
    }

    const value = snapshot.fields[field];
    if (!isPositiveNumber(value)) {
      continue;
    }

    const lineIndent = CHILD_INDENT;
    lines.push(`${lineIndent}- ${formatFieldLabel(field)}: ${formatFieldValue(field, value)}`);

    if (field !== "total_time") {
      continue;
    }

    for (let phaseIndex = index + 1; phaseIndex < requestedFields.length; phaseIndex++) {
      const phaseField = requestedFields[phaseIndex];
      if (!PHASE_DURATION_FIELDS.has(phaseField)) {
        break;
      }

      const phaseValue = snapshot.fields[phaseField];
      if (!isPositiveNumber(phaseValue)) {
        nestedPhaseFields.add(phaseField);
        continue;
      }

      lines.push(
        `${GRANDCHILD_INDENT}- ${formatFieldLabel(phaseField)}: ${formatFieldValue(phaseField, phaseValue)}`,
      );
      nestedPhaseFields.add(phaseField);
    }
  }

  return lines;
}
