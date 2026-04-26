import path from "node:path";
import type { Migration, MigrationState, Satellite, SatelliteType } from "./migration-types.js";

type SatelliteFilenameType = SatelliteType | "snapshot";

const SATELLITE_PATTERN = /^(\d{4})--(.+)\.md$/;
const MIGRATION_PATTERN = /^(\d{4})-(?!-)(.+)\.md$/;
const DOTTED_MIGRATION_PATTERN = /^(\d+)\.\s+(.+)\.md$/;
const DOTTED_SATELLITE_PATTERN = /^(\d+)\.(\d+)\s+(.+)\.md$/;

const DOTTED_SATELLITE_INDEX_BY_TYPE: Record<SatelliteFilenameType, number> = {
  snapshot: 1,
  review: 3,
};

const DOTTED_SATELLITE_LABEL_BY_TYPE: Record<SatelliteFilenameType, string> = {
  snapshot: "Snapshot",
  review: "Review",
};

const SATELLITE_TYPES = new Set<SatelliteFilenameType>([
  "snapshot",
  "review",
]);

interface ParsedMigrationEntry {
  number: number;
  name: string;
  isSatellite: boolean;
  satelliteType: SatelliteFilenameType | null;
}

export interface ParsedMigrationFilename {
  number: number;
  name: string;
}

export function formatMigrationFilename(number: number, name: string): string {
  return `${String(number)}. ${toTitleCaseFromName(name)}.md`;
}

export function formatSatelliteFilename(number: number, type: SatelliteFilenameType): string {
  const satelliteIndex = DOTTED_SATELLITE_INDEX_BY_TYPE[type];
  const satelliteLabel = DOTTED_SATELLITE_LABEL_BY_TYPE[type];
  return `${String(number)}.${String(satelliteIndex)} ${satelliteLabel}.md`;
}

function parseMigrationFilenameDetailed(filename: string): ParsedMigrationEntry | null {
  const dottedSatelliteMatch = filename.match(DOTTED_SATELLITE_PATTERN);
  if (dottedSatelliteMatch) {
    const number = Number.parseInt(dottedSatelliteMatch[1]!, 10);
    const satelliteIndex = Number.parseInt(dottedSatelliteMatch[2]!, 10);
    const satelliteLabel = dottedSatelliteMatch[3]!;
    const satelliteTypeFromIndex = getSatelliteTypeFromDottedIndex(satelliteIndex);
    const satelliteTypeFromLabel = getSatelliteTypeFromLabel(satelliteLabel);
    const satelliteType = satelliteTypeFromLabel ?? satelliteTypeFromIndex;
    if (!satelliteType) {
      return null;
    }
    return {
      number,
      name: satelliteType,
      isSatellite: true,
      satelliteType,
    };
  }

  const satelliteMatch = filename.match(SATELLITE_PATTERN);
  if (satelliteMatch) {
    const number = Number.parseInt(satelliteMatch[1]!, 10);
    const satelliteType = satelliteMatch[2]!;
    if (!SATELLITE_TYPES.has(satelliteType as SatelliteFilenameType)) {
      return null;
    }
    return {
      number,
      name: satelliteType,
      isSatellite: true,
      satelliteType: satelliteType as SatelliteFilenameType,
    };
  }

  const dottedMigrationMatch = filename.match(DOTTED_MIGRATION_PATTERN);
  if (dottedMigrationMatch) {
    return {
      number: Number.parseInt(dottedMigrationMatch[1]!, 10),
      name: toKebabCase(dottedMigrationMatch[2]!),
      isSatellite: false,
      satelliteType: null,
    };
  }

  const migrationMatch = filename.match(MIGRATION_PATTERN);
  if (!migrationMatch) {
    return null;
  }

  return {
    number: Number.parseInt(migrationMatch[1]!, 10),
    name: migrationMatch[2]!,
    isSatellite: false,
    satelliteType: null,
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
    if (!parsed || parsed.isSatellite) {
      continue;
    }

    migrationMap.set(parsed.number, {
      number: parsed.number,
      name: parsed.name,
      filePath,
      satellites: [],
      isApplied: false,
    });
  }

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const parsed = parseMigrationFilenameDetailed(filename);
    if (!parsed || !parsed.isSatellite) {
      continue;
    }

    const migration = migrationMap.get(parsed.number);
    if (!migration) {
      continue;
    }

    if (parsed.satelliteType !== "review") {
      continue;
    }

    migration.satellites.push({
      migrationNumber: parsed.number,
      type: parsed.satelliteType,
      filePath,
    });
  }

  const migrations = [...migrationMap.values()]
    .sort((left, right) => left.number - right.number);

  for (const migration of migrations) {
    migration.satellites.sort((left, right) => {
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

function getLatestSatelliteFromMigrations(migrations: Migration[], type: SatelliteType): Satellite | null {
  const satellites: Satellite[] = [];
  for (const migration of migrations) {
    for (const satellite of migration.satellites) {
      if (satellite.type === type) {
        satellites.push(satellite);
      }
    }
  }

  if (satellites.length === 0) {
    return null;
  }

  satellites.sort((left, right) => {
    if (left.migrationNumber !== right.migrationNumber) {
      return left.migrationNumber - right.migrationNumber;
    }
    return left.type.localeCompare(right.type);
  });

  return satellites[satellites.length - 1]!;
}

function getSatelliteTypeFromDottedIndex(index: number): SatelliteFilenameType | null {
  for (const [type, value] of Object.entries(DOTTED_SATELLITE_INDEX_BY_TYPE)) {
    if (value === index) {
      return type as SatelliteFilenameType;
    }
  }

  return null;
}

function getSatelliteTypeFromLabel(label: string): SatelliteFilenameType | null {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized === "snapshot") {
    return "snapshot";
  }
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
