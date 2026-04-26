export type SatelliteType = "review";

export interface Satellite {
  migrationNumber: number;
  type: SatelliteType;
  filePath: string;
}

export interface Migration {
  number: number;
  name: string;
  filePath: string;
  satellites: Satellite[];
  isApplied: boolean;
}

export interface MigrationState {
  projectRoot: string;
  migrationsDir: string;
  migrations: Migration[];
  currentPosition: number;
  latestSnapshot: Satellite | null;
  backlogPath: string | null;
}
