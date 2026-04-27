import path from "node:path";
import type { Migration, MigrationReviewType, MigrationState } from "./migration-types.js";

type ReviewFilenameType = MigrationReviewType;

const DOUBLE_DASH_AUX_PATTERN = /^(\d{4})--(.+)\.md$/;
const MIGRATION_PATTERN = /^(\d{4})-(?!-)(.+)\.md$/;
const DOTTED_MIGRATION_PATTERN = /^(\d+)\.\s+(.+)\.md$/;
const DOTTED_AUX_PATTERN = /^(\d+)\.(\d+)\s+(.+)\.md$/;

const DOTTED_AUX_INDEX_BY_TYPE: Record<ReviewFilenameType, number> = {
  review: 3,
};

const DOTTED_AUX_LABEL_BY_TYPE: Record<ReviewFilenameType, string> = {
  review: "Review",
};

const RECOGNIZED_AUX_TYPES = new Set<ReviewFilenameType>(["review"]);

interface ParsedMigrationEntry {
  number: number;
  name: string;
  isAuxiliary: boolean;
  reviewType: ReviewFilenameType | null;
}

export interface ParsedMigrationFilename {
  number: number;
  name: string;
}

export function formatMigrationFilename(number: number, name: string): string {
  return `${String(number)}. ${toTitleCaseFromName(name)}.md`;
}

function formatAuxiliaryFilename(number: number, type: ReviewFilenameType): string {
  const auxIndex = DOTTED_AUX_INDEX_BY_TYPE[type];
  const auxLabel = DOTTED_AUX_LABEL_BY_TYPE[type];
  return `${String(number)}.${String(auxIndex)} ${auxLabel}.md`;
}

function parseMigrationFilenameDetailed(filename: string): ParsedMigrationEntry | null {
  const dottedAuxMatch = filename.match(DOTTED_AUX_PATTERN);
  if (dottedAuxMatch) {
    const number = Number.parseInt(dottedAuxMatch[1]!, 10);
    const auxIndex = Number.parseInt(dottedAuxMatch[2]!, 10);
    const auxLabel = dottedAuxMatch[3]!;
    const reviewTypeFromIndex = getReviewTypeFromDottedIndex(auxIndex);
    const reviewTypeFromLabel = getReviewTypeFromLabel(auxLabel);
    const reviewType = reviewTypeFromLabel ?? reviewTypeFromIndex;
    if (!reviewType) {
      return null;
    }
    return {
      number,
      name: reviewType,
      isAuxiliary: true,
      reviewType,
    };
  }

  const dashedAuxMatch = filename.match(DOUBLE_DASH_AUX_PATTERN);
  if (dashedAuxMatch) {
    const number = Number.parseInt(dashedAuxMatch[1]!, 10);
    const reviewType = dashedAuxMatch[2]!;
    if (!RECOGNIZED_AUX_TYPES.has(reviewType as ReviewFilenameType)) {
      return null;
    }
    return {
      number,
      name: reviewType,
      isAuxiliary: true,
      reviewType: reviewType as ReviewFilenameType,
    };
  }

  const dottedMigrationMatch = filename.match(DOTTED_MIGRATION_PATTERN);
  if (dottedMigrationMatch) {
    return {
      number: Number.parseInt(dottedMigrationMatch[1]!, 10),
      name: toKebabCase(dottedMigrationMatch[2]!),
      isAuxiliary: false,
      reviewType: null,
    };
  }

  const migrationMatch = filename.match(MIGRATION_PATTERN);
  if (!migrationMatch) {
    return null;
  }

  return {
    number: Number.parseInt(migrationMatch[1]!, 10),
    name: migrationMatch[2]!,
    isAuxiliary: false,
    reviewType: null,
  };
}

export function parseMigrationFilename(filename: string): ParsedMigrationFilename | null {
  const parsed = parseMigrationFilenameDetailed(filename);
  if (!parsed) {
    return null;
  }

  return {
    number: parsed.number,
    name: parsed.name,
  };
}

export function parseMigrationDirectory(files: string[], migrationsDir: string): MigrationState {
  const migrationMap = new Map<number, Migration>();

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const parsed = parseMigrationFilenameDetailed(filename);
    if (!parsed || parsed.isAuxiliary) {
      continue;
    }

    migrationMap.set(parsed.number, {
      number: parsed.number,
      name: parsed.name,
      filePath,
      reviews: [],
      isApplied: false,
    });
  }

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const parsed = parseMigrationFilenameDetailed(filename);
    if (!parsed || !parsed.isAuxiliary) {
      continue;
    }

    const migration = migrationMap.get(parsed.number);
    if (!migration) {
      continue;
    }

    if (parsed.reviewType !== "review") {
      continue;
    }

    migration.reviews.push({
      migrationNumber: parsed.number,
      type: parsed.reviewType,
      filePath,
    });
  }

  const migrations = [...migrationMap.values()]
    .sort((left, right) => left.number - right.number);

  for (const migration of migrations) {
    migration.reviews.sort((left, right) => {
      if (left.migrationNumber !== right.migrationNumber) {
        return left.migrationNumber - right.migrationNumber;
      }
      return left.type.localeCompare(right.type);
    });
  }

  const state: MigrationState = {
    projectRoot: path.dirname(migrationsDir),
    migrationsDir,
    migrations,
    currentPosition: getCurrentPositionFromMigrations(migrations),
    latestSnapshot: null,
    backlogPath: getSingletonBacklogPath(files, migrationsDir),
  };

  return state;
}

function getCurrentPositionFromMigrations(migrations: Migration[]): number {
  if (migrations.length === 0) {
    return 0;
  }
  return migrations[migrations.length - 1]!.number;
}

function getReviewTypeFromDottedIndex(index: number): ReviewFilenameType | null {
  for (const [type, value] of Object.entries(DOTTED_AUX_INDEX_BY_TYPE)) {
    if (value === index) {
      return type as ReviewFilenameType;
    }
  }

  return null;
}

function getReviewTypeFromLabel(label: string): ReviewFilenameType | null {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized === "review") {
    return "review";
  }

  return null;
}

function getSingletonBacklogPath(files: string[], migrationsDir: string): string | null {
  const expected = path.normalize(path.join(migrationsDir, "Backlog.md"));
  for (const filePath of files) {
    if (path.normalize(filePath) === expected) {
      return filePath;
    }
  }

  return null;
}

function toTitleCaseFromName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Migration";
  }

  const normalized = trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  return normalized
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

function toKebabCase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`'".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized.length > 0 ? normalized : "migration";
}
